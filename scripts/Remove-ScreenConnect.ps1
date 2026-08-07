#Requires -Version 5.1
<#
.SYNOPSIS
    Fully remove the ScreenConnect / ConnectWise Control client from a PC -
    every installed instance, its Windows service, and leftover files.
    Windows 10 and 11. Admin required (self-elevates).

.DESCRIPTION
    The ScreenConnect access agent installs as "ScreenConnect Client (<id>)":
    a program (msiexec-based), a Windows service of the same name, and a folder
    under Program Files (usually Program Files (x86)). A machine can carry MORE
    THAN ONE instance - e.g. agents left behind by different providers. This
    finds every ScreenConnect / ConnectWise Control instance and:

        1. Uninstalls each one silently (msiexec / its uninstall string).
        2. Stops and deletes any leftover ScreenConnect service.
        3. Deletes any leftover "ScreenConnect Client ..." Program Files folder.

    Discovery-based, so it removes all instances and works across versions.

.PARAMETER List
    Show every ScreenConnect product, service, and folder found - change nothing.

.PARAMETER NoElevate
    Do not auto-elevate.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-ScreenConnect.ps1 -List
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Remove-ScreenConnect.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$List,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$Match = 'ScreenConnect|ConnectWise Control'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    if ($List) { $a += '-List' }
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
            if ($p.DisplayName -match $Match) {
                [PSCustomObject]@{
                    DisplayName = $p.DisplayName
                    ProductCode = $k.PSChildName
                    Uninstall   = $p.UninstallString
                    Quiet       = $p.QuietUninstallString
                }
            }
        }
    }
}

function Get-Services { Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ScreenConnect' -or $_.DisplayName -match $Match } }

function Get-Folders {
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base -and (Test-Path $base)) {
            Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'ScreenConnect' } | ForEach-Object { $out.Add($_.FullName) }
        }
    }
    ,$out
}

function Uninstall-Product($app) {
    if ($app.ProductCode -match '^\{[0-9A-Fa-f-]{36}\}$') {
        (Start-Process msiexec.exe -ArgumentList ("/x {0} /qn /norestart" -f $app.ProductCode) -Wait -PassThru).ExitCode
    } elseif ($app.Quiet) {
        (Start-Process cmd.exe -ArgumentList ('/c "{0}"' -f $app.Quiet) -Wait -PassThru).ExitCode
    } elseif ($app.Uninstall) {
        (Start-Process cmd.exe -ArgumentList ('/c "{0}"' -f $app.Uninstall) -Wait -PassThru).ExitCode
    } else { $null }
}

# ===== main ==================================================================
if ($List) {
    Write-Host "=== ScreenConnect products ===" -ForegroundColor Cyan
    $p = @(Get-Installed); if ($p) { $p | Select-Object DisplayName, ProductCode | Format-Table -AutoSize -Wrap } else { "  (none)" }
    Write-Host "=== Services ===" -ForegroundColor Cyan
    $s = @(Get-Services); if ($s) { $s | Select-Object Status, Name, DisplayName | Format-Table -AutoSize } else { "  (none)" }
    Write-Host "=== Program Files folders ===" -ForegroundColor Cyan
    $f = @(Get-Folders); if ($f) { $f | ForEach-Object { "  $_" } } else { "  (none)" }
    return
}

if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

# 1) uninstall each product (this normally removes the service + files too)
foreach ($app in @(Get-Installed)) {
    if ($PSCmdlet.ShouldProcess($app.DisplayName, 'uninstall')) {
        Write-Host ("Uninstalling: {0}" -f $app.DisplayName) -NoNewline
        $code = Uninstall-Product $app
        Write-Host ("  -> exit {0}" -f $code)
    }
}

# 2) delete any leftover services
foreach ($s in @(Get-Services)) {
    if ($PSCmdlet.ShouldProcess($s.Name, 'stop + delete service')) {
        try { Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue } catch {}
        Start-Process sc.exe -ArgumentList ('delete "{0}"' -f $s.Name) -Wait -WindowStyle Hidden
        Write-Host "Service removed: $($s.DisplayName)"
    }
}

# 3) remove any leftover Program Files folders
foreach ($dir in @(Get-Folders)) {
    if (Test-Path $dir) {
        if ($PSCmdlet.ShouldProcess($dir, 'delete folder')) {
            try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop; Write-Host "Folder removed: $dir" }
            catch { Write-Warning "Could not remove $dir (in use?): $($_.Exception.Message)" }
        }
    }
}

Write-Host "`nDone. Re-run with -List to confirm nothing remains." -ForegroundColor Green
