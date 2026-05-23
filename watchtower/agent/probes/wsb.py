"""
probes/wsb.py — Windows Server Backup status.

`Get-WBSummary` from the WindowsServerBackup PowerShell module.
Returns last/next backup times, number of backup versions, and the
last backup result code. Skipped on client SKUs (Win10/11) and on
servers where the WindowsServerBackup feature isn't installed.

Last backup result is reported as an HRESULT (0 = success). We map
the common ones to a human-readable status for the dashboard.

Get-WBSummary is fast (<1s on a small WSB target, ~5s on big retention),
so the timeout here is short.
"""

import json
import subprocess


# HRESULT-ish mapping for common WSB outcomes. There's no canonical
# table; these come from MSFT docs + empirical observation across
# the field. Anything not in this list shows as "code: <int>".
WSB_RESULT_MAP = {
    0: "Success",
    -2147023436: "Cancelled by user",
    -2147024894: "Path not found (volume gone?)",
    -2147467259: "Generic failure (E_FAIL)",
}


# PowerShell snippet — runs Get-WBSummary + Get-WBJob -Previous 10,
# falls back to $null if the module isn't available, then JSON-emits a
# flat object. Get-WBJob is wrapped in its own try so a host that has
# WSB installed but hasn't run any jobs yet still gets a summary back
# without the recentJobs section.
PS_SNIPPET = r"""
$ErrorActionPreference = 'Stop'
try {
    Import-Module WindowsServerBackup -ErrorAction Stop
    $s = Get-WBSummary

    # Get-WBSummary returns [datetime]::MinValue (0001-01-01T00:00:00) for
    # date fields on hosts with no backup history yet — not $null. We have
    # to filter those out client-side so the dashboard's no-policy
    # empty-state branch fires correctly (it gates on the field being
    # null/falsy).
    $minDate = [datetime]::MinValue
    function _DateOrNull($d) {
        if ($d -and $d -ne $minDate) { return $d.ToString('o') } else { return $null }
    }

    $jobs = @()
    try {
        $rawJobs = Get-WBJob -Previous 10 -ErrorAction Stop
        $jobs = @($rawJobs | ForEach-Object {
            [PSCustomObject]@{
                startTime = _DateOrNull $_.StartTime
                endTime   = _DateOrNull $_.EndTime
                jobType   = "$($_.JobType)"
                jobState  = "$($_.JobState)"
                hresult   = $_.HResult
                errorDescription = $_.ErrorDescription
            }
        })
    } catch {
        # No jobs ever run, or Get-WBJob throws on this host — leave $jobs empty.
        $jobs = @()
    }

    # Backup targets — where the backup is being written. From Get-WBPolicy
    # which returns the current scheduled-backup policy. BackupTargets is
    # an array of WBBackupTarget objects; each has Label + TargetType +
    # one of (Path / Volume / UncPath) depending on type. Hosts with no
    # policy yet have $null here, which we coerce to an empty array.
    $targets = @()
    try {
        $policy = Get-WBPolicy -ErrorAction Stop
        if ($policy -and $policy.BackupTargets) {
            $targets = @($policy.BackupTargets | ForEach-Object {
                # WBBackupTarget has different properties per type. Try
                # several so we surface whatever's set without crashing.
                $path = $null
                try { if ($_.Path)    { $path = "$($_.Path)" } } catch {}
                try { if (-not $path -and $_.UncPath) { $path = "$($_.UncPath)" } } catch {}
                try { if (-not $path -and $_.Source)  { $path = "$($_.Source)"  } } catch {}
                [PSCustomObject]@{
                    label = "$($_.Label)"
                    type  = "$($_.TargetType)"
                    path  = $path
                }
            })
        }
    } catch {
        $targets = @()
    }

    $out = [PSCustomObject]@{
        installed              = $true
        lastBackupTime         = _DateOrNull $s.LastBackupTime
        lastBackupResultHR     = $s.LastBackupResultHR
        lastSuccessfulBackup   = _DateOrNull $s.LastSuccessfulBackupTime
        nextBackupTime         = _DateOrNull $s.NextBackupTime
        numberOfVersions       = $s.NumberOfVersions
        currentOperationStatus = "$($s.CurrentOperationStatus)"
        detailedMessage        = $s.DetailedMessage
        recentJobs             = $jobs
        targets                = $targets
    }
    # Depth=4 covers our recentJobs array of objects. ConvertTo-Json defaults
    # to depth=2 which would silently truncate the array into "Length=10".
    $out | ConvertTo-Json -Compress -Depth 4
} catch {
    # Module not installed, or no backup policy set — return a tiny
    # marker the Python side can route to None.
    @{ installed = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress
}
"""


def _is_server_sku():
    """
    Skip the probe on client SKUs to save 200ms of PowerShell spin-up.
    Win32_OperatingSystem.ProductType: 1 = workstation, 2 = DC, 3 = server.
    """
    try:
        import wmi
        os_info = wmi.WMI().Win32_OperatingSystem()[0]
        return int(os_info.ProductType or 0) in (2, 3)
    except Exception:
        # If we can't tell, run the probe anyway — Get-WBSummary will
        # cheap-fail on a client SKU with "module not installed".
        return True


def collect():
    try:
        if not _is_server_sku():
            return None

        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", PS_SNIPPET,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,
        )
        if result.returncode != 0:
            return {"_error": f"Get-WBSummary failed: {result.stderr[:200]}"}
        stdout = result.stdout.strip()
        if not stdout:
            return None
        data = json.loads(stdout)

        if not data.get("installed"):
            # Module missing or no policy — don't emit a section, the
            # admin can see the absence on the dashboard.
            return None

        hr = data.get("lastBackupResultHR")
        last_result = None
        if hr is not None:
            try:
                hr_int = int(hr)
                last_result = WSB_RESULT_MAP.get(hr_int, f"code: {hr_int}")
            except (TypeError, ValueError):
                last_result = str(hr)

        # Normalize each recent job's HRESULT to text the same way we
        # do for the summary. Empty array if WSB has no run history yet.
        raw_jobs = data.get("recentJobs") or []
        recent_jobs = []
        for j in raw_jobs:
            j_hr = j.get("hresult")
            j_result = None
            if j_hr is not None:
                try:
                    j_hr_int = int(j_hr)
                    j_result = WSB_RESULT_MAP.get(j_hr_int, f"code: {j_hr_int}")
                except (TypeError, ValueError):
                    j_result = str(j_hr)
            recent_jobs.append({
                "startTime": j.get("startTime"),
                "endTime": j.get("endTime"),
                "jobType": j.get("jobType"),
                "jobState": j.get("jobState"),
                "result": j_result,
                "errorDescription": j.get("errorDescription"),
            })

        return {
            "installed": True,
            "lastBackupTime": data.get("lastBackupTime"),
            "lastBackupResult": last_result,
            "lastSuccessfulBackup": data.get("lastSuccessfulBackup"),
            "nextBackupTime": data.get("nextBackupTime"),
            "numberOfVersions": data.get("numberOfVersions"),
            "currentOperation": data.get("currentOperationStatus"),
            "detail": data.get("detailedMessage"),
            "recentJobs": recent_jobs,
            "targets": data.get("targets") or [],
        }

    except subprocess.TimeoutExpired:
        return {"_error": "Get-WBSummary timed out"}
    except Exception as e:
        return {"_error": f"wsb probe failed: {e}"}
