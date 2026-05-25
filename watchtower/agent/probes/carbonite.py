"""
probes/carbonite.py — Carbonite backup product detection + status.

Carbonite ships under several SKU names depending on the era and
target audience:
  - Carbonite Server Backup           (legacy on-prem server backup)
  - Carbonite Endpoint Backup         (workstation + small server)
  - Carbonite Safe                    (consumer)
  - Carbonite Safe Server Backup      (consumer-tier server)

Their installers all land under the standard Uninstall registry tree
with publisher "Carbonite" (or "Carbonite, Inc."). Service names vary
by product; we probe a candidate list.

v0.14.10+: in addition to presence/version/service-state, we now try
to capture two operational signals MSPs actually want to see on the
dashboard:

  * `protected` (bool | null) -- per Carbonite's own reporting, is
    the device currently in a protected state. Yes/no instead of
    "service is running" which is a weaker signal.
  * `filesProtected` (int | null) -- count of files Carbonite has
    enrolled in the backup set. Surfaces when growth flatlines (=
    something's not getting picked up).

Both are pulled best-effort from a handful of registry locations
Carbonite has used across products + versions. If none of them
contain a usable value the fields stay null and the dashboard
shows them as "unknown" -- never lie about a backup product.
"""

import json
import os
import re
import subprocess
import winreg

try:
    import logger as _logger
except ImportError:
    class _Stub:
        def log(self, *a, **kw): pass
    _logger = _Stub()


# Service candidates across Carbonite products.
SERVICE_CANDIDATES = [
    "CarboniteService",          # Endpoint Backup
    "Carbonite Server Backup",   # Server Backup (legacy)
    "CarboniteSafeBackup",       # Safe / consumer
    "EVault InfoStage Agent",    # very old SKU
]


# Registry locations where Carbonite has historically stored agent
# status. We try each with both the canonical value name AND a few
# variants because the property names have drifted across versions.
# Each entry is (hive, path, [value_names_to_try], parser).
# Parser is one of:
#   "bool_yn"  -- expect a REG_DWORD or REG_SZ that maps to bool (1/0,
#                 yes/no, true/false, Protected/NotProtected)
#   "int"      -- expect a numeric count
PROTECTED_VALUE_CANDIDATES = [
    # Endpoint Backup writes status under HKLM\SOFTWARE\Carbonite\BUEngine
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\BUEngine",
        ["IsProtected", "Protected", "BackupStatus", "Status"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\BUEngine",
        ["IsProtected", "Protected", "BackupStatus", "Status"]),
    # Some Server Backup versions stash status under \Status subkey
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\Status",
        ["IsProtected", "Protected", "State"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\Status",
        ["IsProtected", "Protected", "State"]),
    # Safe / consumer
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\Carbonite Safe Backup",
        ["IsProtected", "Protected", "BackupState"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\Carbonite Safe Backup",
        ["IsProtected", "Protected", "BackupState"]),
]

FILES_PROTECTED_VALUE_CANDIDATES = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\BUEngine",
        ["FilesProtected", "FileCount", "ProtectedFileCount", "NumFiles"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\BUEngine",
        ["FilesProtected", "FileCount", "ProtectedFileCount", "NumFiles"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\Status",
        ["FilesProtected", "FileCount", "TotalFiles"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\Status",
        ["FilesProtected", "FileCount", "TotalFiles"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Carbonite\Carbonite Safe Backup",
        ["FilesProtected", "FileCount", "BackedUpFileCount"]),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Carbonite\Carbonite Safe Backup",
        ["FilesProtected", "FileCount", "BackedUpFileCount"]),
]


def _service_state(name):
    try:
        r = subprocess.run(
            ["sc.exe", "query", name],
            capture_output=True, text=True, timeout=10,
            creationflags=0x08000000,
        )
        if "1060" in r.stdout or "does not exist" in r.stdout.lower():
            return None
        if "RUNNING" in r.stdout:
            return "running"
        if "STOPPED" in r.stdout:
            return "stopped"
        return "unknown"
    except (subprocess.TimeoutExpired, OSError):
        return None


def _detect_services():
    found = []
    for svc in SERVICE_CANDIDATES:
        state = _service_state(svc)
        if state is not None:
            found.append({"name": svc, "state": state})
    return found


def _read_reg_value(hive, path, name):
    """Returns the value (any type) or None if missing/inaccessible."""
    try:
        with winreg.OpenKey(hive, path, 0,
                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            v, _t = winreg.QueryValueEx(k, name)
            return v
    except (FileNotFoundError, OSError):
        return None


def _coerce_bool(raw):
    """Carbonite's status field has been REG_DWORD, REG_SZ, and BOOL across
    versions. Map all the common forms to a clean Python bool, return None
    for anything we can't confidently classify."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, int):
        if raw == 1:
            return True
        if raw == 0:
            return False
        return None
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("1", "true", "yes", "y", "protected", "ok", "active", "on"):
            return True
        if s in ("0", "false", "no", "n", "notprotected", "not protected",
                 "off", "disabled", "inactive"):
            return False
    return None


def _coerce_int(raw):
    """Tolerates REG_DWORD (already int), REG_SZ digits, REG_QWORD."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None  # don't treat True/False as 1/0 here
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str):
        s = raw.strip().replace(",", "")
        if s.isdigit():
            return int(s)
    return None


def _detect_protected():
    """Walk every candidate (path, value-name) until we find a usable
    value. Returns (protected_bool_or_none, source_string_or_none)."""
    for hive, path, names in PROTECTED_VALUE_CANDIDATES:
        for name in names:
            raw = _read_reg_value(hive, path, name)
            if raw is None:
                continue
            coerced = _coerce_bool(raw)
            if coerced is not None:
                _logger.log(f"  carbonite._detect_protected MATCH {path}\\{name} = {raw!r} -> {coerced}")
                return coerced, f"{path}\\{name}"
    # Fallback: recursive walk of HKLM\SOFTWARE\Carbonite looking for
    # ANY value whose name matches a protected-ish pattern. Useful
    # for Carbonite Endpoint v11+ where the value lives in a subkey
    # we haven't enumerated above. Substring match keeps it tolerant.
    return _walk_carbonite_for_protected()


def _detect_files_protected():
    for hive, path, names in FILES_PROTECTED_VALUE_CANDIDATES:
        for name in names:
            raw = _read_reg_value(hive, path, name)
            coerced = _coerce_int(raw)
            if coerced is not None and coerced >= 0:
                _logger.log(f"  carbonite._detect_files_protected MATCH {path}\\{name} = {raw!r}")
                return coerced, f"{path}\\{name}"
    return _walk_carbonite_for_file_count()


def _walk_subtree(hive, root, callback, depth=0, max_depth=4):
    """Recursive enumerator. Calls callback(full_path, value_name, value)
    for every value under root. Bounded depth so we don't iterate the
    entire registry on a misconfigured key."""
    if depth > max_depth:
        return
    try:
        with winreg.OpenKey(hive, root, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            # Values at this level
            i = 0
            while True:
                try:
                    name, value, _t = winreg.EnumValue(k, i)
                except OSError:
                    break
                callback(root, name, value)
                i += 1
            # Recurse into subkeys
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(k, i)
                except OSError:
                    break
                _walk_subtree(hive, f"{root}\\{sub}", callback, depth + 1, max_depth)
                i += 1
    except (FileNotFoundError, OSError):
        return


# Substring patterns for value names we'd consider "protected status"
# and "files protected count" -- broad on purpose so newer Carbonite
# product variants with different naming still match.
PROTECTED_NAME_PATTERNS = (
    "isprotected", "protected", "backupstatus", "backupstate",
    "protectionstate", "state", "active",
)
FILE_COUNT_NAME_PATTERNS = (
    "filesprotected", "filecount", "protectedfilecount", "numfiles",
    "totalfiles", "backedupfilecount", "filesbackedup", "fileswithbackup",
)


def _hku_carbonite_roots():
    """Enumerate loaded user hives (HKEY_USERS\\<SID>) and return every
    Carbonite-related subkey path we find. Modern Carbonite Endpoint
    (v11+) runs as a service but writes a lot of operational state into
    the backup user's HKCU. Our SYSTEM-context agent can't read HKCU
    directly, but HKEY_USERS exposes every currently-loaded profile as
    a SID-named subkey -- so we walk those.

    Only loaded profiles are visible. If the Carbonite user hasn't
    signed in since boot, their hive isn't mounted and we can't read
    it. Acceptable: we'll get the data on the next check-in after
    they sign in (rare on a server -- the backup user is usually
    always signed in via Carbonite's own scheduled task / RunAs)."""
    roots = []
    try:
        with winreg.OpenKey(winreg.HKEY_USERS, "", 0,
                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as users:
            i = 0
            while True:
                try:
                    sid = winreg.EnumKey(users, i)
                except OSError:
                    break
                i += 1
                # Real user SIDs start with S-1-5-21-...; skip service
                # SIDs (LocalSystem, LocalService, NetworkService) and
                # the _Classes side-hives.
                if not sid.startswith("S-1-5-21-") or sid.endswith("_Classes"):
                    continue
                for sub in (r"Software\Carbonite", r"Software\WOW6432Node\Carbonite"):
                    path = f"{sid}\\{sub}"
                    try:
                        with winreg.OpenKey(winreg.HKEY_USERS, path, 0,
                                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                            roots.append(path)
                    except (FileNotFoundError, OSError):
                        continue
    except (FileNotFoundError, OSError):
        pass
    if roots:
        _logger.log(f"  carbonite._hku_carbonite_roots: found {len(roots)} per-user hives -> {roots}")
    return roots


def _walk_carbonite_for_protected():
    """Last-resort: walk every subkey of HKLM\\SOFTWARE\\Carbonite AND
    every loaded user hive's Software\\Carbonite tree, looking for a
    value whose name matches a protected-ish pattern AND coerces
    cleanly to bool."""
    hits = []

    def visit(path, name, value):
        n_lower = name.lower()
        if any(p in n_lower for p in PROTECTED_NAME_PATTERNS):
            coerced = _coerce_bool(value)
            if coerced is not None:
                hits.append((path, name, value, coerced))

    for root in (r"SOFTWARE\Carbonite", r"SOFTWARE\WOW6432Node\Carbonite"):
        _walk_subtree(winreg.HKEY_LOCAL_MACHINE, root, visit)
    for hku_root in _hku_carbonite_roots():
        _walk_subtree(winreg.HKEY_USERS, hku_root, visit)

    if hits:
        # Prefer hits whose name is exactly 'isprotected' / 'protected'
        # before generic 'state' matches.
        hits.sort(key=lambda h: 0 if h[1].lower() in ("isprotected", "protected") else 1)
        path, name, value, coerced = hits[0]
        _logger.log(f"  carbonite._walk MATCH (fallback) {path}\\{name} = {value!r} -> {coerced}")
        return coerced, f"{path}\\{name}"
    _logger.log("  carbonite._walk_for_protected: no match in HKLM or any HKU hive")
    return None, None


def _walk_carbonite_for_file_count():
    hits = []

    def visit(path, name, value):
        n_lower = name.lower()
        if any(p in n_lower for p in FILE_COUNT_NAME_PATTERNS):
            coerced = _coerce_int(value)
            if coerced is not None and coerced >= 0:
                hits.append((path, name, value, coerced))

    for root in (r"SOFTWARE\Carbonite", r"SOFTWARE\WOW6432Node\Carbonite"):
        _walk_subtree(winreg.HKEY_LOCAL_MACHINE, root, visit)
    for hku_root in _hku_carbonite_roots():
        _walk_subtree(winreg.HKEY_USERS, hku_root, visit)

    if hits:
        # Prefer the largest count (most likely "total files protected"
        # vs. some smaller subset count).
        hits.sort(key=lambda h: -h[3])
        path, name, value, coerced = hits[0]
        _logger.log(f"  carbonite._walk MATCH (fallback) {path}\\{name} = {value!r} -> {coerced}")
        return coerced, f"{path}\\{name}"
    _logger.log("  carbonite._walk_for_file_count: no match in HKLM or any HKU hive")
    return None, None


def _detect_installed_products():
    """Walk Uninstall keys for any DisplayName containing 'Carbonite'."""
    products = []
    for path in (
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0,
                                winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as parent:
                i = 0
                while True:
                    try:
                        sub_name = winreg.EnumKey(parent, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(parent, sub_name) as k:
                            try:
                                display, _ = winreg.QueryValueEx(k, "DisplayName")
                            except FileNotFoundError:
                                continue
                            if not isinstance(display, str) or "carbonite" not in display.lower():
                                continue
                            try:
                                ver, _ = winreg.QueryValueEx(k, "DisplayVersion")
                            except FileNotFoundError:
                                ver = None
                            try:
                                publisher, _ = winreg.QueryValueEx(k, "Publisher")
                            except FileNotFoundError:
                                publisher = None
                            products.append({
                                "name": display,
                                "version": ver,
                                "publisher": publisher,
                            })
                    except (FileNotFoundError, OSError):
                        continue
        except FileNotFoundError:
            continue
    return products


# ──────────────────────────────────────────────────────────────────────
# Event log probe -- speculative. Carbonite Endpoint v10/v11 and its
# enterprise sibling DCProtect (DataCastle Agent, Carbonite's managed
# tier) both potentially write backup outcomes to the Application log
# under their own provider names. On hosts where they don't, this
# returns nothing and the existing "Live status not available" callout
# still renders. On hosts where they do, we get real success/failure
# data into the dashboard without the operator opening the agent UI.
#
# Providers we cast a wide net for:
#   Carbonite, DCProtect, DCA, DataCastle, Webroot, "Carbonite Backup"
#
# Match heuristic: any provider name containing one of those tokens
# (case-insensitive). Cheap to add new ones later.
#
# Message parser: regex looks for "succeeded|completed|finished" vs
# "failed|error|aborted" -- we don't know the exact format Carbonite
# uses across versions, so we classify on common verbs rather than
# requiring an exact string match. If found and parseable, we surface
# lastBackupAt, lastBackupResult, and the 5 most recent sessions.
# ──────────────────────────────────────────────────────────────────────
_CARBONITE_EVENTLOG_PS = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $patterns = @('carbonite', 'dcprotect', 'dca', 'datacastle', 'webroot')
    $providers = Get-WinEvent -ListProvider * -ErrorAction SilentlyContinue |
        Where-Object {
            $name = $_.Name.ToLower()
            $matched = $false
            foreach ($p in $patterns) { if ($name -match $p) { $matched = $true; break } }
            $matched
        } | Select-Object -ExpandProperty Name
    if (-not $providers -or $providers.Count -eq 0) {
        @{ ok = $true; events = @(); providers = @() } | ConvertTo-Json -Compress
        return
    }
    # Some Carbonite installs ship a dedicated log; check those too.
    $dedicatedLogs = Get-WinEvent -ListLog * -ErrorAction SilentlyContinue |
        Where-Object {
            $ln = $_.LogName.ToLower()
            $matched = $false
            foreach ($p in $patterns) { if ($ln -match $p) { $matched = $true; break } }
            $matched -and $_.RecordCount -gt 0
        } | Select-Object -ExpandProperty LogName
    $events = @()
    # Application log filtered by our providers
    try {
        $appEvents = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=$providers} -MaxEvents 50 -ErrorAction Stop
        foreach ($e in $appEvents) { $events += $e }
    } catch {}
    # Dedicated logs
    foreach ($ln in $dedicatedLogs) {
        try {
            $logEvents = Get-WinEvent -LogName $ln -MaxEvents 50 -ErrorAction Stop
            foreach ($e in $logEvents) { $events += $e }
        } catch {}
    }
    $out = @()
    foreach ($e in $events) {
        $out += [PSCustomObject]@{
            timeCreated = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            id          = $e.Id
            level       = $e.LevelDisplayName
            provider    = "$($e.ProviderName)"
            message     = "$($e.Message)"
        }
    }
    @{ ok = $true; events = @($out); providers = @($providers) } | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
"""


def _classify_carbonite_event(msg, level):
    """Best-effort outcome classification from a Carbonite/DCProtect
    event message. We don't have a canonical event-ID table for these
    products across versions, so we look at level + common verbs in
    the message body. Returns "Success" / "Failed" / "Warning" / None.
    """
    if not msg:
        return None
    m = msg.lower()
    # Failure indicators (level=Error usually + failure verbs)
    fail_signals = ("failed", "failure", "aborted", "error occurred", "could not", "unable to back up")
    success_signals = ("completed successfully", "succeeded", "backup completed", "finished successfully", "backup successful")
    warn_signals = ("completed with warnings", "completed with errors")
    if any(s in m for s in fail_signals) or (level == "Error" and "back" in m):
        return "Failed"
    if any(s in m for s in warn_signals) or level == "Warning":
        return "Warning"
    if any(s in m for s in success_signals):
        return "Success"
    return None


def _detect_carbonite_sessions_from_eventlog():
    """Runs the broad Carbonite/DCProtect event-log query and parses
    the results. Returns (last_backup_at, last_backup_result, recent_sessions, providers_found).
    All four are None / empty when nothing useful was found.
    """
    try:
        proc = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", _CARBONITE_EVENTLOG_PS,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,
        )
    except subprocess.TimeoutExpired:
        _logger.log("  carbonite._detect_sessions_from_eventlog: PowerShell timed out after 30s")
        return None, None, [], []
    except OSError as e:
        _logger.log(f"  carbonite._detect_sessions_from_eventlog: PowerShell launch failed: {e}")
        return None, None, [], []

    raw = (proc.stdout or "").strip()
    if not raw:
        return None, None, [], []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        _logger.log(f"  carbonite._detect_sessions_from_eventlog: JSON parse failed; first 200 chars: {raw[:200]!r}")
        return None, None, [], []
    if not parsed.get("ok"):
        _logger.log(f"  carbonite._detect_sessions_from_eventlog: Get-WinEvent failed: {parsed.get('error')}")
        return None, None, [], []

    providers = parsed.get("providers") or []
    events = parsed.get("events") or []
    if not events:
        _logger.log(f"  carbonite._detect_sessions_from_eventlog: {len(providers)} matching providers found, no events emitted")
        return None, None, [], providers

    sessions = []
    for e in events:
        result = _classify_carbonite_event((e or {}).get("message") or "", (e or {}).get("level") or "")
        if not result:
            continue
        sessions.append({
            "result": result,
            "endTime": e.get("timeCreated"),
            "provider": e.get("provider"),
            "eventId": e.get("id"),
            "source": "eventlog",
        })

    if not sessions:
        _logger.log(f"  carbonite._detect_sessions_from_eventlog: {len(events)} events found but none matched outcome verbs")
        return None, None, [], providers

    sessions.sort(key=lambda s: s.get("endTime") or "", reverse=True)
    last = sessions[0]
    _logger.log(f"  carbonite._detect_sessions_from_eventlog: parsed {len(sessions)} sessions, most recent result={last['result']} at {last['endTime']}")
    return last["endTime"], last["result"], sessions[:5], providers


def collect():
    try:
        products = _detect_installed_products()
        services = _detect_services()

        if not products and not services:
            return None

        # Status signals -- both best-effort. None means "we couldn't
        # find a value in any of the known registry locations" which
        # the dashboard will render as "unknown" rather than guessing.
        protected, protected_source = _detect_protected()
        files_protected, files_source = _detect_files_protected()

        # Speculative event-log probe. On most Carbonite Endpoint
        # installs there's nothing here; on DCProtect / enterprise tier
        # installs we might extract real backup outcomes. Falls through
        # cleanly when no events are present.
        last_backup_at, last_backup_result, recent_sessions, evt_providers = \
            _detect_carbonite_sessions_from_eventlog()

        out = {
            "installed": True,
            "products": products,
            "services": services,
            "protected": protected,
            "protectedSource": protected_source,
            "filesProtected": files_protected,
            "filesProtectedSource": files_source,
        }
        if last_backup_at:
            out["lastBackupAt"] = last_backup_at
        if last_backup_result:
            out["lastBackupResult"] = last_backup_result
        if recent_sessions:
            out["recentSessions"] = recent_sessions
        # Always surface what providers (if any) we found, even when no
        # parseable events were extracted. Helps debug "I know DCProtect
        # is running but nothing shows" cases without re-running PS by
        # hand.
        if evt_providers:
            out["eventLogProviders"] = evt_providers
        return out
    except Exception as e:
        return {"_error": f"carbonite probe failed: {e}"}
