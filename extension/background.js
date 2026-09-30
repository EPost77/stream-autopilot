// background.js — service worker for Stream Autopilot.
//
// What it does:
//  - Keeps per-tab autopilot state (armed / streaming detected / struggling).
//  - Arms autopilot automatically: immediately on favorited sites with
//    auto-start, or when a stream is detected anywhere else (auto-detect).
//  - Every few minutes, reports stream health to the Autopilot API.
//  - Fetches remote tuning config once at startup.
//
// Honest limits (also stated in the UI): true "server hopping" only works on
// sites that expose selectable stream edges/servers. On generic sites the
// extension monitors stream health, reports it to your API, shows the fastest
// known edge for your region, and offers a one-click stream reload when
// buffering won't quit. It cannot force YouTube/Twitch onto another CDN.

"use strict";

const HEALTH_ALARM = "autopilot-health-report";
const DEFAULT_REPORT_MINUTES = 5;
const CREDIT_LINE = "Designed and created by EPoBuilds Studio & Jarvis";

// In-memory per-tab state. The service worker can be stopped and restarted
// by the browser at any time; content scripts re-send summaries every few
// seconds, so state rebuilds itself quickly. Nothing here is precious.
const tabState = new Map(); // tabId -> {armed, streamingDetected, struggling, rebuffers, droppedFrames, pageUrl, hlsDetected, updatedAt}

function freshTabState() {
  return {
    armed: false,
    streamingDetected: false,
    struggling: false,
    rebuffers: 0,
    droppedFrames: 0,
    resolution: { w: 0, h: 0 }, // largest video seen; feeds the bitrate estimate
    pageUrl: "",
    hlsDetected: false,
    estimatedMbps: null,
    connectionClass: "Unknown",
    stallPredicted: false,
    bufferedAheadS: 0,
    qualityTier: "",
    switches: 0,          // detected quality-tier changes
    stallsPrevented: 0,   // predicted stalls that never materialized
    predictedAt: 0,       // when the current stall prediction started
    updatedAt: Date.now(),
  };
}

function getTabState(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = freshTabState();
    tabState.set(tabId, s);
  }
  return s;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

/* ---------------- settings & storage ---------------- */

async function getSettings() {
  const s = await chrome.storage.local.get({
    apiBaseUrl: "",
    apiKey: "",
    region: "us",
    autoDetect: true,
    reportMinutes: DEFAULT_REPORT_MINUTES,
  });
  s.apiBaseUrl = (s.apiBaseUrl || "").replace(/\/+$/, ""); // no trailing slash
  return s;
}

async function getFavorites() {
  const { favorites = [] } = await chrome.storage.local.get({ favorites: [] });
  // favorite: {name, url, autoStart}
  return Array.isArray(favorites) ? favorites : [];
}

async function getArmedOverrides() {
  const { armedOverrides = {} } = await chrome.storage.local.get({ armedOverrides: {} });
  return armedOverrides || {};
}

function apiConfigured(settings) {
  return Boolean(settings.apiBaseUrl && settings.apiKey);
}

async function apiFetch(path, { method = "GET", body = null } = {}) {
  const settings = await getSettings();
  if (!apiConfigured(settings)) {
    throw new Error("API not configured — set the base URL and key in settings.");
  }
  const res = await fetch(settings.apiBaseUrl + path, {
    method,
    headers: {
      "X-API-Key": settings.apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  if (res.status === 202) return {};
  return res.json();
}

/* ---------------- remote tuning config ---------------- */

async function refreshConfig() {
  try {
    const { config } = await apiFetch("/config");
    await chrome.storage.local.set({ autopilotConfig: config || {}, configFetchedAt: Date.now() });
    return config || {};
  } catch (_) {
    return null; // offline or unconfigured — keep last cached copy
  }
}

async function getConfig() {
  const { autopilotConfig = {} } = await chrome.storage.local.get({ autopilotConfig: {} });
  return autopilotConfig;
}

/* ---------------- arming logic ---------------- */

async function evaluateArming(tabId, url) {
  const state = getTabState(tabId);
  const host = hostnameOf(url);
  if (!host) return;

  const [favorites, overrides, settings] = await Promise.all([
    getFavorites(), getArmedOverrides(), getSettings(),
  ]);

  if (host in overrides) {
    // Manual per-site toggle from the popup always wins.
    state.armed = Boolean(overrides[host]);
    return;
  }
  const fav = favorites.find((f) => hostnameOf(f.url) === host);
  if (fav && fav.autoStart) {
    state.armed = true; // favorite with auto-start: armed before the stream even loads
    return;
  }
  // Otherwise leave whatever auto-detect decides; a fresh navigation starts disarmed.
  if (!settings.autoDetect) state.armed = false;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const state = getTabState(tabId);
    // New page: reset stream signals, re-evaluate arming.
    state.streamingDetected = false;
    state.struggling = false;
    state.rebuffers = 0;
    state.droppedFrames = 0;
    state.resolution = { w: 0, h: 0 };
    state.estimatedMbps = null;
    state.connectionClass = "Unknown";
    state.stallPredicted = false;
    state.bufferedAheadS = 0;
    state.qualityTier = "";
    state.predictedAt = 0;
    state.hlsDetected = false;
    state.pageUrl = changeInfo.url;
    updateBadge(tabId);
    evaluateArming(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  persistTelemetry();
});

/* ---------------- HLS detection (observe only — never blocks) ---------------- */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId >= 0 && /\.m3u8(\?|#|$)/i.test(details.url || "")) {
      getTabState(details.tabId).hlsDetected = true;
    }
    // No blocking, no redirect — pure observation.
  },
  { urls: ["http://*/*", "https://*/*"] }
);

/* ---------------- stream summaries from content scripts ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "autopilot-stream-summary") return false;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return false;

  (async () => {
    const settings = await getSettings();
    const state = getTabState(tabId);
    const prevRebuffers = state.rebuffers;
    const prevPredicted = state.stallPredicted;
    const prevTier = state.qualityTier;
    const p = msg.payload || {};
    state.pageUrl = p.pageUrl || state.pageUrl;
    state.streamingDetected = Boolean(p.streamingDetected);
    state.struggling = Boolean(p.struggling);
    state.rebuffers = Math.max(0, ...(p.videos || []).map((v) => v.rebufferCount || 0));
    state.droppedFrames = (p.videos || []).reduce((a, v) => a + (v.droppedFrames || 0), 0);
    // keep the biggest video's resolution for the bitrate estimate
    for (const v of p.videos || []) {
      const px = (v.width || 0) * (v.height || 0);
      const cur = state.resolution.w * state.resolution.h;
      if (px > cur) state.resolution = { w: v.width || 0, h: v.height || 0 };
    }
    state.estimatedMbps = p.estimatedMbps ?? null;
    state.connectionClass = p.connectionClass || "Unknown";
    state.stallPredicted = Boolean(p.stallPredicted);
    state.bufferedAheadS = Number(p.bufferedAheadS) || 0;

    // --- governor transitions: a real StreamGov-style event log ---
    const host = esc(hostnameOf(state.pageUrl) || "this site");
    const tier = qualityLabel(state.resolution.w, state.resolution.h);
    if (state.rebuffers > prevRebuffers) {
      await logEvent("bad", `<b>Rebuffer</b> on ${host} — playback stalled (${state.rebuffers} in the last 2 min).`);
      state.predictedAt = 0; // a real stall ends the prediction window
    }
    if (state.stallPredicted && !prevPredicted) {
      const thr = state.estimatedMbps != null ? state.estimatedMbps.toFixed(1) + " Mbps" : "unknown throughput";
      await logEvent("info", `<b>Stall predicted</b> on ${host} — only ${state.bufferedAheadS.toFixed(1)}s buffered at ${thr}.`);
      state.predictedAt = Date.now();
    }
    if (!state.stallPredicted && prevPredicted && state.predictedAt &&
        Date.now() - state.predictedAt < 45000 && state.rebuffers === prevRebuffers) {
      state.stallsPrevented += 1;
      await logEvent("good", `<b>Stall prevented</b> on ${host} — the predicted stall never happened.`);
      state.predictedAt = 0;
    }
    if (tier && tier !== prevTier) {
      state.switches += 1;
      await logEvent("info", `Quality change on ${host}: <b>${prevTier || "unknown"} → ${tier}</b>.`);
    }
    state.qualityTier = tier;
    await persistTelemetry();

    state.updatedAt = Date.now();

    // Auto-detect: a live stream appeared on a non-favorited page.
    if (state.streamingDetected && !state.armed && settings.autoDetect) {
      const host = hostnameOf(state.pageUrl);
      const overrides = await getArmedOverrides();
      if (!(host in overrides) || overrides[host]) {
        state.armed = true;
      }
    }
    updateBadge(tabId);
  })();
  return false;
});

function updateBadge(tabId) {
  const state = tabState.get(tabId);
  if (!state) return;
  if (state.struggling && state.armed) {
    chrome.action.setBadgeText({ tabId, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#e8833a" });
  } else if (state.armed && state.streamingDetected) {
    chrome.action.setBadgeText({ tabId, text: "ON" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e7d46" });
  } else if (state.armed) {
    chrome.action.setBadgeText({ tabId, text: "•" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#5a6b8c" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
}

/* ---------------- health reporting ---------------- */

// Browsers don't expose measured bitrate to extensions, so we estimate from
// the resolution tier. Labeled "estimated" everywhere it surfaces.
function estimateBitrateKbps(width, height) {
  const pixels = (width || 0) * (height || 0);
  if (pixels >= 3840 * 2000) return 25000; // ~4K
  if (pixels >= 2560 * 1300) return 12000; // ~1440p
  if (pixels >= 1920 * 1000) return 6000;  // ~1080p
  if (pixels >= 1280 * 700) return 3000;   // ~720p
  if (pixels > 0) return 1500;             // ~480p and below
  return 0; // unknown resolution
}

async function measurePingMs() {
  const settings = await getSettings();
  if (!apiConfigured(settings)) return 0;
  const t0 = performance.now();
  try {
    await fetch(settings.apiBaseUrl + "/ping", { cache: "no-store" });
    return Math.round(performance.now() - t0);
  } catch (_) {
    return 0;
  }
}

async function reportHealth() {
  const settings = await getSettings();
  if (!apiConfigured(settings)) return; // nothing to report to — stay quiet

  const armedTabs = [...tabState.entries()].filter(
    ([, s]) => s.armed && s.streamingDetected
  );
  if (armedTabs.length === 0) return;

  const pingMs = await measurePingMs();

  for (const [tabId, state] of armedTabs) {
    const payload = {
      region: settings.region || "us",
      bitrate_kbps: estimateBitrateKbps(state.resolution.w, state.resolution.h),
      dropped_frames: state.droppedFrames,
      ping_ms: pingMs,
    };
    try {
      await apiFetch("/health", { method: "POST", body: payload });
      state.lastHealth = Date.now();
    } catch (_) {
      // API down or key bad — try again next cycle, don't spam.
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) reportHealth();
});

async function ensureHealthAlarm() {
  const settings = await getSettings();
  const minutes = Math.max(1, Number(settings.reportMinutes) || DEFAULT_REPORT_MINUTES);
  await chrome.alarms.clear(HEALTH_ALARM);
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: minutes });
}

chrome.runtime.onStartup.addListener(() => {
  refreshConfig();
  ensureHealthAlarm();
});
chrome.runtime.onInstalled.addListener(() => {
  refreshConfig();
  ensureHealthAlarm();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.reportMinutes) ensureHealthAlarm();
});

/* ---------------- governor event log + dashboard telemetry ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function qualityLabel(w, h) {
  const px = (w || 0) * (h || 0);
  if (px >= 3840 * 2000) return "2160p";
  if (px >= 2560 * 1300) return "1440p";
  if (px >= 1920 * 1000) return "1080p";
  if (px >= 1280 * 700) return "720p";
  if (px > 0) return "480p";
  return "";
}

// Ring buffer of human-readable governor events (cap 50), newest last.
async function logEvent(kind, html) {
  try {
    const { autopilotEvents = [] } = await chrome.storage.local.get({ autopilotEvents: [] });
    autopilotEvents.push({ t: Date.now(), kind, html });
    while (autopilotEvents.length > 50) autopilotEvents.shift();
    await chrome.storage.local.set({ autopilotEvents });
  } catch (_) { /* storage unavailable */ }
}

// Snapshot the dashboard page reads via window.__streamAutopilotTelemetry.
// Everything here is measured — never simulated.
async function persistTelemetry() {
  try {
    const { autopilotEvents = [] } = await chrome.storage.local.get({ autopilotEvents: [] });
    const streaming = [...tabState.values()].filter((s) => s.armed && s.streamingDetected);
    const primary = streaming.find((s) => s.estimatedMbps != null) || streaming[0] || null;
    const totalRebuffers = streaming.reduce((a, s) => a + (s.rebuffers || 0), 0);
    const totalPrevented = [...tabState.values()].reduce((a, s) => a + (s.stallsPrevented || 0), 0);
    const totalSwitches = [...tabState.values()].reduce((a, s) => a + (s.switches || 0), 0);
    await chrome.storage.local.set({
      autopilotTelemetry: {
        updatedAt: Date.now(),
        streaming: streaming.length > 0,
        connectionClass: (primary && primary.connectionClass) || "Unknown",
        estimatedMbps: primary && primary.estimatedMbps != null
          ? Math.round(primary.estimatedMbps * 10) / 10 : null,
        bufferedAheadS: primary && primary.bufferedAheadS != null
          ? Math.round(primary.bufferedAheadS * 10) / 10 : null,
        quality: (primary && primary.qualityTier) || "—",
        stats: {
          rebuffers: totalRebuffers,
          stallsPrevented: totalPrevented,
          switches: totalSwitches,
        },
        tabs: streaming.map((s) => ({
          host: hostnameOf(s.pageUrl),
          quality: s.qualityTier || "—",
          rebuffers: s.rebuffers || 0,
          struggling: !!s.struggling,
        })),
        events: autopilotEvents.slice(-20).reverse(), // newest first
      },
    });
  } catch (_) { /* storage unavailable */ }
}

/* ---------------- popup API ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const tabId = (sender.tab && sender.tab.id) ?? msg.tabId;

  (async () => {
    switch (msg.type) {
      case "autopilot-get-tab-state": {
        const state = getTabState(tabId);
        const settings = await getSettings();
        const config = await getConfig();
        sendResponse({
          ok: true,
          state: { ...state },
          host: hostnameOf(state.pageUrl),
          configured: apiConfigured(settings),
          region: settings.region,
          config,
          credit: CREDIT_LINE,
        });
        break;
      }
      case "autopilot-toggle-armed": {
        // Manual per-site override — persists across visits.
        const state = getTabState(tabId);
        const host = hostnameOf(state.pageUrl);
        const overrides = await getArmedOverrides();
        const next = !state.armed;
        if (host) {
          overrides[host] = next;
          await chrome.storage.local.set({ armedOverrides: overrides });
        }
        state.armed = next;
        updateBadge(tabId);
        sendResponse({ ok: true, armed: next });
        break;
      }
      case "autopilot-get-settings": {
        const settings = await getSettings();
        sendResponse({ ok: true, settings, credit: CREDIT_LINE });
        break;
      }
      case "autopilot-save-settings": {
        const s = msg.settings || {};
        await chrome.storage.local.set({
          apiBaseUrl: (s.apiBaseUrl || "").trim(),
          apiKey: (s.apiKey || "").trim(),
          region: (s.region || "us").trim().toLowerCase(),
          autoDetect: s.autoDetect !== false,
          reportMinutes: Math.max(1, Number(s.reportMinutes) || DEFAULT_REPORT_MINUTES),
        });
        await ensureHealthAlarm();
        refreshConfig();
        sendResponse({ ok: true });
        break;
      }
      case "autopilot-test-ping": {
        try {
          const t0 = performance.now();
          const data = await apiFetch("/ping");
          sendResponse({ ok: true, ms: Math.round(performance.now() - t0), data });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "autopilot-get-edges": {
        try {
          const settings = await getSettings();
          const region = (msg.region || settings.region || "us").trim().toLowerCase();
          const data = await apiFetch(`/edge-servers?region=${encodeURIComponent(region)}`);
          sendResponse({ ok: true, region: data.region, servers: data.servers || [] });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "autopilot-get-favorites": {
        sendResponse({ ok: true, favorites: await getFavorites() });
        break;
      }
      case "autopilot-add-favorite": {
        const favs = await getFavorites();
        const f = msg.favorite || {};
        const host = hostnameOf(f.url || "");
        if (!host) { sendResponse({ ok: false, error: "That URL doesn't look valid." }); break; }
        if (!favs.some((x) => hostnameOf(x.url) === host)) {
          favs.push({ name: (f.name || host).trim(), url: f.url.trim(), autoStart: f.autoStart !== false });
          await chrome.storage.local.set({ favorites: favs });
        }
        sendResponse({ ok: true, favorites: favs });
        break;
      }
      case "autopilot-remove-favorite": {
        const host = (msg.host || "").toLowerCase();
        const favs = (await getFavorites()).filter((f) => hostnameOf(f.url) !== host);
        await chrome.storage.local.set({ favorites: favs });
        sendResponse({ ok: true, favorites: favs });
        break;
      }
      case "autopilot-set-favorite-autostart": {
        const host = (msg.host || "").toLowerCase();
        const favs = await getFavorites();
        const f = favs.find((x) => hostnameOf(x.url) === host);
        if (f) {
          f.autoStart = Boolean(msg.autoStart);
          await chrome.storage.local.set({ favorites: favs });
        }
        sendResponse({ ok: true, favorites: favs });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
}
);
