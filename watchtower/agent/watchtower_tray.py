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


def _read_version():
    """Reads agent/VERSION at runtime so the tray's tooltip + right-click
    menu show the exact running version. Mirrors checkin.py's resolver
    without importing checkin (which would drag in requests / collector /
    every probe at tray startup). Bundled into the EXE via PyInstaller's
    --add-data VERSION;. flag in build.ps1."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(base, "VERSION"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "unknown"


AGENT_VERSION = _read_version()


POLL_INTERVAL_SEC = 30
BLINK_INTERVAL_SEC = 1.0       # critical-state icon flip interval
RUN_NOW_MARKER = cfg_mod.DATA_DIR / ".run-now"

# Startup breadcrumb. Each tray launch appends a single line to this
# file with: timestamp, agent version, PID, process owner (best-effort
# via USERNAME env var). Catches the "tray launched but never appeared
# in the taskbar" case -- if the file has a recent entry but no tray
# is visible, the tray started + died before reaching Shell_NotifyIcon.
# If the file has NO recent entry post-install, [Run]'s tray launch
# never actually fired.
_TRAY_STARTUP_LOG = cfg_mod.DATA_DIR / "tray-startup.log"


def _log_tray_startup(stage):
    """Append a stage marker to the startup log. Failure-tolerant --
    a logging glitch must never prevent the tray from launching."""
    import datetime as _dt
    try:
        cfg_mod.DATA_DIR.mkdir(parents=True, exist_ok=True)
        ts = _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        pid = os.getpid()
        owner = os.environ.get("USERNAME", "?")
        line = f"{ts} stage={stage} pid={pid} owner={owner} version={AGENT_VERSION}\n"
        # Keep the file from growing unbounded -- truncate at ~64 KB.
        # Rare for a tray to accumulate that much (each line is ~80 B).
        try:
            if _TRAY_STARTUP_LOG.exists() and _TRAY_STARTUP_LOG.stat().st_size > 65536:
                # Keep last ~half. Cheap rotation.
                with open(_TRAY_STARTUP_LOG, "rb") as f:
                    f.seek(-32768, os.SEEK_END)
                    tail = f.read()
                with open(_TRAY_STARTUP_LOG, "wb") as f:
                    f.write(b"... earlier lines truncated ...\n")
                    f.write(tail)
        except OSError:
            pass
        with open(_TRAY_STARTUP_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        # Logging failures must never stop tray startup.
        pass


# First breadcrumb -- fires as soon as the module is imported, BEFORE
# any pystray/PIL initialization that could blow up.
_log_tray_startup("imported")

# Dashboard URL — surfaced as a tray menu item so users can jump
# to the management page. Empty string means "no dashboard link"
# (e.g. when the dashboard isn't deployed yet).
DASHBOARD_URL = "https://frank-umbrella.github.io/work/watchtower/"


def _hex_to_rgba(hex_str, alpha=255):
    """`#rrggbb` -> (r, g, b, alpha) tuple for PIL."""
    h = hex_str.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


# Brand palette + alert palette. Same colors the dashboard uses for
# the favicon variants (see Watchtower brand.html "Alert states").
TEAL = "#0a6b6b"
WHITE = (255, 255, 255, 255)
CYAN  = "#5af4e3"   # OK beacon
AMBER = "#f59e0b"   # Warn disc (Warn B sawtooth)
AMBER_CRACK = "#b45309"
RED   = "#b91c1c"   # Crit disc (Crit G crumbling)
DARK_BEACON = "#450a0a"  # critical "beacon failed" dim red-brown
RED_CRACK = "#7f1d1d"


def _make_icon_ok():
    """OK state: the existing Watchtower mark (teal disc, intact tower,
    glowing cyan beacon). Drawn pixel-for-pixel from favicon.svg geometry.
    """
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Disc + soft cyan halo behind the body (matches favicon.svg)
    d.ellipse((2, 2, 62, 62), fill=TEAL)
    d.ellipse((22, 22, 42, 42), fill=_hex_to_rgba(CYAN, 90))

    # Crenellations (4) + platform + body
    for x in (18, 26, 34, 42):
        d.rectangle((x, 14, x + 4, 20), fill=WHITE)
    d.rectangle((16, 20, 48, 24), fill=WHITE)
    d.rectangle((20, 24, 44, 54), fill=WHITE)

    # Beacon (cyan = healthy)
    d.ellipse((28, 28, 36, 36), fill=CYAN)

    # Arrow slits + arched door (cut-outs in teal)
    d.rectangle((24, 38, 27, 46), fill=TEAL)
    d.rectangle((37, 38, 40, 46), fill=TEAL)
    d.pieslice((28, 46, 36, 54), 180, 360, fill=TEAL)
    d.rectangle((28, 50, 36, 54), fill=TEAL)
    return img


def _make_icon_warn():
    """Warn state: 'Warn B' design from the alert-icon previews.
    Amber disc, crenellations chipped at sawtooth heights, cyan beacon
    still glowing (host is wounded but still phoning home). Hairline
    cracks scattered on the wall. Static (no blink) per the design --
    blinking amber reads as panicky for a 'eyes-eventually' state.
    """
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Amber disc
    d.ellipse((2, 2, 62, 62), fill=AMBER)

    # Sawtooth crenellations (#1 chipped to h=4, #2 to h=2, #3 full,
    # #4 to h=3). Matches Warn B SVG geometry from the previews file.
    d.rectangle((18, 16, 22, 20), fill=WHITE)   # h=4
    d.rectangle((26, 18, 30, 20), fill=WHITE)   # h=2
    d.rectangle((34, 15, 38, 20), fill=WHITE)   # h=5
    d.rectangle((42, 17, 46, 20), fill=WHITE)   # h=3

    # Top bar + full wall (warn keeps the wall intact)
    d.rectangle((16, 20, 48, 24), fill=WHITE)
    d.rectangle((20, 24, 44, 54), fill=WHITE)

    # Beacon still glowing cyan -- amber disc + cyan beacon is the
    # high-contrast complementary pair the favicon uses.
    d.ellipse((28, 28, 36, 36), fill=CYAN)

    # Hairline cracks (dark amber, thin zigzags)
    d.line([(24, 30), (23, 33), (24, 36)], fill=AMBER_CRACK, width=1)
    d.line([(40, 34), (38, 37), (40, 41)], fill=AMBER_CRACK, width=1)

    # Arrow slits + arched door (amber cut-outs since the disc is amber)
    d.rectangle((24, 38, 27, 46), fill=AMBER)
    d.rectangle((37, 38, 40, 46), fill=AMBER)
    d.pieslice((28, 46, 36, 54), 180, 360, fill=AMBER)
    d.rectangle((28, 50, 36, 54), fill=AMBER)
    return img


def _make_icon_crit():
    """Critical state: 'Crit G' design from the previews. Red disc,
    top-right corner crumbling in a 3-step staircase, round hole
    punched through the wall, DARK beacon (the failed signal that
    differentiates crit from warn), single vertical crack down the
    side. Alternates with the OK icon every BLINK_INTERVAL_SEC to
    grab attention.
    """
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Red disc
    d.ellipse((2, 2, 62, 62), fill=RED)

    # Crenellations: #1, #2 intact; #3 chipped to h=3; #4 GONE
    d.rectangle((18, 14, 22, 20), fill=WHITE)
    d.rectangle((26, 14, 30, 20), fill=WHITE)
    d.rectangle((34, 17, 38, 20), fill=WHITE)
    # #4 omitted

    # Top bar with a small jagged right edge (Crit G geometry).
    # Draw the main bar then a small zigzag tip.
    d.polygon([(16, 20), (40, 20), (41, 22), (39, 24), (16, 24)], fill=WHITE)

    # Wall with 3-step crumbling staircase at the top-right corner.
    # Path mirrors the picked Crit G SVG (36->39->42->44).
    d.polygon([
        (20, 24), (36, 24), (36, 28), (39, 28), (39, 31),
        (42, 31), (42, 34), (44, 34), (44, 54), (20, 54),
    ], fill=WHITE)

    # Dark beacon (the "signal failed" cue). Sits slightly left because
    # the wall's missing chunk on the right pulls the beacon's visual
    # center inward.
    d.ellipse((26, 31, 32, 37), fill=DARK_BEACON)

    # Round hole punched through the wall (cannon-shot look) -- shows
    # the red disc through the white wall.
    d.ellipse((34, 38, 38, 42), fill=RED)

    # Vertical crack running down from below the hole
    d.line([(30, 38), (28, 42), (30, 46), (28, 50)], fill=RED_CRACK, width=1)

    # Single arrow slit (the right one is absorbed into the hole/chunk)
    d.rectangle((24, 42, 27, 48), fill=RED)

    # Arched door (still red since the disc is red)
    d.pieslice((28, 46, 36, 54), 180, 360, fill=RED)
    d.rectangle((28, 50, 36, 54), fill=RED)
    return img


# Cache the three variants -- they're identical between renders so
# there's no reason to redraw the PIL canvas on every poll tick.
_ICON_CACHE = {}


def _icon_for(state_kind):
    """Returns the cached PIL Image for one of 'ok' / 'warn' / 'crit'."""
    if state_kind not in _ICON_CACHE:
        if state_kind == "warn":
            _ICON_CACHE[state_kind] = _make_icon_warn()
        elif state_kind == "crit":
            _ICON_CACHE[state_kind] = _make_icon_crit()
        else:
            _ICON_CACHE[state_kind] = _make_icon_ok()
    return _ICON_CACHE[state_kind]


def _host_health_state(state):
    """Returns 'ok' / 'warn' / 'crit' for the current local host. Reads
    the precomputed state['hostHealthState'] field that checkin.py
    writes after each check-in. Falls back to a coarse derivation from
    state.json's other fields when the field is absent (older agent
    state.json's from before the field was added).
    """
    if not state:
        return "ok"
    # Pre-computed by checkin.py (v0.14.28+)
    precomputed = state.get("hostHealthState")
    if precomputed in ("ok", "warn", "crit"):
        return precomputed
    # Fallback for older state.json shapes -- mirror the previous
    # tray logic so the icon doesn't go blank during upgrade.
    if not state.get("ok", False):
        return "crit"
    last = state.get("lastCheckinAt")
    if last:
        try:
            last_ts = time.strptime(last, "%Y-%m-%dT%H:%M:%SZ")
            delta_h = (time.time() - time.mktime(last_ts)) / 3600.0
            if delta_h > 30:
                return "warn"
        except ValueError:
            pass
    return "ok"


def _tooltip(state):
    # Version + state in one line. Windows tray tooltips are capped at
    # 128 chars on Win7 and 256+ on later versions; we comfortably fit
    # below both with the short timestamps we emit.
    ver = f"v{AGENT_VERSION}"
    if not state:
        return f"Umbrella Watchtower {ver} -- never checked in"
    if not state.get("ok", True):
        return f"Umbrella Watchtower {ver} -- error: {state.get('error', 'unknown')}"
    last = state.get("lastCheckinAt") or "never"
    ip = (state.get("lastReport") or {}).get("externalIp") or "?"
    return f"Umbrella Watchtower {ver} -- last check-in {last} (IP {ip})"


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
    """Background thread: re-renders the icon + tooltip on a 30s cadence
    AND handles the 1-second blink flip when this host is in a critical
    state. Single thread keeps the implementation simple -- the blink
    case just uses a faster inner loop with the same outer 30s check.

    Behavior per health state:
      ok    static OK icon (teal disc, glowing cyan beacon)
      warn  static Warn B icon (amber sawtooth, beacon still cyan)
      crit  Crit G icon ALTERNATING with the OK icon every BLINK_INTERVAL_SEC
            so the tray catches the operator's eye even at-a-glance
    """
    blink_phase = 0  # 0 = alert variant, 1 = OK variant (the flip frame)
    while getattr(icon, "_keep_polling", True):
        state = cfg_mod.load_state()
        kind = _host_health_state(state)
        icon.title = _tooltip(state)

        if kind == "crit":
            # Blink loop. Flips between the crit icon and the OK icon
            # at BLINK_INTERVAL_SEC. The 30-second outer poll re-reads
            # state.json after blink_ticks * BLINK_INTERVAL_SEC seconds.
            blink_ticks = int(POLL_INTERVAL_SEC / BLINK_INTERVAL_SEC)
            for _ in range(blink_ticks):
                if not getattr(icon, "_keep_polling", True):
                    return
                icon.icon = _icon_for("crit" if blink_phase == 0 else "ok")
                blink_phase = 1 - blink_phase
                time.sleep(BLINK_INTERVAL_SEC)
        else:
            # Static icon for ok / warn. Reset blink phase so the next
            # crit transition starts on the alert frame.
            icon.icon = _icon_for(kind)
            blink_phase = 0
            for _ in range(POLL_INTERVAL_SEC):
                if not getattr(icon, "_keep_polling", True):
                    return
                time.sleep(1)


def main():
    initial_state = cfg_mod.load_state()
    # Hostname header + version line (both disabled MenuItems -- pystray
    # uses `enabled=False` callbacks to render a non-clickable label).
    # Operator opens the tray and immediately knows which box they're on
    # (matters on RDP sessions to dozens of customer servers where the
    # taskbar is all anonymous icons) AND which agent version is
    # actually running (matters when "did the auto-update apply?" is
    # the support question).
    hostname = socket.gethostname()
    menu = pystray.Menu(
        pystray.MenuItem(
            f"Watchtower on {hostname}",
            lambda i, it: None,
            enabled=False,
            default=False,
        ),
        pystray.MenuItem(
            f"Agent v{AGENT_VERSION}",
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
        icon=_icon_for(_host_health_state(initial_state)),
        title=_tooltip(initial_state),
        menu=menu,
    )
    _log_tray_startup("icon_created")
    icon._keep_polling = True
    t = threading.Thread(target=_poll_loop, args=(icon,), daemon=True)
    t.start()
    _log_tray_startup("entering_run_loop")
    try:
        icon.run()
        _log_tray_startup("run_loop_exited_normally")
    except Exception as e:
        _log_tray_startup(f"run_loop_exception:{e}")
        raise
    finally:
        icon._keep_polling = False


if __name__ == "__main__":
    try:
        _log_tray_startup("main_called")
        main()
    except Exception as e:
        # Best-effort capture of any startup-time exception that would
        # otherwise vanish into the void (no stderr when launched via
        # runhidden + nowait from Inno's [Run] section).
        _log_tray_startup(f"main_exception:{type(e).__name__}:{e}")
        raise
