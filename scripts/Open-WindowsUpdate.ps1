#Requires -Version 5.1
<#
.SYNOPSIS
    Open the Windows Update screen, pause updates for a set number of days,
    wait, then trigger a check for updates. Windows 10 and Windows 11.

.DESCRIPTION
    Runs this sequence:
      1. Opens Settings > Windows Update (ms-settings:windowsupdate).
      2. Pauses updates for -PauseDays by writing the pause window to
         HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings (needs admin).
      3. Waits -WaitSeconds.
      4. Triggers "Check for updates" (ms-settings:windowsupdate-action).

    Pausing edits machine-wide registry, so the script self-elevates if it is
    not already running as administrator (unless -NoPause is used). The
    ms-settings screen still opens in your normal user session.

    Note: on machines where Windows Update is managed by Group Policy / Intune /
    WSUS, the pause values here may be overridden by policy.

.PARAMETER PauseDays
    How many days to pause updates. Default 7. Windows typically caps pause at
    35 days; values above the cap are clamped by Windows.

.PARAMETER WaitSeconds
    Seconds to wait between pausing and checking for updates. Default 10.

.PARAMETER NoPause
    Skip the pause step (no admin needed) - just open the screen, wait, and
    check for updates.

.PARAMETER Resume
    Clear an existing pause (resume updates) instead of pausing, then open the
    screen and check. Needs admin.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-WindowsUpdate.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-WindowsUpdate.ps1 -PauseDays 14 -WaitSeconds 5
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-WindowsUpdate.ps1 -Resume
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-WindowsUpdate.ps1 -NoPause
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [int]$PauseDays = 7,
    [int]$WaitSeconds = 10,
    [switch]$NoPause,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$UxKey = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
           '-PauseDays', $PauseDays, '-WaitSeconds', $WaitSeconds)
    if ($NoPause) { $a += '-NoPause' }
    if ($Resume)  { $a += '-Resume' }
    Write-Host "Elevating (pausing/resuming updates needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

function Set-Pause {
    if (-not (Test-Path $UxKey)) { New-Item -Path $UxKey -Force | Out-Null }
    $now   = (Get-Date).ToUniversalTime()
    $start = $now.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $end   = $now.AddDays($PauseDays).ToString("yyyy-MM-ddTHH:mm:ssZ")
    $pairs = @{
        'PauseUpdatesStartTime'        = $start
        'PauseUpdatesExpiryTime'       = $end
        'PauseFeatureUpdatesStartTime' = $start
        'PauseFeatureUpdatesEndTime'   = $end
        'PauseQualityUpdatesStartTime' = $start
        'PauseQualityUpdatesEndTime'   = $end
    }
    foreach ($name in $pairs.Keys) {
        New-ItemProperty -Path $UxKey -Name $name -Value $pairs[$name] -PropertyType String -Force | Out-Null
    }
    Write-Host ("Paused updates for {0} day(s) - resumes {1}." -f $PauseDays, $end)
}

function Clear-Pause {
    if (-not (Test-Path $UxKey)) { Write-Host "No pause settings found."; return }
    $names = 'PauseUpdatesStartTime','PauseUpdatesExpiryTime',
             'PauseFeatureUpdatesStartTime','PauseFeatureUpdatesEndTime',
             'PauseQualityUpdatesStartTime','PauseQualityUpdatesEndTime'
    foreach ($n in $names) {
        Remove-ItemProperty -Path $UxKey -Name $n -ErrorAction SilentlyContinue
    }
    Write-Host "Cleared pause - updates resumed."
}

# Self-elevate if we need to touch HKLM and are not admin.
$needsAdmin = (-not $NoPause) -or $Resume
if ($needsAdmin -and -not (Test-Admin)) {
    Invoke-Elevate
    return
}

# 1) Open the Windows Update screen.
Write-Host "Opening Windows Update..."
Start-Process 'ms-settings:windowsupdate'

# 2) Pause or resume.
if ($Resume) {
    if ($PSCmdlet.ShouldProcess('Windows Update', 'resume (clear pause)')) { Clear-Pause }
} elseif (-not $NoPause) {
    if ($PSCmdlet.ShouldProcess('Windows Update', "pause for $PauseDays day(s)")) { Set-Pause }
} else {
    Write-Host "Skipping pause (-NoPause)."
}

# 3) Wait.
if ($WaitSeconds -gt 0) {
    Write-Host "Waiting $WaitSeconds second(s)..."
    Start-Sleep -Seconds $WaitSeconds
}

# 4) Check for updates.
Write-Host "Checking for updates..."
Start-Process 'ms-settings:windowsupdate-action'

Write-Host "Done." -ForegroundColor Green
