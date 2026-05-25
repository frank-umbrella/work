<#
.SYNOPSIS
  Watchtower agent diagnostic dump.

.DESCRIPTION
  Gathers every signal Umbrella Automation typically asks for when a host
  fails to check in, writes them to a single text file under
  C:\ProgramData\Watchtower\, and opens the file in Notepad.

  Run it elevated (Right-click -> Run with PowerShell, or via the
  tray icon's "Save diagnostic report..." menu item).

  Output:
    C:\ProgramData\Watchtower\diagnostic-YYYY-MM-DD_HH-MM-SS.txt

  What's in the file:
    - Agent version + install paths
    - Service state (sc query) + process state
    - config.json (install token redacted)
    - state.json (last successful check-in)
    - Last 200 lines of watchtower.log
    - /validate result against the configured worker
    - /healthz reachability test
    - Manual --checkin-once result (full stdout/stderr + exit code)
    - Service Control Manager events for Watchtower (last 6 hours)
    - Application event log entries for watchtower-svc (last 6 hours)
    - Veeam / Carbonite registry inspection (the two probes that have
      historically missed installs)
    - System summary (hostname, OS, manufacturer, Hyper-V status,
      C: drive free space)
    - Binary versions on disk (svc.exe + tray.exe LastWriteTime + size)
    - Watchtower processes currently running (PID + StartTime)
    - Tray startup log (last 30 entries with PID + owner per launch)
    - Inno Setup install log tail (last 60 lines of last install)
    - WinHTTP proxy config (relevant when installer can't reach worker)
    - Backup-product event log inventory: dedicated logs + Application
      log providers + sample of recent events, for Veeam / Carbonite /
      DCProtect / DataCastle / Webroot / IBackup / IDrive / Pro Softnet
    - Veeam install layout (locating veeamconfig.exe under Program Files)

  Designed to be a single attachment for support. The operator just
  needs to send this file -- no copy/paste of multiple commands.

  Token in config.json is masked to first 6 chars; nothing else is
  redacted (the rest is operational telemetry already visible in the
  dashboard).
#>

$ErrorActionPreference = 'Continue'

# Output path -- timestamped so multiple runs accumulate instead of
# overwriting each other.
$dataDir = 'C:\ProgramData\Watchtower'
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$outPath = Join-Path $dataDir "diagnostic-$stamp.txt"

# Resolve the install dir + EXE paths -- try the modern path first,
# fall back to the legacy "Watchtower" name pre-rebrand.
$installCandidates = @(
    'C:\Program Files (x86)\Umbrella Watchtower',
    'C:\Program Files\Umbrella Watchtower',
    'C:\Program Files (x86)\Watchtower',
    'C:\Program Files\Watchtower'
)
$installDir = $installCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$svcExe = if ($installDir) { Join-Path $installDir 'watchtower-svc.exe' } else { $null }
$trayExe = if ($installDir) { Join-Path $installDir 'watchtower-tray.exe' } else { $null }

# Buffer everything to an in-memory list so we write the file in one shot.
$sb = New-Object System.Text.StringBuilder

function W($text) { [void]$sb.AppendLine($text) }
function H($title) {
    W ""
    W ("=" * 78)
    W "  $title"
    W ("=" * 78)
}

W "Watchtower diagnostic"
W "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
W "Host: $env:COMPUTERNAME"
W "User: $env:USERDOMAIN\$env:USERNAME (elevated: $([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
W "Install dir: $(if ($installDir) { $installDir } else { '(not found in standard locations)' })"

# ============================================================
H "1. Agent version + config.json"
# ============================================================
$cfgPath = Join-Path $dataDir 'config.json'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $tokMask = if ($cfg.installToken) {
            $cfg.installToken.Substring(0, [Math]::Min(6, $cfg.installToken.Length)) + "...(len=" + $cfg.installToken.Length + ")"
        } else { '(missing)' }
        W "workerUrl    : $($cfg.workerUrl)"
        W "client       : $($cfg.client)"
        W "pcId         : $($cfg.pcId)"
        W "installToken : $tokMask"
    } catch {
        W "config.json present but failed to parse: $_"
    }
} else {
    W "config.json MISSING at $cfgPath"
    W "  -- installer never wrote it, OR the agent has been partially uninstalled."
}
$verFile = if ($installDir) { Join-Path $installDir 'VERSION' } else { $null }
if ($verFile -and (Test-Path $verFile)) {
    W "Bundled VERSION file: $(Get-Content $verFile -Raw -EA SilentlyContinue)"
}

# ============================================================
H "2. Service state + process state"
# ============================================================
W (sc.exe query WatchtowerAgent | Out-String)
W "--- Live processes (watchtower-svc, watchtower-tray) ---"
W (Get-Process watchtower-svc, watchtower-tray -EA SilentlyContinue |
    Select-Object Name, Id, CPU, @{N='WorkingSet_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, StartTime |
    Format-Table -AutoSize | Out-String)

# ============================================================
H "3. state.json (last successful check-in)"
# ============================================================
$statePath = Join-Path $dataDir 'state.json'
if (Test-Path $statePath) {
    W (Get-Content $statePath -Raw)
} else {
    W "state.json MISSING -- agent has NEVER successfully checked in."
}

# ============================================================
H "4. watchtower.log (last 200 lines)"
# ============================================================
$logPath = Join-Path $dataDir 'watchtower.log'
if (Test-Path $logPath) {
    W (Get-Content $logPath -Tail 200 -EA SilentlyContinue | Out-String)
} else {
    W "watchtower.log MISSING -- agent code has not run a single checkin yet."
    W "  -- Service is either crashing before reaching run_checkin, OR the"
    W "     installed version predates v0.14.4 (when file logging was added)."
}

# ============================================================
H "5. Network: /validate against configured worker"
# ============================================================
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        try {
            $resp = Invoke-RestMethod -Uri "$($cfg.workerUrl)/validate" `
                -Headers @{ Authorization = "Bearer $($cfg.installToken)" } `
                -ErrorAction Stop -TimeoutSec 15
            W "/validate -> OK"
            W ($resp | ConvertTo-Json -Compress)
        } catch {
            W "/validate FAILED: $($_.Exception.Message)"
            $statusCode = $null
            try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}
            W "  HTTP status: $statusCode"
        }
        try {
            $h = Invoke-WebRequest -Uri "$($cfg.workerUrl)/healthz" `
                -ErrorAction Stop -TimeoutSec 15
            W "/healthz -> HTTP $($h.StatusCode)"
        } catch {
            W "/healthz UNREACHABLE: $($_.Exception.Message)"
        }
    } catch {
        W "Skipped (couldn't read config.json)"
    }
} else {
    W "Skipped (no config.json)"
}

# ============================================================
H "6. Manual --checkin-once (bypasses SCM, runs inline)"
# ============================================================
if ($svcExe -and (Test-Path $svcExe)) {
    W "Running: & `"$svcExe`" --checkin-once"
    W "(timeout: 120s)"
    W "---"
    try {
        $job = Start-Job -ScriptBlock {
            param($exe)
            & $exe --checkin-once 2>&1
            "EXITCODE=$LASTEXITCODE"
        } -ArgumentList $svcExe
        $done = Wait-Job $job -Timeout 120
        if ($done) {
            W (Receive-Job $job | Out-String)
        } else {
            Stop-Job $job -EA SilentlyContinue
            W "Timed out after 120 seconds -- agent code is hung."
        }
        Remove-Job $job -Force -EA SilentlyContinue
    } catch {
        W "Failed to invoke --checkin-once: $_"
    }
} else {
    W "Skipped (watchtower-svc.exe not found)"
}

# ============================================================
H "7. Service Control Manager events (last 6h)"
# ============================================================
try {
    Get-WinEvent -FilterHashtable @{
        LogName = 'System'
        ProviderName = 'Service Control Manager'
        StartTime = (Get-Date).AddHours(-6)
    } -EA SilentlyContinue |
        Where-Object { $_.Message -match 'Watchtower' } |
        Select-Object -First 20 TimeCreated, LevelDisplayName, Message |
        Format-Table -Wrap -AutoSize | Out-String | ForEach-Object { W $_ }
} catch {
    W "Couldn't read System event log: $_"
}

# ============================================================
H "8. Application log -- watchtower-svc errors (last 6h)"
# ============================================================
try {
    Get-WinEvent -FilterHashtable @{
        LogName = 'Application'
        StartTime = (Get-Date).AddHours(-6)
    } -EA SilentlyContinue |
        Where-Object { $_.Message -match 'watchtower-svc|Failed to execute script|WatchtowerAgent' } |
        Select-Object -First 15 TimeCreated, LevelDisplayName, ProviderName, Message |
        Format-Table -Wrap -AutoSize | Out-String | ForEach-Object { W $_ }
} catch {
    W "Couldn't read Application event log: $_"
}

# ============================================================
H "9. Veeam registry inspection"
# ============================================================
foreach ($root in @('HKLM:\SOFTWARE\Veeam', 'HKLM:\SOFTWARE\WOW6432Node\Veeam')) {
    W "--- $root ---"
    try {
        if (Test-Path $root) {
            Get-ChildItem $root -EA SilentlyContinue |
                ForEach-Object {
                    $name = $_.PSChildName
                    W "  $name"
                    try {
                        $props = Get-ItemProperty $_.PSPath -EA SilentlyContinue
                        foreach ($p in $props.PSObject.Properties) {
                            if ($p.Name -notlike 'PS*') {
                                $v = "$($p.Value)"
                                if ($v.Length -gt 100) { $v = $v.Substring(0, 100) + "..." }
                                W "    $($p.Name) = $v"
                            }
                        }
                    } catch {}
                }
        } else {
            W "  (not present)"
        }
    } catch {
        W "  error: $_"
    }
}

# ============================================================
H "10. Carbonite registry inspection"
# ============================================================
foreach ($root in @('HKLM:\SOFTWARE\Carbonite', 'HKLM:\SOFTWARE\WOW6432Node\Carbonite')) {
    W "--- $root ---"
    try {
        if (Test-Path $root) {
            Get-ChildItem $root -Recurse -EA SilentlyContinue |
                Select-Object -First 30 |
                ForEach-Object {
                    W "  $($_.PSPath -replace '.*::','')"
                    try {
                        $props = Get-ItemProperty $_.PSPath -EA SilentlyContinue
                        foreach ($p in $props.PSObject.Properties) {
                            if ($p.Name -notlike 'PS*') {
                                $v = "$($p.Value)"
                                if ($v.Length -gt 80) { $v = $v.Substring(0, 80) + "..." }
                                W "    $($p.Name) = $v"
                            }
                        }
                    } catch {}
                }
        } else {
            W "  (not present)"
        }
    } catch {
        W "  error: $_"
    }
}

# ============================================================
H "11. Network adapter inventory (what the agent's probe sees)"
# ============================================================
# Mirrors the agent's probes/network.py logic exactly:
# Win32_NetworkAdapterConfiguration.IPEnabled == True joined to
# Win32_NetworkAdapter via InterfaceIndex. Surfaces any host where
# the agent reports no internal IP -- the cfg dump tells us whether
# WMI is returning the data and where the dashboard is dropping it.
try {
    W "--- Win32_NetworkAdapterConfiguration where IPEnabled=True ---"
    $cfgs = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=true" -EA SilentlyContinue
    if (-not $cfgs) {
        W "  (none -- this is the bug; the agent has nothing to report as internal IP)"
    } else {
        foreach ($c in $cfgs) {
            W "  Index $($c.InterfaceIndex) ($($c.Description)):"
            W "    IPv4 : $($c.IPAddress -join ', ')"
            W "    GW   : $($c.DefaultIPGateway -join ', ')"
            W "    DHCP : enabled=$($c.DHCPEnabled), server=$($c.DHCPServer)"
            W "    MAC  : $($c.MACAddress)"
        }
    }
    W ""
    W "--- Win32_NetworkAdapter (friendly names + link state) ---"
    Get-CimInstance Win32_NetworkAdapter -Filter "NetEnabled=true" -EA SilentlyContinue |
        Select-Object InterfaceIndex, NetConnectionID, Name, MACAddress, Speed |
        Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
} catch {
    W "Couldn't enumerate NICs: $_"
}

# ============================================================
H "12. System summary"
# ============================================================
try {
    $cs = Get-CimInstance Win32_ComputerSystem
    $os = Get-CimInstance Win32_OperatingSystem
    W "Hostname     : $env:COMPUTERNAME"
    W "Domain       : $($cs.Domain)"
    W "Manufacturer : $($cs.Manufacturer)"
    W "Model        : $($cs.Model)"
    W "OS           : $($os.Caption) (build $($os.BuildNumber))"
    W "Boot time    : $($os.LastBootUpTime)"
    W "Install date : $($os.InstallDate)"
    W "Total RAM GB : $([math]::Round($cs.TotalPhysicalMemory/1GB,1))"
    $cVol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -EA SilentlyContinue
    if ($cVol) {
        W "C: drive     : $([math]::Round($cVol.FreeSpace/1GB,1)) GB free of $([math]::Round($cVol.Size/1GB,1)) GB"
    }
    W "Is virtual?  : $(if ($cs.Manufacturer -match 'Microsoft Corporation' -and $cs.Model -match 'Virtual') { 'yes (Hyper-V)' } elseif ($cs.Manufacturer -match 'VMware') { 'yes (VMware)' } else { 'no / unknown' })"
} catch {
    W "Couldn't read system info: $_"
}

# ============================================================
H "13. Binary versions on disk (agent service + tray)"
# ============================================================
# Tells us at a glance whether the last auto-update actually replaced
# the EXEs (LastWriteTime should match the most recent install attempt).
# Mismatched dates between svc.exe + tray.exe = partial install.
try {
    foreach ($base in @("C:\Program Files\Umbrella Watchtower", "C:\Program Files (x86)\Umbrella Watchtower")) {
        if (Test-Path $base) {
            W "Install root: $base"
            Get-ChildItem "$base\*.exe" -EA SilentlyContinue |
                Select-Object Name, Length, LastWriteTime |
                Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
        }
    }
} catch {
    W "Couldn't enumerate binaries: $_"
}

# ============================================================
H "14. Watchtower processes currently running"
# ============================================================
# PyInstaller --onefile spawns a bootstrap + child, so EXPECT TWO
# watchtower-tray.exe entries when the tray is healthy. More than 2
# = duplicate tray (the ghost-icon-disappears-on-hover failure mode).
try {
    Get-Process | Where-Object { $_.Name -match 'watchtower' } |
        Select-Object Name, Id, StartTime, Path -EA SilentlyContinue |
        Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
} catch {
    W "Couldn't enumerate processes: $_"
}

# ============================================================
H "15. Tray startup log (last 30 entries)"
# ============================================================
# Added in v0.14.103. Each tray launch attempt writes a breadcrumb
# with PID + owner + timestamp. Catches "tray launched but crashed
# during init" -- the file has a recent entry but no tray process
# is running.
$trayLog = "C:\ProgramData\Watchtower\tray-startup.log"
if (Test-Path $trayLog) {
    Get-Content $trayLog -Tail 30 | ForEach-Object { W $_ }
} else {
    W "(tray-startup.log not present -- agent <= 0.14.43 or tray has never started)"
}

# ============================================================
H "16. Install log tail (last 60 lines)"
# ============================================================
# Added in v0.14.89. Inno Setup's verbose transcript of the most
# recent install attempt. Shows PrepareToInstall taskkill outcomes,
# [Files] extraction lines, [Run] sc.exe return codes, and any
# Pascal Log() entries the .iss code wrote.
$installLog = "C:\ProgramData\Watchtower\install.log"
if (Test-Path $installLog) {
    Get-Content $installLog -Tail 60 | ForEach-Object { W $_ }
} else {
    W "(install.log not present -- agent <= 0.14.39 or no install has run via the updater)"
}

# ============================================================
H "17. WinHTTP proxy config (relevant when installer can't reach worker)"
# ============================================================
# When ValidateTokenWithWorker fails inside the installer, the most
# common per-host cause is a misconfigured WinHTTP proxy. The agent's
# Python requests stack uses a different code path, so the agent
# checks in fine even when WinHTTP is broken.
try {
    netsh winhttp show proxy 2>&1 | ForEach-Object { W $_ }
} catch {
    W "Couldn't query WinHTTP proxy: $_"
}

# ============================================================
H "18. Backup product event log inventory"
# ============================================================
# Veeam Agent / Carbonite / DCProtect / IBackup / IDrive: identifies
# which (if any) of these products write to the Windows event log on
# this host. Drives the agent's event-log fallback probes added in
# v0.14.91 (Veeam Agent), v0.14.101 (Carbonite + IBackup).
$patterns = @('veeam', 'carbonite', 'dcprotect', 'dca', 'datacastle', 'webroot', 'ibackup', 'idrive', 'pro softnet')

W "--- Dedicated event logs matching backup-product names ---"
try {
    Get-WinEvent -ListLog * -EA SilentlyContinue | Where-Object {
        $ln = $_.LogName.ToLower()
        $matched = $false
        foreach ($p in $patterns) { if ($ln -match $p) { $matched = $true; break } }
        $matched
    } | Select-Object LogName, RecordCount, IsEnabled | Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
} catch {
    W "  (no matching logs OR query failed: $_)"
}

W "--- Application-log providers matching backup-product names ---"
try {
    $providers = Get-WinEvent -ListProvider * -EA SilentlyContinue | Where-Object {
        $n = $_.Name.ToLower()
        $matched = $false
        foreach ($p in $patterns) { if ($n -match $p) { $matched = $true; break } }
        $matched
    } | Select-Object -ExpandProperty Name
    if ($providers) {
        $providers | ForEach-Object { W "  $_" }
        W ""
        W "--- 5 most recent events from each matching provider ---"
        foreach ($prov in $providers) {
            W "PROVIDER: $prov"
            try {
                Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=$prov} -MaxEvents 5 -EA SilentlyContinue |
                    Select-Object TimeCreated, Id, LevelDisplayName, @{Name='Msg';Expression={if ($_.Message) { $_.Message.Substring(0, [Math]::Min(180, $_.Message.Length)) } else { '(no message)' }}} |
                    Format-List | Out-String | ForEach-Object { W $_ }
            } catch {
                W "  (couldn't read events: $_)"
            }
        }
    } else {
        W "  (no providers found)"
    }
} catch {
    W "  (provider query failed: $_)"
}

# ============================================================
H "19. Veeam install layout (when veeamconfig.exe location matters)"
# ============================================================
# Recent installs of Veeam Agent dropped veeamconfig.exe entirely
# (modern enterprise SKUs). This section helps confirm whether
# veeamconfig is even on disk and what the install layout looks like
# for the agent's _locate_veeamconfig() routine.
foreach ($base in @("C:\Program Files\Veeam", "C:\Program Files (x86)\Veeam")) {
    if (Test-Path $base) {
        W "Veeam install root: $base"
        Get-ChildItem $base -Filter 'veeamconfig.exe' -Recurse -EA SilentlyContinue |
            Select-Object FullName, LastWriteTime |
            Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
        W "Top-level *.exe in ${base}:"
        Get-ChildItem $base -Filter '*.exe' -EA SilentlyContinue |
            Select-Object Name, LastWriteTime |
            Format-Table -AutoSize | Out-String | ForEach-Object { W $_ }
    }
}

# Write + reveal the file
$content = $sb.ToString()
Set-Content -Path $outPath -Value $content -Encoding UTF8

Write-Host ""
Write-Host "Diagnostic written to:" -ForegroundColor Green
Write-Host "  $outPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Attach that file when contacting Umbrella Automation support." -ForegroundColor Yellow

# Open the file in Notepad so the operator can immediately see what's in
# it (and easily Save As / forward).
Start-Process notepad.exe $outPath
