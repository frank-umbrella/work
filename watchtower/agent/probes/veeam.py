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
import re
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
    if not ver:
        return None
    sessions, sessions_error = _detect_br_recent_sessions()
    out = {
        "edition": "br",
        "version": ver,
        # We don't populate lastJob for B&R the way we do for Agent --
        # Get-VBRComputerBackupJobSession is a different API surface
        # and the more useful view for a B&R server is "what are the
        # latest 5 sessions across all jobs," surfaced as recentSessions
        # below. lastJob stays None so the dashboard's existing renderer
        # doesn't show a stale "no last job" line under B&R rows.
        "lastJob": None,
        "recentSessions": sessions,
    }
    if sessions_error:
        out["recentSessionsError"] = sessions_error
    return out


def _detect_br_recent_sessions():
    """
    Pull the 5 most recent Get-VBRBackupSession results across every
    configured B&R job. Returns (list, error_string_or_None).

    Why a single PowerShell invocation:
    - The Veeam.Backup.PowerShell module is HEAVY (~3-5s import). We
      pay that cost once, run all our queries, and exit. Running it
      per query would 3x the wall time.
    - JSON output via ConvertTo-Json -Compress lets us parse a
      well-defined shape rather than fragile table-text scraping.

    Module fallback chain:
      1. Import-Module Veeam.Backup.PowerShell  (B&R 11+ -- ships as
         a real PS module installed to the system module path)
      2. Add-PSSnapin VeeamPSSnapIn             (B&R 9.x / 10.x -- the
         older snapin format, registered into the host's PS providers
         by the B&R installer)
    If both fail, return ([], "<reason>") so the dashboard can show
    "B&R installed, sessions unavailable" rather than silently empty.

    Forces `,$out | ConvertTo-Json` (array wrapping via the unary
    comma operator) so a single-session result is still serialized
    as a JSON array -- PowerShell 5.1's default behavior is to drop
    the array wrap for 1-element collections.
    """
    ps_script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$loaded = $false
try {
    Import-Module Veeam.Backup.PowerShell -ErrorAction Stop -WarningAction SilentlyContinue 3>$null
    $loaded = $true
} catch {}
if (-not $loaded) {
    try {
        Add-PSSnapin VeeamPSSnapIn -ErrorAction Stop
        $loaded = $true
    } catch {}
}
if (-not $loaded) {
    Write-Output '__WT_NO_MODULE__'
    exit
}
try {
    $sessions = @(Get-VBRBackupSession | Sort-Object EndTimeUTC -Descending | Select-Object -First 5)
} catch {
    Write-Output '__WT_QUERY_FAIL__'
    exit
}
$out = @()
foreach ($s in $sessions) {
    $out += [PSCustomObject]@{
        name         = if ($s.Name) { "$($s.Name)" } else { $null }
        jobName      = if ($s.JobName) { "$($s.JobName)" } else { $null }
        result       = "$($s.Result)"
        state        = "$($s.State)"
        creationTime = if ($s.CreationTime) { $s.CreationTime.ToString('yyyy-MM-ddTHH:mm:ss') } else { $null }
        endTime      = if ($s.EndTime)      { $s.EndTime.ToString('yyyy-MM-ddTHH:mm:ss') }      else { $null }
    }
}
# Unary comma forces array wrapping even for 0/1 elements.
,$out | ConvertTo-Json -Compress -Depth 3
"""
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return [], f"powershell invocation failed: {e}"

    stdout = (r.stdout or "").strip()
    if not stdout:
        # PowerShell exited with no output. Could be a hung module load,
        # an empty Get-VBRBackupSession, or stderr-only output. Treat as
        # "no data" but surface the stderr if any so the operator can see.
        err = (r.stderr or "").strip()
        return [], f"empty output{(' / stderr: ' + err[:200]) if err else ''}"

    if "__WT_NO_MODULE__" in stdout:
        return [], "Veeam PowerShell module/snapin not available (B&R Console-only install?)"
    if "__WT_QUERY_FAIL__" in stdout:
        return [], "Get-VBRBackupSession query failed"

    try:
        # Strip any leading non-JSON noise (warning text PowerShell can
        # emit before the JSON line even with -WarningAction silent).
        json_start = stdout.find("[")
        if json_start < 0:
            return [], f"unexpected output: {stdout[:200]}"
        data = json.loads(stdout[json_start:])
        if not isinstance(data, list):
            data = [data] if data else []
        return data, None
    except (ValueError, json.JSONDecodeError) as e:
        return [], f"json parse failed: {e}; raw: {stdout[:200]}"


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


def _locate_veeamconfig():
    """Resolves the full path to veeamconfig.exe across Veeam Agent
    versions. Order (cheap-to-expensive):
      1. PATH lookup -- if veeamconfig is on the system PATH (rare but
         possible after a manual install), shutil.which finds it.
      2. Uninstall registry InstallLocation -- the path Windows
         Installer actually recorded at install time. More reliable
         than Veeam-specific reg keys because it reflects whatever
         folder the operator chose, not the installer's "expected"
         default.
      3. Veeam-specific registry keys under HKLM\\SOFTWARE\\Veeam --
         legacy path, still works on hosts that have it.
      4. Hardcoded fallback candidates (5.x / 6.x default dirs).
      5. Bounded filesystem walk under every C:\\Program Files*\\Veeam\\
         tree, depth <=3. Catches custom install paths the registry
         doesn't surface (e.g. when Veeam was installed via group
         policy with a remapped target).

    Returns the absolute path string, or None when nothing's found.
    """
    import shutil

    # 1. PATH lookup.
    on_path = shutil.which("veeamconfig.exe") or shutil.which("veeamconfig")
    if on_path:
        _logger.log(f"  veeam._locate_veeamconfig PATH HIT -> {on_path}")
        return on_path

    # 2. Uninstall registry InstallLocation. Walk both 64-bit and
    #    WOW6432Node Uninstall hives looking for any DisplayName
    #    matching a Veeam Agent pattern; read the InstallLocation
    #    value from the same key.
    uninstall_patterns = (
        "veeam agent for microsoft windows",
        "veeam endpoint backup",
        "veeam backup for microsoft windows",
        "veeam backup for windows",
        "veeam agent",
    )
    uninstall_roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, root in uninstall_roots:
        try:
            with winreg.OpenKey(hive, root, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as parent:
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
                                display = winreg.QueryValueEx(k, "DisplayName")[0]
                            except (FileNotFoundError, OSError):
                                continue
                            if not isinstance(display, str):
                                continue
                            d_lower = display.lower()
                            if not any(p in d_lower for p in uninstall_patterns):
                                continue
                            try:
                                loc = winreg.QueryValueEx(k, "InstallLocation")[0]
                            except (FileNotFoundError, OSError):
                                continue
                            if not loc:
                                continue
                            candidate = os.path.join(str(loc).rstrip("\\"), "veeamconfig.exe")
                            if os.path.exists(candidate):
                                _logger.log(f"  veeam._locate_veeamconfig UNINSTALL HIT {display!r} -> {candidate}")
                                return candidate
                            _logger.log(f"  veeam._locate_veeamconfig UNINSTALL NO-EXE {display!r} InstallLocation={loc!r}")
                    except (FileNotFoundError, OSError):
                        continue
        except (FileNotFoundError, OSError):
            continue

    # 3. Veeam-specific registry keys.
    reg_lookups = [
        (r"SOFTWARE\Veeam\Veeam Agent for Microsoft Windows", "InstallDir"),
        (r"SOFTWARE\Veeam\Veeam Agent for Microsoft Windows", "Installation Path"),
        (r"SOFTWARE\Veeam\Veeam Agent for Microsoft Windows", "InstallPath"),
        (r"SOFTWARE\Veeam\Veeam Endpoint Backup",             "InstallDir"),
        (r"SOFTWARE\Veeam\Veeam Endpoint Backup",             "Installation Path"),
        (r"SOFTWARE\Veeam\Veeam Endpoint Backup",             "InstallPath"),
        (r"SOFTWARE\Veeam\Veeam Agent",                       "InstallDir"),
        (r"SOFTWARE\Veeam\Veeam Agent",                       "InstallPath"),
    ]
    for path, name in reg_lookups:
        install_dir = _reg_read(winreg.HKEY_LOCAL_MACHINE, path, name)
        if not install_dir:
            continue
        candidate = os.path.join(str(install_dir).rstrip("\\"), "veeamconfig.exe")
        if os.path.exists(candidate):
            _logger.log(f"  veeam._locate_veeamconfig REG HIT {path}\\{name} -> {candidate}")
            return candidate
        _logger.log(f"  veeam._locate_veeamconfig REG NO-EXE {path}\\{name} = {install_dir!r} (no veeamconfig.exe)")

    # 4. Hardcoded fallbacks. Both the legacy 5.x "Endpoint Backup"
    #    folder and the newer 6.x "Backup" folder; both Program Files
    #    + Program Files (x86) for completeness on 32-bit installs.
    for candidate in (
        r"C:\Program Files\Veeam\Endpoint Backup\veeamconfig.exe",
        r"C:\Program Files (x86)\Veeam\Endpoint Backup\veeamconfig.exe",
        r"C:\Program Files\Veeam\Backup\veeamconfig.exe",
        r"C:\Program Files (x86)\Veeam\Backup\veeamconfig.exe",
        r"C:\Program Files\Veeam\veeamconfig.exe",
        r"C:\Program Files (x86)\Veeam\veeamconfig.exe",
    ):
        if os.path.exists(candidate):
            _logger.log(f"  veeam._locate_veeamconfig HARDCODED HIT {candidate}")
            return candidate

    # 5. Bounded filesystem walk under Program Files\Veeam trees.
    #    Catches custom install paths (group policy remap, deliberate
    #    relocation, etc.). Depth-limited to 3 so we don't scan the
    #    entire Veeam tree when it has lots of subfolders.
    for root in (r"C:\Program Files\Veeam", r"C:\Program Files (x86)\Veeam"):
        if not os.path.isdir(root):
            continue
        try:
            root_depth = root.count("\\")
            for dirpath, dirnames, filenames in os.walk(root):
                # Depth limit -- don't descend more than 3 levels under root.
                if dirpath.count("\\") - root_depth > 3:
                    dirnames[:] = []  # prune
                    continue
                for fn in filenames:
                    if fn.lower() == "veeamconfig.exe":
                        candidate = os.path.join(dirpath, fn)
                        _logger.log(f"  veeam._locate_veeamconfig WALK HIT {candidate}")
                        return candidate
        except OSError as e:
            _logger.log(f"  veeam._locate_veeamconfig WALK {root!r} failed: {e}")
            continue

    _logger.log("  veeam._locate_veeamconfig: no veeamconfig.exe found anywhere (path / uninstall / reg / hardcoded / walk all missed)")
    return None


# ──────────────────────────────────────────────────────────────────────
# Event-log fallback for Veeam Agent session history.
#
# Modern Veeam Agent builds (some 6.x releases observed) ship WITHOUT
# veeamconfig.exe entirely -- the standalone CLI was removed. There's
# no PowerShell module installed either. The session/job data exists
# in two places:
#   1. C:\ProgramData\Veeam\EndpointData\VeeamBackup.db (SQLite,
#      typically held open with an exclusive lock by the Veeam service
#      so opening it would race the running agent)
#   2. The dedicated "Veeam Agent" Windows event log
#
# We use the event log. It's a stable public API, lock-free, and the
# event IDs Veeam writes haven't drifted across the last ~5 years of
# Agent versions.
#
# Event IDs we care about (observed on Veeam Agent 6.3.1.1074):
#   190 (Information): "Veeam Agent '<jobname>' finished with <result>."
#                      where <result> is Success / Warning / Failed.
#                      Fires on EVERY job completion regardless of
#                      severity (Level=Information).
#   191 (Warning):     Same message format but emitted at Level=Warning
#                      for non-Success outcomes. Some Veeam versions
#                      emit 190 only, others emit both 190 + 191. We
#                      query both and dedup on TimeCreated.
#
# Message regex extracts job name (single-quoted) and result word.
# ──────────────────────────────────────────────────────────────────────
_VEEAM_EVENTLOG_PS = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $events = Get-WinEvent -LogName 'Veeam Agent' `
        -FilterXPath "*[System[(EventID=190) or (EventID=191)]]" `
        -MaxEvents 50 -ErrorAction Stop
    $out = @()
    foreach ($e in $events) {
        $out += [PSCustomObject]@{
            timeCreated = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            id          = $e.Id
            level       = $e.LevelDisplayName
            message     = "$($e.Message)"
        }
    }
    @{ ok = $true; events = @($out) } | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
"""


def _parse_veeam_eventlog_message(msg):
    """Extracts (job_name, result) from an event 190/191 message body.
    Expected: "Veeam Agent '<name>' finished with <Result>."
    Returns (None, None) on parse miss."""
    if not msg:
        return None, None
    import re
    m = re.search(r"Veeam Agent '([^']+)' finished with (\w+)", msg)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def _detect_agent_sessions_from_eventlog():
    """Reads the 'Veeam Agent' event log via PowerShell + Get-WinEvent.
    Returns (last_job_dict_or_None, recent_sessions_list, reason_string_or_None).

    last_job shape (matches what _parse_session_list produces from
    veeamconfig output, so the dashboard's existing renderer works):
        {result: 'Success'|'Warning'|'Failed', endTime: 'YYYY-MM-DDTHH:MM:SSZ',
         jobName: '<name>'}
    """
    try:
        proc = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", _VEEAM_EVENTLOG_PS,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,
        )
    except subprocess.TimeoutExpired:
        return None, [], "Veeam event-log read timed out after 30s"
    except OSError as e:
        return None, [], f"Veeam event-log PowerShell launch failed: {e}"

    raw = (proc.stdout or "").strip()
    if not raw:
        return None, [], "Veeam event-log query returned empty output"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None, [], f"Veeam event-log JSON parse failed; first 200 chars: {raw[:200]!r}"
    if not parsed.get("ok"):
        err = parsed.get("error") or "unknown"
        return None, [], f"Veeam event-log Get-WinEvent failed: {err}"

    events = parsed.get("events") or []
    if not isinstance(events, list) or not events:
        return None, [], "Veeam event log has no job-completion events (190/191) yet"

    # Build session list -- dedup by (timeCreated, jobName) since some
    # versions emit BOTH 190+191 for the same outcome.
    seen = set()
    sessions = []
    for e in events:
        name, result = _parse_veeam_eventlog_message((e or {}).get("message") or "")
        if not name or not result:
            continue
        key = (e.get("timeCreated"), name)
        if key in seen:
            continue
        seen.add(key)
        sessions.append({
            "jobName": name,
            "result": result,
            "endTime": e.get("timeCreated"),
            "source": "eventlog",
        })

    if not sessions:
        return None, [], "Veeam event log returned events but none matched the expected message format"

    # Sort newest-first by endTime (ISO 8601 strings sort correctly)
    sessions.sort(key=lambda s: s["endTime"] or "", reverse=True)
    last_job = {
        "result": sessions[0]["result"],
        "endTime": sessions[0]["endTime"],
        "jobName": sessions[0]["jobName"],
    }
    _logger.log(
        f"  veeam._detect_agent_sessions_from_eventlog: found {len(sessions)} sessions, "
        f"most recent={last_job!r}"
    )
    # Cap recent at 5 to match the B&R panel layout
    return last_job, sessions[:5], None


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
    last_job_reason = None  # diagnostic surfaced to the dashboard when
                            # last_job stays None -- lets the operator
                            # see WHY rather than just "no session data"
    # Try `veeamconfig session list` — the Agent's CLI. Output is a
    # human-readable table; we parse the first data row. veeamconfig.exe
    # has moved across versions:
    #   - Veeam Agent 5.x: C:\Program Files\Veeam\Endpoint Backup\
    #   - Veeam Agent 6.x: C:\Program Files\Veeam\Backup\
    #     (and the "Endpoint Backup" subfolder no longer exists)
    # Rather than guessing every iteration of the path, READ the install
    # location from the registry first -- the Veeam installer always
    # writes InstallDir / Installation Path / DisplayIcon under the
    # Veeam Agent registry key. Falls back to the hardcoded path
    # candidates if the registry value isn't present.
    veeamconfig = _locate_veeamconfig()
    _logger.log(f"  veeam.veeamconfig path resolved to: {veeamconfig!r}")

    # Recent-sessions list -- populated by either the veeamconfig path
    # or the event-log fallback. Same shape as B&R's recentSessions so
    # the dashboard renderer reuses its existing markup.
    recent_sessions = []

    if not veeamconfig:
        # Modern Veeam Agent builds (some 6.x releases observed in the
        # field) ship WITHOUT veeamconfig.exe entirely -- the standalone
        # CLI was dropped. Fall back to the dedicated 'Veeam Agent'
        # Windows event log, which has the same job-completion data
        # (events 190/191) and is a stable public API. See
        # _detect_agent_sessions_from_eventlog for details.
        _logger.log("  veeam._detect_agent: veeamconfig missing, trying event-log fallback")
        evt_last_job, evt_sessions, evt_reason = _detect_agent_sessions_from_eventlog()
        if evt_last_job:
            last_job = evt_last_job
            recent_sessions = evt_sessions or []
            last_job_reason = None  # we have data; suppress the diagnostic
        else:
            last_job_reason = (
                "Couldn't read Veeam Agent job history. veeamconfig.exe is not "
                "shipped in this Veeam Agent build, and the event-log fallback "
                f"failed: {evt_reason or 'unknown'}"
            )
    else:
        try:
            r = subprocess.run(
                [veeamconfig, "session", "list"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=0x08000000,
            )
            if r.returncode != 0:
                last_job_reason = f"veeamconfig session list returned exit {r.returncode} (stderr: {(r.stderr or '').strip()[:200]!r})"
            elif not r.stdout or not r.stdout.strip():
                last_job_reason = "veeamconfig session list produced no output -- no completed backup sessions on this host yet"
            else:
                parsed = _parse_session_list(r.stdout)
                if parsed is None:
                    last_job_reason = "veeamconfig session list output didn't match expected table format (probe parser miss)"
                else:
                    last_job = parsed
        except subprocess.TimeoutExpired:
            last_job_reason = "veeamconfig session list timed out after 20s"
        except OSError as e:
            last_job = {"_error": f"veeamconfig failed: {e}"}
            last_job_reason = f"veeamconfig launch failed: {e}"

    # Backup policy type(s) -- `veeamconfig job list` enumerates every
    # configured job with its backup type (Volume / File / EntireComputer /
    # SystemState) and destination kind (Local disk / Network share /
    # Cloud Connect / Veeam B&R repository). MSPs want this surfaced so
    # they can see at a glance whether a host has the right level of
    # protection (full image-level vs. file-level vs. orphan with no job).
    jobs = []
    if veeamconfig:
        jobs = _list_veeam_jobs(veeamconfig)

    out = {
        "edition": "agent",
        "version": ver,
        "lastJob": last_job,
        "jobs": jobs,
    }
    # recentSessions: populated by the event-log fallback when
    # veeamconfig.exe is missing. The dashboard already renders this
    # field for the B&R edition, so the same UI block lights up for
    # Agent installs when we have it.
    if recent_sessions:
        out["recentSessions"] = recent_sessions
    if last_job_reason:
        out["lastJobReason"] = last_job_reason
    return out


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


# ──────────────────────────────────────────────────────────────────────
# Veeam log-file identifier scanner.
#
# Each Veeam Agent / Endpoint job keeps a rolling log directory under
#   C:\ProgramData\Veeam\Endpoint\<job folder name>\*.log
# (Veeam B&R uses C:\ProgramData\Veeam\Backup\<job folder>\*.log; we
# scan both locations so hosts running either flavour get IDs populated.)
#
# Inside those logs Veeam prints the repository path it's writing to,
# which embeds a cluster of UUIDs that uniquely identify the job on the
# B&R server side:
#   Veeam/Backup/<Folder>/Clients/{<ClientId>}/Subclients/{<SubclientId>}/<BackupId>
# And separately a line of the form:
#   JobId: {<JobId>}
# (whitespace / underscore / case variations tolerated by the regex.)
#
# These IDs let an operator paste a value into the B&R console search
# and jump straight to the right job -- much faster than hunting by
# human-readable name, especially when the same job name appears on
# multiple hosts.
#
# Scanner constraints (read-only, bounded):
#   * Scan at most 10 log subfolders.
#   * Per subfolder, examine the single most recently modified .log file.
#   * Timeout the whole scan at ~2 seconds via file-count cap; we do NOT
#     read full logs, just scan until both patterns matched or EOF.
#   * The probe NEVER writes or deletes anything. Pure read.
# ──────────────────────────────────────────────────────────────────────

_VEEAM_LOG_ROOTS = (
    r"C:\ProgramData\Veeam\Endpoint",
    r"C:\ProgramData\Veeam\Backup",
)

# Repository path pattern: Veeam/Backup/<Folder>/Clients/{<ClientId>}/Subclients/{<SubclientId>}/<BackupId>
_RX_REPO_PATH = re.compile(
    r"Veeam/Backup/(?P<folder>[^/]+)/Clients/\{(?P<clientId>[0-9a-f-]{36})\}"
    r"/Subclients/\{(?P<subclientId>[0-9a-f-]{36})\}/(?P<backupId>[0-9a-f-]{36})",
    re.IGNORECASE,
)
# JobId line: "Job Id: {uuid}", "JobId:{uuid}", "JOB_ID = uuid" (any
# combination of space / underscore between words, optional braces).
_RX_JOB_ID = re.compile(
    r"Job[\s_]?I[dD][^0-9a-f{]*\{?(?P<jobId>[0-9a-f-]{36})",
    re.IGNORECASE,
)


def _scan_single_log(log_path):
    """Return {jobId, folder, clientId, subclientId, backupId} from the
    given .log file. Any field not found is omitted. Reads up to the
    first 500 KB -- the IDs are logged early in the session so a tiny
    read window is sufficient and keeps the probe fast on hosts with
    massive log files."""
    found = {}
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            buf = f.read(500 * 1024)
    except OSError:
        return found

    m = _RX_REPO_PATH.search(buf)
    if m:
        found["folder"] = m.group("folder")
        found["clientId"] = m.group("clientId")
        found["subclientId"] = m.group("subclientId")
        found["backupId"] = m.group("backupId")
    m = _RX_JOB_ID.search(buf)
    if m:
        found["jobId"] = m.group("jobId")

    return found


def _scan_veeam_log_identifiers():
    """Walk the Veeam log roots and build a list of per-job identifier
    dicts. Each entry looks like:
      {jobName: '<folder name reformatted>', jobId: '...', folder: '...',
       clientId: '...', subclientId: '...', backupId: '...'}

    folder-name reformat: underscores in the directory name become
    spaces -- Veeam stores logs under "My_Backup_Job" even when the job
    is named "My Backup Job", so the display label is clearer with the
    underscore→space swap. The raw folder name is still preserved as
    jobFolder for exact lookup.
    """
    results = []
    seen_folders = 0
    for root in _VEEAM_LOG_ROOTS:
        if not os.path.isdir(root):
            continue
        try:
            subs = [
                os.path.join(root, name) for name in os.listdir(root)
                if os.path.isdir(os.path.join(root, name))
            ]
        except OSError as e:
            _logger.log(f"  veeam._scan_veeam_log_identifiers: listdir {root!r} failed: {e}")
            continue

        for sub in subs:
            if seen_folders >= 10:
                break
            seen_folders += 1
            try:
                logs = sorted(
                    (os.path.join(sub, f) for f in os.listdir(sub) if f.lower().endswith(".log")),
                    key=lambda p: os.path.getmtime(p),
                    reverse=True,
                )
            except OSError:
                continue
            if not logs:
                continue
            ids = _scan_single_log(logs[0])
            if not ids:
                continue
            folder_name = os.path.basename(sub)
            entry = {
                "jobName": folder_name.replace("_", " "),
                "jobFolder": folder_name,
            }
            entry.update(ids)
            results.append(entry)

    _logger.log(
        f"  veeam._scan_veeam_log_identifiers: scanned {seen_folders} folders, "
        f"found {len(results)} identifier records"
    )
    return results


def _merge_identifiers_into_jobs(jobs, identifiers):
    """Attach each identifiers entry to the matching entry in jobs by
    name match. Returns (merged_jobs, unmatched_identifiers).

    Match strategy: case-insensitive compare of normalized names where
    underscores and multiple spaces collapse to a single space. Veeam's
    log folder names use underscores where the UI/CLI reports spaces,
    so a strict equality check misses most matches.
    """
    def norm(s):
        return re.sub(r"[\s_]+", " ", (s or "").strip().lower())

    jobs_by_norm = {norm(j.get("name")): j for j in jobs}
    unmatched = []
    for ident in identifiers:
        key = norm(ident.get("jobName"))
        if key and key in jobs_by_norm:
            target = jobs_by_norm[key]
            for k in ("jobId", "folder", "clientId", "subclientId", "backupId", "jobFolder"):
                if ident.get(k) and not target.get(k):
                    target[k] = ident[k]
        else:
            unmatched.append(ident)
    return jobs, unmatched


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

        # Enrich detected jobs with the UUID identifiers Veeam logs
        # under C:\ProgramData\Veeam\{Endpoint,Backup}\<folder>\*.log.
        # These are what the B&R server-side console uses to identify
        # the job, so having them in the dashboard lets the operator
        # jump straight to the right record on the server rather than
        # hunting by friendly name.
        try:
            identifiers = _scan_veeam_log_identifiers()
            if identifiers:
                # Try to attach to the matching product's job entry.
                # Agent product takes priority (its jobs come from
                # veeamconfig / event log which uses the same friendly
                # names Veeam writes to the log folders).
                for product in products:
                    product_jobs = product.get("jobs") or []
                    merged, remainder = _merge_identifiers_into_jobs(product_jobs, identifiers)
                    product["jobs"] = merged
                    identifiers = remainder  # don't double-attach to the next product
                    if not identifiers:
                        break
                # Any identifiers that didn't match a known job go on
                # the first product as orphan entries -- surfaces jobs
                # that exist in the log tree but weren't enumerated by
                # veeamconfig (CLI uninstalled, snapin missing, etc).
                if identifiers:
                    first = products[0]
                    if "jobs" not in first or not isinstance(first["jobs"], list):
                        first["jobs"] = []
                    for ident in identifiers:
                        first["jobs"].append({
                            "name": ident.get("jobName") or "(unnamed log folder)",
                            "jobFolder": ident.get("jobFolder"),
                            "jobId": ident.get("jobId"),
                            "folder": ident.get("folder"),
                            "clientId": ident.get("clientId"),
                            "subclientId": ident.get("subclientId"),
                            "backupId": ident.get("backupId"),
                            "source": "logScan",  # distinguishes from veeamconfig-enumerated jobs
                        })
        except Exception as e:
            # Identifier scan is a nice-to-have; never fail the whole
            # probe because of it. Record the error alongside the data.
            products[0]["jobIdentifierScanError"] = f"{e.__class__.__name__}: {e}"

        return {
            "installed": True,
            "products": products,
        }
    except Exception as e:
        return {"_error": f"veeam probe failed: {e}"}
