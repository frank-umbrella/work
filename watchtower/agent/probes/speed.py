"""
speed.py -- weekly internet speed test against Cloudflare endpoints.

How this works:
  1. Every check-in reads the cached result from
     %ProgramData%\\Watchtower\\speedtest.json and returns it
     immediately. Reads are cheap (just JSON load), so this never
     delays a check-in.
  2. After returning the cache, the probe checks how old it is. If
     >= 7 days (or the file doesn't exist), it spawns a background
     thread to run the actual test. That thread writes a fresh
     result to the cache when done; the next check-in picks it up.

Speed test method: HTTP-based against speed.cloudflare.com. Cloudflare
exposes /__down?bytes=N and /__up endpoints that are intended for
their own speed-test UI (speed.cloudflare.com) but have been stable
for years and are widely used by third-party speed tools. No API key,
no licensing concerns, free + zero-config.

What we measure:
  - Latency: time to a tiny HTTP HEAD against /__down (TLS handshake +
    one round-trip)
  - Download: 10 MB pulled from /__down?bytes=10000000, divided by
    elapsed seconds, converted to Mbps
  - Upload: 5 MB POSTed to /__up, same conversion

Bandwidth cost: ~15 MB per host per week (10 down + 5 up). Negligible.

Failure handling: probe NEVER raises. Any error during the background
test gets recorded in the cache as { error: "...", tested_at: nowIso }
so the dashboard can surface "Speed test failed last try" rather than
silently hiding the field.
"""

import json
import os
import socket
import ssl
import threading
import time
from datetime import datetime, timezone

import logger as _logger

# Cache file location -- same dir as the agent's other state.
_PROGRAMDATA = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
_CACHE_DIR = os.path.join(_PROGRAMDATA, "Watchtower")
_CACHE_PATH = os.path.join(_CACHE_DIR, "speedtest.json")

# Re-test cadence. User picked once-per-week in v0.14.119 design review;
# adjust here if we ever need a different schedule.
_STALE_AFTER_SEC = 7 * 24 * 60 * 60

# Test payload sizes. 10 MB / 5 MB is enough to get a reasonable Mbps
# reading on residential connections (1-1000 Mbps range) without burning
# real bandwidth. Smaller payloads exaggerate latency overhead; larger
# ones don't add accuracy on the typical fleet.
_DOWNLOAD_BYTES = 10_000_000
_UPLOAD_BYTES = 5_000_000

# Per-operation timeout. A residential modem on a slow link still
# completes 10 MB in under 90s at 1 Mbps; anything past that and we'd
# rather record the failure than block forever.
_HTTP_TIMEOUT_SEC = 120

_CF_HOST = "speed.cloudflare.com"

# Module-level lock so we don't kick off two background tests on
# overlapping check-ins (the daemon thread is fast to spawn but the
# test itself can take 30+ seconds).
_test_lock = threading.Lock()
_test_running = False


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ensure_cache_dir():
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
    except OSError:
        pass


def _load_cache():
    try:
        with open(_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_cache(data):
    _ensure_cache_dir()
    try:
        tmp = _CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, _CACHE_PATH)
    except OSError as e:
        _logger.log(f"speed: cache write failed -- {e}")


def _cache_age_sec(cached):
    if not cached or not cached.get("tested_at"):
        return None
    try:
        ts = datetime.strptime(cached["tested_at"], "%Y-%m-%dT%H:%M:%SZ")
        ts = ts.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except (ValueError, TypeError):
        return None


def _run_speed_test():
    """
    Actually performs the download + upload test. Runs in a daemon
    thread so a slow test never delays a check-in. On success writes
    { downloadMbps, uploadMbps, latencyMs, tested_at } to the cache;
    on failure writes { error, tested_at } so we have a record.
    Never raises -- all exceptions caught + logged + recorded.
    """
    # Late import so a host without `requests` (very rare on Python
    # 3.11+ but PyInstaller bundles can be quirky) records the error
    # instead of failing the import of the whole probe module.
    try:
        import urllib.request
        import urllib.error
    except Exception as e:
        _write_cache({"error": f"urllib import failed: {e}", "tested_at": _now_iso()})
        return

    result = {"tested_at": _now_iso()}
    try:
        # ----- Latency probe -----
        # Single HEAD to /__down catches TCP+TLS round-trip + first byte.
        # Not as precise as a true ping (we measure HTTP overhead too)
        # but representative of what real traffic sees.
        lat_t0 = time.monotonic()
        req = urllib.request.Request(
            f"https://{_CF_HOST}/__down?bytes=0",
            headers={"User-Agent": "Watchtower-Agent/speed-probe"},
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            resp.read(64)  # drain
        latency_ms = (time.monotonic() - lat_t0) * 1000.0

        # ----- Download test -----
        dl_t0 = time.monotonic()
        req = urllib.request.Request(
            f"https://{_CF_HOST}/__down?bytes={_DOWNLOAD_BYTES}",
            headers={"User-Agent": "Watchtower-Agent/speed-probe"},
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            received = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                received += len(chunk)
        dl_elapsed = time.monotonic() - dl_t0
        download_mbps = (received * 8.0) / (dl_elapsed * 1_000_000.0) if dl_elapsed > 0 else 0

        # ----- Upload test -----
        # Cloudflare's /__up accepts arbitrary POST data and discards it.
        # We send a single buffer of zeros sized to _UPLOAD_BYTES.
        ul_t0 = time.monotonic()
        payload = b"\x00" * _UPLOAD_BYTES
        req = urllib.request.Request(
            f"https://{_CF_HOST}/__up",
            data=payload,
            method="POST",
            headers={
                "User-Agent": "Watchtower-Agent/speed-probe",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(_UPLOAD_BYTES),
            },
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            resp.read(64)  # drain ack body
        ul_elapsed = time.monotonic() - ul_t0
        upload_mbps = (_UPLOAD_BYTES * 8.0) / (ul_elapsed * 1_000_000.0) if ul_elapsed > 0 else 0

        result.update({
            "downloadMbps": round(download_mbps, 2),
            "uploadMbps": round(upload_mbps, 2),
            "latencyMs": round(latency_ms, 1),
        })
        _logger.log(
            f"speed: test done -- {result['downloadMbps']} Mbps down / "
            f"{result['uploadMbps']} Mbps up / {result['latencyMs']} ms lat"
        )
    except (urllib.error.URLError, urllib.error.HTTPError, socket.error,
            socket.timeout, ssl.SSLError, OSError) as e:
        # Network failure -- record it, dashboard surfaces "Speed test
        # failed last try" with the error.
        result["error"] = f"network: {e}"
        _logger.log(f"speed: test failed -- {e}")
    except Exception as e:
        # Unexpected -- shouldn't happen, but better recorded than crashed.
        result["error"] = f"unexpected: {e}"
        _logger.log(f"speed: unexpected error -- {e}")

    _write_cache(result)


def _maybe_kick_off_test(cached):
    """
    If the cache is stale (or missing), spawn a daemon thread to run
    the test in the background. Returns nothing; the test result will
    be visible on a future check-in via the cache. Uses a module-level
    lock so two concurrent collect() calls can't spawn two tests.
    """
    global _test_running
    age = _cache_age_sec(cached)
    needs_test = (age is None) or (age >= _STALE_AFTER_SEC)
    if not needs_test:
        return
    with _test_lock:
        if _test_running:
            return  # one already in flight from a prior tick
        _test_running = True

    def _wrapper():
        global _test_running
        try:
            _run_speed_test()
        finally:
            with _test_lock:
                _test_running = False

    t = threading.Thread(target=_wrapper, name="speed-probe-bg", daemon=True)
    t.start()
    _logger.log("speed: kicked off background test (cache stale)")


def collect():
    """
    Cache-first: every call returns the most recent cached result
    (which may be from days ago) and asynchronously checks whether a
    fresh test is due. This means check-ins are always fast (no
    10 MB download blocking them) and the dashboard always has
    SOMETHING to show as long as one test has ever completed.

    Return shape:
      {
        "downloadMbps": 87.42,
        "uploadMbps": 12.61,
        "latencyMs": 18.4,
        "tested_at": "2026-05-25T03:14:22Z",
        "error": null            # or string if last test failed
      }

    Returns None on hosts where we've never been able to run a test
    AND a background test isn't yet complete, so the worker has no
    "speed" field to forward.
    """
    cached = _load_cache()
    _maybe_kick_off_test(cached)
    if cached is None:
        return None
    # Normalize the shape so the worker + dashboard can assume the
    # field names exist (with null values) even on failure cases.
    return {
        "downloadMbps": cached.get("downloadMbps"),
        "uploadMbps": cached.get("uploadMbps"),
        "latencyMs": cached.get("latencyMs"),
        "tested_at": cached.get("tested_at"),
        "error": cached.get("error"),
    }
