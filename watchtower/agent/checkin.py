"""
checkin.py — the one-shot "do a check-in now" workflow, shared by the
service's daily timer and the tray's "Check now" menu item.

  load config → collect everything → POST to worker → write state.json
  → if worker says uninstall:true, hand off to the uninstaller.

This function is safe to call multiple times. Concurrent calls are
serialized via a file lock on %ProgramData%\\Watchtower\\.checkin.lock.
"""

import os
import sys
import time
import socket
import traceback

import config as cfg_mod
import collector
import client


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


def run_checkin():
    """Performs one check-in. Returns the parsed worker response (dict)
    on success, or a dict with {ok:false, error:str} on failure. Always
    writes the result into state.json so the tray reflects it."""
    state = {"checkinStartedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        config = cfg_mod.load_config()
        state["pcId"] = config["pcId"]
        state["client"] = config.get("client")
        state["agentVersion"] = AGENT_VERSION

        report = collector.collect_all()
        state["lastReport"] = {
            "externalIp": report.get("externalIp"),
            "collectionMs": report.get("collectionMs"),
            "probeErrors": [e["probe"] for e in report.get("probeErrors", [])],
        }

        payload = {
            "pcId": config["pcId"],
            "agentVersion": AGENT_VERSION,
            "hostname": socket.gethostname(),
            "client": config.get("client"),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "report": report,
        }
        resp = client.post_checkin(
            worker_url=config["workerUrl"],
            install_token=config["installToken"],
            payload=payload,
        )
        state["lastCheckinAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        state["lastResponse"] = resp
        state["ok"] = True
        cfg_mod.save_state(state)

        # Honor per-PC autoUpdate flag — if set, ping the worker's
        # /latest-version and apply the update before returning. Failure
        # here is logged but doesn't fail the check-in (we already wrote
        # state.json with ok:true).
        if (resp.get("config") or {}).get("autoUpdate"):
            try:
                import updater
                result = updater.apply_update_if_needed(
                    worker_url=config["workerUrl"],
                    current_version=AGENT_VERSION,
                    install_token=config.get("installToken"),
                )
                state["lastUpdateCheck"] = {
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
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

    except Exception as e:
        state["ok"] = False
        state["error"] = str(e)
        state["trace"] = traceback.format_exc()
        state["lastCheckinAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        cfg_mod.save_state(state)
        return {"ok": False, "error": str(e)}
