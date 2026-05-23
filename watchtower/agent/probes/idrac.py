"""
probes/idrac.py — Dell iDRAC Service Module (iSM) presence.

iDRAC itself is the BMC — out-of-band hardware. The Service Module
(iSM) is the OS-side companion that exposes iDRAC data to Windows
via WMI namespaces and a Windows service. This probe detects iSM,
not the BMC firmware. Reporting BMC firmware version + iDRAC IP
would require either an iSM WMI namespace query (CIM_iDRACCardEnumeration)
or a racadm CLI call; both are heavier and deferred.

v1 just answers: is iSM installed on this host, what's its version,
is the service running.
"""

import subprocess
import winreg


# iSM registers under "Dell Inc." (modern installs) or "Dell" (older).
ISM_REG_CANDIDATES = [
    r"SOFTWARE\Dell Inc.\iDRAC Service Module",
    r"SOFTWARE\Dell\iDRAC Service Module",
    r"SOFTWARE\WOW6432Node\Dell Inc.\iDRAC Service Module",
]

# Service identifiers iSM has used across versions.
ISM_SERVICE_CANDIDATES = ["dcism", "iDRACSvc", "Dell iDRAC Service Module"]


def _reg_subkey_exists(hive, path):
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
            return True
    except (FileNotFoundError, OSError):
        return False


def _detect_install():
    for path in ISM_REG_CANDIDATES:
        if _reg_subkey_exists(winreg.HKEY_LOCAL_MACHINE, path):
            return True
    return False


def _detect_version_from_uninstall():
    """Walk the Uninstall registry tree for an iDRAC Service Module entry."""
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
                            display, _ = winreg.QueryValueEx(k, "DisplayName")
                            if isinstance(display, str) and "iDRAC Service Module" in display:
                                try:
                                    ver, _ = winreg.QueryValueEx(k, "DisplayVersion")
                                    return ver
                                except FileNotFoundError:
                                    return None
                    except (FileNotFoundError, OSError):
                        continue
        except FileNotFoundError:
            continue
    return None


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


def _detect_service():
    for svc in ISM_SERVICE_CANDIDATES:
        state = _service_state(svc)
        if state is not None:
            return svc, state
    return None, None


def collect():
    try:
        if not _detect_install():
            return None

        service_name, service_state = _detect_service()
        return {
            "installed": True,
            "version": _detect_version_from_uninstall(),
            "serviceName": service_name,
            "serviceState": service_state,
        }
    except Exception as e:
        return {"_error": f"idrac probe failed: {e}"}
