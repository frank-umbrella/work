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

try:
    import logger as _logger
except ImportError:
    # Standalone testing -- logger ships in the agent bundle but the
    # updater module is occasionally imported in isolation (CLI utility,
    # unit test). Stub so nothing crashes.
    class _Stub:
        def log(self, *a, **kw): pass
    _logger = _Stub()


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
    _logger.log(f"updater.check_for_update: GET {url}")
    try:
        r = requests.get(url, timeout=timeout)
    except requests.RequestException as e:
        _logger.log(f"updater.check_for_update: network error: {e}")
        raise UpdateError(f"network error: {e}")
    if not r.ok:
        _logger.log(f"updater.check_for_update: HTTP {r.status_code} body={r.text[:200]!r}")
        raise UpdateError(f"HTTP {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except ValueError:
        _logger.log(f"updater.check_for_update: non-JSON body={r.text[:200]!r}")
        raise UpdateError(f"non-JSON response: {r.text[:200]}")
    if not data.get("ok"):
        _logger.log(f"updater.check_for_update: worker ok=False error={data.get('error')!r}")
        raise UpdateError(data.get("error", "no latest version available"))
    for required in ("version", "downloadUrl", "sha256"):
        if not data.get(required):
            _logger.log(f"updater.check_for_update: missing required field {required!r}")
            raise UpdateError(f"latest-version response missing field: {required}")
    _logger.log(
        f"updater.check_for_update: OK version={data.get('version')} "
        f"sha256={(data.get('sha256') or '')[:12]}... source={data.get('source')} "
        f"sha256Source={data.get('sha256Source')} staleFallback={data.get('staleFallback')}"
    )
    return data


def _download_with_progress(url, dest_path, timeout=300):
    """Streams the EXE to disk. 5-minute total timeout — typical installer
    is 50-100 MB so even on a slow link 5 min is generous."""
    _logger.log(f"updater._download: GET {url} -> {dest_path}")
    bytes_written = 0
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            if not r.ok:
                _logger.log(f"updater._download: HTTP {r.status_code}")
                raise UpdateError(f"download HTTP {r.status_code}")
            with open(dest_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 64):
                    if chunk:
                        f.write(chunk)
                        bytes_written += len(chunk)
    except requests.RequestException as e:
        _logger.log(f"updater._download: network error after {bytes_written} bytes: {e}")
        raise UpdateError(f"download network error: {e}")
    _logger.log(f"updater._download: OK wrote {bytes_written} bytes")


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
    _logger.log(
        f"updater.apply_update_if_needed: starting (current={current_version} "
        f"force={force} have_token={bool(install_token)})"
    )
    info = check_for_update(worker_url)
    latest = info["version"]

    if not force and not is_newer(latest, current_version):
        _logger.log(f"updater.apply_update_if_needed: up-to-date (current={current_version} latest={latest})")
        return {"applied": False, "reason": "up-to-date", "current": current_version, "latest": latest}

    if not install_token:
        # Without the install token we can't re-run the installer
        # silently — it would prompt for one in the wizard.
        _logger.log("updater.apply_update_if_needed: no install_token, refusing to update silently")
        return {"applied": False, "reason": "no-config-token", "latest": latest}

    # Download to %TEMP%
    dest = os.path.join(tempfile.gettempdir(), f"Watchtower-Setup-update-{latest}.exe")
    _download_with_progress(info["downloadUrl"], dest)

    # Verify hash before doing anything else with the file
    got = _sha256_file(dest)
    expected = (info["sha256"] or "").lower()
    _logger.log(f"updater.apply_update_if_needed: sha256 check expected={expected[:16]}... got={got[:16]}...")
    if got != expected:
        try:
            os.remove(dest)
        except OSError:
            pass
        _logger.log(f"updater.apply_update_if_needed: SHA MISMATCH -- refusing to spawn installer")
        raise UpdateError(f"sha256 mismatch: expected {expected[:12]}..., got {got[:12]}...")

    # Inno Setup log location -- writes a verbose install transcript to
    # %ProgramData%\Watchtower\install.log. Path is stable so post-failure
    # diagnostics (and the Save Diagnostic Report .cmd) always know where
    # to look. Without /LOG the installer is silent on every error mode --
    # PrepareToInstall failures, token re-validation failures, file
    # extraction errors, [Run] sc.exe failures -- all invisible.
    install_log_dir = r"C:\ProgramData\Watchtower"
    try:
        os.makedirs(install_log_dir, exist_ok=True)
    except OSError:
        pass
    install_log_path = os.path.join(install_log_dir, "install.log")

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
        f"/LOG={install_log_path}",
    ]
    # CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS so the installer survives
    # the parent (this Python process) exiting when the WatchtowerAgent
    # service gets stopped by the installer.
    DETACHED_PROCESS = 0x00000008
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    # Log a redacted version of the args (token elided) before spawn so
    # we have a record of exactly what was attempted even if the spawn
    # call itself silently failed.
    redacted = [a if not a.startswith("/TOKEN=") else "/TOKEN=<redacted>" for a in args]
    _logger.log(f"updater.apply_update_if_needed: spawning installer args={redacted}")
    try:
        proc = subprocess.Popen(
            args,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )
        _logger.log(f"updater.apply_update_if_needed: installer spawned pid={proc.pid}, install log -> {install_log_path}")
    except OSError as e:
        _logger.log(f"updater.apply_update_if_needed: installer spawn FAILED: {e}")
        raise UpdateError(f"installer spawn failed: {e}")

    return {"applied": True, "version": latest, "from": current_version}
