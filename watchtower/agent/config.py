"""
config.py — paths + read/write helpers for the agent's on-disk state.

Two files live under %ProgramData%\Watchtower\:

  config.json   — written by the installer (immutable at runtime).
                  Contains the install token, worker URL, client name,
                  and the stable per-install pcId UUID.

  state.json    — written by the service after each check-in.
                  Contains last-checkin timestamp, last external IP,
                  last response from the worker (config + uninstall flag),
                  and the most recent error if any. The tray reads this
                  every few seconds to refresh its menu.

Both files live in ProgramData (not %APPDATA%) because the service runs
as LocalSystem and the tray runs as the interactive user — they need a
shared location both can read.
"""

import json
import os
import uuid
from pathlib import Path


# %ProgramData%\Watchtower\ — created by the installer with the right ACL
# (service writes, users read). If we fall back to creating it here, we
# don't set the ACL — assume installer did its job.
PROGRAM_DATA = Path(os.environ.get("ProgramData", r"C:\ProgramData"))
DATA_DIR = PROGRAM_DATA / "Watchtower"
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / "state.json"
LOG_PATH = DATA_DIR / "watchtower.log"


def _ensure_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_config():
    """
    Returns the installer-baked configuration as a dict, or raises
    FileNotFoundError if the agent hasn't been properly installed.

    Expected shape:
      {
        "workerUrl": "https://watchtower-worker.sevendwarfs.workers.dev",
        "installToken": "<base64-32-bytes>",
        "client": "OPFD",
        "pcId": "<uuid>",
        "agentVersion": "0.1.0"
      }
    """
    _ensure_dir()
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(
            f"config.json missing at {CONFIG_PATH}. "
            "Was the agent installed via Watchtower-Setup.exe?"
        )
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    # The installer creates pcId on first run if it wasn't baked in
    # at build time (older installers won't have it). Self-heal.
    if not cfg.get("pcId"):
        cfg["pcId"] = str(uuid.uuid4())
        save_config(cfg)

    required = ("workerUrl", "installToken", "client", "pcId")
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        raise ValueError(f"config.json is missing required keys: {missing}")
    return cfg


def save_config(cfg):
    """Used for the pcId self-heal path and for installer testing only.
    Production code should treat config.json as installer-owned."""
    _ensure_dir()
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    tmp.replace(CONFIG_PATH)


def load_state():
    """Returns the most recent state dict, or an empty dict if none yet."""
    _ensure_dir()
    if not STATE_PATH.exists():
        return {}
    try:
        with STATE_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state):
    """Atomic-ish write: write to .tmp, then rename over the target.
    Tray polls state.json — never tear a half-written file in front of it."""
    _ensure_dir()
    tmp = STATE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp.replace(STATE_PATH)
