#Requires -Version 5.1
<#
.SYNOPSIS
    Run Check Disk (chkdsk) the classic way - fix filesystem errors and scan
    for bad sectors (chkdsk /f /r). On the Windows drive it schedules the check
    for the next restart. Windows 10 and 11. Admin required (self-elevates).

.DESCRIPTION
    Wraps the classic:  chkdsk C: /f /r
      /f  fixes filesystem errors
      /r  locates bad sectors and recovers readable data (implies a long
          surface scan - can take hours on large/slow drives)

    The Windows (system) drive can't be locked while Windows is running, so
    chkdsk offers to schedule the check at the next restart - this script
    answers Yes automatically and confirms it's queued. Non-system drives are
    checked immediately when they can be locked.

.PARAMETER Drive
    Drive letter to check. Default C.

.PARAMETER ReadOnly
    Scan only - report problems without fixing anything (no /f, no /r).
    Runs live, no reboot needed.

.PARAMETER SkipSurface
    Skip the bad-sector surface scan (/r) - much faster; still fixes
    filesystem errors (/f).

.PARAMETER Reboot
    Restart the PC immediately after scheduling, so the check runs now.

.PARAMETER Status
    Just show whether a check is already scheduled for the drive (chkntfs).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Invoke-CheckDisk.ps1
    Schedules chkdsk C: /f /r for the next restart (the classic full check).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Invoke-CheckDisk.ps1 -SkipSurface
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Invoke-CheckDisk.ps1 -Drive D
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Invoke-CheckDisk.ps1 -Status
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z]$')][string]$Drive = 'C',
    [switch]$ReadOnly,
    [switch]$SkipSurface,
    [switch]$Reboot,
    [switch]$Status,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$Drive = $Drive.ToUpper()

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath), '-Drive', $Drive)
    foreach ($s in 'ReadOnly','SkipSurface','Reboot','Status') {
        if ((Get-Variable $s).Value) { $a += "-$s" }
    }
    Write-Host "Elevating (chkdsk needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

# Status is read-only (but chkntfs itself still requires an elevated prompt).
if ($Status) {
    Write-Host "Scheduled-check status for ${Drive}: (chkntfs)" -ForegroundColor Cyan
    chkntfs "${Drive}:"
    Write-Host "`n(Nothing was changed - status query only.)"
    if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
    return
}

# Build chkdsk arguments
$args_ = @("${Drive}:")
if (-not $ReadOnly) {
    $args_ += '/F'
    if (-not $SkipSurface) { $args_ += '/R' }
}
$argLine = $args_ -join ' '

$sysDrive = $env:SystemDrive.TrimEnd(':')
Write-Host ("Running: chkdsk {0}" -f $argLine) -ForegroundColor Cyan
if (-not $ReadOnly -and $Drive -eq $sysDrive) {
    Write-Host "This is the Windows drive - the check will be SCHEDULED for the next restart." -ForegroundColor Yellow
}
if ($ReadOnly) {
    Write-Host "(Read-only scan - nothing will be changed.)"
}

if ($PSCmdlet.ShouldProcess("drive ${Drive}:", "chkdsk $argLine")) {
    # echo Y answers the "schedule on next restart?" prompt for a locked drive.
    cmd /c "echo Y|chkdsk $argLine"
    $code = $LASTEXITCODE
    Write-Host ""
    switch ($code) {
        0 { Write-Host "chkdsk: no errors found (exit 0)." -ForegroundColor Green }
        1 { Write-Host "chkdsk: errors were found and fixed (exit 1)." -ForegroundColor Green }
        2 { Write-Host "chkdsk: cleanup performed or check scheduled (exit 2)." -ForegroundColor Green }
        3 { Write-Host "chkdsk: errors found - could not all be fixed (exit 3)." -ForegroundColor Yellow }
        default { Write-Host "chkdsk exit code: $code" }
    }
    Write-Host ""
    Write-Host "Scheduled-check status (chkntfs):"
    chkntfs "${Drive}:"

    if ($Reboot -and -not $ReadOnly) {
        if ($PSCmdlet.ShouldProcess('this PC', 'restart now to run the check')) {
            Write-Host "Restarting..." -ForegroundColor Yellow
            Restart-Computer -Force
        }
    } elseif (-not $ReadOnly -and $Drive -eq $sysDrive) {
        Write-Host "Restart the PC when convenient to run the check (or re-run with -Reboot)." -ForegroundColor Yellow
    }
}

# Keep the (elevated) window open so the results can be read.
if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
