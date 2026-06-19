#Requires -Version 5.1
<#
.SYNOPSIS
    Disable (or re-enable, or list) an application's auto-start across every
    Windows startup surface, on Windows 10 and Windows 11.

.DESCRIPTION
    A single program can hook into startup in several different places. This
    engine matches a regex against ALL of them and flips each match off in the
    same way the Task Manager "Startup apps" tab does (reversible), so the app
    stops launching at boot/logon regardless of which mechanism it used:

      1. Win32 "Run" keys      HKCU\..\Run, HKLM\..\Run, HKLM\WOW6432Node\..\Run
                               -> disabled via the StartupApproved binary value
                                  (byte0: 0x02 = enabled, 0x03 = disabled)
      2. Startup folders       per-user + all-users Start Menu \Startup *.lnk
                               -> disabled via StartupApproved\StartupFolder
      3. Scheduled Tasks       any task whose name/path matches
                               -> Disable-ScheduledTask
      4. Packaged (UWP) apps   AppModel\SystemAppData\<PFN>\<TaskId>\State
                               -> State 1 = DisabledByUser (sticky), 2 = Enabled

    HKCU and packaged-app changes need no admin rights. HKLM Run entries,
    all-users startup shortcuts, and some scheduled tasks require elevation;
    the script auto-elevates when needed (suppress with -NoElevate).

.PARAMETER Match
    Case-insensitive regex matched against Run value names AND their command
    line, startup-shortcut file names AND their target path, scheduled task
    names/paths, and packaged-app family names. Example: 'malwarebyte|mbam'.

.PARAMETER Enable
    Re-enable matching entries instead of disabling them.

.PARAMETER List
    Show what matches without changing anything.

.PARAMETER NoElevate
    Do not auto-elevate; HKLM / all-users / task changes are skipped with a
    warning if not already running as administrator.

.EXAMPLE
    .\Disable-StartupApp.ps1 -Match 'copilot' -List
.EXAMPLE
    .\Disable-StartupApp.ps1 -Match 'malwarebyte|mbam'
.EXAMPLE
    .\Disable-StartupApp.ps1 -Match 'copilot' -Enable
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)] [string]$Match,
    [switch]$Enable,
    [switch]$List,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
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

# --- StartupApproved binary writer (Task Manager-consistent) -----------------
function Set-Approved($ApprovedPath, $ValueName, [bool]$EnableState) {
    if (-not (Test-Path $ApprovedPath)) {
        New-Item -Path $ApprovedPath -Force | Out-Null
    }
    $bytes = New-Object byte[] 12
    $bytes[0] = if ($EnableState) { 0x02 } else { 0x03 }
    New-ItemProperty -Path $ApprovedPath -Name $ValueName -PropertyType Binary `
        -Value $bytes -Force | Out-Null
}

# --- 1 + 2: Run keys and Startup folders -------------------------------------
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
    try {
        $sh = New-Object -ComObject WScript.Shell
        return $sh.CreateShortcut($lnkPath).TargetPath
    } catch { return '' }
}

function Process-RunScopes([bool]$isAdmin) {
    foreach ($s in $RunScopes) {
        if (-not (Test-Path $s.Run)) { continue }
        $item = Get-Item $s.Run
        foreach ($name in $item.Property) {
            $data = (Get-ItemProperty $s.Run -Name $name).$name
            if ($name -notmatch $Match -and "$data" -notmatch $Match) { continue }
            if ($List) { Add-Result $s.Run $name 'match' $data; continue }
            if ($s.NeedsAdmin -and -not $isAdmin) {
                Add-Result $s.Run $name 'SKIPPED (needs admin)' $data; continue
            }
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
            if ($s.NeedsAdmin -and -not $isAdmin) {
                Add-Result $s.Folder $lnk.Name 'SKIPPED (needs admin)' $target; continue
            }
            if ($PSCmdlet.ShouldProcess("$($s.Folder)\$($lnk.Name)", $(if ($Enable) {'enable'} else {'disable'}))) {
                Set-Approved $s.Approved $lnk.Name ([bool]$Enable)
                Add-Result $s.Folder $lnk.Name $(if ($Enable) {'ENABLED'} else {'DISABLED'}) $target
            }
        }
    }
}

# --- 3: Scheduled tasks ------------------------------------------------------
function Process-ScheduledTasks([bool]$isAdmin) {
    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.TaskName -match $Match -or $_.TaskPath -match $Match
    }
    foreach ($t in $tasks) {
        $full = ($t.TaskPath + $t.TaskName)
        if ($List) { Add-Result 'ScheduledTask' $full 'match' $t.State; continue }
        try {
            if ($Enable) {
                if ($PSCmdlet.ShouldProcess($full, 'enable task')) {
                    Enable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Out-Null
                    Add-Result 'ScheduledTask' $full 'ENABLED' ''
                }
            } else {
                if ($PSCmdlet.ShouldProcess($full, 'disable task')) {
                    Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath | Out-Null
                    Add-Result 'ScheduledTask' $full 'DISABLED' ''
                }
            }
        } catch {
            Add-Result 'ScheduledTask' $full $(if ($isAdmin) {'ERROR'} else {'SKIPPED (needs admin)'}) $_.Exception.Message
        }
    }
}

# --- 4: Packaged (UWP) startup tasks -----------------------------------------
function Process-PackagedTasks {
    $root = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData'
    if (-not (Test-Path $root)) { return }
    $pfns = Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match $Match }
    foreach ($pfn in $pfns) {
        Get-ChildItem $pfn.PSPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($props.PSObject.Properties.Name -notcontains 'State') { return }
            $taskId = $_.PSChildName
            $label  = "$($pfn.PSChildName)\$taskId"
            if ($List) { Add-Result 'PackagedApp' $label 'match' "State=$($props.State)"; return }
            $new = if ($Enable) { 2 } else { 1 }   # 2=Enabled, 1=DisabledByUser
            if ($PSCmdlet.ShouldProcess($label, "set State=$new")) {
                New-ItemProperty -Path $_.PSPath -Name 'State' -Value $new -PropertyType DWord -Force | Out-Null
                Add-Result 'PackagedApp' $label $(if ($Enable) {'ENABLED'} else {'DISABLED'}) "State $($props.State) -> $new"
            }
        }
    }
}

# --- elevation ---------------------------------------------------------------
function Test-NeedsElevation {
    # Quick scan: would any HKLM Run or all-users startup shortcut match?
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
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
                 '-Match',('"{0}"' -f $Match))
    if ($Enable) { $argList += '-Enable' }
    if ($List)   { $argList += '-List' }
    Write-Host "Elevating to modify all-users (HKLM) startup entries..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
}

# --- main --------------------------------------------------------------------
$isAdmin = Test-Admin

if (-not $List -and -not $isAdmin -and -not $NoElevate -and (Test-NeedsElevation)) {
    Invoke-Elevate
    Write-Host "(All-users entries were handled in the elevated window above.)"
    # continue to also handle the per-user entries in this non-elevated session
}

Process-RunScopes    $isAdmin
Process-FolderScopes $isAdmin
Process-ScheduledTasks $isAdmin
Process-PackagedTasks

if ($script:results.Count -eq 0) {
    if ($WhatIfPreference) {
        Write-Host "(-WhatIf) No changes made; see the 'What if:' lines above for what would happen." -ForegroundColor Yellow
    } else {
        Write-Host "No startup entries matched /$Match/." -ForegroundColor Yellow
    }
} else {
    $script:results | Format-Table -AutoSize -Wrap
    if (-not $List) {
        Write-Host ""
        Write-Host "Done. Changes that took effect apply at next logon (or restart Explorer / sign out to confirm now)." -ForegroundColor Green
    }
}
