// content.js — runs in every page (all frames). Watches <video> elements,
// measures playback health, and — when autopilot is on — actively prevents
// stalls before you see them: easing speed to rebuild buffer, pausing briefly
// to let a starving buffer catch up, and reloading a truly dead stream.
// Reports summaries and intervention events to the background service worker.
// It reads video playback stats and drives the video element (play/pause/
// playbackRate/src reload); it never blocks or modifies network requests.

(() => {
  "use strict";

  // Handshake flag: lets the Stream Autopilot dashboard detect that the
  // extension is installed and flip its "Enable Autopilot" button to active.
  try {
    window.__streamAutopilotInstalled = true;
    window.dispatchEvent(new CustomEvent("stream-autopilot:installed"));
  } catch (_) { /* non-DOM context */ }

  // Per-video state, keyed by the element itself.
  const videos = new Map();

  const SUMMARY_INTERVAL_MS = 5000;
  const REBUFFER_WINDOW_MS = 120000; // rolling window for "struggling" detection
  const REBUFFER_HARD_LIMIT = 3; // rebuffers inside the window => stream is struggling

  function getDroppedFrames(video) {
    try {
      if (typeof video.getVideoPlaybackQuality === "function") {
        const q = video.getVideoPlaybackQuality();
        if (q && typeof q.droppedVideoFrames === "number") return q.droppedVideoFrames;
      }
    } catch (_) { /* older browsers */ }
    // Safari-era fallback
    if (typeof video.webkitDroppedFrameCount === "number") {
      return video.webkitDroppedFrameCount;
    }
    return 0;
  }

  // --- StreamGov-style passive measurement (no extra network traffic) ---

  // Seconds of video buffered ahead of the playhead.
  function bufferedAhead(video) {
    try {
      const b = video.buffered;
      const t = video.currentTime || 0;
      if (!b || b.length === 0) return 0;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t && t <= b.end(i)) return Math.max(0, b.end(i) - t);
      }
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > t) return Math.max(0, b.end(i) - t);
      }
      return 0;
    } catch (_) { return 0; }
  }

  // Bitrate estimate from the resolution tier (mirrors background.js).
  function bitrateBps(w, h) {
    const px = (w || 0) * (h || 0);
    if (px >= 3840 * 2000) return 25e6;
    if (px >= 2560 * 1300) return 12e6;
    if (px >= 1920 * 1000) return 6e6;
    if (px >= 1280 * 700) return 3e6;
    if (px > 0) return 1.5e6;
    return 0;
  }

  // Harmonic mean + EWMA blend, the way StreamGov estimates throughput.
  function estimateMbps(state) {
    const s = state.thrSamples.slice(-6);
    if (!s.length) return state.ewma;
    let inv = 0;
    for (const v of s) inv += 1 / Math.max(v, 0.05);
    const hm = s.length / inv;
    const est = state.ewma == null ? hm : 0.5 * hm + 0.5 * state.ewma;
    return Math.round(est * 10) / 10;
  }

  function classifyConnection(est, samples) {
    if (est == null) return "Unknown";
    if (est < 1.5) return "Poor";
    if (samples.length >= 4) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / samples.length);
      if (mean > 0 && sd / mean > 0.6) return "Variable";
    }
    return "Solid";
  }

  // --- Automatic stall prevention ("the engine") ---
  //
  // Three escalating, fully automatic interventions. All are conservative:
  // they engage only when a stall is actually imminent or happening, they
  // never fight the user's own pause/seek/speed choices, and the strongest
  // (reload) has strict cooldowns. The `autoRecover` setting and a per-site
  // OFF override both disable them entirely.

  const AUTO = {
    SPEED_RATE: 0.92,          // barely noticeable; lets the buffer catch up
    SPEED_ENGAGE_AHEAD: 3,     // s of buffer below which we ease off
    SPEED_RELEASE_AHEAD: 6,    // s of buffer at which full speed returns
    PAUSE_AHEAD: 1.2,          // s of buffer below which we pause to rebuild
    PAUSE_RESUME_AHEAD: 4,     // s of buffer at which we resume
    PAUSE_TIMEOUT_MS: 15000,   // give up waiting for buffer after this long
    STALL_CONFIRM_MS: 6000,    // no progress this long while wanting to play = real stall
    RELOAD_COOLDOWN_MS: 20000, // min gap between auto reloads
    RELOAD_WINDOW_MS: 300000,  // reload counting window
    RELOAD_MAX_PER_WINDOW: 2,  // max auto reloads per window
    MIN_WATCH_MS: 30000,       // don't auto-reload a video younger than this
  };

  // Cached autopilot settings (refreshed at most every 30s — never per tick).
  let cachedAuto = { autoRecover: true, disabledHosts: {} };
  let autoSettingsAt = 0;
  async function refreshAutoSettings() {
    const now = Date.now();
    if (now - autoSettingsAt < 30000) return;
    autoSettingsAt = now;
    try {
      const s = await chrome.storage.local.get({ autoRecover: true, armedOverrides: {} });
      cachedAuto = {
        autoRecover: s.autoRecover !== false,
        disabledHosts: s.armedOverrides || {},
      };
    } catch (_) { /* keep last known */ }
  }

  function notifyAuto(video, state, action, text) {
    try {
      chrome.runtime.sendMessage({
        type: "autopilot-auto-action",
        action, text,
        pageUrl: location.href,
      });
    } catch (_) { /* worker asleep — the HUD/popup still narrate locally */ }
  }

  // Reload just the video element (not the whole page): re-establishes a dead
  // stream while keeping page state. Only for plain URLs — never touch
  // blob:/MSE players, whose internals we don't own.
  function reloadVideoElement(video) {
    const src = currentSrc(video);
    if (!src || /^blob:/i.test(src)) return false;
    try {
      const t = video.currentTime || 0;
      video.src = src;
      video.load();
      const restore = () => {
        try {
          if (Number.isFinite(t) && t > 0 && t < (video.duration || Infinity)) {
            video.currentTime = Math.max(0, t - 0.5);
          }
        } catch (_) {}
        const p = video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      };
      if (video.readyState >= 1) restore();
      else video.addEventListener("loadedmetadata", restore, { once: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  function autoRecover(video, state, now) {
    const a = state.auto;
    const ct = video.currentTime || 0;
    if (ct > a.lastT + 0.01) { a.lastT = ct; a.lastProgressAt = now; }

    // kill-switches first
    if (!cachedAuto.autoRecover) return;
    if (cachedAuto.disabledHosts[location.hostname] === false) return;
    if (!video.isConnected) return;

    const playing = !video.paused && !video.ended && video.readyState >= 2;
    const ahead = state.bufferedAhead || 0;
    const br = bitrateBps(video.videoWidth, video.videoHeight) / 1e6;
    const lastThr = state.thrSamples.length ? state.thrSamples[state.thrSamples.length - 1] : null;
    const draining = lastThr != null && br > 0 && lastThr < br * 0.85;
    const live = !Number.isFinite(video.duration);
    const wantsToPlay = state.everPlayed && !video.paused && !video.ended;
    // Short clips can't hold 6s of buffer — scale thresholds to the media.
    const dur = video.duration;
    const speedRelease = Number.isFinite(dur) ? Math.min(AUTO.SPEED_RELEASE_AHEAD, dur * 0.75) : AUTO.SPEED_RELEASE_AHEAD;
    const pauseResume = Number.isFinite(dur) ? Math.min(AUTO.PAUSE_RESUME_AHEAD, dur * 0.7) : AUTO.PAUSE_RESUME_AHEAD;
    // Within a few seconds of the natural end there is no buffer left to
    // rebuild — slowing down or pausing there only delays the finish.
    // Scaled to the clip: a fixed 8s guard would permanently disable short
    // videos, so the tail zone is the last 20% (capped at 8s).
    const nearEnd = Number.isFinite(dur) && dur - ct > 0 && dur - ct < Math.min(8, dur * 0.2);

    // --- 1) gentle: ease playback speed so the buffer can catch up ---
    if (a.speedCut) {
      if (ahead >= speedRelease || !playing) {
        try {
          if (Math.abs(video.playbackRate - AUTO.SPEED_RATE) < 0.02) video.playbackRate = 1;
        } catch (_) {}
        a.speedCut = false;
        notifyAuto(video, state, "speed-restore", "Back to full speed — buffer recovered.");
      }
    } else if (
      !nearEnd &&
      playing && state.everPlayed && !a.userPaused &&
      Math.abs(video.playbackRate - 1) < 0.01 && // never override the user's own speed
      ahead < AUTO.SPEED_ENGAGE_AHEAD && ahead > AUTO.PAUSE_AHEAD && draining
    ) {
      try {
        video.playbackRate = AUTO.SPEED_RATE;
        a.speedCut = true;
        notifyAuto(video, state, "speed-cut", "Eased playback to 92% to rebuild buffer.");
      } catch (_) {}
    }

    // --- 2) medium: pause to rebuild a starving buffer (VOD only — pausing
    // --- live just adds delay instead of fixing anything) ---
    if (a.autoPaused) {
      const rebuilt = ahead >= pauseResume;
      if (rebuilt ||
          now - a.pauseStartedAt > AUTO.PAUSE_TIMEOUT_MS ||
          a.userTookOver) {
        a.autoPaused = false;
        const tookOver = a.userTookOver;
        a.userTookOver = false;
        if (rebuilt) {
          a.pauseFails = 0; // network cooperated — reset the backoff
        } else if (!tookOver) {
          // The buffer didn't rebuild: the network isn't cooperating.
          // Back off exponentially instead of thrashing pause/resume —
          // let the video play through and stall naturally for a while.
          a.pauseFails += 1;
          a.noPauseUntil = now + Math.min(120000, 15000 * a.pauseFails);
        }
        if (!a.userPaused && !tookOver) {
          const p = video.play();
          if (p && typeof p.then === "function") {
            p.then(() => {
              notifyAuto(video, state, "resume", rebuilt ? "Resumed — buffer rebuilt." : "Resumed — network too slow to pre-buffer.");
            }).catch(() => {
              a.stickyNote = "Tap play to resume";
              notifyAuto(video, state, "resume-blocked", "Couldn't auto-resume — tap play.");
            });
          }
        }
      }
    } else if (
      !live && !nearEnd && playing && state.everPlayed && !a.userPaused &&
      now >= a.noPauseUntil &&
      ahead <= AUTO.PAUSE_AHEAD && (draining || state.stallPredicted)
    ) {
      try {
        // Mark it BEFORE pausing: the pause event can fire synchronously,
        // and the handler must see this as our pause, not the user's.
        a.autoPaused = true;
        a.pauseStartedAt = now;
        video.pause();
        notifyAuto(video, state, "auto-pause", "Paused to rebuild buffer before a visible stall.");
      } catch (_) {}
    }

    // --- 3) last resort: the stall is real — reload the video element ---
    const stalled = wantsToPlay &&
      (now - a.lastProgressAt > AUTO.STALL_CONFIRM_MS) &&
      video.readyState < 3;
    if (stalled) {
      const recent = a.reloads.filter((t) => now - t < AUTO.RELOAD_WINDOW_MS);
      a.reloads = recent;
      const ageOk = now - a.watchedAt > AUTO.MIN_WATCH_MS;
      const gapOk = recent.length === 0 || now - recent[recent.length - 1] > AUTO.RELOAD_COOLDOWN_MS;
      if (recent.length < AUTO.RELOAD_MAX_PER_WINDOW && ageOk && gapOk) {
        if (reloadVideoElement(video)) {
          a.reloads.push(now);
          a.lastProgressAt = now; // give the fresh load a chance
          a.stickyNote = "";
          notifyAuto(video, state, "auto-reload", "Reloaded a stalled stream automatically.");
        }
      } else if (recent.length >= AUTO.RELOAD_MAX_PER_WINDOW) {
        a.stickyNote = "Still stuck — reload the page";
      }
    }

    // human-readable current action for HUD/popup narration
    if (a.autoPaused) state.autoAction = "Paused — rebuilding buffer…";
    else if (a.speedCut) state.autoAction = "Eased to 92% — rebuilding buffer…";
    else if (a.stickyNote) state.autoAction = a.stickyNote;
    else state.autoAction = "";
  }

  // Sampled every second: watches how fast the buffer fills to derive real
  // throughput, and predicts a stall while there's still time to act.
  function sampleBuffers() {
    const now = Date.now();
    refreshAutoSettings();
    for (const [video, state] of videos) {
      if (!video.isConnected) continue;
      const ahead = bufferedAhead(video);
      const ct = video.currentTime || 0;
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      const prev = state.lastBufSample;
      state.bufferedAhead = ahead;
      if (prev && playing) {
        const dt = (now - prev.t) / 1000;
        // If the whole video is already buffered there is nothing left to
        // download — a 0 B/s sample here would look like a dead network and
        // poison the drain detection. Skip sampling when the buffer is full.
        const bufferFull = Number.isFinite(video.duration) && ahead >= video.duration - ct - 0.5;
        // A seek (or loop wrap) moves the playhead discontinuously: the
        // buffer-ahead math then reads ~0 downloaded, which also looks like
        // a dead network. Skip sampling across discontinuities.
        const expectedAdvance = dt * (video.playbackRate || 1);
        const seekJump = Math.abs((ct - prev.ct) - expectedAdvance) > 2;
        // A throughput sample is only meaningful while the browser is
        // actively downloading. Before the fetch starts, after it finishes,
        // or while the browser is satisfied with its buffer, downloaded/sec
        // reads ~0 — a false "dead network" that then freezes, because
        // later ticks keep skipping while the buffer looks full.
        const netDownloading = video.networkState === video.NETWORK_LOADING;
        if (dt > 0.3 && dt < 5 && !bufferFull && !seekJump && netDownloading) {
          const br = bitrateBps(video.videoWidth, video.videoHeight);
          // video-seconds downloaded = buffer growth + what we played through
          const downloadedVideoSec = (ahead - prev.ahead) + (ct - prev.ct);
          if (br > 0 && downloadedVideoSec > -1) {
            const mbps = Math.max(0, (downloadedVideoSec / dt) * br / 1e6);
            if (mbps < 200) { // sanity cap against garbage samples
              state.thrSamples.push(mbps);
              if (state.thrSamples.length > 12) state.thrSamples.shift();
              state.ewma = state.ewma == null ? mbps : 0.7 * state.ewma + 0.3 * mbps;
            }
          }
        }
      }
      state.lastBufSample = { t: now, ahead, ct };
      // Stall prediction: playing, buffer nearly gone, downloading slower
      // than the current rendition needs. This is the governor's preempt.
      const lastThr = state.thrSamples.length ? state.thrSamples[state.thrSamples.length - 1] : 99;
      const curBrMbps = bitrateBps(video.videoWidth, video.videoHeight) / 1e6;
      state.stallPredicted = playing && state.everPlayed && ahead < 2 && lastThr < curBrMbps * 0.9;
      autoRecover(video, state, now);
    }
  }

  function currentSrc(video) {
    const src = video.currentSrc || video.src || "";
    // also check <source> children in case currentSrc is empty
    if (!src) {
      const s = video.querySelector("source[src]");
      return s ? s.getAttribute("src") : "";
    }
    return src;
  }

  function looksLikeHls(src) {
    return /\.m3u8(\?|#|$)/i.test(src || "");
  }

  function watch(video) {
    if (videos.has(video)) return;
    const state = {
      rebufferTimes: [],   // timestamps of "waiting" events while playing
      lastTime: 0,         // last sampled currentTime
      lastSampleAt: 0,     // when we last sampled currentTime
      advancing: false,    // currentTime is progressing between samples
      everPlayed: false,
      bufferedAhead: 0,    // seconds of video buffered ahead of the playhead
      thrSamples: [],      // recent passive throughput samples (Mbps)
      ewma: null,          // EWMA of throughput
      lastBufSample: null, // {t, ahead, ct} — feeds the throughput math
      stallPredicted: false,
      autoAction: "",      // human-readable current intervention ("" = none)
      auto: {
        lastT: 0,                 // last currentTime seen (progress tracking)
        lastProgressAt: Date.now(),
        watchedAt: Date.now(),
        speedCut: false,          // we eased playbackRate to 0.92
        autoPaused: false,        // we paused to rebuild the buffer
        pauseStartedAt: 0,
        pauseFails: 0,            // consecutive pauses that didn't rebuild
        noPauseUntil: 0,          // backoff deadline after failed pauses
        userPaused: false,        // user paused themselves — never fight it
        userTookOver: false,      // user seeked mid-recovery — hand control back
        reloads: [],              // timestamps of auto reloads (cooldown)
        stickyNote: "",           // persistent note, e.g. "tap play to resume"
      },
    };
    videos.set(video, state);

    video.addEventListener("playing", () => {
      state.everPlayed = true;
      state.auto.userPaused = false;
      state.auto.stickyNote = "";
      state.auto.lastProgressAt = Date.now();
      sendSummary();
    });
    video.addEventListener("play", () => {
      state.auto.userPaused = false;
      state.auto.stickyNote = "";
    });
    video.addEventListener("pause", () => {
      if (state.auto.autoPaused && !state.auto.userPaused) {
        // our own recovery pause — not the user
      } else {
        state.auto.userPaused = true;
        state.auto.autoPaused = false; // never auto-resume a user's own pause
        state.auto.stickyNote = "";
      }
      sendSummary();
    });
    video.addEventListener("seeking", () => {
      // user grabbed the controls mid-recovery — hand control back
      if (state.auto.autoPaused) {
        state.auto.autoPaused = false;
        state.auto.userTookOver = true;
      }
    });
    video.addEventListener("waiting", () => {
      // "waiting" fired while the user actually wanted playback = a stall.
      if (!video.paused && !video.ended) {
        state.rebufferTimes.push(Date.now());
        // keep the rolling window tidy
        const cutoff = Date.now() - REBUFFER_WINDOW_MS;
        state.rebufferTimes = state.rebufferTimes.filter((t) => t > cutoff);
        sendSummary();
      }
    });
    video.addEventListener("stalled", () => sendSummary());
    video.addEventListener("emptied", () => sendSummary());
  }

  function scan(root) {
    const scope = root || document;
    scope.querySelectorAll("video").forEach(watch);
  }

  // Watch for videos added later (single-page apps, lazy players).
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") watch(node);
        else if (node.querySelectorAll) node.querySelectorAll("video").forEach(watch);
      }
    }
  });

  function rebufferCount(state) {
    const cutoff = Date.now() - REBUFFER_WINDOW_MS;
    return state.rebufferTimes.filter((t) => t > cutoff).length;
  }

  function describe(video, state) {
    const now = Date.now();
    // "streaming active" = a video that is playing with network-driven
    // currentTime progression. A frozen currentTime means nothing is arriving.
    const progressing = state.lastSampleAt > 0
      ? (video.currentTime > state.lastTime + 0.01)
      : false;
    state.advancing = progressing;
    state.lastTime = video.currentTime;
    state.lastSampleAt = now;

    const playing = !video.paused && !video.ended && video.readyState >= 2;
    const src = currentSrc(video);
    const rb = rebufferCount(state);
    const est = estimateMbps(state);

    return {
      src: src.slice(0, 300),
      isHls: looksLikeHls(src),
      playing,
      // We treat any remote, progressing video as streaming. Progressive
      // downloads and live HLS both count — the health signals are the same.
      streamingActive: playing && progressing && state.everPlayed,
      rebufferCount: rb,
      struggling: rb >= REBUFFER_HARD_LIMIT,
      droppedFrames: getDroppedFrames(video),
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      duration: Number.isFinite(video.duration) ? Math.round(video.duration) : -1, // -1 = live/indefinite
      bufferedAheadS: Math.round((state.bufferedAhead || 0) * 10) / 10,
      throughputMbps: est,
      stallPredicted: !!state.stallPredicted,
      connectionClass: classifyConnection(est, state.thrSamples),
      autoAction: state.autoAction || "",
    };
  }

  function sendSummary() {
    if (videos.size === 0) return;
    const list = [];
    for (const [video, state] of videos) {
      // drop dead elements (removed from DOM)
      if (!video.isConnected) {
        videos.delete(video);
        continue;
      }
      list.push(describe(video, state));
    }
    if (list.length === 0) return;
    const streamingDetected = list.some((v) => v.streamingActive);
    const primary = list.find((v) => v.streamingActive) || list[0] || {};
    try {
      chrome.runtime.sendMessage({
        type: "autopilot-stream-summary",
        payload: {
          pageUrl: location.href,
          streamingDetected,
          struggling: list.some((v) => v.struggling),
          stallPredicted: list.some((v) => v.stallPredicted),
          estimatedMbps: primary.throughputMbps ?? null,
          connectionClass: primary.connectionClass || "Unknown",
          bufferedAheadS: primary.bufferedAheadS ?? 0,
          autoAction: primary.autoAction || "",
          videos: list,
        },
      });
    } catch (_) {
      // background worker may be asleep; it wakes on the next alarm/message.
    }
  }

  // Kick off
  scan(document);
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  setInterval(sendSummary, SUMMARY_INTERVAL_MS);
  setInterval(sampleBuffers, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sendSummary();
  });

  // Dashboard bridge: the Stream Autopilot dashboard page reads this for
  // REAL telemetry (never simulated). Refreshed from extension storage.
  setInterval(async () => {
    try {
      const { autopilotTelemetry = null } = await chrome.storage.local.get({ autopilotTelemetry: null });
      if (autopilotTelemetry) {
        window.__streamAutopilotTelemetry = autopilotTelemetry;
        window.dispatchEvent(new CustomEvent("stream-autopilot:telemetry", { detail: autopilotTelemetry }));
      }
    } catch (_) { /* storage unavailable */ }
  }, 5000);
})();
