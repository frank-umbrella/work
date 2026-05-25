"""
probes/logmein.py — LogMeIn (GoTo) host detection.

Three signals:
  1. Install state — registry HKLM\\SOFTWARE\\LogMeIn (also WOW6432Node).
  2. Service state — Get-Service LogMeIn (Running / Stopped / Disabled).
  3. Computer description — the value shown in the LogMeIn Central
     web UI. LogMeIn writes it into the registry at install time;
     the exact value name has drifted across versions, so we probe
     several explicit candidate locations AND fall back to a recursive
     tree-walk of the entire LogMeIn registry subtree looking for any
     value whose name contains 'Description'. The recursive fallback
     means new LogMeIn / GoTo Resolve versions that move the field
     again still get picked up without a code change.

The probe also returns `descriptionSource` so the dashboard / a
debugging operator can see which registry path the description was
read from. Useful when the wrong key is being picked or when adding
a new explicit candidate after a fleet-wide LogMeIn version bump.
"""

import subprocess
import winreg


# Candidate value paths for "computer description" — checked in order
# before falling back to the recursive tree-walk. Adding common
# variations seen across LogMeIn Pro / LogMeIn Central / GoTo Resolve.
DESCRIPTION_CANDIDATES = [
    # Classic V5 layout
    (r"SOFTWARE\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\LogMeIn\V5", "Description"),
    (r"SOFTWARE\LogMeIn\V5\Profile", "Description"),
    (r"SOFTWARE\LogMeIn\V5\Net", "Description"),
    # No-version layouts (newer / older variants)
    (r"SOFTWARE\LogMeIn\HostInfo", "Description"),
    (r"SOFTWARE\LogMeIn", "Description"),
    (r"SOFTWARE\LogMeIn", "Comment"),
    (r"SOFTWARE\LogMeIn", "ComputerDescription"),
    # WOW6432Node mirrors (32-bit installers on 64-bit Windows)
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\Profile", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\Net", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\HostInfo", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn", "Comment"),
]

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
    'description' (case-insensitive). Returns (full_path, value) on
    first hit, or (None, None) if nothing found. Depth-capped to
    prevent runaway recursion."""
    if depth > MAX_TREEWALK_DEPTH:
        return (None, None)
    # Check this key's own values first
    for name, value, _typ in _enumerate_values(hive, root_path, wow):
        if name and "description" in name.lower() and value:
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


def _description():
    """Returns (value, source_path) where source_path is the registry
    location the description was read from (for debugging). Returns
    (None, None) when nothing matched any explicit candidate AND the
    tree-walk fallback came up empty."""
    # Pass 1: explicit candidates (fast path -- known locations).
    for path, name in DESCRIPTION_CANDIDATES:
        v = _reg_read(winreg.HKEY_LOCAL_MACHINE, path, name)
        if v:
            return v, "HKLM\\" + path + "\\" + name
    # Pass 2: tree-walk fallback. Catches new LogMeIn / GoTo versions
    # that moved the field to a path not in our hardcoded list.
    for root_path, wow in TREEWALK_ROOTS:
        found_path, found_value = _tree_search_for_description(
            winreg.HKEY_LOCAL_MACHINE, root_path, wow
        )
        if found_value:
            return found_value, "HKLM\\" + found_path + "  (treewalk)"
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
