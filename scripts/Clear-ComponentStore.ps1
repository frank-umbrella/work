#Requires -Version 5.1
<#
.SYNOPSIS
    Clean up the Windows component store (the WinSxS folder) to reclaim disk
    space. Windows 10 and 11. Admin required (self-elevates).

.DESCRIPTION
    Runs:  Dism.exe /Online /Cleanup-Image /StartComponentCleanup
    which removes superseded component versions from WinSxS. Safe, supported,
    and often frees several GB. Can take a while.

    Options:
      -Analyze    Just report the store's size and whether cleanup is
                  recommended (AnalyzeComponentStore) - changes nothing.
      -ResetBase  Adds /ResetBase: also deletes the fallback copies of ALL
                  superseded updates. Frees the most space, but is
                  NON-REVERSIBLE - installed updates can no longer be
                  uninstalled afterward. Only use on a stable machine.
      -UseTask    Instead of DISM, run the built-in Windows servicing task
                  ("\Microsoft\Windows\Servicing\StartComponentCleanup"),
                  which does the same cleanup in the background and
                  auto-stops after an hour.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Clear-ComponentStore.ps1 -Analyze
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Clear-ComponentStore.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Clear-ComponentStore.ps1 -ResetBase
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Analyze,
    [switch]$ResetBase,
    [switch]$UseTask,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

if ($ResetBase -and $UseTask) { throw "-ResetBase and -UseTask cannot be combined (the task never uses ResetBase)." }
if ($Analyze -and ($ResetBase -or $UseTask)) { throw "-Analyze runs alone - it only reports, it doesn't clean." }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    foreach ($s in 'Analyze','ResetBase','UseTask') {
        if ((Get-Variable $s).Value) { $a += "-$s" }
    }
    Write-Host "Elevating (DISM needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

function Wait-Close {
    # Keep the (elevated) window open so the results can be read.
    if ($Host.Name -eq 'ConsoleHost') { Read-Host "Press Enter to close" | Out-Null }
}

if ($Analyze) {
    Write-Host "Analyzing the component store (read-only)..." -ForegroundColor Cyan
    Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore
    Wait-Close
    return
}

if ($UseTask) {
    Write-Host "Starting the built-in servicing cleanup task (background, auto-stops after ~1h)..." -ForegroundColor Cyan
    if ($PSCmdlet.ShouldProcess('StartComponentCleanup scheduled task', 'run')) {
        schtasks.exe /Run /TN "\Microsoft\Windows\Servicing\StartComponentCleanup"
        Write-Host "Task started. It runs in the background; no window to watch."
    }
    Wait-Close
    return
}

$args_ = '/Online','/Cleanup-Image','/StartComponentCleanup'
if ($ResetBase) {
    $args_ += '/ResetBase'
    Write-Warning "ResetBase: after this, installed updates can NO LONGER be uninstalled. Non-reversible."
}
Write-Host ("Running: Dism.exe {0}  (this can take a while)" -f ($args_ -join ' ')) -ForegroundColor Cyan
if ($PSCmdlet.ShouldProcess('WinSxS component store', "DISM $($args_ -join ' ')")) {
    Dism.exe @args_
    Write-Host ("DISM exit code: {0}" -f $LASTEXITCODE)
    Write-Host "`nDone. Run again with -Analyze to see the store's new size." -ForegroundColor Green
}
Wait-Close
