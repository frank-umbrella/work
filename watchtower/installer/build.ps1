# build.ps1 - builds the generic Watchtower-Setup.exe installer.
#
# Single installer for every client. The operator running it on the target
# PC pastes their install token into the wizard (or passes /TOKEN= for a
# silent install). The token is validated against the worker before the
# install completes - see installer\watchtower.iss [Code] section.
#
# Steps:
#   1. Verify Python + PyInstaller + Inno Setup are available.
#   2. PyInstaller --onefile for watchtower_service.py and watchtower_tray.py
#      → installer\build\watchtower-svc.exe + watchtower-tray.exe.
#   3. ISCC.exe compiles watchtower.iss with /DWorkerUrl + /DAppVersion
#      defines (no per-client values - those are runtime now).
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
    # Default reads agent/VERSION — single source of truth, also read by
    # checkin.py at runtime. Pass -AppVersion explicitly to override for
    # a one-off (e.g. a hotfix build that needs to differ from VERSION).
    [string] $AppVersion  = "",
    # Optional path to a LogMeIn host MSI to bundle into the installer. When
    # set, the wizard shows an "Also install LogMeIn remote access" checkbox
    # (checked by default). Operator can uncheck per install. Silent install
    # honors /COMPONENTS="logmein" - pass /COMPONENTS="" to skip LogMeIn.
    # When omitted, no LogMeIn UI appears and the installer behaves as before.
    [string] $LogmeinMsi  = "",

    # Optional extra args appended to the LogMeIn msiexec command. /quiet
    # /norestart are always passed by the .iss; pass DEPLOYID + related
    # LogMeIn properties here when the MSI isn't a pre-customized
    # "Deploy Installation Package" download. Example:
    #   -LogmeinMsiArgs "DEPLOYID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx INSTALLMETHOD=5 FQDNDESC=1"
    [string] $LogmeinMsiArgs = "",

    # When set, after a successful build the resulting EXE is uploaded
    # to a GitHub Release tagged "v$AppVersion" on frank-umbrella/work.
    # Requires `gh` CLI authenticated as a user with push access; the
    # global `gh auth switch -u frank-umbrella` rule applies here.
    # Prints the public download URL + SHA256 on success so they can be
    # set in the Watchtower dashboard's Settings tab to roll the update
    # out fleet-wide.
    [switch] $Publish,

    [switch] $SkipPyInstaller
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentDir = Join-Path (Split-Path $here -Parent) 'agent'
$buildDir = Join-Path $here 'build'
$distDir  = Join-Path $here 'dist'

# Resolve AppVersion: -AppVersion arg > agent/VERSION file content. If both
# are empty we hard-fail rather than ship an unversioned build.
if (-not $AppVersion) {
    $versionFile = Join-Path $agentDir 'VERSION'
    if (-not (Test-Path $versionFile)) {
        throw "agent/VERSION not found and no -AppVersion override given."
    }
    $AppVersion = (Get-Content $versionFile -Raw).Trim()
}
Write-Host "==> Agent version: $AppVersion" -ForegroundColor DarkGray

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
# does when run without elevation - drops into %LOCALAPPDATA%\Programs).
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
# PyInstaller - two --onefile EXEs from the agent source
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if (-not $SkipPyInstaller) {
    Write-Host "==> PyInstaller: watchtower-svc.exe" -ForegroundColor Cyan
    Push-Location $agentDir
    try {
        # PyInstaller resolves --add-data source paths relative to --specpath
        # (NOT cwd), so we pass VERSION as an absolute path. Otherwise it
        # looks in installer\build\_spec_svc\VERSION and fails.
        $versionFile = Join-Path $agentDir 'VERSION'
        if (-not (Test-Path $versionFile)) {
            throw "VERSION file missing at $versionFile"
        }
        # --hidden-import covers the dynamically-imported probes/* modules
        # since PyInstaller's static analysis won't see importlib.import_module.
        pyinstaller `
            --onefile `
            --name watchtower-svc `
            --distpath $buildDir `
            --workpath (Join-Path $buildDir '_work_svc') `
            --specpath (Join-Path $buildDir '_spec_svc') `
            --noconsole `
            --add-data "${versionFile};." `
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
            --hidden-import probes.windows_updates `
            --hidden-import probes.usb `
            --hidden-import updater `
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
            --add-data "${versionFile};." `
            --hidden-import updater `
            --hidden-import checkin `
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
# Installer EXE icon - generate watchtower.ico from the dashboard's
# favicon.svg (crenellated tower on teal disc). This is the SAME design
# used for the tray icon and the wizard small image, so the product
# reads the same in Explorer, taskbar, system tray, browser tab, and
# installer wizard.
# Cached on disk after the first build.
# ---------------------------------------------------------------------------
$icoPath = Join-Path $here 'watchtower.ico'
if (-not (Test-Path $icoPath)) {
    $faviconSvg = Join-Path (Split-Path $here -Parent) 'favicon.svg'
    if (Test-Path $faviconSvg) {
        Write-Host "==> Generating installer icon from watchtower/favicon.svg" -ForegroundColor Cyan
        $makeIconScript = Join-Path $here 'make_icon.py'
        & python $makeIconScript
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $icoPath)) {
            Write-Warning "make_icon.py failed; installer will compile without a custom icon."
        }
    } else {
        Write-Warning "favicon not found at $faviconSvg; installer will compile without a custom icon."
    }
}

# ---------------------------------------------------------------------------
# Wizard branding BMPs - large left-banner + small top-right icon for the
# Inno Setup wizard pages. Generated from the same branding house logo.
# Re-run make_wizard_images.py manually after changing branding assets to
# refresh; build.ps1 only generates when files are missing.
# ---------------------------------------------------------------------------
$wizardLarge = Join-Path $here 'watchtower-wizard.bmp'
$wizardSmall = Join-Path $here 'watchtower-wizard-small.bmp'
if (-not (Test-Path $wizardLarge) -or -not (Test-Path $wizardSmall)) {
    $brandingPng = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) 'branding\source\Logo-House-Icon.png'
    if (Test-Path $brandingPng) {
        Write-Host "==> Generating Inno Setup wizard images from branding source" -ForegroundColor Cyan
        $makeWizardScript = Join-Path $here 'make_wizard_images.py'
        & python $makeWizardScript
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "make_wizard_images.py failed; installer will compile without wizard branding."
        }
    } else {
        Write-Warning "branding asset not found at $brandingPng; installer will compile without wizard branding."
    }
}

# ---------------------------------------------------------------------------
# Inno Setup - compile generic installer (no per-client defines)
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
    if ($LogmeinMsiArgs) {
        Write-Host "==> LogMeIn extra args: $LogmeinMsiArgs" -ForegroundColor DarkGray
        $isccArgs += "/DLogMeInMsiArgs=$LogmeinMsiArgs"
    }
} elseif ($LogmeinMsiArgs) {
    Write-Warning "-LogmeinMsiArgs supplied without -LogmeinMsi; ignored."
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
        Write-Host "LogMeIn MSI is bundled - wizard will show an 'Also install LogMeIn' checkbox (checked by default)." -ForegroundColor DarkGray
    }
} else {
    throw "Expected output missing: $out"
}

# ---------------------------------------------------------------------------
# Optional publish to GitHub Releases
# ---------------------------------------------------------------------------
if ($Publish) {
    Write-Host ""
    Write-Host "==> Publishing to GitHub Releases" -ForegroundColor Cyan

    if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) {
        throw "gh CLI not on PATH. Install via 'winget install GitHub.cli' or skip -Publish."
    }

    # SHA256 -- agents verify this before running the downloaded EXE so a
    # tampered upload can't be executed silently as LocalSystem.
    $hash = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
    Write-Host "SHA256: $hash" -ForegroundColor DarkGray

    $tag = "watchtower-v$AppVersion"
    $assetName = 'Watchtower-Setup.exe'
    $repo = 'frank-umbrella/work'

    # Check if release exists. PS 5.1 wraps native stderr as
    # NativeCommandError under $ErrorActionPreference=Stop, so we
    # temporarily switch to SilentlyContinue + check $LASTEXITCODE
    # ourselves. "release not found" is the expected case for a new tag.
    $releaseExists = $false
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $null = & gh release view $tag --repo $repo 2>&1
        if ($LASTEXITCODE -eq 0) { $releaseExists = $true }
    } finally {
        $ErrorActionPreference = $prevPref
    }

    if (-not $releaseExists) {
        Write-Host "Creating release $tag" -ForegroundColor DarkGray
        $notes = "Watchtower agent $AppVersion. SHA256: $hash"
        & gh release create $tag $out --repo $repo --title "Watchtower $AppVersion" --notes $notes
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    } else {
        Write-Host "Release $tag exists, replacing asset" -ForegroundColor DarkGray
        & gh release upload $tag $out --repo $repo --clobber
        if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    }

    $downloadUrl = "https://github.com/$repo/releases/download/$tag/$assetName"
    Write-Host ""
    Write-Host "Published:" -ForegroundColor Green
    Write-Host "  URL:    $downloadUrl" -ForegroundColor Green
    Write-Host "  SHA256: $hash" -ForegroundColor Green
    Write-Host ""
    Write-Host "Paste into the Watchtower dashboard Settings tab to roll this version out to opted-in hosts." -ForegroundColor DarkGray
}
