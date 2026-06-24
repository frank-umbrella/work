#Requires -Version 5.1
<#
.SYNOPSIS
    Remove leftover ESET Online Scanner pieces - the periodic-scan scheduled
    tasks that make it run at startup, plus its data folder and Desktop
    shortcut. Windows 10 and Windows 11. Self-elevates.

.DESCRIPTION
    ESET Online Scanner is one-time by default, but if "Periodic scanning" was
    accepted it registers scheduled tasks (EOSv3 Scheduler onLogOn / onTime)
    that re-run scans at logon / on a timer, and these survive even after you
    "delete" the scanner. This removes:

        * Scheduled tasks matching EOSv3 / ESET Online Scanner
        * The data folder  <user>\AppData\Local\ESET\ESETOnlineScanner
          (checked for every user profile, plus ProgramData)
        * Desktop shortcuts named "ESET Online Scanner*"
        * Any running esetonlinescanner process

    NOTE: deleting the data folder also discards any ESET Online Scanner
    QUARANTINE. If the scanner quarantined something you might still want, copy
    it out first. This does NOT touch any installed ESET antivirus product -
    only the on-demand Online Scanner's leftovers.

.PARAMETER List
    Show what would be removed (tasks, folders, shortcuts) - change nothing.

.PARAMETER NoElevate
    Do not auto-elevate (task removal and other-user folders then need admin).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-ESETOnlineScanner.ps1 -List
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-ESETOnlineScanner.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$List,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$TaskMatch = 'EOSv3|ESET Online Scanner|ESETOnlineScanner'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    if ($List) { $a += '-List' }
    Write-Host "Elevating (removing scheduled tasks / other-user data needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

function Get-Targets {
    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match $TaskMatch }

    $folders = New-Object System.Collections.Generic.List[string]
    Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $f = Join-Path $_.FullName 'AppData\Local\ESET\ESETOnlineScanner'
        if (Test-Path $f) { $folders.Add($f) }
    }
    foreach ($p in @((Join-Path $env:ProgramData 'ESET\ESET Online Scanner'),
                     (Join-Path $env:ProgramData 'ESET\ESETOnlineScanner'))) {
        if (Test-Path $p) { $folders.Add($p) }
    }

    $shortcuts = New-Object System.Collections.Generic.List[string]
    $desks = @()
    Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $desks += (Join-Path $_.FullName 'Desktop') }
    $desks += (Join-Path $env:PUBLIC 'Desktop')
    foreach ($d in $desks) {
        Get-ChildItem $d -Filter 'ESET Online Scanner*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $shortcuts.Add($_.FullName) }
    }

    $procs = Get-Process -Name 'esetonlinescanner','eos' -ErrorAction SilentlyContinue

    [PSCustomObject]@{ Tasks = $tasks; Folders = $folders; Shortcuts = $shortcuts; Procs = $procs }
}

# ===== main ==================================================================
$t = Get-Targets

if ($List) {
    Write-Host "=== Scheduled tasks ===" -ForegroundColor Cyan
    if ($t.Tasks) { $t.Tasks | Select-Object TaskPath, TaskName, State | Format-Table -AutoSize } else { "  (none)" }
    Write-Host "=== Data folders ===" -ForegroundColor Cyan
    if ($t.Folders) { $t.Folders | ForEach-Object { "  $_" } } else { "  (none)" }
    Write-Host "=== Desktop shortcuts ===" -ForegroundColor Cyan
    if ($t.Shortcuts) { $t.Shortcuts | ForEach-Object { "  $_" } } else { "  (none)" }
    Write-Host "=== Running process ===" -ForegroundColor Cyan
    if ($t.Procs) { $t.Procs | Select-Object Name, Id | Format-Table -AutoSize } else { "  (none)" }
    return
}

if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

# stop running scanner
foreach ($p in $t.Procs) {
    if ($PSCmdlet.ShouldProcess($p.Name, 'stop process')) {
        try { $p | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host "Stopped: $($p.Name)" } catch {}
    }
}

# remove scheduled tasks (the startup trigger)
foreach ($task in $t.Tasks) {
    if ($PSCmdlet.ShouldProcess(($task.TaskPath + $task.TaskName), 'remove scheduled task')) {
        try {
            Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue | Out-Null
            Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false -ErrorAction SilentlyContinue
            Write-Host "Task removed: $($task.TaskName)"
        } catch { Write-Warning "Could not remove task $($task.TaskName): $($_.Exception.Message)" }
    }
}

# remove data folders
foreach ($f in $t.Folders) {
    if ($PSCmdlet.ShouldProcess($f, 'delete folder (includes any quarantine)')) {
        try { Remove-Item -LiteralPath $f -Recurse -Force -ErrorAction Stop; Write-Host "Folder removed: $f" }
        catch { Write-Warning "Could not fully remove $f (in use?): $($_.Exception.Message)" }
    }
}

# remove desktop shortcuts
foreach ($s in $t.Shortcuts) {
    if ($PSCmdlet.ShouldProcess($s, 'delete shortcut')) {
        try { Remove-Item -LiteralPath $s -Force -ErrorAction SilentlyContinue; Write-Host "Shortcut removed: $s" } catch {}
    }
}

Write-Host "`nDone. Re-run with -List to confirm nothing remains." -ForegroundColor Green
