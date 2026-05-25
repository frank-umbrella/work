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


def scrub_legacy_token_leaks():
    """Removes install tokens from existing install.log files. Earlier
    builds (<=v0.14.39) passed /TOKEN= on the command line, which Inno
    Setup echoes verbatim into install.log's header. That log lives in
    %ProgramData%\\Watchtower\\ with users-modify ACL -- any local user
    could read the token. This function is called once per agent boot
    to scrub any historical leaks. Idempotent / safe to call repeatedly.

    Replaces every occurrence of `wt_<43-base64-chars>` in install.log
    with `<redacted-by-scrub>`. Also redacts the legacy
    WATCHTOWER_INSTALL_TOKEN shared-secret form (any token after
    `/TOKEN=` up to whitespace) for older installers."""
    import re
    log_path = r"C:\ProgramData\Watchtower\install.log"
    if not os.path.exists(log_path):
        return
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        # Per-client token format: wt_<43 base64url chars>
        scrubbed = re.sub(r"wt_[A-Za-z0-9_\-]{40,}", "wt_<redacted-by-scrub>", content)
        # Legacy /TOKEN=<anything> shared-secret form
        scrubbed = re.sub(r"(/TOKEN=)\S+", r"\1<redacted-by-scrub>", scrubbed)
        if scrubbed != content:
            with open(log_path, "w", encoding="utf-8") as f:
                f.write(scrubbed)
            _logger.log(f"updater.scrub_legacy_token_leaks: redacted token(s) in {log_path}")
    except OSError as e:
        _logger.log(f"updater.scrub_legacy_token_leaks: skipped ({e})")


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

    # CRITICAL: do NOT pass the install token via the command line.
    # Inno Setup writes the entire command line into install.log as
    # part of its standard header -- and that log lives in
    # %ProgramData%\Watchtower\ which has users-modify permissions, so
    # any non-admin user on the box could read the token and use it to
    # silently install rogue agents that appear in the dashboard as
    # legitimate endpoints. Write the token to a stash file with
    # admin-only ACL, pass the file path instead; the installer's
    # [Code] reads it and deletes the stash on success.
    token_stash = os.path.join(install_log_dir, ".install-token.stash")
    try:
        # Write atomically + restrict ACL. We use icacls because
        # creating a Windows ACL from Python's stdlib alone is messy --
        # icacls.exe is universally available and predictable.
        with open(token_stash, "w", encoding="ascii") as f:
            f.write(install_token)
        # /inheritance:r removes inherited ACEs (so users-modify on the
        # parent dir doesn't grant anyone read access). Then explicit
        # grants for SYSTEM + Administrators only.
        subprocess.run(
            ["icacls.exe", token_stash,
             "/inheritance:r",
             "/grant:r", "SYSTEM:F",
             "/grant:r", "Administrators:F"],
            capture_output=True,
            timeout=15,
            creationflags=0x08000000,
        )
        _logger.log(f"updater.apply_update_if_needed: wrote token stash {token_stash} with admin-only ACL")
    except (OSError, subprocess.TimeoutExpired) as e:
        _logger.log(f"updater.apply_update_if_needed: token-stash write failed: {e}")
        raise UpdateError(f"could not write token stash: {e}")

    # Spawn installer detached so the existing service can exit cleanly
    # when the installer's [UninstallRun] eventually stops it. /TOKEN
    # reuses the existing install token so no operator interaction
    # required. /COMPONENTS="" (no Tasks override) defaults to whatever
    # Tasks the original install had — we don't want to surprise-install
    # LogMeIn during an update if it wasn't part of the original.
    # /TOKENFILE replaces the old /TOKEN= argument so the token never
    # appears in Inno's command-line log. The installer's [Code] reads
    # the file when /TOKENFILE= is present (falling back to /TOKEN= if
    # someone runs an older installer build manually).
    #
    # /SKIPVALIDATE=1 -- bypass the installer's in-process token
    # revalidation. THIS agent service just successfully validated the
    # token by check-in (the worker returned the config payload that
    # triggered this update). Re-validating from inside the spawned
    # installer is redundant AND fragile: observed on Server 2025
    # where the installer's WinHTTP COM throws connection errors even
    # though the same call from Python (this very process) succeeds.
    # The agent revalidates on every check-in, so a revoked token gets
    # caught on the agent side regardless.
    args = [
        dest,
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        f"/TOKENFILE={token_stash}",
        "/SKIPVALIDATE=1",
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
