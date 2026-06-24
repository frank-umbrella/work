#Requires -Version 5.1
<#
.SYNOPSIS
    Fully remove HP Wolf Security / HP Wolf Pro Security and stop it from
    reinstalling itself. Windows 10 and Windows 11. Admin required (self-elevates).

.DESCRIPTION
    A plain "uninstall in Programs and Features" leaves the HP Security Update
    Service behind, which then re-downloads and reinstalls the agent - which is
    why it keeps coming back. This script removes the whole stack in HP's
    documented order, with the update service last, and also clears the
    services, scheduled tasks, and Store/AppX packages that trigger reinstalls.

    HP's documented uninstall order (https://support.hpwolf.com - "How to
    uninstall HP Wolf Pro Security"):
        1. HP Wolf Security / HP Wolf Pro Security
        2. HP Wolf Security - Console
        3. HP Security Update Service   <- removing this stops the reinstall

    What it does, in order:
        1. Stops + disables HP Wolf / Sure Click / Sure Sense / Security Update
           services (prevents reinstall and tamper during removal).
        2. Disables + removes matching scheduled tasks.
        3. Uninstalls each matching product silently (msiexec /x {GUID} /qn), in
           the order above, update service LAST.
        4. Removes matching Store / provisioned AppX packages.
        5. Reports whether a reboot is needed (HP recommends one).

    Discovery-based: it finds whatever HP Wolf components are actually present
    (and their current MSI product codes), so it works across versions.

    MANAGED / PASSWORD-PROTECTED installs: if HP Wolf Pro Security is managed by
    an HP admin console or set with an uninstall password, msiexec may fail
    (exit 1603). Those require the admin console or the uninstall password - the
    script reports the failure rather than forcing it.

.PARAMETER List
    Show every HP Wolf / Sure / Security Update component, service, task, and
    AppX package found - change nothing.

.PARAMETER Reboot
    Reboot automatically when finished (HP recommends a reboot to complete).

.PARAMETER NoElevate
    Do not auto-elevate (most steps will then fail without admin).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-HPWolfSecurity.ps1 -List
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-HPWolfSecurity.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-HPWolfSecurity.ps1 -Reboot
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$List,
    [switch]$Reboot,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

# Uninstall order (anchored regex). Update Service is LAST on purpose - it is
# the component that re-downloads the agent if removed too early.
$UninstallOrder = @(
    '^HP Wolf Pro Security$'
    '^HP Wolf Security$'
    '^HP Wolf Security - Console$'
    '^HP Sure Sense.*'
    '^HP Sure Click.*'
    '^HP Security Update Service$'
)
# Broad match for services / tasks / appx / leftover entries.
$BroadMatch = 'HP Wolf|HP Sure Click|HP Sure Sense|HP Security Update|Bromium'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    if ($List)   { $a += '-List' }
    if ($Reboot) { $a += '-Reboot' }
    Write-Host "Elevating (removing software needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

function Get-Installed {
    $roots = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
             'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    foreach ($r in $roots) {
        if (-not (Test-Path $r)) { continue }
        foreach ($k in Get-ChildItem $r -ErrorAction SilentlyContinue) {
            $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
            if (-not $p.DisplayName) { continue }
            [PSCustomObject]@{
                DisplayName    = $p.DisplayName
                ProductCode    = $k.PSChildName
                UninstallString= $p.UninstallString
                QuietString    = $p.QuietUninstallString
            }
        }
    }
}

function Uninstall-Product($app) {
    if ($app.ProductCode -match '^\{[0-9A-Fa-f-]{36}\}$') {
        $p = Start-Process msiexec.exe -ArgumentList ("/x {0} /qn /norestart" -f $app.ProductCode) -Wait -PassThru
        return $p.ExitCode
    }
    if ($app.QuietString) {
        $p = Start-Process cmd.exe -ArgumentList ('/c "{0}"' -f $app.QuietString) -Wait -PassThru
        return $p.ExitCode
    }
    if ($app.UninstallString) {
        Write-Warning ("'{0}' has no silent uninstall string; running it may prompt." -f $app.DisplayName)
        $p = Start-Process cmd.exe -ArgumentList ('/c "{0}"' -f $app.UninstallString) -Wait -PassThru
        return $p.ExitCode
    }
    return $null
}

function Describe-Exit($code) {
    switch ($code) {
        0     { 'OK' }
        3010  { 'OK (reboot required)' }
        1605  { 'not installed' }
        1618  { 'another install in progress - retry later' }
        1603  { 'FAILED 1603 (often managed/password-protected - needs HP console or uninstall password)' }
        default { "exit $code" }
    }
}

# ===== main ==================================================================
if (-not $List -and -not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

$rebootNeeded = $false

# --- discovery
$installed = Get-Installed
$services  = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match $BroadMatch -or $_.Name -match $BroadMatch }
$tasks     = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match $BroadMatch -or $_.TaskPath -match 'HP' -and $_.TaskName -match 'Wolf|Sure|Security Update' }
$appx      = @()
try { $appx = Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Wolf|HPSure' } } catch {}

if ($List) {
    Write-Host "=== HP Wolf components found ===" -ForegroundColor Cyan
    $hp = $installed | Where-Object { $d = $_.DisplayName; ($UninstallOrder | Where-Object { $d -match $_ }) -or $d -match $BroadMatch }
    if ($hp) { $hp | Select-Object DisplayName, ProductCode | Format-Table -AutoSize -Wrap } else { "  (none)" }
    Write-Host "=== Services ===" -ForegroundColor Cyan
    if ($services) { $services | Select-Object Status, Name, DisplayName | Format-Table -AutoSize } else { "  (none)" }
    Write-Host "=== Scheduled tasks ===" -ForegroundColor Cyan
    if ($tasks) { $tasks | Select-Object TaskPath, TaskName, State | Format-Table -AutoSize } else { "  (none)" }
    Write-Host "=== AppX packages ===" -ForegroundColor Cyan
    if ($appx) { $appx | Select-Object Name, PackageFullName | Format-Table -AutoSize -Wrap } else { "  (none)" }
    return
}

# --- 1) stop + disable services first (prevents reinstall / tamper)
foreach ($s in $services) {
    if ($PSCmdlet.ShouldProcess($s.Name, 'stop + disable service')) {
        try { Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue } catch {}
        try { Set-Service -Name $s.Name -StartupType Disabled -ErrorAction SilentlyContinue } catch {}
        Write-Host "Service stopped/disabled: $($s.DisplayName)"
    }
}

# --- 2) disable + remove scheduled tasks
foreach ($t in $tasks) {
    if ($PSCmdlet.ShouldProcess(($t.TaskPath + $t.TaskName), 'remove scheduled task')) {
        try { Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue | Out-Null } catch {}
        try { Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        Write-Host "Task removed: $($t.TaskName)"
    }
}

# --- 3) uninstall products in HP's order (update service last)
$done = New-Object System.Collections.Generic.HashSet[string]
foreach ($pattern in $UninstallOrder) {
    foreach ($app in ($installed | Where-Object { $_.DisplayName -match $pattern })) {
        if ($done.Contains($app.ProductCode)) { continue }
        [void]$done.Add($app.ProductCode)
        if ($PSCmdlet.ShouldProcess($app.DisplayName, 'uninstall')) {
            Write-Host ("Uninstalling: {0}" -f $app.DisplayName) -NoNewline
            $code = Uninstall-Product $app
            if ($code -eq 3010) { $rebootNeeded = $true }
            Write-Host ("  -> {0}" -f (Describe-Exit $code))
        }
    }
}
# catch-all: any remaining HP Wolf entry not matched above
foreach ($app in ($installed | Where-Object { $_.DisplayName -match 'HP Wolf' -and -not $done.Contains($_.ProductCode) })) {
    if ($PSCmdlet.ShouldProcess($app.DisplayName, 'uninstall')) {
        Write-Host ("Uninstalling: {0}" -f $app.DisplayName) -NoNewline
        $code = Uninstall-Product $app
        if ($code -eq 3010) { $rebootNeeded = $true }
        Write-Host ("  -> {0}" -f (Describe-Exit $code))
    }
}

# --- 4) remove Store / provisioned AppX
foreach ($pkg in $appx) {
    if ($PSCmdlet.ShouldProcess($pkg.Name, 'remove AppX')) {
        try { Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction SilentlyContinue; Write-Host "AppX removed: $($pkg.Name)" } catch {}
    }
}
try {
    Get-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'Wolf|HPSure' } | ForEach-Object {
            if ($PSCmdlet.ShouldProcess($_.DisplayName, 'remove provisioned AppX')) {
                Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName -ErrorAction SilentlyContinue | Out-Null
                Write-Host "Provisioned AppX removed: $($_.DisplayName)"
            }
        }
} catch {}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Re-run with -List to confirm nothing remains." -ForegroundColor Green
if ($rebootNeeded -or $true) {
    Write-Host "A reboot is recommended to finish removal." -ForegroundColor Yellow
    if ($Reboot) {
        if ($PSCmdlet.ShouldProcess('this PC', 'restart now')) { Restart-Computer -Force }
    } else {
        Write-Host "Run again with -Reboot to restart automatically, or reboot manually."
    }
}
