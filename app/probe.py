"""Edge-server latency probe.

Measures TCP-connect latency to each candidate edge host and upserts the
rankings into the API database. Run on a cron (every 5 min):

    */5 * * * * AUTOPILOT_API_KEY=... AUTOPILOT_EDGES="host1,us" \\
        /path/to/.venv/bin/python /path/to/app/probe.py

Candidate hosts come from real stream traffic observed by the extension —
paste them into AUTOPILOT_EDGES as "host,region" lines. No hosts are
hardcoded here because edge hostnames rotate.
"""
import os
import socket
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import get_db  # noqa: E402

TIMEOUT_S = 3.0
SAMPLES = 3


def parse_edges():
    raw = os.environ.get("AUTOPILOT_EDGES", "")
    edges = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or "," not in line:
            continue
        host, region = (p.strip() for p in line.split(",", 1))
        if host and region:
            edges.append((host, region))
    return edges


def tcp_latency_ms(host: str, port: int = 443):
    latencies = []
    for _ in range(SAMPLES):
        start = time.perf_counter()
        try:
            with socket.create_connection((host, port), timeout=TIMEOUT_S):
                latencies.append((time.perf_counter() - start) * 1000)
        except OSError:
            return None
    return statistics.median(latencies)


def main():
    edges = parse_edges()
    if not edges:
        print("AUTOPILOT_EDGES is empty — nothing to probe. "
              "Set it to 'host,region' lines from real stream traffic.")
        return 1
    conn = get_db()
    now = int(time.time())
    for host, region in edges:
        latency = tcp_latency_ms(host)
        if latency is None:
            print(f"  {host}: unreachable, skipping")
            continue
        conn.execute(
            "INSERT INTO edge_servers (host, region, latency_ms, last_checked) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(host) DO UPDATE SET latency_ms=excluded.latency_ms, "
            "region=excluded.region, last_checked=excluded.last_checked",
            (host, region, round(latency, 1), now),
        )
        print(f"  {host} [{region}]: {latency:.0f} ms")
    conn.commit()
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
