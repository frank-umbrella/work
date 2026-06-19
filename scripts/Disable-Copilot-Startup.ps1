#Requires -Version 5.1
<#
.SYNOPSIS
    Stop Microsoft 365 Copilot (and the standalone Windows Copilot) from
    launching at startup, on Windows 10 and Windows 11. No admin required.

.DESCRIPTION
    "Microsoft 365 Copilot" is the rebranded Microsoft 365 / Office hub app
    (package Microsoft.MicrosoftOfficeHub_8wekyb3d8bbwe); the standalone
    assistant is "Copilot" (Microsoft.Copilot_8wekyb3d8bbwe). Both auto-start
    via a packaged-app startup task whose State lives under HKCU. This wrapper
    calls Disable-StartupApp.ps1 with a regex covering both, plus any matching
    Run / scheduled-task / startup-folder entries.

.PARAMETER Enable
    Re-enable Copilot startup instead of disabling it.

.PARAMETER List
    Show what matches without changing anything.

.EXAMPLE
    .\Disable-Copilot-Startup.ps1
.EXAMPLE
    .\Disable-Copilot-Startup.ps1 -List
.EXAMPLE
    .\Disable-Copilot-Startup.ps1 -Enable
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Enable,
    [switch]$List
)

# Matches the two packaged family names and any Copilot/365 Run or task entries.
# 'officehub' targets the Microsoft 365 Copilot app without catching every
# Office component (Word/Excel/etc. are not in scope here).
$pattern = 'copilot|officehub|microsoft 365|m365'

$engine = Join-Path $PSScriptRoot 'Disable-StartupApp.ps1'
if (-not (Test-Path $engine)) { throw "Engine not found: $engine" }

$splat = @{ Match = $pattern }
if ($Enable)      { $splat['Enable']  = $true }
if ($List)        { $splat['List']    = $true }
if ($WhatIfPreference) { $splat['WhatIf'] = $true }

& $engine @splat
