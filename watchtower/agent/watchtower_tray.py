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


def _make_icon(color_hex):
    """Draw a small monochrome eye icon in the requested color. Loaded
    once and re-rendered when the status color needs to change."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Outer eye silhouette
    d.ellipse((6, 18, 58, 46), outline=color_hex, width=4)
    # Pupil
    d.ellipse((26, 24, 38, 40), fill=color_hex)
    return img


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
        return "Watchtower — never checked in"
    if not state.get("ok", True):
        return f"Watchtower — error: {state.get('error', 'unknown')}"
    last = state.get("lastCheckinAt") or "never"
    ip = (state.get("lastReport") or {}).get("externalIp") or "?"
    return f"Watchtower — last check-in {last} (IP {ip})"


def _on_check_now(icon, item):
    """Drop a marker file so the service picks up an unscheduled check-in
    next time it loops. (In v0.1.0 the service's loop tick is daily, so
    'check now' really means 'next time the service wakes up.')"""
    try:
        cfg_mod.DATA_DIR.mkdir(parents=True, exist_ok=True)
        RUN_NOW_MARKER.touch(exist_ok=True)
    except OSError:
        pass


def _on_open_dashboard(icon, item):
    if DASHBOARD_URL:
        webbrowser.open(DASHBOARD_URL)


def _on_show_status_file(icon, item):
    # Open the parent folder in Explorer so users / Frank can quickly
    # inspect state.json and config.json.
    folder = str(cfg_mod.DATA_DIR)
    os.startfile(folder)  # noqa: S606  (deliberate; folder is fixed)


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
    menu = pystray.Menu(
        pystray.MenuItem("Check now", _on_check_now),
        pystray.MenuItem("Open Watchtower dashboard", _on_open_dashboard),
        pystray.MenuItem("Show data folder", _on_show_status_file),
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
