"""
checkin.py — the one-shot "do a check-in now" workflow, shared by the
service's daily timer and the tray's "Check now" menu item.

  load config → collect everything → POST to worker → write state.json
  → if worker says uninstall:true, hand off to the uninstaller.

This function is safe to call multiple times. Concurrent calls are
serialized via a file lock on %ProgramData%\\Watchtower\\.checkin.lock.
"""

import os
import time
import socket
import traceback

import config as cfg_mod
import collector
import client


AGENT_VERSION = "0.1.0"


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
