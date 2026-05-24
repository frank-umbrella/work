"""
probes/veeam.py — Veeam install state + last-backup result.

Three Veeam flavors exist and they expose their session data differently.
We probe each in order, stop at the first hit:

  1. Veeam Backup & Replication (Veeam.Backup.Launcher.exe) — registry at
     HKLM\\SOFTWARE\\Veeam\\Veeam Backup and Replication. Last-session
     data via Get-VBRComputerBackupJobSession (PowerShell module loaded
     from C:\\Program Files\\Veeam\\Backup and Replication\\Console\\).
     Heavy module, only loaded if we detect B&R.

  2. Veeam Agent for Microsoft Windows (Veeam.EndPoint.Backup.exe) —
     registry at HKLM\\SOFTWARE\\Veeam\\Veeam Endpoint Backup. Last
     session via `veeamconfig.exe session list` (the agent's CLI),
     parsed as table output.

  3. Neither installed — return None.

The Belarc report we worked from earlier showed BOTH B&R 11.0.0.1011 AND
Agent 6.3.1.1074 on the same host (OPFD-SERVER), so this probe needs to
report when both are present rather than stopping at the first hit. We
do that by collecting all detected products.
"""

import json
import os
import subprocess
import winreg


def _reg_read(hive, path, name):
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            v, _ = winreg.QueryValueEx(k, name)
            return v
    except FileNotFoundError:
        return None
    except OSError:
        return None


def _detect_br():
    # B&R registry root carries DisplayVersion (e.g. "11.0.0.1011")
    ver = _reg_read(
        winreg.HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Veeam\Veeam Backup and Replication",
        "DisplayVersion",
    )
    if ver:
        return {"edition": "br", "version": ver, "lastJob": None}
    return None


def _scan_uninstall_for_veeam_agent():
    """
    Fallback path -- newer Veeam Agent (5.x / 6.x / 12.x) doesn't always
    populate the SOFTWARE\\Veeam tree the way older versions did, but
    every Windows installer DOES register an Uninstall entry. We walk
    both 64-bit and WOW6432Node Uninstall hives looking for ANY display
    name containing "veeam agent" / "veeam endpoint" / "veeam backup
    for microsoft windows". Substring match rather than startswith --
    Veeam's installers have prepended numeric version prefixes ("12.1.2
    Veeam Agent for Microsoft Windows") in some shipped builds.

    Returns the DisplayVersion string when found, None otherwise.
    Also stores the matched DisplayName for diagnostic surfacing back
    to the dashboard so we can tell which path matched.
    """
    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    # Substring patterns we recognize as a Veeam Agent / Endpoint install
    # (case-insensitive). Order doesn't matter -- first match wins.
    patterns = (
        "veeam agent for microsoft windows",
        "veeam endpoint backup",
        "veeam backup for microsoft windows",
        "veeam backup for windows",  # legacy
        "veeam agent",               # very permissive fallback
    )
    for hive, root in candidates:
        try:
            with winreg.OpenKey(hive, root, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                i = 0
                while True:
                    try:
                        sub_name = winreg.EnumKey(k, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(k, sub_name, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as sub:
                            try:
                                dn, _ = winreg.QueryValueEx(sub, "DisplayName")
                            except FileNotFoundError:
                                continue
                            if not dn:
                                continue
                            dn_l = dn.lower()
                            if any(p in dn_l for p in patterns):
                                try:
                                    dv, _ = winreg.QueryValueEx(sub, "DisplayVersion")
                                    if dv:
                                        return dv
                                except FileNotFoundError:
                                    return "(unknown version)"
                    except (FileNotFoundError, OSError):
                        continue
        except (FileNotFoundError, OSError):
            continue
    return None


def _service_running(name):
    """
    Lightweight check: returns True if `sc query <name>` reports the
    service exists and is in RUNNING state. Used as a tie-breaker --
    even when the registry probe misses Veeam, a running
    VeeamEndpointBackupSvc means the agent IS installed.
    """
    try:
        r = subprocess.run(
            ["sc", "query", name],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=0x08000000,
        )
        if r.returncode != 0:
            return False
        return "RUNNING" in (r.stdout or "")
    except Exception:
        return False


def _detect_agent():
    # The Veeam Agent installer has shipped the version string under at
    # least three different value names across versions:
    #   * SOFTWARE\Veeam\Veeam Endpoint Backup        -> DisplayVersion (legacy)
    #   * SOFTWARE\Veeam\Veeam Agent for Microsoft Windows -> Version (6.x)
    #   * SOFTWARE\Veeam\Veeam Agent for Microsoft Windows -> DisplayVersion (some 5.x)
    # We try every (path, value-name) combination so installs from any
    # era show up. Server3 (Veeam Agent 6.3.1.1074) lives under the
    # second pattern -- its key path matches my older probe, but the
    # value name is `Version`, not `DisplayVersion`. v0.14.2 only
    # looked for DisplayVersion -> silently returned None.
    paths_to_try = [
        (r"SOFTWARE\Veeam\Veeam Agent for Microsoft Windows", "Version"),
        (r"SOFTWARE\Veeam\Veeam Agent for Microsoft Windows", "DisplayVersion"),
        (r"SOFTWARE\Veeam\Veeam Endpoint Backup",             "DisplayVersion"),
        (r"SOFTWARE\Veeam\Veeam Endpoint Backup",             "Version"),
        (r"SOFTWARE\Veeam\Veeam Agent",                       "Version"),
        (r"SOFTWARE\Veeam\Veeam Agent",                       "DisplayVersion"),
    ]
    ver = None
    for path, value_name in paths_to_try:
        ver = _reg_read(winreg.HKEY_LOCAL_MACHINE, path, value_name)
        if ver:
            break
    if not ver:
        # Newer (5.x / 6.x) installs may not populate the SOFTWARE\Veeam
        # tree the way older versions did. Fall back to the Uninstall
        # registry, which IS reliably populated by every Windows installer.
        ver = _scan_uninstall_for_veeam_agent()
    if not ver:
        # Last-resort tie-breaker: if a Veeam Agent service is running on
        # this box, the agent is installed. Without a version we report
        # "(unknown)" but at least the dashboard sees something.
        for svc_name in ("VeeamEndpointBackupSvc", "VeeamAgentService", "VeeamAgent"):
            if _service_running(svc_name):
                ver = "(unknown -- detected via service)"
                break
    if not ver:
        return None

    last_job = None
    # Try `veeamconfig session list` — the Agent's CLI. Output is a
    # human-readable table; we parse the first data row.
    veeamconfig = None
    for candidate in (
        r"C:\Program Files\Veeam\Endpoint Backup\veeamconfig.exe",
        r"C:\Program Files (x86)\Veeam\Endpoint Backup\veeamconfig.exe",
    ):
        if os.path.exists(candidate):
            veeamconfig = candidate
            break

    if veeamconfig:
        try:
            r = subprocess.run(
                [veeamconfig, "session", "list"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=0x08000000,
            )
            if r.returncode == 0 and r.stdout:
                last_job = _parse_session_list(r.stdout)
        except (subprocess.TimeoutExpired, OSError) as e:
            last_job = {"_error": f"veeamconfig failed: {e}"}

    return {"edition": "agent", "version": ver, "lastJob": last_job}


def _parse_session_list(stdout):
    """
    veeamconfig session list output looks roughly like:

      Name           Job type    State      Start time            End time
      -------------  ----------  ---------  --------------------  --------------------
      Daily Backup   Backup      Success    5/22/2026 2:00:00 AM  5/22/2026 2:14:11 AM
      ...

    Most-recent session is usually first. We grab the top data row.
    """
    lines = [ln.rstrip() for ln in stdout.splitlines() if ln.strip()]
    if len(lines) < 3:
        return None
    # Skip header + separator
    data_rows = lines[2:]
    if not data_rows:
        return None
    # Columns are whitespace-separated but names can contain spaces.
    # Heuristic: split on 2+ spaces.
    parts = [p.strip() for p in data_rows[0].split("  ") if p.strip()]
    if len(parts) >= 4:
        return {
            "name": parts[0],
            "jobType": parts[1],
            "result": parts[2],
            "startTime": parts[3] if len(parts) > 3 else None,
            "endTime": parts[4] if len(parts) > 4 else None,
        }
    return {"_raw": data_rows[0]}


def collect():
    try:
        products = []
        agent = _detect_agent()
        if agent:
            products.append(agent)
        br = _detect_br()
        if br:
            products.append(br)

        if not products:
            return None

        return {
            "installed": True,
            "products": products,
        }
    except Exception as e:
        return {"_error": f"veeam probe failed: {e}"}
