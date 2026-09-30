"""Stream Autopilot API — companion backend for the autopilot browser extension.

Chaturbate exposes no public API, so this service handles everything that
needs a server: edge-server rankings, crowdsourced platform health,
token-promo tracking, and remote tuning config for the extension.
"""
import os
import secrets
import sqlite3
import time
from collections import defaultdict

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("AUTOPILOT_DB", os.path.join(BASE_DIR, "autopilot.db"))
# One-click deploys (e.g. Railway template button) shouldn't need openssl:
# if no key is provided we mint one on first boot and print it to the logs
# so the owner can paste it into the extension/dashboard settings once.
API_KEY = os.environ.get("AUTOPILOT_API_KEY", "")
if not API_KEY:
    API_KEY = secrets.token_hex(32)
    print("*** Stream Autopilot generated API key (paste into extension/dashboard):", API_KEY, "***", flush=True)
RATE_LIMIT_PER_MIN = int(os.environ.get("AUTOPILOT_RATE_LIMIT", "120"))

app = FastAPI(title="Stream Autopilot API", version="0.1.0")

# Allow the browser-based API tester to call us from any origin.
# Auth is via the X-API-Key header (not cookies), so this is safe.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- db

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


DEFAULT_CONFIG = {
    "quality_step_down_latency_ms": "1500",   # step quality down if buffer < this
    "quality_step_up_latency_ms": "600",      # step quality up if buffer > this
    "chat_throttle_msgs_per_min": "600",      # throttle chat rendering above this
    "health_report_window_min": "15",         # aggregation window for /health
    "audio_fallback_dropped_frames": "120",   # auto audio-only above this/min
}


def init_db() -> None:
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS edge_servers (
            host TEXT PRIMARY KEY,
            region TEXT NOT NULL,
            latency_ms REAL,
            last_checked INTEGER
        );
        CREATE TABLE IF NOT EXISTS health_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL,
            bitrate_kbps REAL NOT NULL,
            dropped_frames INTEGER NOT NULL,
            ping_ms REAL NOT NULL,
            reported_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS token_promos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            bonus_pct REAL,
            url TEXT,
            observed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        """
    )
    now = int(time.time())
    for k, v in DEFAULT_CONFIG.items():
        conn.execute(
            "INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
            (k, v, now),
        )
    conn.commit()
    conn.close()


init_db()


def get_config_value(key: str) -> str:
    conn = get_db()
    row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else ""


# ---------------------------------------------------------------- auth + rate limit

def require_key(x_api_key: str = Header(default="")) -> bool:
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="invalid api key")
    return True


_hits: dict[str, list[float]] = defaultdict(list)


def rate_limit(x_api_key: str = Header(default=""), ok: bool = Depends(require_key)):
    now = time.time()
    window = [t for t in _hits[x_api_key] if now - t < 60]
    if len(window) >= RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="rate limited, slow down")
    window.append(now)
    _hits[x_api_key] = window


# ---------------------------------------------------------------- models

class HealthReport(BaseModel):
    region: str = Field(min_length=2, max_length=8)
    bitrate_kbps: float = Field(ge=0)
    dropped_frames: int = Field(ge=0)
    ping_ms: float = Field(ge=0)


class EdgeServer(BaseModel):
    host: str
    region: str
    latency_ms: float = Field(ge=0)


# ---------------------------------------------------------------- routes

@app.get("/ping")
def ping():
    return {"ok": True, "ts": int(time.time())}


@app.get("/edge-servers")
def edge_servers(region: str = "us", _=Depends(rate_limit)):
    conn = get_db()
    rows = conn.execute(
        "SELECT host, region, latency_ms, last_checked FROM edge_servers "
        "WHERE region = ? ORDER BY latency_ms ASC",
        (region,),
    ).fetchall()
    conn.close()
    return {"region": region, "servers": [dict(r) for r in rows]}


@app.post("/edge-servers")
def upsert_edge_server(s: EdgeServer, _=Depends(rate_limit)):
    conn = get_db()
    conn.execute(
        "INSERT INTO edge_servers (host, region, latency_ms, last_checked) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(host) DO UPDATE SET latency_ms=excluded.latency_ms, "
        "region=excluded.region, last_checked=excluded.last_checked",
        (s.host, s.region, s.latency_ms, int(time.time())),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "host": s.host}


@app.post("/health", status_code=202)
def report_health(r: HealthReport, _=Depends(rate_limit)):
    conn = get_db()
    conn.execute(
        "INSERT INTO health_reports (region, bitrate_kbps, dropped_frames, ping_ms, reported_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (r.region, r.bitrate_kbps, r.dropped_frames, r.ping_ms, int(time.time())),
    )
    # prune anything older than 24h
    conn.execute(
        "DELETE FROM health_reports WHERE reported_at < ?",
        (int(time.time()) - 86400,),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/health")
def platform_health(region: str = "us", _=Depends(rate_limit)):
    window_min = int(get_config_value("health_report_window_min") or 15)
    since = int(time.time()) - window_min * 60
    conn = get_db()
    row = conn.execute(
        "SELECT AVG(bitrate_kbps) AS avg_bitrate, AVG(dropped_frames) AS avg_dropped, "
        "AVG(ping_ms) AS avg_ping, COUNT(*) AS n FROM health_reports "
        "WHERE region = ? AND reported_at > ?",
        (region, since),
    ).fetchone()
    conn.close()
    n = row["n"] or 0
    status = "unknown"
    if n >= 5:
        status = "degraded" if (row["avg_dropped"] or 0) > 50 else "healthy"
    return {
        "region": region,
        "status": status,
        "samples": n,
        "avg_bitrate_kbps": row["avg_bitrate"],
        "avg_dropped_frames": row["avg_dropped"],
        "avg_ping_ms": row["avg_ping"],
    }


@app.get("/token-promos")
def token_promos(_=Depends(rate_limit)):
    conn = get_db()
    rows = conn.execute(
        "SELECT title, bonus_pct, url, observed_at FROM token_promos "
        "ORDER BY observed_at DESC LIMIT 20"
    ).fetchall()
    conn.close()
    return {"promos": [dict(r) for r in rows]}


@app.get("/config")
def tuning_config(_=Depends(rate_limit)):
    conn = get_db()
    rows = conn.execute("SELECT key, value, updated_at FROM config").fetchall()
    conn.close()
    return {"config": {r["key"]: r["value"] for r in rows}}
