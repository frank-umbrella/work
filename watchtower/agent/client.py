"""
client.py — posts a single check-in to watchtower-worker.

Network-aware retry: connection errors get up to 3 tries with backoff,
but a 401 (bad token) or 4xx fails fast — those are real problems that
won't fix themselves with another attempt.
"""

import time
import requests


class CheckinError(Exception):
    pass


def post_checkin(worker_url, install_token, payload, timeout=30):
    """
    POST the check-in to the worker. Returns the parsed JSON response
    on success: { ok, config, uninstall }.

    Raises CheckinError on any non-recoverable failure with a human
    description (logged + surfaced in state.json so the tray can show it).
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
            raise CheckinError(f"HTTP {r.status_code}: {detail}")

        # 5xx — retry-worthy server error.
        if r.status_code >= 500:
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            time.sleep(2 ** attempt)
            continue

        # 2xx — done.
        try:
            return r.json()
        except ValueError:
            raise CheckinError(f"worker returned non-JSON 2xx: {r.text[:200]}")

    raise CheckinError(f"All 3 attempts failed. Last error: {last_err}")
