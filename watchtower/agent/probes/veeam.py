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

try:
    import logger as _logger
except ImportError:
    # Fallback for development / standalone testing -- logger ships in
    # the agent bundle, but if it's not importable just stub it out so
    # the probe doesn't crash.
    class _Stub:
        def log(self, *a, **kw): pass
    _logger = _Stub()


def _reg_read(hive, path, name):
    """Read a single registry value, returning the value or None on miss.
    Logs every attempt to watchtower.log with the outcome so the operator
    can see exactly which path/value combinations succeeded and which
    failed -- critical for diagnosing 'Veeam is installed but the probe
    misses it' reports without needing to attach a debugger."""
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            v, t = winreg.QueryValueEx(k, name)
            _logger.log(f"  veeam._reg_read OK   path={path!r} name={name!r} type={t} value={v!r}")
            return v
    except FileNotFoundError as e:
        _logger.log(f"  veeam._reg_read MISS path={path!r} name={name!r} ({e.__class__.__name__})")
        return None
    except OSError as e:
        _logger.log(f"  veeam._reg_read ERR  path={path!r} name={name!r} {e.__class__.__name__}: {e}")
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


def _enumerate_veeam_subkeys():
    """Dump the actual subkey names under HKLM\\SOFTWARE\\Veeam (and the
    WOW6432Node variant) into the log so we can see what the agent's
    view of the registry actually contains. Useful when the operator
    SEES Veeam in regedit / PowerShell but the probe still misses it
    -- usually means the key name has different whitespace, casing,
    or the install lives in a different hive/view."""
    for hive, root in [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Veeam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Veeam"),
    ]:
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
                _logger.log(f"  veeam._enumerate {root!r}: {len(names)} subkeys = {names!r}")
        except (FileNotFoundError, OSError) as e:
            _logger.log(f"  veeam._enumerate {root!r} not present ({e.__class__.__name__})")


def _detect_agent():
    _logger.log("veeam._detect_agent: starting")
    _enumerate_veeam_subkeys()
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

    # Backup policy type(s) -- `veeamconfig job list` enumerates every
    # configured job with its backup type (Volume / File / EntireComputer /
    # SystemState) and destination kind (Local disk / Network share /
    # Cloud Connect / Veeam B&R repository). MSPs want this surfaced so
    # they can see at a glance whether a host has the right level of
    # protection (full image-level vs. file-level vs. orphan with no job).
    jobs = []
    if veeamconfig:
        jobs = _list_veeam_jobs(veeamconfig)

    return {
        "edition": "agent",
        "version": ver,
        "lastJob": last_job,
        "jobs": jobs,
    }


def _list_veeam_jobs(veeamconfig_path):
    """Parse `veeamconfig job list` into a list of policy entries.

    Output shape (Veeam Agent 5.x/6.x):

      Name                  Type          Repository
      --------------------- ------------- ----------------
      Daily Backup          EntireComputer LocalDisk
      Weekly File Sync      File           NetworkShare

    Some versions use slightly different column names (BackupType /
    Destination), so we just take the first 3 whitespace-separated
    chunks after the header separator. Tolerant of extra columns.
    """
    try:
        r = subprocess.run(
            [veeamconfig_path, "job", "list"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=0x08000000,
        )
        if r.returncode != 0 or not r.stdout:
            return []
    except (subprocess.TimeoutExpired, OSError):
        return []

    lines = [ln.rstrip() for ln in r.stdout.splitlines() if ln.strip()]
    if len(lines) < 3:
        return []
    # Skip header + separator
    data_rows = lines[2:]
    parsed = []
    for row in data_rows[:20]:  # cap at 20 jobs to keep payload small
        # Split on 2+ spaces (column names often have one space, so
        # 2+ reliably separates columns).
        parts = [p.strip() for p in row.split("  ") if p.strip()]
        if not parts:
            continue
        entry = {"name": parts[0]}
        if len(parts) >= 2:
            entry["policyType"] = parts[1]   # EntireComputer / Volume / File / SystemState
        if len(parts) >= 3:
            entry["destination"] = parts[2]  # LocalDisk / NetworkShare / Repository / CloudConnect
        if len(parts) >= 4:
            # Some versions add a Schedule column; preserve it raw.
            entry["schedule"] = " ".join(parts[3:])
        parsed.append(entry)
    return parsed


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
