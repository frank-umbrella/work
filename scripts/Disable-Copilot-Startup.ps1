#Requires -Version 5.1
<#
.SYNOPSIS
    Stop Microsoft 365 Copilot (and the standalone Windows Copilot) from
    launching at startup, on Windows 10 and Windows 11. No admin required.
    Self-contained - just download this one file and run it.

.DESCRIPTION
    "Microsoft 365 Copilot" is the rebranded Microsoft 365 / Office hub app
    (package Microsoft.MicrosoftOfficeHub_8wekyb3d8bbwe); the standalone
    assistant is "Copilot" (Microsoft.Copilot_8wekyb3d8bbwe). Both auto-start
    via a packaged-app startup task whose State lives under HKCU. This sets
    that task to DisabledByUser, and also disables any matching Run keys,
    scheduled tasks, or Startup-folder shortcuts, the same way Task Manager's
    Startup tab does (reversible).

.PARAMETER Enable
    Re-enable Copilot startup instead of disabling it.

.PARAMETER List
    Show what matches without changing anything.

.PARAMETER NoElevate
    Do not auto-elevate; any all-users (HKLM) entries are skipped with a warning.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-Copilot-Startup.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-Copilot-Startup.ps1 -List
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-Copilot-Startup.ps1 -Enable
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Enable,
    [switch]$List,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

# Matches the two packaged family names and any Copilot/365 Run or task entries.
# 'officehub' targets the Microsoft 365 Copilot app without catching every
# Office component (Word/Excel/etc. are not in scope here).
$Match = 'copilot|officehub|microsoft 365|m365'

# ===== inlined startup-disable engine (self-contained; no external files) =====
$script:results = @()

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Add-Result($Location, $Name, $Action, $Detail) {
    $script:results += [PSCustomObject]@{
        Location = $Location; Name = $Name; Action = $Action; Detail = $Detail
    }
}

function Set-Approved($ApprovedPath, $ValueName, [bool]$EnableState) {
    if (-not (Test-Path $ApprovedPath)) { New-Item -Path $ApprovedPath -Force | Out-Null }
    $bytes = New-Object byte[] 12
    $bytes[0] = if ($EnableState) { 0x02 } else { 0x03 }
    New-ItemProperty -Path $ApprovedPath -Name $ValueName -PropertyType Binary -Value $bytes -Force | Out-Null
}

$RunScopes = @(
    @{ Run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
       Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
       NeedsAdmin = $false }
    @{ Run = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
       Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
       NeedsAdmin = $true }
    @{ Run = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
       Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'
       NeedsAdmin = $true }
)
$FolderScopes = @(
    @{ Folder = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')
       Approved = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
       NeedsAdmin = $false }
    @{ Folder = (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup')
       Approved = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
       NeedsAdmin = $true }
)

function Resolve-LnkTarget($lnkPath) {
    try { (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath).TargetPath } catch { '' }
}

function Process-RunScopes([bool]$isAdmin) {
    foreach ($s in $RunScopes) {
        if (-not (Test-Path $s.Run)) { continue }
        $item = Get-Item $s.Run
        foreach ($name in $item.Property) {
            $data = (Get-ItemProperty $s.Run -Name $name).$name
            if ($name -notmatch $Match -and "$data" -notmatch $Match) { continue }
            if ($List) { Add-Result $s.Run $name 'match' $data; continue }
            if ($s.NeedsAdmin -and -not $isAdmin) { Add-Result $s.Run $name 'SKIPPED (needs admin)' $data; continue }
            if ($PSCmdlet.ShouldProcess("$($s.Run)\$name", $(if ($Enable) {'enable'} else {'disable'}))) {
                Set-Approved $s.Approved $name ([bool]$Enable)
                Add-Result $s.Run $name $(if ($Enable) {'ENABLED'} else {'DISABLED'}) $data
            }
        }
    }
}

function Process-FolderScopes([bool]$isAdmin) {
    foreach ($s in $FolderScopes) {
        if (-not (Test-Path $s.Folder)) { continue }
        foreach ($lnk in Get-ChildItem -Path $s.Folder -Filter *.lnk -ErrorAction SilentlyContinue) {
            $target = Resolve-LnkTarget $lnk.FullName
            if ($lnk.Name -notmatch $Match -and "$target" -notmatch $Match) { continue }
            if ($List) { Add-Result $s.Folder $lnk.Name 'match' $target; continue }
            if ($s.NeedsAdmin -and -not $isAdmin) { Add-Result $s.Folder $lnk.Name 'SKIPPED (needs admin)' $target; continue }
            if ($PSCmdlet.ShouldProcess("$($s.Folder)\$($lnk.Name)", $(if ($Enable) {'enable'} else {'disable'}))) {
                Set-Approved $s.Approved $lnk.Name ([bool]$Enable)
                Add-Result $s.Folder $lnk.Name $(if ($Enable) {'ENABLED'} else {'DISABLED'}) $target
            }
        }
    }
}

function Process-ScheduledTasks([bool]$isAdmin) {
    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match $Match -or $_.TaskPath -match $Match }
    foreach ($t in $tasks) {
        $full = ($t.TaskPath + $t.TaskName)
        if ($List) { Add-Result 'ScheduledTask' $full 'match' $t.State; continue }
        try {
            if ($Enable) {
                if ($PSCmdlet.ShouldProcess($full, 'enable task')) { Enable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Out-Null; Add-Result 'ScheduledTask' $full 'ENABLED' '' }
            } else {
                if ($PSCmdlet.ShouldProcess($full, 'disable task')) { Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Out-Null; Add-Result 'ScheduledTask' $full 'DISABLED' '' }
            }
        } catch { Add-Result 'ScheduledTask' $full $(if ($isAdmin) {'ERROR'} else {'SKIPPED (needs admin)'}) $_.Exception.Message }
    }
}

function Process-PackagedTasks {
    $root = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData'
    if (-not (Test-Path $root)) { return }
    $pfns = Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match $Match }
    foreach ($pfn in $pfns) {
        Get-ChildItem $pfn.PSPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($props.PSObject.Properties.Name -notcontains 'State') { return }
            $label = "$($pfn.PSChildName)\$($_.PSChildName)"
            if ($List) { Add-Result 'PackagedApp' $label 'match' "State=$($props.State)"; return }
            $new = if ($Enable) { 2 } else { 1 }   # 2=Enabled, 1=DisabledByUser
            if ($PSCmdlet.ShouldProcess($label, "set State=$new")) {
                New-ItemProperty -Path $_.PSPath -Name 'State' -Value $new -PropertyType DWord -Force | Out-Null
                Add-Result 'PackagedApp' $label $(if ($Enable) {'ENABLED'} else {'DISABLED'}) "State $($props.State) -> $new"
            }
        }
    }
}

function Test-NeedsElevation {
    foreach ($s in $RunScopes) {
        if (-not $s.NeedsAdmin -or -not (Test-Path $s.Run)) { continue }
        $item = Get-Item $s.Run
        foreach ($name in $item.Property) {
            $data = (Get-ItemProperty $s.Run -Name $name).$name
            if ($name -match $Match -or "$data" -match $Match) { return $true }
        }
    }
    $common = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup'
    if (Test-Path $common) {
        foreach ($lnk in Get-ChildItem $common -Filter *.lnk -ErrorAction SilentlyContinue) {
            if ($lnk.Name -match $Match -or (Resolve-LnkTarget $lnk.FullName) -match $Match) { return $true }
        }
    }
    return $false
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath))
    if ($Enable) { $a += '-Enable' }
    if ($List)   { $a += '-List' }
    Write-Host "Elevating to modify all-users (HKLM) startup entries..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait
}

# --- main --------------------------------------------------------------------
$isAdmin = Test-Admin
if (-not $List -and -not $isAdmin -and -not $NoElevate -and (Test-NeedsElevation)) {
    Invoke-Elevate
    Write-Host "(All-users entries were handled in the elevated window above.)"
}

Process-RunScopes      $isAdmin
Process-FolderScopes   $isAdmin
Process-ScheduledTasks $isAdmin
Process-PackagedTasks

if ($script:results.Count -eq 0) {
    if ($WhatIfPreference) { Write-Host "(-WhatIf) No changes made; see the 'What if:' lines above." -ForegroundColor Yellow }
    else { Write-Host "No Copilot startup entries matched." -ForegroundColor Yellow }
} else {
    $script:results | Format-Table -AutoSize -Wrap
    if (-not $List) { Write-Host "`nDone. Takes effect at next sign-in." -ForegroundColor Green }
}
