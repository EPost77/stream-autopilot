# Stream Autopilot API

Companion backend for the autopilot browser extension. Chaturbate exposes no
public API, so this service handles everything that needs a server:

| Endpoint | Method | What it does |
|---|---|---|
| `/ping` | GET | liveness check (no auth) |
| `/edge-servers?region=us` | GET | fastest CDN edges, ranked by latency |
| `/edge-servers` | POST | upsert an edge host `{host, region, latency_ms}` |
| `/health` | POST | extension reports `{region, bitrate_kbps, dropped_frames, ping_ms}` |
| `/health?region=us` | GET | crowdsourced platform status: healthy / degraded / unknown |
| `/token-promos` | GET | current token bonus promos |
| `/config` | GET | remote tuning knobs for the extension |

Auth: `X-API-Key` header on every route except `/ping`. Rate limit: 120 req/min per key (env `AUTOPILOT_RATE_LIMIT`).

## Quickstart

```bash
cd stream-autopilot-api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
AUTOPILOT_API_KEY=dev-key .venv/bin/python -m uvicorn app.main:app --port 8471
```

## Probe job (edge-server rankings)

```bash
# every 5 minutes via cron:
*/5 * * * * AUTOPILOT_EDGES="edge01.example.com,us" /path/to/.venv/bin/python /path/to/app/probe.py
```

Candidate edge hosts come from real stream traffic observed by the extension —
paste them into `AUTOPILOT_EDGES` as `host,region` lines. Nothing is hardcoded
because edge hostnames rotate.

## Extension snippet

```js
const API = "https://your-host.example.com";
const KEY = "user-api-key";

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// fastest edge for this user
const { servers } = await api("/edge-servers?region=us");

// report stream health every minute
setInterval(() => api("/health", { method: "POST",
  body: JSON.stringify({ region: "us", bitrate_kbps, dropped_frames, ping_ms }) }), 60000);

// remote tuning without shipping an extension update
const { config } = await api("/config");
```

## Deploy (Railway)

1. Put this folder's files in a GitHub repo (the web upload works fine).
2. On railway.app: New Project → Deploy from GitHub → pick the repo.
3. No environment variables needed: if `AUTOPILOT_API_KEY` is not set, the
   app mints one on first boot and prints it in the deploy logs — look for
   `*** Stream Autopilot generated API key ***` and paste it into the
   extension/dashboard settings once. (You can also set `AUTOPILOT_API_KEY`
   yourself to use your own key.)
4. Railway gives you the live URL. Open the API tester page, enter the URL and your key, and run all tests.

Local dev is unchanged: `AUTOPILOT_API_KEY=dev-key .venv/bin/python -m uvicorn app.main:app --port 8471`.

## Architecture

Three pieces, each doing the job it fits best:

| Piece | Where it lives | What it does |
|---|---|---|
| **Backend API** | `app/` (this service) | Edge-server rankings, crowdsourced `/health`, token promos, remote `/config`. The brain. |
| **Browser extension** | `extension/` | Manifest V3. Watches `<video>` elements for stalls/rebuffers/dropped frames, auto-arms on favorites or when a stream is detected, reports health on a timer, shows fastest edges in the popup. The hands. |
| **Dashboard** | `dashboard/` | Static page: favorite-site cards, stream-health panel, fastest-edges table, settings. The home base. Also installable as an app on Android (see below). |

Install the extension: [EXTENSION_INSTALL.md](EXTENSION_INSTALL.md).

## Honest limits

True "server hopping" only works on sites that expose selectable stream
edges/servers. On generic sites (YouTube, Twitch, etc.) the extension monitors
stream health, reports it, shows the fastest known edge for the region, and
offers a one-click reload nudge when buffering persists. It cannot force a big
platform onto another CDN, and the UI says so wherever edges are shown.

## Dashboard as an app (Android)

`dashboard/` is a static page with PWA support — no build step:

1. Serve the `dashboard/` folder over **HTTPS** (GitHub Pages, Netlify, or any
   static host; `localhost` works for testing).
2. Open the URL in Chrome on your phone.
3. Menu (⋮) → **Add to Home screen** (or **Install app**).
4. It opens full-screen like a native app and works offline for the shell;
   API panels need a connection, naturally.

Files: `index.html` (the whole app, no external libraries),
`manifest.webmanifest`, `sw.js` (offline app-shell cache), `icons/`.
