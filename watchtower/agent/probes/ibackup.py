"""
probes/ibackup.py — IBackup (Pro Softnet Corp.) detection + status.

IBackup is a cloud backup product from Pro Softnet Corporation (the
same company that makes IDrive). MSPs see it on a mix of workstations
and small-business servers as an off-site complement to local WSB /
Veeam. Several SKUs exist depending on era + target:

  - IBackup for Windows         (workstation / single user)
  - IBackup for Servers         (multi-user / server)
  - IBackup Professional        (legacy small-business tier)
  - IBackup Online              (very old; pre-2012)

All of them register an Uninstall entry with a DisplayName containing
"IBackup" and a Publisher of "Pro Softnet Corp" (or "Pro Softnet
Corporation"). Service names + registry status paths vary by SKU and
have drifted across versions, so we use a candidate list + a registry-
tree walk fallback for status fields -- same belt-and-suspenders
approach carbonite.py uses.

Returns None if IBackup isn't installed at all (no Uninstall entry,
no candidate service registered). Otherwise:

  {
    installed: True,
    products: [ {name, version, publisher}, ... ],
    services: [ {name, state}, ... ],     # 'running' / 'stopped' / 'unknown'
    lastBackupAt: ISO string or None,     # best-effort from registry
    lastBackupResult: 'Success'/'Failed'/'Warning'/None,
    lastBackupSource: 'HKLM\\Path\\ValueName' or None,  # diagnostic
  }
"""

import json
import subprocess
import winreg

try:
    import logger as _logger
except ImportError:
    class _Stub:
        def log(self, *a, **kw): pass
    _logger = _Stub()


# Service candidates seen across IBackup SKUs. We probe each; any that
# exists (running, stopped, or paused) confirms IBackup is installed
# even when the Uninstall entry got corrupted on upgrade.
SERVICE_CANDIDATES = [
    "IBackupService",            # IBackup for Windows (modern)
    "IBackupServerService",      # IBackup for Servers
    "IBackup Service",           # alt spacing seen on older builds
    "IBackup",                   # very old SKU
    "ProSoftnetIBackup",         # branded service name on some versions
]


# Substring patterns we treat as a "this is IBackup" match against the
# Uninstall DisplayName. Case-insensitive. Deliberately tight -- we
# don't want to false-match generic "Backup" entries.
DISPLAY_NAME_PATTERNS = (
    "ibackup",
)

# Publishers that ship IBackup. Tolerant of the comma-vs-no-comma
# variants Pro Softnet has used.
PUBLISHER_PATTERNS = (
    "pro softnet",
)


# Known registry roots IBackup has written to. Walked by
# _detect_last_backup() for status fields and also enumerated for
# diagnostic logging so we can see what's actually there during
# field troubleshooting. Several variants because Pro Softnet has
# used different publisher key names across SKUs (shortened "Corp"
# in newer installers; IDrive Inc. for SKUs that share the IDrive
# code base). Field discovery from the v0.14.30 log showed an
# IBackup 11.0 install with NONE of the four original roots present
# -- that prompted the wider candidate list + the dynamic top-level
# scan below in _find_ibackup_roots().
STATIC_REG_ROOTS = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Pro Softnet Corp"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Pro Softnet Corp"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Pro Softnet Corporation"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Pro Softnet Corporation"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Pro Softnet"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Pro Softnet"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\IBackup"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\IBackup"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\IDriveInc"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\IDriveInc"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\IDrive Inc"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\IDrive Inc"),
]


# Substrings that flag a top-level HKLM\SOFTWARE subkey as
# IBackup-related. Used by _find_ibackup_roots() to walk every
# direct child of SOFTWARE (and WOW6432Node\SOFTWARE) so we can
# pick up future Pro Softnet rebranding without code changes.
_REG_ROOT_NAME_PATTERNS = (
    "ibackup", "pro softnet", "prosoftnet", "idrive",
)


def _find_ibackup_roots():
    """Walks every direct child of HKLM\\SOFTWARE (and WOW6432Node)
    looking for subkey NAMES containing any of our IBackup patterns.
    Combined with the static candidate list, this lets us catch
    publisher-key renames without needing to update the probe.
    Returns a deduped (hive, path) list."""
    found = []
    seen = set()

    def add(hive, path):
        key = (hive, path.lower())
        if key in seen:
            return
        seen.add(key)
        found.append((hive, path))

    for root in (r"SOFTWARE", r"SOFTWARE\WOW6432Node"):
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, root, 0,
                                winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(k, i)
                    except OSError:
                        break
                    i += 1
                    sub_l = sub.lower()
                    if any(p in sub_l for p in _REG_ROOT_NAME_PATTERNS):
                        add(winreg.HKEY_LOCAL_MACHINE, f"{root}\\{sub}")
        except (FileNotFoundError, OSError):
            continue
    return found


def _hkey_users_ibackup_roots():
    """IBackup historically stores per-user config + last-backup state
    under HKCU. Our agent runs as SYSTEM so it can't see HKCU directly,
    but HKEY_USERS is enumerable -- every loaded user profile shows up
    as a SID-named subkey. Walk each one looking for the same set of
    IBackup-related publisher keys we look for under HKLM. Loaded
    profiles only -- if the IBackup user hasn't logged in since boot,
    their hive isn't mounted and we can't read it. That's acceptable;
    we'll get the data on the next check-in after they sign in."""
    found = []
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
                # Skip the well-known service SIDs + the _Classes
                # sub-hives. Real user SIDs start with S-1-5-21-...
                if not sid.startswith("S-1-5-21-") or sid.endswith("_Classes"):
                    continue
                for sub in (
                    r"Software\Pro Softnet Corp",
                    r"Software\Pro Softnet Corporation",
                    r"Software\Pro Softnet",
                    r"Software\IBackup",
                    r"Software\IDriveInc",
                    r"Software\IDrive Inc",
                ):
                    path = f"{sid}\\{sub}"
                    try:
                        with winreg.OpenKey(winreg.HKEY_USERS, path, 0,
                                            winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                            found.append((winreg.HKEY_USERS, path))
                    except (FileNotFoundError, OSError):
                        continue
    except (FileNotFoundError, OSError):
        pass
    return found


def _all_reg_roots():
    """Union of static candidates + dynamically-discovered HKLM
    publisher keys + HKEY_USERS per-profile hives. Deduped."""
    roots = list(STATIC_REG_ROOTS)
    roots.extend(_find_ibackup_roots())
    roots.extend(_hkey_users_ibackup_roots())
    seen = set()
    out = []
    for hive, path in roots:
        key = (hive, path.lower())
        if key not in seen:
            seen.add(key)
            out.append((hive, path))
    return out


# Substring patterns we recognize as last-backup-time fields when walking
# the IBackup subtree. Stored as multiple variants because the value
# names have drifted across SKUs/versions.
LAST_BACKUP_TIME_PATTERNS = (
    "lastbackuptime", "lastbackup", "lastsuccessfulbackup",
    "lastbackupat", "lastbackupdatetime", "lastbackupcompleted",
    "lastrun", "lastruntime", "lastsync",
)

# And for backup-result/status fields (e.g. "Success" / "Failed").
LAST_BACKUP_RESULT_PATTERNS = (
    "lastbackupstatus", "lastbackupresult", "backupresult",
    "lastrunresult", "lastrunstatus", "lastsessionstatus",
)


def _service_state(name):
    """Returns 'running' / 'stopped' / 'unknown' / None (not installed).
    `sc.exe` exit code is unreliable across Windows versions; parse the
    stdout for STATE keywords instead. 1060 = 'service does not exist'."""
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
        if "PAUSED" in r.stdout:
            return "paused"
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


def _detect_installed_products():
    """Walk both 32 + 64-bit Uninstall hives looking for any DisplayName
    that matches an IBackup pattern, OR whose Publisher is Pro Softnet.
    Returns a list of {name, version, publisher} dicts. Empty if no
    install was found."""
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
                            if not isinstance(display, str):
                                continue
                            try:
                                publisher, _ = winreg.QueryValueEx(k, "Publisher")
                            except FileNotFoundError:
                                publisher = None
                            display_l = display.lower()
                            publisher_l = (publisher or "").lower()
                            # Match if EITHER the display name contains
                            # "ibackup" OR the publisher contains "pro
                            # softnet" AND the display name suggests a
                            # backup product (avoids accidentally matching
                            # IDrive or other Pro Softnet products if any
                            # are ever installed alongside).
                            display_matches = any(p in display_l for p in DISPLAY_NAME_PATTERNS)
                            publisher_matches = (
                                any(p in publisher_l for p in PUBLISHER_PATTERNS)
                                and "backup" in display_l
                            )
                            if not (display_matches or publisher_matches):
                                continue
                            try:
                                ver, _ = winreg.QueryValueEx(k, "DisplayVersion")
                            except FileNotFoundError:
                                ver = None
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


def _walk_subtree(hive, root, callback, depth=0, max_depth=4):
    """Recursive enumerator. Calls callback(full_path, value_name, value)
    for every value under root. Bounded depth so a misconfigured key
    doesn't iterate the entire registry. Same shape Carbonite uses."""
    if depth > max_depth:
        return
    try:
        with winreg.OpenKey(hive, root, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            i = 0
            while True:
                try:
                    name, value, _t = winreg.EnumValue(k, i)
                except OSError:
                    break
                callback(root, name, value)
                i += 1
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


def _enumerate_ibackup_subkeys(roots):
    """Dump the top-level subkey names under each IBackup-related
    registry root into the log. Useful when an operator reports
    "IBackup is installed but Watchtower says no" or status fields are
    missing -- the diagnostic shows what's actually present on that
    host so we can update the candidate lists. Takes the resolved
    roots list (static + dynamic + HKEY_USERS) so the log entries
    include whatever publisher-key variant we actually found."""
    hive_label = {
        winreg.HKEY_LOCAL_MACHINE: "HKLM",
        winreg.HKEY_USERS: "HKU",
        winreg.HKEY_CURRENT_USER: "HKCU",
    }
    for hive, root in roots:
        prefix = hive_label.get(hive, str(hive))
        try:
            with winreg.OpenKey(hive, root, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                names = []
                i = 0
                while True:
                    try:
                        names.append(winreg.EnumKey(k, i))
                    except OSError:
                        break
                    i += 1
                _logger.log(f"  ibackup._enumerate {prefix}\\{root}: {len(names)} subkeys = {names!r}")
        except (FileNotFoundError, OSError) as e:
            _logger.log(f"  ibackup._enumerate {prefix}\\{root} not present ({e.__class__.__name__})")


def _detect_last_backup():
    """Walk the IBackup registry roots looking for a value whose name
    matches a known last-backup-time pattern (LastBackupTime,
    LastBackupAt, LastRun, etc.). Same fallback strategy carbonite.py
    uses for protection state -- substring matching is tolerant of
    naming drift across versions.

    Returns (iso_timestamp_or_None, source_path_or_None,
             result_string_or_None).
    """
    time_hits = []
    result_hits = []

    def visit(path, name, value):
        n_lower = name.lower()
        if any(p in n_lower for p in LAST_BACKUP_TIME_PATTERNS):
            iso = _coerce_iso(value)
            if iso:
                time_hits.append((path, name, value, iso))
        if any(p in n_lower for p in LAST_BACKUP_RESULT_PATTERNS):
            s = _coerce_result_str(value)
            if s:
                result_hits.append((path, name, value, s))

    for hive, root in _all_reg_roots():
        _walk_subtree(hive, root, visit)

    last_at = None
    last_source = None
    last_result = None

    if time_hits:
        # Prefer values whose name is exactly "lastbackuptime" or
        # "lastsuccessfulbackup" over generic "lastrun" matches.
        time_hits.sort(key=lambda h: 0 if h[1].lower() in (
            "lastbackuptime", "lastsuccessfulbackup", "lastbackup",
        ) else 1)
        path, name, raw, iso = time_hits[0]
        last_at = iso
        last_source = f"{path}\\{name}"
        _logger.log(f"  ibackup._detect_last_backup TIME MATCH {last_source} = {raw!r} -> {iso}")
    if result_hits:
        result_hits.sort(key=lambda h: 0 if h[1].lower() in (
            "lastbackupresult", "lastbackupstatus",
        ) else 1)
        path, name, raw, s = result_hits[0]
        last_result = s
        _logger.log(f"  ibackup._detect_last_backup RESULT MATCH {path}\\{name} = {raw!r} -> {s}")

    return last_at, last_source, last_result


def _coerce_iso(raw):
    """IBackup has stored timestamps as:
      - REG_DWORD: Unix epoch seconds
      - REG_QWORD: Windows FILETIME (100ns since 1601-01-01)
      - REG_SZ:    Various local-date strings ("2026-05-25 14:32:01",
                   "5/25/2026 2:32:01 PM", ISO 8601)
    Returns an ISO-8601 string in UTC if we can parse it, else None."""
    if raw is None:
        return None
    import datetime
    # Numeric -- distinguish Unix epoch from FILETIME by magnitude.
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        n = int(raw)
        if n <= 0:
            return None
        try:
            if n > 1_000_000_000_000_000:
                # FILETIME (100ns since 1601-01-01)
                epoch_diff_100ns = 116444736000000000
                seconds = (n - epoch_diff_100ns) / 10_000_000
                dt = datetime.datetime.utcfromtimestamp(seconds)
            else:
                # Unix epoch seconds (or ms if too big)
                if n > 100_000_000_000:
                    n = n // 1000
                dt = datetime.datetime.utcfromtimestamp(n)
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        # Try a handful of formats; fall back to leaving the string as-is
        # if it already looks ISO-ish (dashboard renders strings raw too).
        candidates = [
            "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%m/%d/%Y %I:%M:%S %p",
            "%m/%d/%Y %H:%M:%S",
            "%m/%d/%Y",
        ]
        for fmt in candidates:
            try:
                dt = datetime.datetime.strptime(s, fmt)
                return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                continue
        # Last resort: if it looks like ISO already, hand it back unchanged.
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return s
        return None
    return None


def _coerce_result_str(raw):
    """Map a registry value to one of 'Success' / 'Failed' / 'Warning' /
    None. IBackup has used both numeric codes (0=success, non-zero=fail)
    and string labels. Return None when we can't confidently classify --
    the dashboard renders that as 'unknown' rather than guessing."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return "Success" if raw else "Failed"
    if isinstance(raw, int):
        if raw == 0:
            return "Success"
        if raw > 0:
            return "Failed"
        return None
    if isinstance(raw, str):
        s = raw.strip().lower()
        if not s:
            return None
        if s in ("success", "ok", "completed", "complete", "done", "succeeded"):
            return "Success"
        if s in ("failed", "fail", "error", "errored"):
            return "Failed"
        if s in ("warning", "warn", "partial", "succeeded with warnings"):
            return "Warning"
        # Numeric-string fallback
        if s.lstrip("-").isdigit():
            n = int(s)
            return "Success" if n == 0 else "Failed"
    return None


# ──────────────────────────────────────────────────────────────────────
# Event-log fallback for IBackup. The registry surface we walk covers
# HKLM + every loaded HKEY_USERS hive (added v0.14.83), but on hosts
# where the backup user isn't currently signed in, IBackup's per-
# session state in their HKCU is invisible. The Windows event log is
# a separate channel that IBackup / IDrive sometimes write to under
# their own provider names. Mirror of the Carbonite event-log probe.
# ──────────────────────────────────────────────────────────────────────
_IBACKUP_EVENTLOG_PS = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $patterns = @('ibackup', 'idrive', 'pro softnet')
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
    $dedicatedLogs = Get-WinEvent -ListLog * -ErrorAction SilentlyContinue |
        Where-Object {
            $ln = $_.LogName.ToLower()
            $matched = $false
            foreach ($p in $patterns) { if ($ln -match $p) { $matched = $true; break } }
            $matched -and $_.RecordCount -gt 0
        } | Select-Object -ExpandProperty LogName
    $events = @()
    try {
        $appEvents = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=$providers} -MaxEvents 50 -ErrorAction Stop
        foreach ($e in $appEvents) { $events += $e }
    } catch {}
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


def _classify_ibackup_event(msg, level):
    """Best-effort outcome classification for an IBackup / IDrive event.
    Returns "Success" / "Failed" / "Warning" / None."""
    if not msg:
        return None
    m = msg.lower()
    fail_signals = ("failed", "failure", "aborted", "error occurred", "could not back up", "backup did not complete")
    success_signals = ("completed successfully", "succeeded", "backup completed", "finished successfully", "backup successful")
    warn_signals = ("completed with warnings", "completed with errors", "skipped")
    if any(s in m for s in fail_signals) or (level == "Error" and "back" in m):
        return "Failed"
    if any(s in m for s in warn_signals) or level == "Warning":
        return "Warning"
    if any(s in m for s in success_signals):
        return "Success"
    return None


def _detect_ibackup_sessions_from_eventlog():
    """Runs the IBackup/IDrive event-log query and parses results.
    Returns (last_backup_at, last_backup_result, recent_sessions, providers_found).
    """
    try:
        proc = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", _IBACKUP_EVENTLOG_PS,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,
        )
    except subprocess.TimeoutExpired:
        _logger.log("  ibackup._detect_sessions_from_eventlog: PowerShell timed out after 30s")
        return None, None, [], []
    except OSError as e:
        _logger.log(f"  ibackup._detect_sessions_from_eventlog: PowerShell launch failed: {e}")
        return None, None, [], []

    raw = (proc.stdout or "").strip()
    if not raw:
        return None, None, [], []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        _logger.log(f"  ibackup._detect_sessions_from_eventlog: JSON parse failed; first 200 chars: {raw[:200]!r}")
        return None, None, [], []
    if not parsed.get("ok"):
        _logger.log(f"  ibackup._detect_sessions_from_eventlog: Get-WinEvent failed: {parsed.get('error')}")
        return None, None, [], []

    providers = parsed.get("providers") or []
    events = parsed.get("events") or []
    if not events:
        _logger.log(f"  ibackup._detect_sessions_from_eventlog: {len(providers)} matching providers found, no events emitted")
        return None, None, [], providers

    sessions = []
    for e in events:
        result = _classify_ibackup_event((e or {}).get("message") or "", (e or {}).get("level") or "")
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
        _logger.log(f"  ibackup._detect_sessions_from_eventlog: {len(events)} events found but none matched outcome verbs")
        return None, None, [], providers

    sessions.sort(key=lambda s: s.get("endTime") or "", reverse=True)
    last = sessions[0]
    _logger.log(f"  ibackup._detect_sessions_from_eventlog: parsed {len(sessions)} sessions, most recent result={last['result']} at {last['endTime']}")
    return last["endTime"], last["result"], sessions[:5], providers


def collect():
    try:
        _logger.log("ibackup.collect: starting")
        _enumerate_ibackup_subkeys(_all_reg_roots())

        products = _detect_installed_products()
        services = _detect_services()

        if not products and not services:
            _logger.log("ibackup.collect: no install / service detected, returning None")
            return None

        last_at, last_source, last_result = _detect_last_backup()

        # Event-log fallback: when the registry walk doesn't yield a
        # last-backup timestamp (backup user not signed in, or IBackup
        # version doesn't write status to registry), try the event log.
        # Even when the registry DOES have data, the event log gives us
        # recentSessions for the dashboard's recent-backups list.
        evt_last_at, evt_last_result, recent_sessions, evt_providers = \
            _detect_ibackup_sessions_from_eventlog()
        # Prefer registry-derived data when both are present (more
        # canonical); fall back to event-log data otherwise.
        if not last_at and evt_last_at:
            last_at = evt_last_at
            last_source = "eventlog"
        if not last_result and evt_last_result:
            last_result = evt_last_result

        out = {
            "installed": True,
            "products": products,
            "services": services,
            "lastBackupAt": last_at,
            "lastBackupSource": last_source,
            "lastBackupResult": last_result,
        }
        if recent_sessions:
            out["recentSessions"] = recent_sessions
        if evt_providers:
            out["eventLogProviders"] = evt_providers
        return out
    except Exception as e:
        return {"_error": f"ibackup probe failed: {e}"}
