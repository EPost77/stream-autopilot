// popup.js — drives the extension popup UI. Talks to background.js only;
// never touches the network directly (all API calls go through the worker).

"use strict";

let activeTabId = null;
let currentHost = "";

async function bg(msg) {
  return chrome.runtime.sendMessage({ tabId: activeTabId, ...msg });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;
  await Promise.all([renderStatus(), renderFavorites(), renderSettings()]);
  await renderEdges();

  document.getElementById("toggle-btn").addEventListener("click", async () => {
    const res = await bg({ type: "autopilot-toggle-armed" });
    if (res && res.ok) renderStatus();
  });
  document.getElementById("add-fav-btn").addEventListener("click", async () => {
    const res = await bg({
      type: "autopilot-add-favorite",
      favorite: { name: currentHost, url: "https://" + currentHost, autoStart: true },
    });
    if (res && res.ok) renderFavorites();
    else if (res && res.error) alert(res.error);
  });
  document.getElementById("reload-btn").addEventListener("click", async () => {
    if (activeTabId != null) chrome.tabs.reload(activeTabId);
  });
  document.getElementById("edge-refresh").addEventListener("click", renderEdges);
  document.getElementById("save-btn").addEventListener("click", saveSettings);
  document.getElementById("test-btn").addEventListener("click", testPing);
}

async function renderStatus() {
  const res = await bg({ type: "autopilot-get-tab-state" });
  if (!res || !res.ok) return;
  const s = res.state;
  currentHost = res.host || "";
  document.getElementById("current-host").textContent = currentHost || "—";
  document.getElementById("stream-detected").textContent = s.streamingDetected ? "Yes" : "No";
  document.getElementById("rebuffers").textContent = String(s.rebuffers || 0);
  document.getElementById("dropped").textContent = String(s.droppedFrames || 0);

  const pill = document.getElementById("armed-pill");
  pill.textContent = s.armed ? "ON" : "OFF";
  pill.className = "pill " + (s.armed ? "on" : "off");

  document.getElementById("toggle-btn").textContent =
    s.armed ? "Turn OFF for this site" : "Turn ON for this site";

  document.getElementById("struggle-box").style.display =
    s.struggling && s.armed ? "block" : "none";

  document.getElementById("not-configured").style.display =
    res.configured ? "none" : "block";
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

async function renderFavorites() {
  const res = await bg({ type: "autopilot-get-favorites" });
  const list = document.getElementById("fav-list");
  list.innerHTML = "";
  const favs = (res && res.favorites) || [];
  if (favs.length === 0) {
    list.innerHTML = '<div class="empty">No favorites yet — add the sites you watch most.</div>';
    return;
  }
  for (const f of favs) {
    const host = hostOf(f.url);
    const div = document.createElement("div");
    div.className = "fav";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name || host;
    name.title = "Open " + f.url + " in a new tab";
    name.addEventListener("click", () => chrome.tabs.create({ url: f.url }));

    const auto = document.createElement("label");
    auto.className = "inline";
    auto.style.margin = "0";
    auto.style.fontSize = "11px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = f.autoStart !== false;
    cb.title = "Auto-start autopilot on this site";
    cb.addEventListener("change", async () => {
      await bg({ type: "autopilot-set-favorite-autostart", host, autoStart: cb.checked });
    });
    auto.appendChild(cb);
    auto.appendChild(document.createTextNode("auto"));

    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.className = "danger";
    rm.title = "Remove favorite";
    rm.addEventListener("click", async () => {
      await bg({ type: "autopilot-remove-favorite", host });
      renderFavorites();
    });

    div.appendChild(name);
    div.appendChild(auto);
    div.appendChild(rm);
    list.appendChild(div);
  }
}

async function renderEdges() {
  const region = document.getElementById("edge-region").value || "us";
  const list = document.getElementById("edge-list");
  const res = await bg({ type: "autopilot-get-edges", region });
  list.innerHTML = "";
  if (!res || !res.ok) {
    list.innerHTML = '<div class="empty">Connect your API in Settings to see edge rankings.</div>';
    return;
  }
  const servers = res.servers || [];
  if (servers.length === 0) {
    list.innerHTML = '<div class="empty">No edges reported for this region yet.</div>';
    return;
  }
  for (const s of servers.slice(0, 8)) {
    const div = document.createElement("div");
    div.className = "edge";
    const host = document.createElement("span");
    host.textContent = s.host || "?";
    const ms = document.createElement("span");
    ms.className = "ms";
    ms.textContent = (s.latency_ms != null ? s.latency_ms + " ms" : "—");
    div.appendChild(host);
    div.appendChild(ms);
    list.appendChild(div);
  }
}

async function renderSettings() {
  const res = await bg({ type: "autopilot-get-settings" });
  if (!res || !res.ok) return;
  const s = res.settings;
  document.getElementById("set-url").value = s.apiBaseUrl || "";
  document.getElementById("set-key").value = s.apiKey || "";
  document.getElementById("set-region").value = s.region || "us";
  document.getElementById("set-autodetect").checked = s.autoDetect !== false;
  document.getElementById("set-minutes").value = s.reportMinutes || 5;
  document.getElementById("edge-region").value = s.region || "us";
}

async function saveSettings() {
  await bg({
    type: "autopilot-save-settings",
    settings: {
      apiBaseUrl: document.getElementById("set-url").value,
      apiKey: document.getElementById("set-key").value,
      region: document.getElementById("set-region").value,
      autoDetect: document.getElementById("set-autodetect").checked,
      reportMinutes: document.getElementById("set-minutes").value,
    },
  });
  document.getElementById("test-result").textContent = "Saved.";
  renderStatus();
  renderEdges();
}

async function testPing() {
  const el = document.getElementById("test-result");
  el.textContent = "Pinging…";
  const res = await bg({ type: "autopilot-test-ping" });
  el.textContent = res && res.ok
    ? `Connected — API answered in ${res.ms} ms.`
    : `Couldn't reach it: ${(res && res.error) || "unknown error"}`;
}

document.addEventListener("DOMContentLoaded", init);
