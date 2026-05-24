"""
probes/windows_updates.py — pending Windows Updates.

v0.14.14 rewrite: previously called the Windows Update Agent COM API
(Microsoft.Update.Session) directly via pywin32. That works -- until the
COM Search() call hangs on an unreachable WSUS, the collector's per-probe
timeout kills the daemon thread holding the CoInitialize state, and the
NEXT probe iteration hits a pythoncom311.dll access violation that
takes down the entire watchtower-svc.exe process. We've seen this in
the field: agent crashes 3+ times in a row at startup, never reaches
the POST step, never appears in the dashboard.

The fix is to shell the WUApi call out to a PowerShell subprocess. COM
state lives in the subprocess, with its own lifetime. If the subprocess
hangs we kill it without touching the agent process. If the COM call
crashes (it has, repeatedly), only the subprocess dies and the agent
keeps running.

What we emit is structurally identical to the previous version so the
worker / dashboard don't need to change. The reboot-pending check still
runs in-process (pure registry reads, no COM, no risk).
"""

import datetime
import json
import subprocess
import winreg


PROBE_TIMEOUT_SEC = 35  # WUApi can be slow even on healthy hosts


PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $results  = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
    $updates  = @($results.Updates)
    $count    = $updates.Count

    function Sev($u) {
        $s = "$($u.MsrcSeverity)".Trim()
        if ([string]::IsNullOrEmpty($s)) { 'Unspecified' } else { $s }
    }

    # Per-severity + per-category counts across the FULL pending set.
    $sevBreak = @{}
    $catBreak = @{}
    foreach ($u in $updates) {
        $s = Sev $u
        if (-not $sevBreak.ContainsKey($s)) { $sevBreak[$s] = 0 }
        $sevBreak[$s] = $sevBreak[$s] + 1
        $cat = ''
        try {
            if ($u.Categories.Count -gt 0) { $cat = "$($u.Categories.Item(0).Name)" }
        } catch {}
        if ($cat -ne '') {
            if (-not $catBreak.ContainsKey($cat)) { $catBreak[$cat] = 0 }
            $catBreak[$cat] = $catBreak[$cat] + 1
        }
    }

    # First 30 update titles with key fields. Caps payload on hosts that
    # have a year of pending updates.
    $top = @($updates | Select-Object -First 30 | ForEach-Object {
        $u = $_
        $cat = ''
        try {
            if ($u.Categories.Count -gt 0) { $cat = "$($u.Categories.Item(0).Name)" }
        } catch {}
        $sz = $null
        try {
            $b = [int64]$u.MaxDownloadSize
            if ($b -gt 0) { $sz = [math]::Round($b / 1MB, 1) }
        } catch {}
        [PSCustomObject]@{
            title    = "$($u.Title)"
            severity = Sev $u
            category = $cat
            sizeMB   = $sz
            isBeta   = [bool]$u.IsBeta
        }
    })

    [PSCustomObject]@{
        pendingCount      = $count
        severityBreakdown = $sevBreak
        categoryBreakdown = $catBreak
        updates           = $top
    } | ConvertTo-Json -Compress -Depth 4
} catch {
    @{ _error = $_.Exception.Message } | ConvertTo-Json -Compress
}
"""


def _detect_reboot_pending():
    """In-process registry probe -- no COM, no risk of pywin32 crash.
    Any of the three documented locations being set = pending reboot."""
    checks = [
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
         "subkey"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
         "subkey"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager",
         "value:PendingFileRenameOperations"),
    ]
    for hive, path, mode in checks:
        try:
            if mode == "subkey":
                with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                    return True
            elif mode.startswith("value:"):
                value_name = mode.split(":", 1)[1]
                with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                    try:
                        val, _ = winreg.QueryValueEx(k, value_name)
                        if val and any(v for v in val):
                            return True
                    except FileNotFoundError:
                        continue
        except (FileNotFoundError, OSError):
            continue
    return False


def _run_powershell_wuapi():
    """Spawn powershell.exe to do the WUApi search. Returns the parsed
    JSON dict or raises on timeout/non-zero exit. Subprocess isolation
    means a crashing pythoncom DLL kills the powershell process only --
    the agent never touches COM directly."""
    proc = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-Command", PS_SCRIPT,
        ],
        capture_output=True,
        text=True,
        timeout=PROBE_TIMEOUT_SEC,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"WUApi PowerShell exited {proc.returncode}: {proc.stderr[:200]}"
        )
    stdout = (proc.stdout or "").strip()
    if not stdout:
        raise RuntimeError("WUApi PowerShell returned empty output")
    return json.loads(stdout)


def collect():
    out = {
        "rebootRequired": _detect_reboot_pending(),
        "lastSearchSucceeded": None,
    }

    try:
        data = _run_powershell_wuapi()
    except subprocess.TimeoutExpired:
        # COM search hung in the subprocess (WSUS unreachable, broken
        # update source). Subprocess is killed; agent unaffected. Emit
        # what we have (reboot state) with an error marker.
        out["_error"] = (
            f"WUApi search did not return within {PROBE_TIMEOUT_SEC}s "
            "(WSUS unreachable or misconfigured)"
        )
        return out
    except (RuntimeError, json.JSONDecodeError, OSError) as e:
        out["_error"] = f"windows_updates probe failed: {e}"
        return out

    if isinstance(data, dict) and data.get("_error"):
        out["_error"] = data["_error"]
        return out

    out["pendingCount"] = data.get("pendingCount", 0)
    out["severityBreakdown"] = data.get("severityBreakdown") or {}
    out["categoryBreakdown"] = data.get("categoryBreakdown") or {}
    out["updates"] = data.get("updates") or []
    out["lastSearchSucceeded"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    return out
