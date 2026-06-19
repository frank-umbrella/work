#Requires -Version 5.1
<#
.SYNOPSIS
    Force every system-tray (notification area) icon to always display on the
    taskbar, instead of being tucked away in the Windows 11 chevron flyout.

.DESCRIPTION
    Windows 11 (build 22000+) tracks per-icon visibility under
        HKCU\Control Panel\NotifyIconSettings\<hash>
    where each app gets a subkey containing an "IsPromoted" DWORD:
        IsPromoted = 1  -> icon shown directly on the taskbar (what we want)
        IsPromoted = 0  -> icon hidden inside the "Hidden icon menu" chevron
    The Settings > Personalization > Taskbar "always show new icons" option is
    unreliable: newly installed apps frequently land with IsPromoted = 0, so
    they vanish into the flyout. This script sets IsPromoted = 1 on every
    entry so all icons display, and the chevron disappears once nothing is
    hidden.

    On Windows 10 it instead sets EnableAutoTray = 0, the equivalent of
    "Always show all icons in the notification area."

    A subkey only exists after its app has shown a tray icon at least once.
    Brand-new apps therefore need a re-run after they have launched, which is
    why -Install registers a logon scheduled task that re-applies the fix
    automatically on every sign-in.

.PARAMETER Install
    Copy this script to a stable local path and register a scheduled task that
    re-applies the fix ~1 minute after each logon. Survives new app installs.

.PARAMETER Uninstall
    Remove the scheduled task and the local copy created by -Install.

.PARAMETER NoRestart
    Apply the registry changes but do not restart Explorer. (The logon task
    uses this implicitly only when nothing changed.)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Show-AllTrayIcons.ps1
    One-shot: show all current tray icons and restart Explorer now.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Show-AllTrayIcons.ps1 -Install
    Apply now and auto-reapply on every logon.

.NOTES
    Runs entirely in HKCU - no administrator rights required.
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$TaskName    = 'ShowAllTrayIcons'
$InstallDir  = Join-Path $env:LOCALAPPDATA 'ShowAllTrayIcons'
$InstallPath = Join-Path $InstallDir 'Show-AllTrayIcons.ps1'

function Test-IsWindows11 {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    return ([int]$cv.CurrentBuildNumber -ge 22000)
}

function Set-Win11TrayIcons {
    $base = 'HKCU:\Control Panel\NotifyIconSettings'
    if (-not (Test-Path $base)) {
        Write-Warning "NotifyIconSettings key not present yet. Tray apps register here only after they have shown an icon once. Launch your apps, then re-run."
        return 0
    }
    $changed = 0
    foreach ($key in Get-ChildItem $base) {
        $current = (Get-ItemProperty -Path $key.PSPath -Name 'IsPromoted' -ErrorAction SilentlyContinue).IsPromoted
        if ($current -ne 1) {
            New-ItemProperty -Path $key.PSPath -Name 'IsPromoted' -Value 1 -PropertyType DWord -Force | Out-Null
            $changed++
        }
        $exe = (Get-ItemProperty -Path $key.PSPath -Name 'ExecutablePath' -ErrorAction SilentlyContinue).ExecutablePath
        Write-Verbose "Promoted: $exe"
    }
    Write-Host ("Windows 11: promoted {0} icon(s) that were hidden." -f $changed)
    return $changed
}

function Set-Win10TrayIcons {
    $adv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
    $current = (Get-ItemProperty -Path $adv -Name 'EnableAutoTray' -ErrorAction SilentlyContinue).EnableAutoTray
    if ($current -ne 0) {
        New-ItemProperty -Path $adv -Name 'EnableAutoTray' -Value 0 -PropertyType DWord -Force | Out-Null
        Write-Host "Windows 10: set EnableAutoTray=0 (always show all icons)."
        return 1
    }
    Write-Host "Windows 10: EnableAutoTray already 0 (always show all icons)."
    return 0
}

function Restart-Explorer {
    Write-Host "Restarting Explorer to apply changes..."
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe
    }
}

function Invoke-Apply {
    if (Test-IsWindows11) {
        $changed = Set-Win11TrayIcons
    } else {
        $changed = Set-Win10TrayIcons
    }
    if ($changed -gt 0 -and -not $NoRestart) {
        Restart-Explorer
    } else {
        Write-Host "No restart needed."
    }
}

function Install-LogonTask {
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    Copy-Item -Path $PSCommandPath -Destination $InstallPath -Force
    Write-Host "Installed script to $InstallPath"

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $InstallPath)

    $trigger = New-ScheduledTaskTrigger -AtLogOn
    # Wait a minute so startup tray apps have registered before we promote them.
    $trigger.Delay = 'PT1M'

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable

    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description 'Promote all system tray icons to always-visible on the taskbar.' `
        -Force | Out-Null

    Write-Host "Registered logon task '$TaskName' (runs ~1 min after each sign-in)."
    Write-Host "Applying once now..."
    Invoke-Apply
}

function Uninstall-LogonTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed logon task '$TaskName'."
    } else {
        Write-Host "No logon task '$TaskName' found."
    }
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Host "Removed $InstallDir"
    }
}

# --- entry point ---
if ($Install) {
    Install-LogonTask
} elseif ($Uninstall) {
    Uninstall-LogonTask
} else {
    Invoke-Apply
}
