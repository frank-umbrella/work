"""
client.py — posts a single check-in to watchtower-worker.

Network-aware retry: connection errors get up to 3 tries with backoff,
but a 401 (bad token) or 4xx fails fast — those are real problems that
won't fix themselves with another attempt.

When all 3 worker attempts fail with a network/timeout error, we do a
quick disambiguation by hitting two well-known HTTPS connectivity
endpoints (Google + Cloudflare's generate_204). Both fail = internet
is genuinely down (ISP, WiFi, etc). At least one succeeds = the
internet is fine but our worker / Cloudflare is the problem. This
distinction is logged into state.json so the dashboard can render
'host is offline because the internet is down' vs 'because the worker
is down' separately.
"""

import time
import requests


# Connectivity sanity-check endpoints. Both return HTTP 204 No Content
# with empty body in ~50ms. Used by every consumer device + Windows
# itself for "captive portal" / "is the internet up" checks, so they're
# CDN-cached and extremely fast. We pick two from different networks
# so one provider being flaky doesn't cause false 'internet_down'.
CONNECTIVITY_PROBES = [
    "https://www.google.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
]
CONNECTIVITY_TIMEOUT_SEC = 5


class CheckinError(Exception):
    """Recoverable failures (network, 5xx) carry kind='network';
    non-recoverable (4xx) carry kind='http'. The kind feeds into the
    offlinePeriods reason categorization the service writes to
    state.json so the dashboard can distinguish internet-down from
    worker-down."""
    def __init__(self, message, kind="network"):
        super().__init__(message)
        self.kind = kind


def check_internet_reachable():
    """
    Returns True if at least one of the connectivity probe endpoints
    returns HTTP 204 within CONNECTIVITY_TIMEOUT_SEC. Used to
    disambiguate 'worker is down' from 'our internet is down' after a
    /checkin attempt fails with a network error.

    Wrapped in a broad try/except because the caller already knows
    something's wrong with networking -- we don't want a DNS error or
    SSL handshake error here to crash the disambiguation step itself.
    """
    for url in CONNECTIVITY_PROBES:
        try:
            r = requests.get(url, timeout=CONNECTIVITY_TIMEOUT_SEC)
            if r.status_code == 204:
                return True
        except requests.RequestException:
            continue
        except Exception:
            continue
    return False


def post_checkin(worker_url, install_token, payload, timeout=30):
    """
    POST the check-in to the worker. Returns the parsed JSON response
    on success: { ok, config, uninstall }.

    Raises CheckinError on any non-recoverable failure with a human
    description (logged + surfaced in state.json so the tray can show it).
    The exception's `.kind` attribute is 'network' for transport-layer
    failures and 'http' for 4xx responses.
    """
    url = worker_url.rstrip("/") + "/checkin"
    headers = {
        "Authorization": f"Bearer {install_token}",
        "Content-Type": "application/json",
        "User-Agent": f"watchtower-agent/{payload.get('agentVersion', 'unknown')}",
    }

    last_err = None
    for attempt in range(3):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except requests.RequestException as e:
            last_err = f"network error: {e}"
            time.sleep(2 ** attempt)  # 1s, 2s, 4s
            continue

        # 4xx is final — token bad, payload malformed, etc. Don't retry.
        if 400 <= r.status_code < 500:
            try:
                detail = r.json()
            except ValueError:
                detail = {"raw": r.text[:500]}
            raise CheckinError(f"HTTP {r.status_code}: {detail}", kind="http")

        # 5xx — retry-worthy server error.
        if r.status_code >= 500:
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            time.sleep(2 ** attempt)
            continue

        # 2xx — done.
        try:
            return r.json()
        except ValueError:
            raise CheckinError(f"worker returned non-JSON 2xx: {r.text[:200]}", kind="http")

    raise CheckinError(f"All 3 attempts failed. Last error: {last_err}", kind="network")
