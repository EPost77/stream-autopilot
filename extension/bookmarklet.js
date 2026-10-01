/* Stream Autopilot — one-click bookmarklet injector.
 *
 * Drag to your bookmarks bar, then click it on any streaming tab.
 * No install, no store, no signup. Self-contained: measures the video
 * passively (reads video.buffered / currentTime) and actively prevents
 * stalls — easing speed to rebuild buffer, pausing briefly to let a
 * starving buffer catch up, reloading a truly dead stream. Floating HUD,
 * zero chrome.* APIs so it runs anywhere a bookmarklet runs.
 *
 * Designed and created by EPoBuilds Studio & Jarvis — epobuilds@gmail.com
 */
(function __autopilotBookmarklet() {
  "use strict";

  // Clicking the bookmarklet again toggles the panel.
  if (window.__autopilotBM && typeof window.__autopilotBM.toggle === "function") {
    window.__autopilotBM.toggle();
    return;
  }

  var PANEL_ID = "__autopilotBMPanel";
  var REBUFFER_WINDOW_MS = 120000;
  var REBUFFER_HARD_LIMIT = 3;

  var videos = new Map();
  var running = true;
  var panelVisible = true;

  /* ---------- passive measurement (same math as the extension) ---------- */

  function bufferedAhead(video) {
    try {
      var b = video.buffered, t = video.currentTime || 0;
      if (!b || b.length === 0) return 0;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= t && t <= b.end(i)) return Math.max(0, b.end(i) - t);
      }
      for (var j = 0; j < b.length; j++) {
        if (b.start(j) > t) return Math.max(0, b.end(j) - t);
      }
      return 0;
    } catch (_) { return 0; }
  }

  function bitrateBps(w, h) {
    var px = (w || 0) * (h || 0);
    if (px >= 3840 * 2000) return 25e6;
    if (px >= 2560 * 1300) return 12e6;
    if (px >= 1920 * 1000) return 6e6;
    if (px >= 1280 * 700) return 3e6;
    if (px > 0) return 1.5e6;
    return 0;
  }

  function estimateMbps(state) {
    var s = state.thrSamples.slice(-6);
    if (!s.length) return state.ewma;
    var inv = 0, i;
    for (i = 0; i < s.length; i++) inv += 1 / Math.max(s[i], 0.05);
    var hm = s.length / inv;
    var est = state.ewma == null ? hm : 0.5 * hm + 0.5 * state.ewma;
    return Math.round(est * 10) / 10;
  }

  function classifyConnection(est, samples) {
    if (est == null) return "Unknown";
    if (est < 1.5) return "Poor";
    if (samples.length >= 4) {
      var mean = samples.reduce(function (a, b) { return a + b; }, 0) / samples.length;
      var sd = Math.sqrt(samples.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / samples.length);
      if (mean > 0 && sd / mean > 0.6) return "Variable";
    }
    return "Solid";
  }

  function getDroppedFrames(video) {
    try {
      if (typeof video.getVideoPlaybackQuality === "function") {
        var q = video.getVideoPlaybackQuality();
        if (q && typeof q.droppedVideoFrames === "number") return q.droppedVideoFrames;
      }
    } catch (_) {}
    if (typeof video.webkitDroppedFrameCount === "number") return video.webkitDroppedFrameCount;
    return 0;
  }

  function rebufferCount(state) {
    var cutoff = Date.now() - REBUFFER_WINDOW_MS;
    return state.rebufferTimes.filter(function (t) { return t > cutoff; }).length;
  }

  function watch(video) {
    if (videos.has(video)) return;
    var state = {
      rebufferTimes: [], everPlayed: false, bufferedAhead: 0,
      thrSamples: [], ewma: null, lastBufSample: null, stallPredicted: false,
      autoAction: "",
      auto: {
        lastT: 0, lastProgressAt: Date.now(), watchedAt: Date.now(),
        speedCut: false, autoPaused: false, pauseStartedAt: 0,
        pauseFails: 0, noPauseUntil: 0,
        userPaused: false, userTookOver: false,
        reloads: [], stickyNote: "",
      },
    };
    videos.set(video, state);
    video.addEventListener("playing", function () {
      state.everPlayed = true;
      state.auto.userPaused = false;
      state.auto.stickyNote = "";
      state.auto.lastProgressAt = Date.now();
    });
    video.addEventListener("play", function () {
      state.auto.userPaused = false;
      state.auto.stickyNote = "";
    });
    video.addEventListener("pause", function () {
      if (state.auto.autoPaused && !state.auto.userPaused) {
        // our own recovery pause — not the user
      } else {
        state.auto.userPaused = true;
        state.auto.autoPaused = false; // never auto-resume a user's own pause
        state.auto.stickyNote = "";
      }
    });
    video.addEventListener("seeking", function () {
      if (state.auto.autoPaused) {
        state.auto.autoPaused = false;
        state.auto.userTookOver = true;
      }
    });
    video.addEventListener("waiting", function () {
      if (!video.paused && !video.ended) {
        state.rebufferTimes.push(Date.now());
        var cutoff = Date.now() - REBUFFER_WINDOW_MS;
        state.rebufferTimes = state.rebufferTimes.filter(function (t) { return t > cutoff; });
      }
    });
  }

  function scan(root) {
    var scope = root || document;
    var list = scope.querySelectorAll ? scope.querySelectorAll("video") : [];
    for (var i = 0; i < list.length; i++) watch(list[i]);
  }

  var observer = null;
  try {
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === "VIDEO") watch(node);
          else if (node.querySelectorAll) {
            var vs = node.querySelectorAll("video");
            for (var k = 0; k < vs.length; k++) watch(vs[k]);
          }
        }
      }
    });
  } catch (_) {}

  function sampleBuffers() {
    var now = Date.now();
    videos.forEach(function (state, video) {
      if (!video.isConnected) { videos.delete(video); return; }
      var ahead = bufferedAhead(video);
      var ct = video.currentTime || 0;
      var playing = !video.paused && !video.ended && video.readyState >= 2;
      var prev = state.lastBufSample;
      state.bufferedAhead = ahead;
      if (prev && playing) {
        var dt = (now - prev.t) / 1000;
        var bufferFull = isFinite(video.duration) && ahead >= video.duration - ct - 0.5;
        // A seek (or loop wrap) moves the playhead discontinuously: the
        // buffer-ahead math then reads ~0 downloaded, which also looks like
        // a dead network. Skip sampling across discontinuities.
        var expectedAdvance = dt * (video.playbackRate || 1);
        var seekJump = Math.abs((ct - prev.ct) - expectedAdvance) > 2;
        // A throughput sample is only meaningful while the browser is
        // actively downloading. Before the fetch starts, after it finishes,
        // or while the browser is satisfied with its buffer, downloaded/sec
        // reads ~0 — a false "dead network" that then freezes, because
        // later ticks keep skipping while the buffer looks full.
        var netDownloading = video.networkState === video.NETWORK_LOADING;
        if (dt > 0.3 && dt < 5 && !bufferFull && !seekJump && netDownloading) {
          var br = bitrateBps(video.videoWidth, video.videoHeight);
          var downloadedVideoSec = (ahead - prev.ahead) + (ct - prev.ct);
          if (br > 0 && downloadedVideoSec > -1) {
            var mbps = Math.max(0, (downloadedVideoSec / dt) * br / 1e6);
            if (mbps < 200) {
              state.thrSamples.push(mbps);
              if (state.thrSamples.length > 12) state.thrSamples.shift();
              state.ewma = state.ewma == null ? mbps : 0.7 * state.ewma + 0.3 * mbps;
            }
          }
        }
      }
      state.lastBufSample = { t: now, ahead: ahead, ct: ct };
      var lastThr = state.thrSamples.length ? state.thrSamples[state.thrSamples.length - 1] : 99;
      var curBrMbps = bitrateBps(video.videoWidth, video.videoHeight) / 1e6;
      state.stallPredicted = playing && state.everPlayed && ahead < 2 && lastThr < curBrMbps * 0.9;
    });
  }

  /* ---------- automatic stall prevention ---------- */
  /* Same three escalating interventions as the extension: ease speed,
     pause to rebuild, reload a dead stream. Never fights the user. */

  var AUTO = {
    SPEED_RATE: 0.92,
    SPEED_ENGAGE_AHEAD: 3,
    SPEED_RELEASE_AHEAD: 6,
    PAUSE_AHEAD: 1.2,
    PAUSE_RESUME_AHEAD: 4,
    PAUSE_TIMEOUT_MS: 15000,
    STALL_CONFIRM_MS: 6000,
    RELOAD_COOLDOWN_MS: 20000,
    RELOAD_WINDOW_MS: 300000,
    RELOAD_MAX_PER_WINDOW: 2,
    MIN_WATCH_MS: 30000,
  };

  function currentSrc(video) {
    var src = video.currentSrc || video.src || "";
    if (!src) {
      var s = video.querySelector("source[src]");
      return s ? s.getAttribute("src") : "";
    }
    return src;
  }

  function reloadVideoElement(video) {
    var src = currentSrc(video);
    if (!src || /^blob:/i.test(src)) return false;
    try {
      var t = video.currentTime || 0;
      video.src = src;
      video.load();
      var restore = function () {
        try {
          if (isFinite(t) && t > 0 && t < (video.duration || Infinity)) {
            video.currentTime = Math.max(0, t - 0.5);
          }
        } catch (_) {}
        try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
      };
      if (video.readyState >= 1) restore();
      else video.addEventListener("loadedmetadata", restore, { once: true });
      return true;
    } catch (_) { return false; }
  }

  function autoRecover(video, state, now) {
    var a = state.auto;
    var ct = video.currentTime || 0;
    if (ct > a.lastT + 0.01) { a.lastT = ct; a.lastProgressAt = now; }
    if (!video.isConnected) return;

    var playing = !video.paused && !video.ended && video.readyState >= 2;
    var ahead = state.bufferedAhead || 0;
    var br = bitrateBps(video.videoWidth, video.videoHeight) / 1e6;
    var lastThr = state.thrSamples.length ? state.thrSamples[state.thrSamples.length - 1] : null;
    var draining = lastThr != null && br > 0 && lastThr < br * 0.85;
    var live = !isFinite(video.duration);
    var wantsToPlay = state.everPlayed && !video.paused && !video.ended;
    var dur = video.duration;
    var speedRelease = isFinite(dur) ? Math.min(AUTO.SPEED_RELEASE_AHEAD, dur * 0.75) : AUTO.SPEED_RELEASE_AHEAD;
    var pauseResume = isFinite(dur) ? Math.min(AUTO.PAUSE_RESUME_AHEAD, dur * 0.7) : AUTO.PAUSE_RESUME_AHEAD;
    // Within a few seconds of the natural end there is no buffer left to
    // rebuild — slowing down or pausing there only delays the finish.
    // Scaled to the clip: a fixed 8s guard would permanently disable short
    // videos, so the tail zone is the last 20% (capped at 8s).
    var nearEnd = isFinite(dur) && dur - ct > 0 && dur - ct < Math.min(8, dur * 0.2);

    if (a.speedCut) {
      if (ahead >= speedRelease || !playing) {
        try {
          if (Math.abs(video.playbackRate - AUTO.SPEED_RATE) < 0.02) video.playbackRate = 1;
        } catch (_) {}
        a.speedCut = false;
      }
    } else if (
      !nearEnd &&
      playing && state.everPlayed && !a.userPaused &&
      Math.abs(video.playbackRate - 1) < 0.01 &&
      ahead < AUTO.SPEED_ENGAGE_AHEAD && ahead > AUTO.PAUSE_AHEAD && draining
    ) {
      try { video.playbackRate = AUTO.SPEED_RATE; a.speedCut = true; } catch (_) {}
    }

    if (a.autoPaused) {
      var rebuilt = ahead >= pauseResume;
      if (rebuilt ||
          now - a.pauseStartedAt > AUTO.PAUSE_TIMEOUT_MS ||
          a.userTookOver) {
        a.autoPaused = false;
        var tookOver = a.userTookOver;
        a.userTookOver = false;
        if (rebuilt) {
          a.pauseFails = 0;
        } else if (!tookOver) {
          // buffer didn't rebuild — back off so we don't thrash
          a.pauseFails += 1;
          a.noPauseUntil = now + Math.min(120000, 15000 * a.pauseFails);
        }
        if (!a.userPaused && !tookOver) {
          try {
            var p = video.play();
            if (p && p.then) {
              p.then(function () {}, function () { a.stickyNote = "Tap play to resume"; });
            }
          } catch (_) {}
        }
      }
    } else if (
      !live && !nearEnd && playing && state.everPlayed && !a.userPaused &&
      now >= a.noPauseUntil &&
      ahead <= AUTO.PAUSE_AHEAD && (draining || state.stallPredicted)
    ) {
      // Mark BEFORE pausing: the pause event can fire synchronously, and the
      // handler must see this as our pause, not the user's.
      try { a.autoPaused = true; a.pauseStartedAt = now; video.pause(); } catch (_) {}
    }

    var stalled = wantsToPlay &&
      (now - a.lastProgressAt > AUTO.STALL_CONFIRM_MS) &&
      video.readyState < 3;
    if (stalled) {
      var recent = a.reloads.filter(function (t) { return now - t < AUTO.RELOAD_WINDOW_MS; });
      a.reloads = recent;
      var ageOk = now - a.watchedAt > AUTO.MIN_WATCH_MS;
      var gapOk = recent.length === 0 || now - recent[recent.length - 1] > AUTO.RELOAD_COOLDOWN_MS;
      if (recent.length < AUTO.RELOAD_MAX_PER_WINDOW && ageOk && gapOk) {
        if (reloadVideoElement(video)) {
          a.reloads.push(now);
          a.lastProgressAt = now;
          a.stickyNote = "";
        }
      } else if (recent.length >= AUTO.RELOAD_MAX_PER_WINDOW) {
        a.stickyNote = "Still stuck — reload the page";
      }
    }

    if (a.autoPaused) state.autoAction = "⏸ Paused — rebuilding buffer…";
    else if (a.speedCut) state.autoAction = "⚡ Eased to 92% — rebuilding buffer…";
    else if (a.stickyNote) state.autoAction = a.stickyNote;
    else state.autoAction = "";
  }

  /* ---------- floating HUD ---------- */

  function el(tag, style, html) {
    var d = document.createElement(tag);
    d.setAttribute("style", style);
    if (html != null) d.innerHTML = html;
    return d;
  }

  var BASE = "box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;";
  var panel = el("div",
    BASE + "position:fixed;right:14px;bottom:14px;width:248px;z-index:2147483647;" +
    "background:#121826;border:1px solid #1f2940;border-radius:14px;color:#e6ebf5;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12px;overflow:hidden;");
  panel.id = PANEL_ID;

  var dotColors = { on: "#34d399", off: "#69748a" };
  var dot = el("span",
    "display:inline-block;width:8px;height:8px;border-radius:50%;background:" + dotColors.on + ";" +
    "animation:__apBlink 1.6s infinite;");
  var styleTag = el("style", "", "@keyframes __apBlink{0%,100%{opacity:1}50%{opacity:.35}}");
  document.head.appendChild(styleTag);

  var head = el("div",
    BASE + "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1f2940;");
  head.appendChild(dot);
  var title = el("span", BASE + "font-weight:700;letter-spacing:.08em;font-size:11px;", "⚡ AUTOPILOT");
  head.appendChild(title);
  var liveTag = el("span",
    BASE + "margin-left:auto;font-size:10px;color:#34d399;font-weight:700;", "LIVE");
  head.appendChild(liveTag);
  var closeBtn = el("button",
    BASE + "background:none;border:none;color:#69748a;font-size:14px;cursor:pointer;padding:0 2px;", "×");
  closeBtn.title = "Hide panel (bookmarklet keeps running; click it again to bring back)";
  closeBtn.onclick = function () { togglePanel(); };
  head.appendChild(closeBtn);
  panel.appendChild(head);

  var body = el("div", BASE + "padding:10px 12px;");
  panel.appendChild(body);

  var bigRow = el("div", BASE + "display:flex;align-items:baseline;gap:8px;");
  var mbpsEl = el("span", BASE + "font-size:26px;font-weight:800;color:#22d3ee;", "—");
  var unitEl = el("span", BASE + "font-size:11px;color:#69748a;", "Mbps");
  var classBadge = el("span",
    BASE + "margin-left:auto;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;" +
    "background:#1f2940;color:#9aa7c2;", "…");
  bigRow.appendChild(mbpsEl); bigRow.appendChild(unitEl); bigRow.appendChild(classBadge);
  body.appendChild(bigRow);

  var bufLabel = el("div", BASE + "margin-top:8px;font-size:10px;color:#69748a;", "BUFFER AHEAD");
  var bufBar = el("div", BASE + "height:6px;background:#1f2940;border-radius:4px;margin-top:4px;overflow:hidden;");
  var bufFill = el("div", BASE + "height:100%;width:0%;background:#22d3ee;border-radius:4px;transition:width .5s;");
  bufBar.appendChild(bufFill);
  var bufTxt = el("div", BASE + "margin-top:3px;font-size:11px;color:#e6ebf5;", "—");
  body.appendChild(bufLabel); body.appendChild(bufBar); body.appendChild(bufTxt);

  var statsRow = el("div",
    BASE + "display:flex;gap:12px;margin-top:8px;font-size:11px;color:#9aa7c2;");
  var rbEl = el("span", "", "Rebuffers: <b style='color:#e6ebf5'>0</b>");
  var dfEl = el("span", "", "Dropped: <b style='color:#e6ebf5'>0</b>");
  statsRow.appendChild(rbEl); statsRow.appendChild(dfEl);
  body.appendChild(statsRow);

  var statusEl = el("div", BASE + "margin-top:8px;font-size:11px;min-height:16px;color:#9aa7c2;", "");
  body.appendChild(statusEl);

  var reloadBtn = el("button",
    BASE + "display:none;width:100%;margin-top:8px;padding:8px;border:none;border-radius:9px;cursor:pointer;" +
    "background:#22d3ee;color:#06222a;font-weight:700;font-size:12px;", "↻ Reload stream");
  reloadBtn.onclick = function () { location.reload(); };
  body.appendChild(reloadBtn);

  var foot = el("div",
    BASE + "padding:8px 12px;border-top:1px solid #1f2940;font-size:10px;color:#69748a;",
    "EPoBuilds Studio &amp; Jarvis");
  panel.appendChild(foot);

  function classColor(c) {
    if (c === "Solid") return ["#34d399", "rgba(52,211,153,.12)"];
    if (c === "Variable") return ["#fbbf24", "rgba(251,191,36,.12)"];
    if (c === "Poor") return ["#ef4444", "rgba(239,68,68,.12)"];
    return ["#9aa7c2", "#1f2940"];
  }

  function render() {
    if (!panelVisible) return;
    var list = [];
    videos.forEach(function (state, video) {
      if (!video.isConnected) { videos.delete(video); return; }
      var playing = !video.paused && !video.ended && video.readyState >= 2;
      list.push({ video: video, state: state, playing: playing });
    });
    if (!list.length) {
      mbpsEl.textContent = "—"; classBadge.textContent = "NO VIDEO";
      bufTxt.textContent = "No video on this page yet — play a stream.";
      bufFill.style.width = "0%";
      statusEl.textContent = "";
      reloadBtn.style.display = "none";
      rbEl.innerHTML = "Rebuffers: <b style='color:#e6ebf5'>0</b>";
      dfEl.innerHTML = "Dropped: <b style='color:#e6ebf5'>0</b>";
      return;
    }
    var primary = null, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].playing && list[i].state.everPlayed) { primary = list[i]; break; }
    }
    if (!primary) primary = list[0];
    var st = primary.state, v = primary.video;
    var est = estimateMbps(st);
    var cls = classifyConnection(est, st.thrSamples);
    var cc = classColor(cls);
    mbpsEl.textContent = est == null ? "—" : est;
    classBadge.textContent = cls.toUpperCase();
    classBadge.setAttribute("style",
      BASE + "margin-left:auto;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;" +
      "color:" + cc[0] + ";background:" + cc[1] + ";");
    var ahead = st.bufferedAhead || 0;
    bufTxt.textContent = ahead.toFixed(1) + "s buffered";
    bufFill.style.width = Math.min(100, ahead / 20 * 100) + "%";
    bufFill.style.background = ahead < 2 ? "#ef4444" : ahead < 6 ? "#fbbf24" : "#22d3ee";
    var rb = rebufferCount(st);
    rbEl.innerHTML = "Rebuffers: <b style='color:#e6ebf5'>" + rb + "</b>";
    dfEl.innerHTML = "Dropped: <b style='color:#e6ebf5'>" + getDroppedFrames(v) + "</b>";
    var struggling = rb >= REBUFFER_HARD_LIMIT;
    if (st.autoAction) {
      statusEl.innerHTML = "<span style='color:#22d3ee'>" + st.autoAction + "</span>";
    } else if (st.stallPredicted) {
      statusEl.innerHTML = "<span style='color:#fbbf24'>▲ Stall risk — buffer almost gone</span>";
    } else if (struggling) {
      statusEl.innerHTML = "<span style='color:#ef4444'>● Stream struggling — reload may help</span>";
    } else if (primary.playing) {
      statusEl.innerHTML = "<span style='color:#34d399'>● Stream healthy</span>";
    } else {
      statusEl.textContent = "Video found — press play.";
    }
    reloadBtn.style.display = (struggling || st.stallPredicted) ? "block" : "none";
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
    if (panelVisible) render();
  }

  // public handle for re-click toggle
  window.__autopilotBM = { toggle: togglePanel };

  document.body.appendChild(panel);

  scan(document);
  if (observer && document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  setInterval(function () {
    if (!running) return;
    sampleBuffers();
    var now = Date.now();
    videos.forEach(function (state, video) { autoRecover(video, state, now); });
    render();
  }, 1000);
  render();
})();
