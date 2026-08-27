#Requires -Version 5.1
<#
.SYNOPSIS
    Repair corrupted Windows system files: DISM /RestoreHealth to repair the
    component store, then SFC /scannow to repair system files from it - in the
    correct order. Windows 10 and 11. Admin required (self-elevates).

.DESCRIPTION
    The standard "something is corrupted" repair pass:

      1. DISM.exe /Online /Cleanup-Image /RestoreHealth
         Repairs the Windows component store (the source SFC repairs from),
         downloading known-good files from Windows Update if needed. Can take
         several minutes and may sit at certain percentages - that's normal.

      2. sfc /scannow
         Scans protected system files and replaces corrupted ones from the
         (now repaired) component store. Do not close the window mid-scan.

    Running DISM first matters: if the component store itself is corrupt, SFC
    repairs from a bad source and fails.

.PARAMETER SfcOnly
    Skip DISM; run only sfc /scannow.

.PARAMETER DismOnly
    Run only the DISM /RestoreHealth step; skip SFC.

.PARAMETER ExportLog
    After SFC, write the SFC results (the [SR] lines from CBS.log) to
    SFCDETAILS.TXT on the Desktop for review. Note: CBS.log accumulates, so
    the file includes results from previous SFC runs too.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Repair-SystemFiles.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Repair-SystemFiles.ps1 -ExportLog
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Repair-SystemFiles.ps1 -SfcOnly
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$SfcOnly,
    [switch]$DismOnly,
    [switch]$ExportLog,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

if ($SfcOnly -and $DismOnly) { throw "-SfcOnly and -DismOnly cannot be combined." }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    foreach ($s in 'SfcOnly','DismOnly','ExportLog') {
        if ((Get-Variable $s).Value) { $a += "-$s" }
    }
    Write-Host "Elevating (DISM and SFC need administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

# 1) DISM RestoreHealth
if (-not $SfcOnly) {
    Write-Host "Step 1/2: DISM /Online /Cleanup-Image /RestoreHealth" -ForegroundColor Cyan
    Write-Host "(Repairs the component store; may download files from Windows Update. Several minutes; stalls at some percentages are normal.)"
    if ($PSCmdlet.ShouldProcess('Windows image', 'DISM RestoreHealth')) {
        DISM.exe /Online /Cleanup-Image /RestoreHealth
        Write-Host ("DISM exit code: {0}" -f $LASTEXITCODE)
    }
    Write-Host ""
}

# 2) SFC /scannow
if (-not $DismOnly) {
    Write-Host "Step 2/2: sfc /scannow" -ForegroundColor Cyan
    Write-Host "(Replaces corrupted system files from the component store. Don't close this window until it reaches 100%.)"
    if ($PSCmdlet.ShouldProcess('system files', 'sfc /scannow')) {
        sfc /scannow
        Write-Host ("SFC exit code: {0}" -f $LASTEXITCODE)
    }
}

# 3) optional log export
if ($ExportLog -and -not $DismOnly) {
    $dest = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SFCDETAILS.TXT'
    if ($PSCmdlet.ShouldProcess($dest, 'export SFC [SR] log lines')) {
        cmd /c "findstr /C:`"[SR]`" %windir%\Logs\CBS\CBS.log > `"$dest`""
        if (Test-Path $dest) {
            Write-Host "SFC details written to: $dest" -ForegroundColor Green
            Write-Host "(CBS.log accumulates - the file includes previous SFC runs too.)"
        } else {
            Write-Warning "Could not write $dest"
        }
    }
}

Write-Host "`nDone. If corruption was found and repaired, reboot and re-run to confirm a clean pass." -ForegroundColor Green

# Keep the (elevated) window open so the results can be read.
if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
