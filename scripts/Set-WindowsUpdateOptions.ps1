#Requires -Version 5.1
<#
.SYNOPSIS
    Configure Windows Update "Advanced options": turn on "Receive updates for
    other Microsoft products" and "Notify me when a restart is required", and
    set Active hours. Windows 10 and Windows 11. Admin required (self-elevates).

.DESCRIPTION
    Sets, under HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings and via the
    Microsoft Update COM service:

      * Receive updates for other Microsoft products
            Registers the Microsoft Update service (GUID 7971f918-...) through
            Microsoft.Update.ServiceManager, with an AllowMUUpdateService=1
            registry fallback.
      * Notify me when a restart is required to finish updating
            RestartNotificationsAllowed2 = 1
      * Active hours
            Manual: SmartActiveHoursState = 0 + ActiveHoursStart / ActiveHoursEnd
            Auto:   SmartActiveHoursState = 1 (Windows adjusts by activity)

    On machines managed by Group Policy / Intune / WSUS, policy may override
    these. Active hours range cannot exceed 18 hours (a Windows limit).

.PARAMETER ActiveHoursStart
    Active hours start hour, 0-23 (24-hour). Default 7 (7 AM).

.PARAMETER ActiveHoursEnd
    Active hours end hour, 0-23 (24-hour). Default 23 (11 PM).

.PARAMETER AutoActiveHours
    Let Windows manage active hours automatically instead of setting fixed hours.

.PARAMETER NoMicrosoftUpdate
    Skip the "Receive updates for other Microsoft products" step.

.PARAMETER NoRestartNotify
    Skip the "Notify me when a restart is required" step.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WindowsUpdateOptions.ps1
    Turn both toggles on and set active hours to 7 AM - 11 PM.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WindowsUpdateOptions.ps1 -ActiveHoursStart 8 -ActiveHoursEnd 22

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Set-WindowsUpdateOptions.ps1 -AutoActiveHours
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateRange(0,23)][int]$ActiveHoursStart = 7,
    [ValidateRange(0,23)][int]$ActiveHoursEnd   = 23,
    [switch]$AutoActiveHours,
    [switch]$NoMicrosoftUpdate,
    [switch]$NoRestartNotify
)

$ErrorActionPreference = 'Stop'
$UxKey = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
$MicrosoftUpdateId = '7971f918-a847-4430-9279-4a52d1efe18d'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
           '-ActiveHoursStart', $ActiveHoursStart, '-ActiveHoursEnd', $ActiveHoursEnd)
    if ($AutoActiveHours)   { $a += '-AutoActiveHours' }
    if ($NoMicrosoftUpdate) { $a += '-NoMicrosoftUpdate' }
    if ($NoRestartNotify)   { $a += '-NoRestartNotify' }
    Write-Host "Elevating (these settings are machine-wide and need administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

function Format-Hour([int]$h) { (Get-Date -Hour $h -Minute 0 -Second 0).ToString('h:mm tt') }

# Self-elevate for HKLM + COM service registration.
if (-not (Test-Admin)) { Invoke-Elevate; return }

if (-not (Test-Path $UxKey)) { New-Item -Path $UxKey -Force | Out-Null }

# 1) Receive updates for other Microsoft products
if (-not $NoMicrosoftUpdate) {
    if ($PSCmdlet.ShouldProcess('Receive updates for other Microsoft products', 'turn on')) {
        $ok = $false
        try {
            $sm = New-Object -ComObject Microsoft.Update.ServiceManager
            # flags 7 = AllowPendingRegistration | AllowOnlineRegistration | RegisterServiceWithAU
            $sm.AddService2($MicrosoftUpdateId, 7, '') | Out-Null
            $ok = $true
        } catch {
            Write-Warning "COM opt-in failed ($($_.Exception.Message)); using registry fallback."
        }
        New-ItemProperty $UxKey -Name 'AllowMUUpdateService' -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host ("Receive updates for other Microsoft products: ON{0}" -f $(if ($ok) {''} else {' (registry fallback)'}))
    }
}

# 2) Notify me when a restart is required to finish updating
if (-not $NoRestartNotify) {
    if ($PSCmdlet.ShouldProcess('Notify me when a restart is required', 'turn on')) {
        New-ItemProperty $UxKey -Name 'RestartNotificationsAllowed2' -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "Notify me when a restart is required to finish updating: ON"
    }
}

# 3) Active hours
if ($AutoActiveHours) {
    if ($PSCmdlet.ShouldProcess('Active hours', 'set to automatic')) {
        New-ItemProperty $UxKey -Name 'SmartActiveHoursState' -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "Active hours: automatic (Windows adjusts based on activity)."
    }
} else {
    $span = ($ActiveHoursEnd - $ActiveHoursStart + 24) % 24
    if ($span -eq 0 -or $span -gt 18) {
        Write-Warning ("Active hours range is {0}h; Windows requires 1-18h. Setting it anyway, but Windows may ignore it." -f $span)
    }
    if ($PSCmdlet.ShouldProcess('Active hours', ("set {0} - {1}" -f (Format-Hour $ActiveHoursStart), (Format-Hour $ActiveHoursEnd)))) {
        New-ItemProperty $UxKey -Name 'SmartActiveHoursState' -Value 0 -PropertyType DWord -Force | Out-Null
        New-ItemProperty $UxKey -Name 'ActiveHoursStart' -Value $ActiveHoursStart -PropertyType DWord -Force | Out-Null
        New-ItemProperty $UxKey -Name 'ActiveHoursEnd' -Value $ActiveHoursEnd -PropertyType DWord -Force | Out-Null
        Write-Host ("Active hours: {0} - {1}" -f (Format-Hour $ActiveHoursStart), (Format-Hour $ActiveHoursEnd))
    }
}

Write-Host "`nDone. Open Windows Update > Advanced options to confirm." -ForegroundColor Green
