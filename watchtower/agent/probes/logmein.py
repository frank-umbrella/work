"""
probes/logmein.py — LogMeIn (GoTo) host detection.

Three signals:
  1. Install state — registry HKLM\\SOFTWARE\\LogMeIn (also WOW6432Node).
  2. Service state — Get-Service LogMeIn (Running / Stopped / Disabled).
  3. Computer description — the value shown in the LogMeIn Central
     web UI. Confirmed on a live celtic-hyperv host: this is stored
     at HKLM\\SOFTWARE\\LogMeIn\\V5\\WebSvc as the 'HostDescription'
     REG_SZ. WebSvc is the per-computer cloud-link block written by
     the LogMeIn host service on first sync with Central.

     LMIDescription (also under V5) is a SEPARATE field -- it's the
     URL-encoded hostname LogMeIn uses as its internal computer ID
     (e.g. 'CELTIC%2DHYPERV' for hostname 'CELTIC-HYPERV'), NOT the
     human-friendly label. We deliberately skip it.

     For backward compatibility we still scan a handful of older
     candidate paths AND fall back to a recursive tree-walk that
     looks for value names containing 'description' but SKIPS the
     'LMIDescription' / 'LMI*' family.

The probe also returns `descriptionSource` so the dashboard / a
debugging operator can see which registry path the description was
read from. Useful when the wrong key is being picked or when adding
a new explicit candidate after a fleet-wide LogMeIn version bump.
"""

import subprocess
import urllib.parse
import winreg


# Candidate value paths for "computer description" — checked in order
# before falling back to the recursive tree-walk. WebSvc\HostDescription
# is the confirmed-correct location for LogMeIn V5 / GoTo Resolve
# (verified 2026-05-25 on celtic-hyperv); listed first so it short-
# circuits before any heuristic fallback even fires.
DESCRIPTION_CANDIDATES = [
    # Confirmed location (LogMeIn V5+)
    (r"SOFTWARE\LogMeIn\V5\WebSvc", "HostDescription"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\WebSvc", "HostDescription"),
    # Older candidates kept for backward compat
    (r"SOFTWARE\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\LogMeIn\V5", "Description"),
    (r"SOFTWARE\LogMeIn\V5\Profile", "Description"),
    (r"SOFTWARE\LogMeIn\V5\Net", "Description"),
    (r"SOFTWARE\LogMeIn\HostInfo", "Description"),
    (r"SOFTWARE\LogMeIn", "Description"),
    (r"SOFTWARE\LogMeIn", "Comment"),
    (r"SOFTWARE\LogMeIn", "ComputerDescription"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\Profile", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\Net", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\HostInfo", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn", "Comment"),
]

# Value-name prefixes the tree-walk fallback should IGNORE. LogMeIn
# internal IDs use 'LMI*' naming (LMIDescription = URL-encoded hostname,
# LMIComputerID, etc) -- those aren't the friendly description we want.
TREEWALK_IGNORE_PREFIXES = ("lmi",)

# Roots scanned by the tree-walk fallback. Both 64-bit and 32-bit
# registry views, since LogMeIn installs sometimes land in WOW6432Node
# on 64-bit Windows depending on installer bitness.
TREEWALK_ROOTS = [
    (r"SOFTWARE\LogMeIn", winreg.KEY_WOW64_64KEY),
    (r"SOFTWARE\WOW6432Node\LogMeIn", winreg.KEY_WOW64_64KEY),
]

# Recursion depth cap on the tree walk -- LogMeIn's tree is shallow
# (typically <5 levels) and we don't want a malformed subkey loop to
# spin forever.
MAX_TREEWALK_DEPTH = 6


def _reg_read(hive, path, name, wow=winreg.KEY_WOW64_64KEY):
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | wow) as k:
            v, _ = winreg.QueryValueEx(k, name)
            return v
    except (FileNotFoundError, OSError):
        return None


def _enumerate_subkeys(hive, path, wow):
    """Yield all immediate subkey names of `path`. Empty generator if
    the path doesn't exist."""
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | wow) as parent:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(parent, i)
                except OSError:
                    return
                yield name
                i += 1
    except (FileNotFoundError, OSError):
        return


def _enumerate_values(hive, path, wow):
    """Yield (name, value, type) for every value under `path`."""
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | wow) as k:
            i = 0
            while True:
                try:
                    name, value, typ = winreg.EnumValue(k, i)
                except OSError:
                    return
                yield (name, value, typ)
                i += 1
    except (FileNotFoundError, OSError):
        return


def _tree_search_for_description(hive, root_path, wow, depth=0):
    """Recursively search `root_path` for any value name containing
    'description' (case-insensitive) -- but skip LogMeIn's internal
    LMI* prefixed values which look like descriptions but are really
    the URL-encoded hostname used as an internal computer ID.
    Returns (full_path, value) on first hit, or (None, None) if
    nothing found. Depth-capped to prevent runaway recursion."""
    if depth > MAX_TREEWALK_DEPTH:
        return (None, None)
    # Check this key's own values first
    for name, value, _typ in _enumerate_values(hive, root_path, wow):
        if not name or not value:
            continue
        nl = name.lower()
        if nl.startswith(TREEWALK_IGNORE_PREFIXES):
            continue
        if "description" in nl:
            return (root_path + "\\" + name, value)
    # Recurse into subkeys
    for subkey in _enumerate_subkeys(hive, root_path, wow):
        result = _tree_search_for_description(
            hive, root_path + "\\" + subkey, wow, depth + 1
        )
        if result[0] is not None:
            return result
    return (None, None)


def _detect_install():
    # Common LogMeIn root paths. Presence of any of these = installed.
    candidates = [
        (r"SOFTWARE\LogMeIn", winreg.KEY_WOW64_64KEY),
        (r"SOFTWARE\WOW6432Node\LogMeIn", winreg.KEY_WOW64_64KEY),
    ]
    for path, wow in candidates:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | wow):
                return True
        except FileNotFoundError:
            continue
    return False


def _detect_version():
    # Pulled out of Uninstall entries since the LogMeIn root subkeys
    # don't always carry a DisplayVersion value.
    for hive, path in (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ):
        try:
            with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as parent:
                i = 0
                while True:
                    try:
                        sub_name = winreg.EnumKey(parent, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(parent, sub_name) as k:
                            display, _ = winreg.QueryValueEx(k, "DisplayName")
                            if isinstance(display, str) and display.startswith("LogMeIn"):
                                try:
                                    ver, _ = winreg.QueryValueEx(k, "DisplayVersion")
                                    return ver
                                except FileNotFoundError:
                                    continue
                    except (FileNotFoundError, OSError):
                        continue
        except FileNotFoundError:
            continue
    return None


def _service_state(name):
    """Returns 'running', 'stopped', 'disabled', or None if not registered."""
    try:
        r = subprocess.run(
            ["sc.exe", "query", name],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=0x08000000,
        )
        if "1060" in r.stdout or "does not exist" in r.stdout.lower():
            return None
        if "RUNNING" in r.stdout:
            return "running"
        if "STOPPED" in r.stdout:
            # Also check StartType — sc qc — to distinguish Stopped from Disabled
            qc = subprocess.run(
                ["sc.exe", "qc", name],
                capture_output=True, text=True, timeout=10,
                creationflags=0x08000000,
            )
            if "DISABLED" in qc.stdout:
                return "disabled"
            return "stopped"
        return "unknown"
    except (subprocess.TimeoutExpired, OSError):
        return None


def _maybe_url_decode(value):
    """LogMeIn's LMIDescription value (the internal computer ID) is
    URL-encoded (e.g. 'CELTIC%2DHYPERV' for 'CELTIC-HYPERV'). The
    real HostDescription field at WebSvc isn't encoded, but if a
    future LogMeIn version stores the friendly description in an
    encoded form, decode it transparently. urlib.parse.unquote is a
    no-op for plain strings (returns them unchanged) so this is
    always safe to call."""
    if not isinstance(value, str):
        return value
    if "%" not in value:
        return value
    try:
        return urllib.parse.unquote(value)
    except Exception:
        return value


def _description():
    """Returns (value, source_path) where source_path is the registry
    location the description was read from (for debugging). Returns
    (None, None) when nothing matched any explicit candidate AND the
    tree-walk fallback came up empty."""
    # Pass 1: explicit candidates (fast path -- known locations).
    # WebSvc\\HostDescription is at the top of the list so it short-
    # circuits before tree-walking can possibly pick the wrong key.
    for path, name in DESCRIPTION_CANDIDATES:
        v = _reg_read(winreg.HKEY_LOCAL_MACHINE, path, name)
        if v:
            return _maybe_url_decode(v), "HKLM\\" + path + "\\" + name
    # Pass 2: tree-walk fallback. Catches new LogMeIn / GoTo versions
    # that moved the field to a path not in our hardcoded list. The
    # walk skips LMI* prefixed values (those are internal IDs).
    for root_path, wow in TREEWALK_ROOTS:
        found_path, found_value = _tree_search_for_description(
            winreg.HKEY_LOCAL_MACHINE, root_path, wow
        )
        if found_value:
            return _maybe_url_decode(found_value), "HKLM\\" + found_path + "  (treewalk)"
    return None, None


def collect():
    try:
        if not _detect_install():
            return None
        desc_value, desc_source = _description()
        return {
            "installed": True,
            "version": _detect_version(),
            "serviceState": _service_state("LogMeIn"),
            "guardianServiceState": _service_state("LMIGuardianSvc"),
            "description": desc_value,
            "descriptionSource": desc_source,
        }
    except Exception as e:
        return {"_error": f"logmein probe failed: {e}"}
