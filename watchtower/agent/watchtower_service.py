"""
watchtower_service.py — the Windows service entry point.

Wraps the daily check-in loop in pywin32's ServiceFramework so it can
be registered with `sc create` and survive logouts. Runs as LocalSystem
(set by the installer) so probes can read SYSTEM-only registry trees
(LogMeIn V5, USBSTOR) and Defender state.

Schedule:
  - On service start: wait 30s (let the system stabilize), then run.
  - Every 24h thereafter: run another check-in.
  - SCM stop event interrupts the wait immediately so service stop
    doesn't time out.

If the worker returns `uninstall:true`, the service spawns the
uninstaller and exits. Doing that from inside the service we're
uninstalling is fragile, so we use a detached subprocess + exit.
"""

import os
import subprocess
import sys
import time

import servicemanager
import win32event
import win32service
import win32serviceutil

# Ensure the bundled-module directory is on sys.path when launched by SCM.
# PyInstaller's --onefile target unpacks to %TEMP%\_MEIxxxx and sets sys.path
# correctly, so this is a no-op there. When running from source for dev,
# this makes sibling modules importable.
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

import checkin  # noqa: E402  (must come after sys.path tweak)


CHECKIN_INTERVAL_SEC = 24 * 60 * 60   # daily on success
STARTUP_DELAY_SEC = 30                # let the network come up first

# Exponential-backoff schedule after a failed check-in (in seconds).
# Index N = wait time after the (N+1)th consecutive failure. After we
# fall off the end of the list, we go back to the normal 24h cadence
# (i.e. the worker is presumed dead-for-the-day and we'll try tomorrow).
#
# Designed to recover quickly from short ISP blips (5 min picks up the
# common <15-min outages) without hammering Cloudflare during a real
# sustained outage (caps at 4h then daily).
BACKOFF_SCHEDULE_SEC = [
     5 * 60,     # 1st failure: try again in 5 min
    15 * 60,     # 2nd: 15 min
    30 * 60,     # 3rd: 30 min
    60 * 60,     # 4th: 1 hour
    2 * 60 * 60, # 5th: 2 hours
    4 * 60 * 60, # 6th: 4 hours
]


def _next_wait_after_failure(consecutive_failures):
    """Map a consecutive-failure count to the seconds-until-next-attempt.
    Caller passes the count AFTER the failing attempt was logged."""
    n = max(0, int(consecutive_failures) - 1)
    if n < len(BACKOFF_SCHEDULE_SEC):
        return BACKOFF_SCHEDULE_SEC[n]
    return CHECKIN_INTERVAL_SEC      # fall back to daily after we've exhausted backoff


class WatchtowerService(win32serviceutil.ServiceFramework):
    _svc_name_ = "WatchtowerAgent"
    _svc_display_name_ = "Watchtower Monitoring Agent"
    _svc_description_ = (
        "Daily check-in to Umbrella Automation's Watchtower service. "
        "Reports external IP, Veeam backup status, LogMeIn state, and "
        "asset inventory."
    )

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        # Manual-reset event the main loop blocks on. SCM stop signals it.
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )

        # Initial settle delay — but cooperatively. If SCM signals stop
        # during the settle window, exit cleanly.
        if win32event.WaitForSingleObject(self.stop_event, STARTUP_DELAY_SEC * 1000) == win32event.WAIT_OBJECT_0:
            return

        while True:
            failed_this_round = False
            try:
                resp = checkin.run_checkin()
                if resp.get("uninstall"):
                    servicemanager.LogInfoMsg("Worker requested uninstall; spawning uninstaller and exiting.")
                    _spawn_uninstaller()
                    return
                # run_checkin returns {ok: false, error, reason} on failure;
                # check that explicitly so we shorten the next sleep.
                if not resp.get("ok", False):
                    failed_this_round = True
            except Exception as e:
                servicemanager.LogErrorMsg(f"check-in raised: {e}")
                failed_this_round = True

            # Choose the next sleep interval. On success we go back to the
            # normal 24h cadence. On failure we use the backoff schedule
            # keyed off the consecutiveFailures counter that run_checkin
            # just bumped (and persisted to state.json).
            if failed_this_round:
                try:
                    import config as cfg_mod
                    cur_state = cfg_mod.load_state() or {}
                    cf = cur_state.get("consecutiveFailures", 1)
                except Exception:
                    cf = 1
                next_wait_sec = _next_wait_after_failure(cf)
                servicemanager.LogInfoMsg(
                    f"check-in failed (consecutive={cf}); next attempt in {next_wait_sec // 60} min"
                )
            else:
                next_wait_sec = CHECKIN_INTERVAL_SEC

            # Sleep until either next_wait_sec elapses or stop is signaled.
            wait = win32event.WaitForSingleObject(self.stop_event, next_wait_sec * 1000)
            if wait == win32event.WAIT_OBJECT_0:
                return


def _spawn_uninstaller():
    """Detach the uninstaller so it can remove our own service while we
    exit cleanly. Inno Setup drops `unins000.exe` into the install dir.

    Probes both the current install path (Umbrella Watchtower) and the
    legacy path (Watchtower) — installs from v0.1.0 land at the legacy
    path, and re-running their installer won't relocate them since
    Inno Setup honors the existing install location for the same AppId.
    """
    candidates = [
        r"C:\Program Files\Umbrella Watchtower\unins000.exe",
        r"C:\Program Files (x86)\Umbrella Watchtower\unins000.exe",
        r"C:\Program Files\Watchtower\unins000.exe",            # legacy
        r"C:\Program Files (x86)\Watchtower\unins000.exe",      # legacy
    ]
    for p in candidates:
        if os.path.exists(p):
            # /SILENT runs without prompts; /NORESTART avoids a forced reboot.
            subprocess.Popen(
                [p, "/SILENT", "/NORESTART"],
                creationflags=0x00000008,  # DETACHED_PROCESS
            )
            return


if __name__ == "__main__":
    # Four modes:
    #   watchtower-svc.exe install         — registers the service
    #   watchtower-svc.exe start           — starts it
    #   watchtower-svc.exe debug           — runs in foreground for development
    #   watchtower-svc.exe --checkin-once  — runs ONE check-in inline and exits.
    #     Bypasses the SCM entirely. Useful for diagnosing "service is
    #     running but state.json never appears" -- you see the traceback
    #     in the console + the run is appended to watchtower.log. Safe
    #     to run while the service is alive; the file lock in
    #     checkin.run_checkin() prevents overlap.
    if len(sys.argv) == 2 and sys.argv[1] == "--checkin-once":
        result = checkin.run_checkin()
        import json as _json
        print(_json.dumps(result, indent=2, default=str))
        sys.exit(0 if result.get("ok") else 1)
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(WatchtowerService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(WatchtowerService)
