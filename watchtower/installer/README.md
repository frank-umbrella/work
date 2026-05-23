# Watchtower installer

Builds per-client `Watchtower-Setup-<ClientName>.exe` installers via
PyInstaller + Inno Setup 6.

## One-time setup

```powershell
# Tools
winget install Python.Python.3.11
winget install JRSoftware.InnoSetup

# Python deps for building the agent
cd ..\agent
python -m pip install -r requirements.txt
python -m pip install pyinstaller
```

## Build for a client

```powershell
cd ..\installer
.\build.ps1 -ClientName "OPFD" -InstallToken "<paste the 32-byte base64 token>"
```

Output: `installer\dist\Watchtower-Setup-OPFD.exe`.

Hand that file to the technician deploying on the client PC. Running
it requires admin elevation (the wizard will prompt for UAC) and takes
maybe 15 seconds end-to-end.

## Iteration tips

- `-SkipPyInstaller` reuses the previously built `watchtower-svc.exe` /
  `watchtower-tray.exe` from `build\`. Useful when you're only tweaking
  the `.iss` and don't need to re-bundle Python.
- `-AppVersion` lets you bump the installer's displayed version
  independent of `watchtower.iss`.
- The pcId UUID is generated at install time on the client PC — so
  the same `Watchtower-Setup-OPFD.exe` deployed on three different PCs
  produces three distinct pcIds. The InstallToken is shared across
  every PC for that client (and currently across all clients too — the
  worker accepts whatever token matches `WATCHTOWER_INSTALL_TOKEN`).

## Generating an InstallToken

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Set this same value as the `WATCHTOWER_INSTALL_TOKEN` secret on the
Cloudflare Worker (see `..\worker\README.md`).
