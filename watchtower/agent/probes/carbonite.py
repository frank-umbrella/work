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

import os
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


def _walk_carbonite_for_protected():
    """Last-resort: walk every subkey of HKLM\\SOFTWARE\\Carbonite (both
    hives) for a value whose name matches a protected-ish pattern AND
    coerces cleanly to bool."""
    hits = []

    def visit(path, name, value):
        n_lower = name.lower()
        if any(p in n_lower for p in PROTECTED_NAME_PATTERNS):
            coerced = _coerce_bool(value)
            if coerced is not None:
                hits.append((path, name, value, coerced))

    for root in (r"SOFTWARE\Carbonite", r"SOFTWARE\WOW6432Node\Carbonite"):
        _walk_subtree(winreg.HKEY_LOCAL_MACHINE, root, visit)

    if hits:
        # Prefer hits whose name is exactly 'isprotected' / 'protected'
        # before generic 'state' matches.
        hits.sort(key=lambda h: 0 if h[1].lower() in ("isprotected", "protected") else 1)
        path, name, value, coerced = hits[0]
        _logger.log(f"  carbonite._walk MATCH (fallback) {path}\\{name} = {value!r} -> {coerced}")
        return coerced, f"{path}\\{name}"
    _logger.log("  carbonite._walk_for_protected: no match in any subkey")
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

    if hits:
        # Prefer the largest count (most likely "total files protected"
        # vs. some smaller subset count).
        hits.sort(key=lambda h: -h[3])
        path, name, value, coerced = hits[0]
        _logger.log(f"  carbonite._walk MATCH (fallback) {path}\\{name} = {value!r} -> {coerced}")
        return coerced, f"{path}\\{name}"
    _logger.log("  carbonite._walk_for_file_count: no match in any subkey")
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

        return {
            "installed": True,
            "products": products,
            "services": services,
            "protected": protected,
            "protectedSource": protected_source,
            "filesProtected": files_protected,
            "filesProtectedSource": files_source,
        }
    except Exception as e:
        return {"_error": f"carbonite probe failed: {e}"}
