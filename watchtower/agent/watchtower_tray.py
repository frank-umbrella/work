"""
watchtower_tray.py — system tray icon for the interactive user.

Reads %ProgramData%\\Watchtower\\state.json every 30 seconds and
updates the tray icon + tooltip + menu accordingly. Does NOT collect
data itself — that's the service's job. The tray's only purpose is to
make the agent visible ("yes, it's installed and reporting") and to
expose a manual "Check now" option that asks the service to run an
out-of-schedule check-in.

Triggering an out-of-schedule check-in: writes a marker file at
%ProgramData%\\Watchtower\\.run-now so the service picks it up on its
next wake; if the user wants immediate, they can stop+start the service
from services.msc. (A proper named-pipe IPC is a v0.2.0 improvement.)
"""

import os
import socket
import subprocess
import sys
import time
import threading
import webbrowser
from pathlib import Path

from PIL import Image, ImageDraw
import pystray

import config as cfg_mod


POLL_INTERVAL_SEC = 30
RUN_NOW_MARKER = cfg_mod.DATA_DIR / ".run-now"

# Dashboard URL — surfaced as a tray menu item so users can jump
# to the management page. Empty string means "no dashboard link"
# (e.g. when the dashboard isn't deployed yet).
DASHBOARD_URL = "https://frank-umbrella.github.io/work/watchtower/"


def _make_icon(beacon_hex):
    """Draw the Watchtower crenellated tower icon (matches favicon.svg
    structure) on a 64x64 RGBA canvas. The ONLY thing that varies by
    health status is the beacon-and-halo color -- the rest of the icon
    (teal disc, white tower silhouette, arrow slits, door) stays
    constant so the brand reads the same in tray, browser tab, and
    installer wizard. Hover the tray icon for human-readable status.

    Status palette via beacon color:
      cyan   #5af4e3  -- healthy (default favicon color)
      amber  #d99c2a  -- stale (>30h since last check-in)
      red    #d04646  -- agent error / unreachable worker
      grey   #8a8a8a  -- unknown / never checked in

    Geometry mirrors favicon.svg's viewBox 0 0 64 64. Hand-drawn in PIL
    rather than rasterized via cairosvg to keep the tray EXE small
    (cairosvg would pull in libcairo and inflate the PyInstaller bundle).
    """
    TEAL = "#0a6b6b"
    WHITE = (255, 255, 255, 255)

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Disc background (matches favicon.svg circle cx=32 cy=32 r=30)
    d.ellipse((2, 2, 62, 62), fill=TEAL)

    # Beacon halo behind the body (subtle status-colored glow). PIL
    # doesn't draw soft alpha gradients cheaply, so we use a single
    # 50%-opacity disc -- close enough at tray size.
    halo_rgba = _hex_to_rgba(beacon_hex, 90)
    d.ellipse((22, 22, 42, 42), fill=halo_rgba)

    # Crenellations across the top (4 small white rects)
    for x in (18, 26, 34, 42):
        d.rectangle((x, 14, x + 4, 20), fill=WHITE)
    # Battlement platform under the crenellations
    d.rectangle((16, 20, 48, 24), fill=WHITE)
    # Tower body
    d.rectangle((20, 24, 44, 54), fill=WHITE)

    # Glowing beacon at center of body -- the status indicator
    d.ellipse((28, 28, 36, 36), fill=beacon_hex)

    # Arrow-slit windows flanking the beacon (cut-out style: teal-on-white)
    d.rectangle((24, 38, 27, 46), fill=TEAL)
    d.rectangle((37, 38, 40, 46), fill=TEAL)

    # Arched door at the base of the tower. PIL doesn't have a quadratic
    # bezier primitive at this version level, so approximate the arch with
    # a pieslice clipped against a rectangle: draws the top half of a
    # circle, with the flat bottom forming the door's base.
    d.pieslice((28, 46, 36, 54), 180, 360, fill=TEAL)
    d.rectangle((28, 50, 36, 54), fill=TEAL)

    return img


def _hex_to_rgba(hex_str, alpha):
    """`#rrggbb` -> (r, g, b, alpha) tuple for PIL."""
    h = hex_str.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


GREEN = "#1bb978"
AMBER = "#d99c2a"
RED = "#d04646"
GREY = "#8a8a8a"


def _status_color(state):
    if not state:
        return GREY
    if not state.get("ok", False):
        return RED
    last = state.get("lastCheckinAt")
    if not last:
        return GREY
    # Anything older than 30h = amber (we expect a check-in every 24h).
    try:
        last_ts = time.strptime(last, "%Y-%m-%dT%H:%M:%SZ")
        delta_h = (time.time() - time.mktime(last_ts)) / 3600.0
        if delta_h > 30:
            return AMBER
    except ValueError:
        pass
    return GREEN


def _tooltip(state):
    if not state:
        return "Umbrella Watchtower — never checked in"
    if not state.get("ok", True):
        return f"Umbrella Watchtower — error: {state.get('error', 'unknown')}"
    last = state.get("lastCheckinAt") or "never"
    ip = (state.get("lastReport") or {}).get("externalIp") or "?"
    return f"Umbrella Watchtower — last check-in {last} (IP {ip})"


def _on_check_now(icon, item):
    """Drop a marker file so the service picks up an unscheduled check-in
    next time it loops. (In v0.1.0 the service's loop tick is daily, so
    'check now' really means 'next time the service wakes up.')"""
    try:
        cfg_mod.DATA_DIR.mkdir(parents=True, exist_ok=True)
        RUN_NOW_MARKER.touch(exist_ok=True)
    except OSError:
        pass


def _on_check_for_updates(icon, item):
    """Manual update check. Fetches latest version from worker, compares
    to currently-installed version. If newer, downloads + verifies +
    spawns the installer silently using the install token from
    config.json. No-op if already up-to-date.

    Runs in this tray process (per-user session), so UAC may pop up
    when the spawned installer needs admin elevation."""
    try:
        cfg = cfg_mod.load_config()
        # Lazy import — keeps tray startup snappy (updater pulls in requests).
        import updater
        import checkin as _checkin  # for AGENT_VERSION
        result = updater.apply_update_if_needed(
            worker_url=cfg["workerUrl"],
            current_version=_checkin.AGENT_VERSION,
            install_token=cfg.get("installToken"),
        )
        if result.get("applied"):
            icon.notify(f"Update {result['from']} -> {result['version']} installing now.", "Watchtower update")
        elif result.get("reason") == "up-to-date":
            icon.notify(f"Up to date (v{result.get('current', '?')}).", "Watchtower update")
        else:
            icon.notify(f"No update applied: {result.get('reason', 'unknown')}", "Watchtower update")
    except Exception as e:
        try:
            icon.notify(f"Update check failed: {e}", "Watchtower update")
        except Exception:
            pass


def _on_open_dashboard(icon, item):
    if DASHBOARD_URL:
        webbrowser.open(DASHBOARD_URL)


def _on_show_status_file(icon, item):
    # Open the parent folder in Explorer so users / Frank can quickly
    # inspect state.json and config.json.
    folder = str(cfg_mod.DATA_DIR)
    os.startfile(folder)  # noqa: S606  (deliberate; folder is fixed)


def _on_save_diagnostic(icon, item):
    """Launches the bundled diagnostic launcher (.cmd self-elevates,
    runs diagnostic.ps1, writes timestamped .txt under %ProgramData%
    \\Watchtower, opens it in Notepad). No copy/paste needed -- the
    operator attaches the resulting .txt to support email."""
    # The installer drops the launcher at {app}\scripts\Save Diagnostic Report.cmd.
    # Locate the EXE's parent dir first, then probe both 'scripts'
    # subfolder + the EXE dir itself (legacy locations).
    candidates = []
    try:
        exe_dir = os.path.dirname(sys.executable)
        candidates.append(os.path.join(exe_dir, "scripts", "Save Diagnostic Report.cmd"))
        candidates.append(os.path.join(exe_dir, "Save Diagnostic Report.cmd"))
    except Exception:
        pass
    # Fall back to the standard install dirs in case sys.executable is
    # something unexpected (running from source, etc).
    for base in (
        r"C:\Program Files (x86)\Umbrella Watchtower",
        r"C:\Program Files\Umbrella Watchtower",
    ):
        candidates.append(os.path.join(base, "scripts", "Save Diagnostic Report.cmd"))

    for path in candidates:
        if os.path.exists(path):
            try:
                os.startfile(path)  # noqa: S606
            except OSError as e:
                # Surface to the user via a balloon notification rather
                # than crashing the tray.
                try:
                    icon.notify(f"Diagnostic launcher failed: {e}", "Watchtower")
                except Exception:
                    pass
            return

    try:
        icon.notify(
            "Diagnostic launcher not found. Update the agent to v0.14.13 or newer.",
            "Watchtower"
        )
    except Exception:
        pass


def _on_restart_service(icon, item):
    """Stop + start the WatchtowerAgent service via sc.exe. Self-elevates
    through PowerShell Start-Process -Verb RunAs so the operator gets a
    single UAC prompt instead of having to open an admin shell first.
    Use when the agent looks stuck (tray says 'never checked in' but the
    service is in the running state, or vice versa)."""
    ps_cmd = (
        "Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList "
        "'-NoProfile','-Command',"
        "'Stop-Service WatchtowerAgent -Force -EA SilentlyContinue; "
        "Start-Sleep 2; Start-Service WatchtowerAgent; "
        "Write-Host \"Watchtower service restarted.\" -ForegroundColor Green; "
        "Start-Sleep 3'"
    )
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-Command", ps_cmd],
            creationflags=0x08000000,  # CREATE_NO_WINDOW for the parent
        )
        try:
            icon.notify(
                "Restarting Watchtower service... UAC prompt incoming.",
                "Watchtower"
            )
        except Exception:
            pass
    except OSError as e:
        try:
            icon.notify(f"Restart failed: {e}", "Watchtower")
        except Exception:
            pass


def _on_quit(icon, item):
    icon.stop()


def _poll_loop(icon):
    """Background thread: re-renders the icon + tooltip every POLL_INTERVAL_SEC."""
    while getattr(icon, "_keep_polling", True):
        state = cfg_mod.load_state()
        icon.icon = _make_icon(_status_color(state))
        icon.title = _tooltip(state)
        for _ in range(POLL_INTERVAL_SEC):
            if not getattr(icon, "_keep_polling", True):
                return
            time.sleep(1)


def main():
    initial_state = cfg_mod.load_state()
    # Hostname header (disabled MenuItem -- pystray uses `enabled=False`
    # callbacks to render a non-clickable label). Operator opens the
    # tray and immediately knows which box they're on (matters on RDP
    # sessions to dozens of customer servers where the taskbar is
    # all anonymous icons).
    hostname = socket.gethostname()
    menu = pystray.Menu(
        pystray.MenuItem(
            f"Watchtower on {hostname}",
            lambda i, it: None,
            enabled=False,
            default=False,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Check now", _on_check_now),
        pystray.MenuItem("Check for updates", _on_check_for_updates),
        pystray.MenuItem("Open Watchtower dashboard", _on_open_dashboard),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Troubleshoot",
            pystray.Menu(
                pystray.MenuItem("Restart Watchtower service", _on_restart_service),
                pystray.MenuItem("Save diagnostic report...", _on_save_diagnostic),
                pystray.MenuItem("Show data folder", _on_show_status_file),
            ),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", _on_quit),
    )
    icon = pystray.Icon(
        "watchtower",
        icon=_make_icon(_status_color(initial_state)),
        title=_tooltip(initial_state),
        menu=menu,
    )
    icon._keep_polling = True
    t = threading.Thread(target=_poll_loop, args=(icon,), daemon=True)
    t.start()
    icon.run()
    icon._keep_polling = False


if __name__ == "__main__":
    main()
