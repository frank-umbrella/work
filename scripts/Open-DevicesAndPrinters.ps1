#Requires -Version 5.1
<#
.SYNOPSIS
    Open the classic (Windows 7-style) Devices and Printers window, or the old
    Add Printer wizard. Windows 10 and Windows 11. No admin needed.

.DESCRIPTION
    Newer Windows routes "Devices and Printers" into Settings; this opens the
    classic Control Panel window directly via its shell folder GUID
    (shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}). With -AddPrinter it
    launches the legacy Add Printer wizard (rundll32 printui.dll,PrintUIEntry
    /il), which is handy for adding a printer by IP / local port the old way.

.PARAMETER AddPrinter
    Open the old Add Printer wizard instead of the Devices and Printers window.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-DevicesAndPrinters.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Open-DevicesAndPrinters.ps1 -AddPrinter
#>
[CmdletBinding()]
param(
    [switch]$AddPrinter
)

$ErrorActionPreference = 'Stop'

if ($AddPrinter) {
    Write-Host "Opening the classic Add Printer wizard..."
    Start-Process rundll32.exe -ArgumentList 'printui.dll,PrintUIEntry /il'
} else {
    Write-Host "Opening classic Devices and Printers..."
    Start-Process explorer.exe -ArgumentList 'shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}'
}
