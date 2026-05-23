"""
updater.py — agent self-update.

Two entry points:
  - check_for_update(worker_url) returns the latest-version payload
    without doing anything else (used by the tray "Check for updates"
    menu item).
  - apply_update_if_needed(worker_url, current_version, install_token,
                           force=False) does the full flow: check,
    compare semver, download, verify SHA256, spawn installer.

When invoked from the service (LocalSystem), the spawned installer
inherits LocalSystem rights, runs as expected, stops the existing
WatchtowerAgent service, replaces the binary, and restarts the
service. When invoked from the tray (user session), the spawned
installer prompts for UAC unless we're already elevated.

Safety guarantees:
  - SHA256 mismatch -> refuse to run. Worker controls what the
    expected hash is; only an admin who has BOTH Firestore write AND
    GitHub repo push can manipulate both sides.
  - Downgrade attempts blocked. Compare semver; only proceed if the
    advertised version is strictly newer.
  - All failures are recoverable. If anything goes wrong before the
    installer is spawned, the running agent is untouched.
"""

import os
import re
import sys
import tempfile
import hashlib
import subprocess

import requests


class UpdateError(Exception):
    pass


def _semver_tuple(v):
    """Best-effort semver parse: '0.9.0' -> (0, 9, 0). Handles 'wt_' prefix
    and trailing labels (e.g. '0.9.0-beta1') by stripping non-numeric tails."""
    if not v:
        return (0, 0, 0)
    # Strip leading 'v' or 'watchtower-v' if present
    v = re.sub(r"^(watchtower-)?v", "", str(v).strip(), flags=re.IGNORECASE)
    # Split on dot, take leading-numeric portion of each part
    parts = []
    for p in v.split(".")[:3]:
        m = re.match(r"^(\d+)", p)
        parts.append(int(m.group(1)) if m else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_newer(advertised, current):
    """Returns True iff advertised version is strictly greater than current."""
    return _semver_tuple(advertised) > _semver_tuple(current)


def check_for_update(worker_url, timeout=15):
    """Calls worker /latest-version. Returns dict with keys version,
    downloadUrl, sha256, notes — or raises UpdateError on failure."""
    url = worker_url.rstrip("/") + "/latest-version"
    try:
        r = requests.get(url, timeout=timeout)
    except requests.RequestException as e:
        raise UpdateError(f"network error: {e}")
    if not r.ok:
        raise UpdateError(f"HTTP {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except ValueError:
        raise UpdateError(f"non-JSON response: {r.text[:200]}")
    if not data.get("ok"):
        raise UpdateError(data.get("error", "no latest version available"))
    for required in ("version", "downloadUrl", "sha256"):
        if not data.get(required):
            raise UpdateError(f"latest-version response missing field: {required}")
    return data


def _download_with_progress(url, dest_path, timeout=300):
    """Streams the EXE to disk. 5-minute total timeout — typical installer
    is 50-100 MB so even on a slow link 5 min is generous."""
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            if not r.ok:
                raise UpdateError(f"download HTTP {r.status_code}")
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 64):
                    if chunk:
                        f.write(chunk)
    except requests.RequestException as e:
        raise UpdateError(f"download network error: {e}")


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 64), b""):
            h.update(chunk)
    return h.hexdigest().lower()


def apply_update_if_needed(worker_url, current_version, install_token, force=False):
    """Full update flow. Returns a dict describing what happened:
        { applied: True,  version: "0.9.0" } on success (installer spawned)
        { applied: False, reason: "up-to-date", current: "...", latest: "..." }
        { applied: False, reason: "no-config-token" } if install_token is empty
    Raises UpdateError if something went wrong fetching / verifying.

    `force=True` skips the version comparison and reinstalls even if the
    advertised version isn't newer — used by the tray when the operator
    explicitly clicks "Reinstall" / "Check for updates" on a host that's
    already current."""
    info = check_for_update(worker_url)
    latest = info["version"]

    if not force and not is_newer(latest, current_version):
        return {"applied": False, "reason": "up-to-date", "current": current_version, "latest": latest}

    if not install_token:
        # Without the install token we can't re-run the installer
        # silently — it would prompt for one in the wizard.
        return {"applied": False, "reason": "no-config-token", "latest": latest}

    # Download to %TEMP%
    dest = os.path.join(tempfile.gettempdir(), f"Watchtower-Setup-update-{latest}.exe")
    _download_with_progress(info["downloadUrl"], dest)

    # Verify hash before doing anything else with the file
    got = _sha256_file(dest)
    expected = (info["sha256"] or "").lower()
    if got != expected:
        try:
            os.remove(dest)
        except OSError:
            pass
        raise UpdateError(f"sha256 mismatch: expected {expected[:12]}..., got {got[:12]}...")

    # Spawn installer detached so the existing service can exit cleanly
    # when the installer's [UninstallRun] eventually stops it. /TOKEN
    # reuses the existing install token so no operator interaction
    # required. /COMPONENTS="" (no Tasks override) defaults to whatever
    # Tasks the original install had — we don't want to surprise-install
    # LogMeIn during an update if it wasn't part of the original.
    args = [
        dest,
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        f"/TOKEN={install_token}",
        '/TASKS=""',  # opt out of any newly-added optional tasks; updates should be conservative
    ]
    # CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS so the installer survives
    # the parent (this Python process) exiting when the WatchtowerAgent
    # service gets stopped by the installer.
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    subprocess.Popen(
        args,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )

    return {"applied": True, "version": latest, "from": current_version}
