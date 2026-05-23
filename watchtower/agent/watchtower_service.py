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


CHECKIN_INTERVAL_SEC = 24 * 60 * 60   # daily
STARTUP_DELAY_SEC = 30                # let the network come up first


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
            try:
                resp = checkin.run_checkin()
                if resp.get("uninstall"):
                    servicemanager.LogInfoMsg("Worker requested uninstall; spawning uninstaller and exiting.")
                    _spawn_uninstaller()
                    return
            except Exception as e:
                servicemanager.LogErrorMsg(f"check-in raised: {e}")

            # Sleep until either CHECKIN_INTERVAL_SEC elapses or stop is signaled.
            wait = win32event.WaitForSingleObject(self.stop_event, CHECKIN_INTERVAL_SEC * 1000)
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
    # Three modes:
    #   watchtower_service.py install   — registers the service
    #   watchtower_service.py start     — starts it
    #   watchtower_service.py debug     — runs in foreground for development
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(WatchtowerService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(WatchtowerService)
