"""
probes/sentinelone.py — SentinelOne agent detection + version.

Detection is purely registry-based — SentinelOne carries a stable
HKLM\\SOFTWARE\\Sentinel Labs\\Sentinel Agent key with version info.
We avoid SentinelCtl.exe and SentinelHelperService.exe IPC because
those need elevated privilege and the registry alone is enough for
"is it installed + what version + is the service running."
"""

import subprocess
import winreg


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


def _detect_via_uninstall():
    """Walk Uninstall keys looking for 'Sentinel Agent'. Returns version or None."""
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
                            if isinstance(display, str) and "Sentinel" in display:
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


def collect():
    try:
        version = _detect_via_uninstall()
        if not version:
            return None
        return {
            "installed": True,
            "version": version,
            "serviceState": _service_state("SentinelAgent"),
            "helperServiceState": _service_state("SentinelHelperService"),
        }
    except Exception as e:
        return {"_error": f"sentinelone probe failed: {e}"}
