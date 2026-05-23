# Watchtower installer

Builds the generic `Watchtower-Setup.exe` via PyInstaller + Inno Setup 6.
The same EXE deploys to every client &mdash; the install token (and the
client it's bound to) is entered at install time in the wizard, or
passed via `/TOKEN=...` for silent installs.

See [docs.html](../docs.html) for the operator-facing guide.

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

## Build

```powershell
cd ..\installer
.\build.ps1
```

Output: `installer\dist\Watchtower-Setup.exe`. Ship the same file to
every client.

## Iteration tips

- `-SkipPyInstaller` reuses the previously built `watchtower-svc.exe` /
  `watchtower-tray.exe` from `build\`. Useful when you're only tweaking
  the `.iss` and don't need to re-bundle Python.
- `-AppVersion` lets you bump the installer's displayed version
  independent of `watchtower.iss`.
- `-WorkerUrl` overrides the worker URL baked into the installer (the
  default points at production). Useful when iterating against a
  staging worker.
- `-LogmeinMsi <path>` bakes a LogMeIn host MSI into the installer.
  The wizard then shows an opt-out "Also install LogMeIn remote access"
  checkbox (checked by default). The MSI runs as
  `msiexec /i /quiet /norestart` after the agent install. Silent
  override: `Watchtower-Setup.exe /COMPONENTS=""` to skip it.
  Drop the MSI in `installer\vendor\` -- that path is gitignored.
  Silent override: `Watchtower-Setup.exe /TASKS="!logmein"` to skip on
  a host that already has LogMeIn.

## Generating install tokens

Tokens are now generated per-client in the Watchtower dashboard
(Clients tab &rarr; `+ Token`). Each token is bound to a client at
generation time and SHA-256-hashed before storage; the raw token is
shown once in a copy-to-clipboard modal.

The legacy shared-secret pattern (`WATCHTOWER_INSTALL_TOKEN` env var on
the worker) is still accepted by the worker as a backward-compat /
emergency-backdoor; see `..\worker\README.md`.
