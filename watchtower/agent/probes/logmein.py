"""
probes/logmein.py — LogMeIn (GoTo) host detection.

Three signals:
  1. Install state — registry HKLM\\SOFTWARE\\LogMeIn (also WOW6432Node).
  2. Service state — Get-Service LogMeIn (Running / Stopped / Disabled).
  3. Computer description — the value shown in the LogMeIn Central
     web UI. LogMeIn writes it into the registry at install time;
     the exact value name has drifted across versions, so we probe
     several candidate locations and return the first hit.

If your LogMeIn version stores the description somewhere this probe
doesn't find, log the missing key in state.json's probeErrors[] and
we'll add it to the candidate list.
"""

import subprocess
import winreg


# Candidate value paths for "computer description" — different LogMeIn
# major versions have used different value names. Format: (subkey, value).
DESCRIPTION_CANDIDATES = [
    (r"SOFTWARE\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\LogMeIn\V5", "Description"),
    (r"SOFTWARE\LogMeIn\V5\Profile", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5\HostInfo", "Description"),
    (r"SOFTWARE\WOW6432Node\LogMeIn\V5", "Description"),
]


def _reg_read(hive, path, name, wow=winreg.KEY_WOW64_64KEY):
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | wow) as k:
            v, _ = winreg.QueryValueEx(k, name)
            return v
    except (FileNotFoundError, OSError):
        return None


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
    for path, name in DESCRIPTION_CANDIDATES:
        v = _reg_read(winreg.HKEY_LOCAL_MACHINE, path, name)
        if v:
            return v
    return None


def collect():
    try:
        if not _detect_install():
            return None
        return {
            "installed": True,
            "version": _detect_version(),
            "serviceState": _service_state("LogMeIn"),
            "guardianServiceState": _service_state("LMIGuardianSvc"),
            "description": _description(),
        }
    except Exception as e:
        return {"_error": f"logmein probe failed: {e}"}
