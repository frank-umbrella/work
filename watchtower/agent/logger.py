"""
logger.py — tiny file-based logger for the Watchtower agent.

Writes timestamped lines to %ProgramData%\\Watchtower\\watchtower.log so
the operator can diagnose a wedged install (hung probe, bad token,
unreachable worker) WITHOUT having to attach a debugger or run the
service in debug mode. The file is appended to on every check-in.

Why not Python's `logging` module: it's overkill for our needs (we have
one file, one level, no rotation), pulls in stdlib config noise, and
the `logging.handlers.RotatingFileHandler` requires careful flush
discipline to survive a hard service kill. A 1-function appender that
flushes after every line is simpler and safer.

Why not Windows Event Log via servicemanager.LogInfoMsg: the service
ALREADY uses that for startup/stop events. Mixing per-line probe logs
in there would drown out the meaningful events and require operators
to filter event viewer for our provider. A file in ProgramData is
easier to tail with PowerShell.

Log rotation: when the file passes 2 MB, we rename it to .1 and start
fresh. We keep only one backup -- the agent isn't a high-traffic
service, so 2 MB of recent + one old generation is plenty for triage.
"""

import os
import sys
import time

try:
    # Reuse the same DATA_DIR resolution config.py uses so the log lives
    # alongside config.json + state.json. Avoids the LocalSystem vs.
    # interactive-Administrator ProgramData drift.
    import config as cfg_mod
    LOG_PATH = cfg_mod.DATA_DIR / "watchtower.log"
except Exception:
    # Fallback for the unlikely case config.py fails to import (e.g. if
    # logger is imported before sys.path is set up). Hard-coded path
    # matches what config.py would have computed anyway.
    LOG_PATH = None


MAX_BYTES = 2 * 1024 * 1024  # 2 MB before rotation


def _resolve_path():
    """Lazy path resolution -- config.py might not be importable when
    this module is first loaded under PyInstaller. Recomputes each call
    if it wasn't ready at import time."""
    global LOG_PATH
    if LOG_PATH is not None:
        return LOG_PATH
    try:
        import config as cfg_mod
        LOG_PATH = cfg_mod.DATA_DIR / "watchtower.log"
    except Exception:
        # Absolute last resort -- write next to the EXE so it's at least
        # findable by an operator who knows where Watchtower lives.
        base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
        LOG_PATH = os.path.join(base, "watchtower.log")
    return LOG_PATH


def _maybe_rotate(path):
    """If the log is too big, roll it to .1 (overwriting any existing
    .1). Best-effort -- a rotate failure isn't worth crashing the
    service over."""
    try:
        if os.path.exists(path) and os.path.getsize(path) > MAX_BYTES:
            backup = str(path) + ".1"
            try:
                if os.path.exists(backup):
                    os.remove(backup)
            except OSError:
                pass
            os.rename(path, backup)
    except OSError:
        pass


def log(msg):
    """Append a single timestamped line. Newline added automatically.
    Never raises -- diagnostic logging that crashes the agent is worse
    than no logging at all."""
    try:
        path = _resolve_path()
        if path is None:
            return
        # Make sure the parent dir exists before the first write.
        try:
            os.makedirs(os.path.dirname(str(path)), exist_ok=True)
        except OSError:
            pass
        _maybe_rotate(path)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{ts}Z {msg}\n")
            f.flush()
    except Exception:
        # Swallow everything. Logging must never break the agent.
        pass
