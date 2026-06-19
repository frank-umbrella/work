#Requires -Version 5.1
<#
.SYNOPSIS
    Launch Windows Disk Cleanup (cleanmgr.exe). Windows 10 and Windows 11.

.DESCRIPTION
    Opens the Disk Cleanup tool for the chosen drive. By default it opens the
    normal interactive Disk Cleanup window for C: so you can pick what to
    remove. Optional switches drive the built-in cleanmgr automation:

      -SystemFiles  Re-launch with the "Clean up system files" view (elevated),
                    which also offers Windows Update cleanup, old installations,
                    etc. Prompts for admin.
      -Auto         Run an unattended cleanup of common safe categories using
                    cleanmgr's sageset/sagerun preset (no UI to click through).

.PARAMETER Drive
    Drive letter to clean. Default 'C'.

.PARAMETER SystemFiles
    Open the elevated "system files" cleanup view (more categories).

.PARAMETER Auto
    Configure a preset and run it unattended (no prompts). Cleans temp files,
    recycle bin, thumbnails, delivery optimization files, and similar safe
    categories.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-DiskCleanup.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-DiskCleanup.ps1 -SystemFiles
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-DiskCleanup.ps1 -Auto
#>
[CmdletBinding()]
param(
    [string]$Drive = 'C',
    [switch]$SystemFiles,
    [switch]$Auto
)

$ErrorActionPreference = 'Stop'
$DriveLetter = $Drive.TrimEnd(':','\')

if ($Auto) {
    # Categories cleaned unattended. These are the common safe ones; edit to taste.
    $cats = @(
        'Active Setup Temp Folders','Downloaded Program Files','Internet Cache Files',
        'Recycle Bin','Temporary Files','Thumbnail Cache','Delivery Optimization Files',
        'Update Cleanup','Windows Error Reporting Files'
    )
    $flagBase = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches'
    $sage = 1
    foreach ($cat in $cats) {
        $p = Join-Path $flagBase $cat
        if (Test-Path $p) {
            New-ItemProperty -Path $p -Name ("StateFlags{0:0000}" -f $sage) -Value 2 -PropertyType DWord -Force | Out-Null
        }
    }
    Write-Host "Running unattended Disk Cleanup (sagerun:$sage)..."
    Start-Process cleanmgr.exe -ArgumentList ("/sagerun:{0}" -f $sage) -Wait
    Write-Host "Done." -ForegroundColor Green
    return
}

if ($SystemFiles) {
    # /d <drive> targets the drive; cleanmgr self-elevates for the system-files view.
    Write-Host "Opening Disk Cleanup (system files) for ${DriveLetter}:..."
    Start-Process cleanmgr.exe -ArgumentList ("/d {0}:" -f $DriveLetter) -Verb RunAs
    return
}

Write-Host "Opening Disk Cleanup for ${DriveLetter}:..."
Start-Process cleanmgr.exe -ArgumentList ("/d {0}:" -f $DriveLetter)
