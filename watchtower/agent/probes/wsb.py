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
# Suppress all non-output streams so warnings / verbose / progress
# from cmdlets in this snippet don't get captured by Python's stdout.
# v0.14.18 fix: previously a "Reading PSGetModuleVersionHashtable from
# remote MEC..." progress write would pollute stdout BEFORE ConvertTo-Json
# ran, breaking the agent's json.loads() with the famous
# "Expecting value: line 1 column 1 (char 0)" error.
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Helper -- always available, even if Import-Module below fails. Some
# scripts had _DateOrNull defined INSIDE the try block, so when the
# outer catch ran with an Import-Module failure, _DateOrNull was not
# in scope and the catch block itself blew up with a "function not
# found" error -- emitting a stderr line to stdout instead of the
# expected fallback JSON. Define it up front so it's always reachable.
$minDate = [datetime]::MinValue
function _DateOrNull($d) {
    if ($d -and $d -ne $minDate) { return $d.ToString('o') } else { return $null }
}

try {
    Import-Module WindowsServerBackup -ErrorAction Stop
    $s = Get-WBSummary

    # Get-WBSummary returns [datetime]::MinValue (0001-01-01T00:00:00) for
    # date fields on hosts with no backup history yet -- not $null. The
    # _DateOrNull function (defined ABOVE the try block in v0.14.18+)
    # filters those out so the dashboard's no-policy empty-state branch
    # fires correctly (it gates on the field being null/falsy).

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

    # Pull the full WBPolicy once so we can extract targets + sources +
    # schedule + VSS options without re-calling Get-WBPolicy three times.
    # Hosts with no policy yet have $null here, which we coerce to empty
    # arrays / nulls below so the JSON shape stays consistent.
    $policy = $null
    try { $policy = Get-WBPolicy -ErrorAction Stop } catch { $policy = $null }

    # Backup targets — where the backup is being written. BackupTargets is
    # an array of WBBackupTarget objects; each has Label + TargetType +
    # one of (Path / Volume / UncPath) depending on type.
    #
    # PER-TARGET FORMAT DATE (v0.14.160+): read the NTFS volume root's
    # CreationTime via Get-Item. This is the moment the disk was last
    # formatted (NTFS creates $Volume's root directory during format and
    # never modifies it after), which proxies for "when did this physical
    # disk go into rotation for backups." More accurate than the
    # oldest-backup-version timestamp because format date predates the
    # first backup -- often by months (drive arrives → formatted → sits
    # → first backup runs).
    #
    # STRICTLY READ-ONLY. Get-Item is the PowerShell equivalent of stat();
    # the -Force flag suppresses the "are you sure" prompt for paths with
    # the system attribute set (volume roots), it does NOT grant write
    # permission. We never call Format-Volume, format.com, Initialize-Disk,
    # Clear-Disk, or any other write cmdlet anywhere in this probe.
    #
    # UNC targets get formatDate = $null since "when was the remote share
    # created" isn't meaningful for disk rotation planning. Disconnected
    # local targets (drive went offline since policy was set) also yield
    # null with no error -- Test-Path short-circuits.
    $targets = @()
    if ($policy -and $policy.BackupTargets) {
        $targets = @($policy.BackupTargets | ForEach-Object {
            $path = $null
            try { if ($_.Path)    { $path = "$($_.Path)" } } catch {}
            try { if (-not $path -and $_.UncPath) { $path = "$($_.UncPath)" } } catch {}
            try { if (-not $path -and $_.Source)  { $path = "$($_.Source)"  } } catch {}

            # Per-target NTFS volume format date. Read-only Get-Item on
            # the volume root. Skip UNC paths (\\server\share) -- those
            # match '^\\\\[^?]' (two backslashes followed by a non-?
            # character) and aren't physical disks. Volume GUID paths
            # like '\\?\Volume{guid}\' (common when WSB takes a disk
            # exclusively and Windows drops the drive letter) DO match
            # the negated pattern and get the lookup.
            $formatDate = $null
            try {
                if ($path -and $path -notmatch '^\\\\[^?]' -and (Test-Path $path)) {
                    $rootItem = Get-Item $path -Force -ErrorAction Stop
                    $formatDate = _DateOrNull $rootItem.CreationTime
                }
            } catch {
                # Quiet -- a missing / offline / inaccessible target
                # shouldn't fail the whole probe. formatDate stays $null.
            }

            [PSCustomObject]@{
                label      = "$($_.Label)"
                type       = "$($_.TargetType)"
                path       = $path
                formatDate = $formatDate
            }
        })
    }

    # Backup sources — what gets backed up. The policy carries up to four
    # source collections; admins typically pick exactly one model:
    #   VolumesToBackup       — full-volume backups (most common)
    #   FilesSpecsToBackup    — selective file/folder includes
    #   BareMetalRecovery     — bare-metal recovery (system + boot volume + system state)
    #   SystemState           — system state backup (registry, AD, etc)
    # We flatten all four into one array tagged with category so the
    # dashboard can render them grouped or flat.
    $sources = @()
    if ($policy) {
        try {
            foreach ($v in @($policy.VolumesToBackup)) {
                if ($v) {
                    $sources += [PSCustomObject]@{
                        category = "volume"
                        label    = "$($v.MountPath)"
                        detail   = "$($v.FileSystem) $([math]::Round($v.TotalSpace / 1GB, 1))GB"
                    }
                }
            }
        } catch {}
        try {
            foreach ($f in @($policy.FilesSpecsToBackup)) {
                if ($f) {
                    $sources += [PSCustomObject]@{
                        category = "files"
                        label    = "$($f.FileSpec)"
                        detail   = if ($f.IsInclusion) { "include" } else { "exclude" }
                    }
                }
            }
        } catch {}
        if ($policy.BareMetalRecovery) {
            $sources += [PSCustomObject]@{ category = "bare-metal"; label = "Bare metal recovery"; detail = "enabled" }
        }
        if ($policy.SystemState) {
            $sources += [PSCustomObject]@{ category = "system-state"; label = "System state"; detail = "enabled" }
        }
    }

    # Schedule — array of DateTime objects (one per scheduled run per day).
    # Get-WBPolicy returns them as DateTime with the date floor at 1601-01-01,
    # so only the time portion matters. Format as HH:mm strings for display.
    $schedule = @()
    if ($policy -and $policy.Schedule) {
        try {
            $schedule = @($policy.Schedule | ForEach-Object {
                if ($_) { $_.ToString("HH:mm") }
            })
        } catch { $schedule = @() }
    }

    # VSS backup mode + housekeeping flags.
    #   VssBackupOptions: VssCopyBackup (default — doesn't clear app logs)
    #                     vs VssFullBackup (clears app logs, marks files as backed up)
    #   AllowDeleteOldBackups: when target fills, can WSB prune old versions
    #   OverwriteOldFormatVhd: deal with legacy VHD formats from older OSes
    $vssMode = $null
    $allowDeleteOld = $null
    $overwriteOld = $null
    if ($policy) {
        try { $vssMode        = "$($policy.VssBackupOptions)" } catch {}
        try { $allowDeleteOld = [bool]$policy.AllowDeleteOldBackups } catch {}
        try { $overwriteOld   = [bool]$policy.OverwriteOldFormatVhd } catch {}
    }

    # Human-readable frequency description from the schedule array.
    # WSB's standard schedule is daily-at-time(s); compute a label.
    $frequency = $null
    if ($schedule.Count -gt 0) {
        $sortedTimes = @($schedule | Sort-Object)
        if ($sortedTimes.Count -eq 1) {
            $frequency = "Daily at $($sortedTimes[0])"
        } else {
            $frequency = "Daily, $($sortedTimes.Count) times ($($sortedTimes -join ', '))"
        }
    } elseif ($policy) {
        $frequency = "Policy exists, no times scheduled"
    }

    # ALL backup versions, not just LastBackup/LastSuccess. Get-WBBackupSet
    # returns one entry per completed backup with VersionId + BackupTime +
    # BackupTarget. We summarize the full set (totalBackups), then group
    # by target to show "N backups on Drive E:" / "N backups on \\server\share".
    # Each backup set also carries its own VssBackupOption so admins can
    # see if a specific run was VssCopy vs VssFull (handy when policy
    # changed mid-history).
    $totalBackups = 0
    $backupsByTarget = @()
    $perBackupVss = @()
    try {
        $sets = @(Get-WBBackupSet -ErrorAction Stop)
        $totalBackups = $sets.Count
        if ($sets.Count -gt 0) {
            # Group by BackupTarget label so the dashboard shows
            # backups-per-disk for multi-target WSB policies.
            $grouped = $sets | Group-Object -Property @{
                Expression = {
                    $t = $_.BackupTarget
                    if ($t -and $t.Label) { "$($t.Label)" }
                    elseif ($t -and $t.Path) { "$($t.Path)" }
                    elseif ($t -and $t.UncPath) { "$($t.UncPath)" }
                    else { "(unknown target)" }
                }
            }
            $backupsByTarget = @($grouped | ForEach-Object {
                $first = $_.Group | Sort-Object BackupTime | Select-Object -First 1
                $last  = $_.Group | Sort-Object BackupTime -Descending | Select-Object -First 1
                [PSCustomObject]@{
                    target          = "$($_.Name)"
                    count           = $_.Count
                    oldestBackup    = _DateOrNull $first.BackupTime
                    newestBackup    = _DateOrNull $last.BackupTime
                }
            })
            # Per-backup VSS settings -- capped at the 20 most recent
            # so the payload stays small even on hosts with 90+ days
            # of daily backups retained.
            $perBackupVss = @($sets | Sort-Object BackupTime -Descending |
                Select-Object -First 20 | ForEach-Object {
                    $tgt = $_.BackupTarget
                    $tgtLabel = $null
                    if ($tgt) {
                        if ($tgt.Label)   { $tgtLabel = "$($tgt.Label)" }
                        elseif ($tgt.Path) { $tgtLabel = "$($tgt.Path)" }
                        elseif ($tgt.UncPath) { $tgtLabel = "$($tgt.UncPath)" }
                    }
                    $vss = $null
                    try { $vss = "$($_.VssBackupOption)" } catch {}
                    [PSCustomObject]@{
                        backupTime = _DateOrNull $_.BackupTime
                        target     = $tgtLabel
                        vssOption  = $vss
                    }
                })
        }
    } catch {
        # Get-WBBackupSet can throw if no backups have ever completed.
        # That's not an error; leave counts at 0 and skip the arrays.
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
        sources                = $sources
        schedule               = $schedule
        frequency              = $frequency
        vssMode                = $vssMode
        allowDeleteOldBackups  = $allowDeleteOld
        overwriteOldFormatVhd  = $overwriteOld
        hasPolicy              = ($policy -ne $null)
        totalBackups           = $totalBackups
        backupsByTarget        = $backupsByTarget
        perBackupVss           = $perBackupVss
    }
    # Depth=4 covers our recentJobs array of objects. ConvertTo-Json defaults
    # to depth=2 which would silently truncate the array into "Length=10".
    $out | ConvertTo-Json -Compress -Depth 4
} catch {
    # Module not installed, or no backup policy set, or any other
    # outer-try failure. Emit a tiny marker the Python side routes
    # to None. Wrapped in its own try so a catch-block failure
    # (very rare, but seen when $_.Exception.Message itself throws)
    # still produces stdout that parses as JSON, instead of an
    # empty stdout that breaks json.loads with "Expecting value:
    # line 1 column 1 (char 0)".
    try {
        $errMsg = "$($_.Exception.Message)"
    } catch {
        $errMsg = 'unknown error'
    }
    Write-Output (@{ installed = $false; reason = $errMsg } | ConvertTo-Json -Compress)
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
            # 45s -- Get-WBBackupSet on hosts with 90+ days of daily
            # retention can take ~15s alone, plus Get-WBSummary +
            # Get-WBJob + Get-WBPolicy. Still well under the 60s
            # per-probe wall-clock cap in collector.py.
            timeout=45,
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
            # Policy details (v0.12.3+). Empty / null when WSB is installed
            # but no scheduled backup policy has been configured yet.
            "sources": data.get("sources") or [],
            "schedule": data.get("schedule") or [],
            "frequency": data.get("frequency"),
            "vssMode": data.get("vssMode"),
            "allowDeleteOldBackups": data.get("allowDeleteOldBackups"),
            "overwriteOldFormatVhd": data.get("overwriteOldFormatVhd"),
            "hasPolicy": data.get("hasPolicy", False),
            # Full backup-set inventory (v0.14.10+). Get-WBBackupSet
            # returns every retained backup version with its target and
            # VssBackupOption. totalBackups is the headline count for
            # the dashboard; backupsByTarget groups counts per
            # destination disk/share; perBackupVss surfaces per-run
            # VSS mode (capped at the 20 most recent to keep payload
            # small on hosts with deep retention).
            "totalBackups": data.get("totalBackups", 0),
            "backupsByTarget": data.get("backupsByTarget") or [],
            "perBackupVss": data.get("perBackupVss") or [],
        }

    except subprocess.TimeoutExpired:
        return {"_error": "Get-WBSummary timed out"}
    except Exception as e:
        return {"_error": f"wsb probe failed: {e}"}
