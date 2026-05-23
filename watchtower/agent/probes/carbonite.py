"""
probes/carbonite.py — Carbonite backup product detection.

Carbonite ships under several SKU names depending on the era and
target audience:
  - Carbonite Server Backup           (legacy on-prem server backup)
  - Carbonite Endpoint Backup         (workstation + small server)
  - Carbonite Safe                    (consumer)
  - Carbonite Safe Server Backup      (consumer-tier server)

Their installers all land under the standard Uninstall registry tree
with publisher "Carbonite" (or "Carbonite, Inc."). Service names vary
by product; we probe a candidate list.

v1 reports presence + version + product flavor + service state.
Last-backup status is product-specific (the Server product writes
session logs to disk, the Endpoint product is opaque) and is deferred
to a follow-up if/when MSP admins ask for it.
"""

import subprocess
import winreg


# Service candidates across Carbonite products.
SERVICE_CANDIDATES = [
    "CarboniteService",          # Endpoint Backup
    "Carbonite Server Backup",   # Server Backup (legacy)
    "CarboniteSafeBackup",       # Safe / consumer
    "EVault InfoStage Agent",    # very old SKU
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

        return {
            "installed": True,
            "products": products,
            "services": services,
        }
    except Exception as e:
        return {"_error": f"carbonite probe failed: {e}"}
