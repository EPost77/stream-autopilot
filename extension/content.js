// content.js — runs in every page (all frames). Watches <video> elements,
// tracks playback health, and reports summaries to the background service
// worker. It never touches page data beyond video playback stats and never
// blocks or modifies network requests.

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

  // Sampled every second: watches how fast the buffer fills to derive real
  // throughput, and predicts a stall while there's still time to act.
  function sampleBuffers() {
    const now = Date.now();
    for (const [video, state] of videos) {
      if (!video.isConnected) continue;
      const ahead = bufferedAhead(video);
      const ct = video.currentTime || 0;
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      const prev = state.lastBufSample;
      state.bufferedAhead = ahead;
      if (prev && playing) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0.3 && dt < 5) {
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
    };
    videos.set(video, state);

    video.addEventListener("playing", () => {
      state.everPlayed = true;
      sendSummary();
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
    video.addEventListener("pause", () => sendSummary());
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
