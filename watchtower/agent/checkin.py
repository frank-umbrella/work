"""
checkin.py — the one-shot "do a check-in now" workflow, shared by the
service's daily timer and the tray's "Check now" menu item.

  load config → collect everything → POST to worker → write state.json
  → if worker says uninstall:true, hand off to the uninstaller.

This function is safe to call multiple times. Concurrent calls are
serialized via a file lock on %ProgramData%\\Watchtower\\.checkin.lock.

v0.14.27: offline-period tracking
  When a check-in fails, we open an entry in state['currentOfflinePeriod']
  with the failure timestamp + the failure reason ('internet_down' if the
  Google/Cloudflare 204 probes also fail, otherwise 'worker_down'). The
  next successful check-in closes the period (sets endedAt + durationSec)
  and appends it to state['offlinePeriods'][]. The agent then ships the
  periods up to the worker in the check-in payload so the dashboard can
  render the host's connectivity timeline. We prune anything older than
  30 days locally to keep state.json bounded.
"""

import datetime
import os
import sys
import time
import socket
import traceback

import config as cfg_mod
import collector
import client
import logger as _logger
import health as _health


# Local cap on how much offline history we keep in state.json. Worker
# stores a longer rolling window in Firestore so the dashboard can show
# multi-month timelines; the agent only needs enough to (a) close out
# in-flight periods and (b) re-send the recent window on each check-in
# in case the worker missed a previous one.
OFFLINE_HISTORY_DAYS = 30


def _read_version():
    """Reads agent/VERSION at runtime. Single source of truth — same file
    is used by build.ps1 for the installer's AppVersion. PyInstaller
    bundles it into the EXE via --add-data, so it lives next to the
    bundled __main__ at runtime under the temp _MEIPASS directory."""
    # PyInstaller frozen mode puts data files in _MEIPASS; dev mode falls
    # back to the file beside this script.
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(base, "VERSION"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "unknown"


AGENT_VERSION = _read_version()


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _classify_failure(exc):
    """Return one of 'internet_down' / 'worker_down' / 'http_error'.

    'http_error' is a 4xx (bad token / payload) which isn't a network
    issue at all. The other two split network failures by whether our
    own internet is reachable. The disambiguation probe runs ONLY when
    we know the worker call failed -- we don't double-tax the network
    in the happy path.
    """
    kind = getattr(exc, "kind", "network")
    if kind == "http":
        return "http_error"
    # Worker /checkin failed at the network layer. Is the rest of the
    # internet alive? If so, the worker (or Cloudflare in front of it)
    # is the problem.
    if client.check_internet_reachable():
        return "worker_down"
    return "internet_down"


def _prune_offline_periods(periods):
    """Drop periods that ended more than OFFLINE_HISTORY_DAYS ago.
    Keeps the in-flight (no endedAt) entry untouched if any."""
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=OFFLINE_HISTORY_DAYS)
    kept = []
    for p in (periods or []):
        ended = p.get("endedAt")
        if not ended:
            kept.append(p)            # in-flight, never drop
            continue
        try:
            t = datetime.datetime.fromisoformat(ended.replace("Z", "+00:00")).replace(tzinfo=None)
        except (ValueError, AttributeError):
            kept.append(p)            # malformed -- keep it, don't lose data
            continue
        if t >= cutoff:
            kept.append(p)
    return kept


def _open_offline_period_if_new(state, reason):
    """Open state['currentOfflinePeriod'] iff one isn't already in flight.
    Don't reopen mid-outage -- preserving the original startedAt is what
    makes the dashboard's 'duration' calculation right."""
    if state.get("currentOfflinePeriod"):
        return
    state["currentOfflinePeriod"] = {
        "startedAt": _now_iso(),
        "reason": reason,
    }


def _close_offline_period_if_any(state):
    """If an offline period is in flight, close it and append to history.
    Called from the success path. Returns the closed period (or None) so
    the caller can log it."""
    cur = state.get("currentOfflinePeriod")
    if not cur:
        return None
    cur["endedAt"] = _now_iso()
    # durationSec = endedAt - startedAt, best-effort
    try:
        started = datetime.datetime.fromisoformat(cur["startedAt"].replace("Z", "+00:00")).replace(tzinfo=None)
        ended = datetime.datetime.fromisoformat(cur["endedAt"].replace("Z", "+00:00")).replace(tzinfo=None)
        cur["durationSec"] = int((ended - started).total_seconds())
    except (ValueError, AttributeError, KeyError):
        cur["durationSec"] = None
    cur["attempts"] = state.get("consecutiveFailures", 0) + 1  # this success closes the streak
    state.setdefault("offlinePeriods", []).append(cur)
    state["offlinePeriods"] = _prune_offline_periods(state["offlinePeriods"])
    state.pop("currentOfflinePeriod", None)
    return cur


def run_checkin():
    """Performs one check-in. Returns the parsed worker response (dict)
    on success, or a dict with {ok:false, error:str} on failure. Always
    writes the result into state.json so the tray reflects it."""
    # Preserve existing state across runs so offline-period tracking +
    # consecutiveFailures survive between check-in attempts.
    state = cfg_mod.load_state() or {}
    state["checkinStartedAt"] = _now_iso()
    _logger.log(f"run_checkin: starting (agent v{AGENT_VERSION})")
    try:
        config = cfg_mod.load_config()
        state["pcId"] = config["pcId"]
        state["client"] = config.get("client")
        state["agentVersion"] = AGENT_VERSION
        _logger.log(f"run_checkin: loaded config (pcId={config['pcId'][:8]}..., client={config.get('client')!r}, worker={config['workerUrl']})")

        report = collector.collect_all()
        state["lastReport"] = {
            "externalIp": report.get("externalIp"),
            "collectionMs": report.get("collectionMs"),
            "probeErrors": [e["probe"] for e in report.get("probeErrors", [])],
        }

        # Compute this host's worst-state for the tray icon. The full
        # report is too big to drop into state.json (Belarc-lite-style
        # inventory can hit 200KB+), but the tray needs a single-word
        # summary to pick which icon variant to display. health.py's
        # contract: pass the report via a transient state['_report']
        # field, read state['hostHealthState'] back, drop the _report
        # field before save_state writes to disk.
        state["_report"] = report
        state["hostHealthState"] = _health.compute_host_health_state(state)
        state.pop("_report", None)

        # Include offline-period history in the payload so the worker can
        # forward it into Firestore for the dashboard's connectivity chart.
        # Prune in-flight first so a stale in-flight entry doesn't ship.
        existing_periods = _prune_offline_periods(state.get("offlinePeriods", []))
        state["offlinePeriods"] = existing_periods

        payload = {
            "pcId": config["pcId"],
            "agentVersion": AGENT_VERSION,
            "hostname": socket.gethostname(),
            "client": config.get("client"),
            "ts": _now_iso(),
            "report": report,
            "offlinePeriods": existing_periods,
            "consecutiveFailures": state.get("consecutiveFailures", 0),
        }
        _logger.log(f"run_checkin: collected {len(report)} keys, posting to worker")
        resp = client.post_checkin(
            worker_url=config["workerUrl"],
            install_token=config["installToken"],
            payload=payload,
        )
        # Success path. Close any in-flight offline period and reset the
        # consecutive-failures counter.
        closed = _close_offline_period_if_any(state)
        if closed:
            _logger.log(f"run_checkin: closed offline period: started={closed.get('startedAt')}, duration={closed.get('durationSec')}s, reason={closed.get('reason')}")
        state["consecutiveFailures"] = 0
        state.pop("lastFailureKind", None)
        state["lastCheckinAt"] = _now_iso()
        state["lastResponse"] = resp
        state["ok"] = True
        # Promote helpDeskUrl from the response config to a top-level
        # state field so the tray can read it cheaply at menu-open time
        # without parsing the full lastResponse blob. Always assigned
        # (even when None) so a cleared URL is reflected immediately
        # rather than leaving a stale value behind.
        cfg_resp = resp.get("config") or {}
        state["helpDeskUrl"] = cfg_resp.get("helpDeskUrl") or None
        # Also retain the resolved client name so the tray menu can
        # label the link "Open <Client> help desk" rather than the
        # generic phrasing.
        if cfg_resp.get("client") or resp.get("client"):
            state["clientName"] = cfg_resp.get("client") or resp.get("client")
        cfg_mod.save_state(state)
        _logger.log(f"run_checkin: SUCCESS (worker ok={resp.get('ok')}, uninstall={resp.get('uninstall', False)})")

        # Honor per-PC autoUpdate flag OR the one-shot forceUpdate flag
        # — if EITHER is set, ping the worker's /latest-version and apply
        # the update before returning. Failure here is logged but doesn't
        # fail the check-in (we already wrote state.json with ok:true).
        # forceUpdate is the "I want this host updated NOW" push the admin
        # can trigger from the dashboard; the worker self-clears it once
        # the agent reports the matching version on a subsequent check-in.
        cfg_resp = resp.get("config") or {}
        if cfg_resp.get("autoUpdate") or cfg_resp.get("forceUpdate"):
            try:
                import updater
                # One-shot cleanup of any token leaked into install.log
                # by older builds (<= v0.14.39 passed /TOKEN= inline).
                # Idempotent; cheap when there's nothing to scrub.
                try:
                    updater.scrub_legacy_token_leaks()
                except Exception:
                    pass  # never fail an update because of log scrubbing
                result = updater.apply_update_if_needed(
                    worker_url=config["workerUrl"],
                    current_version=AGENT_VERSION,
                    install_token=config.get("installToken"),
                )
                state["lastUpdateCheck"] = {
                    "at": _now_iso(),
                    **result,
                }
                cfg_mod.save_state(state)
            except Exception as e:
                # Don't let an updater failure cascade — the agent should
                # keep running on its current version regardless.
                state.setdefault("lastUpdateCheck", {})["error"] = str(e)
                cfg_mod.save_state(state)

        # Honor worker-side uninstall directive. Returning the response
        # to the service lets it call the uninstaller.
        return resp

    except client.CheckinError as e:
        # Network or HTTP failure. Open / extend the offline period and
        # bump the consecutive-failures counter. Categorize the failure
        # via a quick connectivity probe so the dashboard can split
        # internet-down vs worker-down outages.
        reason = _classify_failure(e)
        state["consecutiveFailures"] = (state.get("consecutiveFailures") or 0) + 1
        state["lastFailureKind"] = reason
        state["lastFailureAt"] = _now_iso()
        # Don't open an offline period for HTTP errors (4xx) -- those
        # mean the token is bad or the payload is wrong, not that the
        # host is offline. The dashboard already surfaces that via the
        # error field on the host doc.
        if reason != "http_error":
            _open_offline_period_if_new(state, reason)
        state["ok"] = False
        state["error"] = str(e)
        state["lastCheckinAt"] = _now_iso()
        cfg_mod.save_state(state)
        _logger.log(f"run_checkin: FAILED ({reason}, attempt #{state['consecutiveFailures']}) -- {e}")
        return {"ok": False, "error": str(e), "reason": reason}

    except Exception as e:
        # Unexpected -- log full traceback and treat like a generic
        # failure. Don't categorize via the internet probe (could be a
        # probe crash, not a network issue).
        state["consecutiveFailures"] = (state.get("consecutiveFailures") or 0) + 1
        state["lastFailureKind"] = "unknown"
        state["lastFailureAt"] = _now_iso()
        state["ok"] = False
        state["error"] = str(e)
        state["trace"] = traceback.format_exc()
        state["lastCheckinAt"] = _now_iso()
        cfg_mod.save_state(state)
        _logger.log(f"run_checkin: FAILED -- {e}")
        _logger.log(f"run_checkin: traceback:\n{traceback.format_exc()}")
        return {"ok": False, "error": str(e)}
