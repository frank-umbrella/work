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
# field troubleshooting.
REG_ROOTS = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Pro Softnet Corporation"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Pro Softnet Corporation"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\IBackup"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\IBackup"),
]


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


def _enumerate_ibackup_subkeys():
    """Dump the top-level subkey names under each known IBackup-related
    registry root into the log. Useful when an operator reports
    "IBackup is installed but Watchtower says no" or status fields are
    missing -- the diagnostic shows what's actually present on that
    host so we can update the candidate lists."""
    for hive, root in REG_ROOTS:
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
                _logger.log(f"  ibackup._enumerate {root!r}: {len(names)} subkeys = {names!r}")
        except (FileNotFoundError, OSError) as e:
            _logger.log(f"  ibackup._enumerate {root!r} not present ({e.__class__.__name__})")


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

    for hive, root in REG_ROOTS:
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


def collect():
    try:
        _logger.log("ibackup.collect: starting")
        _enumerate_ibackup_subkeys()

        products = _detect_installed_products()
        services = _detect_services()

        if not products and not services:
            _logger.log("ibackup.collect: no install / service detected, returning None")
            return None

        last_at, last_source, last_result = _detect_last_backup()

        return {
            "installed": True,
            "products": products,
            "services": services,
            "lastBackupAt": last_at,
            "lastBackupSource": last_source,
            "lastBackupResult": last_result,
        }
    except Exception as e:
        return {"_error": f"ibackup probe failed: {e}"}
