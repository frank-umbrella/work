# build.ps1 — builds the generic Watchtower-Setup.exe installer.
#
# Single installer for every client. The operator running it on the target
# PC pastes their install token into the wizard (or passes /TOKEN= for a
# silent install). The token is validated against the worker before the
# install completes — see installer\watchtower.iss [Code] section.
#
# Steps:
#   1. Verify Python + PyInstaller + Inno Setup are available.
#   2. PyInstaller --onefile for watchtower_service.py and watchtower_tray.py
#      → installer\build\watchtower-svc.exe + watchtower-tray.exe.
#   3. ISCC.exe compiles watchtower.iss with /DWorkerUrl + /DAppVersion
#      defines (no per-client values — those are runtime now).
#   4. Output: installer\dist\Watchtower-Setup.exe
#
# Usage:
#   .\build.ps1
#
# Optional:
#   -WorkerUrl   defaults to https://watchtower-worker.umbrelladev.workers.dev
#   -AppVersion  defaults to whatever's in watchtower.iss
#   -SkipPyInstaller  reuse existing build\*.exe (faster iterations on the .iss)

[CmdletBinding()]
param(
    [string] $WorkerUrl   = "https://watchtower-worker.umbrelladev.workers.dev",
    [string] $AppVersion  = "0.3.0",
    # Optional path to a LogMeIn host MSI to bundle into the installer. When
    # set, the wizard shows an "Also install LogMeIn remote access" checkbox
    # (checked by default). Operator can uncheck per install. Silent install
    # honors /COMPONENTS="logmein" — pass /COMPONENTS="" to skip LogMeIn.
    # When omitted, no LogMeIn UI appears and the installer behaves as before.
    [string] $LogmeinMsi  = "",
    [switch] $SkipPyInstaller
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentDir = Join-Path (Split-Path $here -Parent) 'agent'
$buildDir = Join-Path $here 'build'
$distDir  = Join-Path $here 'dist'

# ---------------------------------------------------------------------------
# Sanity check tools
# ---------------------------------------------------------------------------
function Test-Tool($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required tool not found: $name. $hint"
    }
}

if (-not $SkipPyInstaller) {
    Test-Tool 'python.exe'      'Install Python 3.11+ from python.org or via winget install Python.Python.3.11'
    Test-Tool 'pyinstaller.exe' 'pip install pyinstaller'
}

# Inno Setup may land in any of three places depending on how it was
# installed: system-wide 32-bit (the classic location), system-wide 64-bit
# (rare but possible), or per-user (what `winget install JRSoftware.InnoSetup`
# does when run without elevation — drops into %LOCALAPPDATA%\Programs).
$isccCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    throw "ISCC.exe not found in any of:`n  $($isccCandidates -join "`n  ")`nInstall Inno Setup 6 via 'winget install JRSoftware.InnoSetup -e'."
}
Write-Host "Using ISCC: $iscc" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# PyInstaller — two --onefile EXEs from the agent source
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if (-not $SkipPyInstaller) {
    Write-Host "==> PyInstaller: watchtower-svc.exe" -ForegroundColor Cyan
    Push-Location $agentDir
    try {
        # --hidden-import covers the dynamically-imported probes/* modules
        # since PyInstaller's static analysis won't see importlib.import_module.
        pyinstaller `
            --onefile `
            --name watchtower-svc `
            --distpath $buildDir `
            --workpath (Join-Path $buildDir '_work_svc') `
            --specpath (Join-Path $buildDir '_spec_svc') `
            --noconsole `
            --hidden-import probes.system `
            --hidden-import probes.network `
            --hidden-import probes.storage `
            --hidden-import probes.users `
            --hidden-import probes.software `
            --hidden-import probes.defender `
            --hidden-import probes.veeam `
            --hidden-import probes.wsb `
            --hidden-import probes.carbonite `
            --hidden-import probes.logmein `
            --hidden-import probes.sentinelone `
            --hidden-import probes.omsa `
            --hidden-import probes.idrac `
            --hidden-import probes.hotfixes `
            --hidden-import probes.usb `
            watchtower_service.py
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed for watchtower-svc" }

        Write-Host "==> PyInstaller: watchtower-tray.exe" -ForegroundColor Cyan
        pyinstaller `
            --onefile `
            --name watchtower-tray `
            --distpath $buildDir `
            --workpath (Join-Path $buildDir '_work_tray') `
            --specpath (Join-Path $buildDir '_spec_tray') `
            --noconsole `
            --windowed `
            watchtower_tray.py
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed for watchtower-tray" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $buildDir 'watchtower-svc.exe'))) {
    throw "watchtower-svc.exe missing from $buildDir"
}
if (-not (Test-Path (Join-Path $buildDir 'watchtower-tray.exe'))) {
    throw "watchtower-tray.exe missing from $buildDir"
}

# ---------------------------------------------------------------------------
# Inno Setup — compile generic installer (no per-client defines)
# ---------------------------------------------------------------------------
Write-Host "==> ISCC: Watchtower-Setup.exe" -ForegroundColor Cyan
$iss = Join-Path $here 'watchtower.iss'

$isccArgs = @(
    "/DWorkerUrl=$WorkerUrl",
    "/DAppVersion=$AppVersion"
)

if ($LogmeinMsi) {
    if (-not (Test-Path $LogmeinMsi)) {
        throw "LogmeinMsi path does not exist: $LogmeinMsi"
    }
    $resolved = (Resolve-Path $LogmeinMsi).Path
    Write-Host "==> Bundling LogMeIn MSI: $resolved" -ForegroundColor DarkGray
    $isccArgs += "/DLogMeInMsi=$resolved"
}

& $iscc @isccArgs $iss

if ($LASTEXITCODE -ne 0) {
    throw "ISCC failed with exit code $LASTEXITCODE"
}

$out = Join-Path $distDir 'Watchtower-Setup.exe'
if (Test-Path $out) {
    Write-Host ""
    Write-Host "Done: $out" -ForegroundColor Green
    Write-Host "Ship this same file to every client; the install token is entered at install time." -ForegroundColor DarkGray
    if ($LogmeinMsi) {
        Write-Host "LogMeIn MSI is bundled — wizard will show an 'Also install LogMeIn' checkbox (checked by default)." -ForegroundColor DarkGray
    }
} else {
    throw "Expected output missing: $out"
}
