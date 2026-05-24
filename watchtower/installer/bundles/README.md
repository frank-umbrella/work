# Optional bundles

The Watchtower installer can bundle other MSPs' MSIs alongside the agent
+ tray, so a single `Watchtower-Setup.exe` deploy also installs LogMeIn /
similar in one click. Drop the MSI(s) into this folder; the GitHub
Actions installer workflow + the local `build.ps1` both pick them up
automatically.

## LogMeIn (`LogMeIn.msi`)

If `bundles/LogMeIn.msi` exists, the installer:

1. Adds an optional "Install LogMeIn" task to the wizard (checked by
   default)
2. Bundles the MSI inside `Watchtower-Setup.exe`
3. Runs `msiexec /i LogMeIn.msi /quiet /norestart` on install when the
   task is checked

The MSI should be the pre-customized package you download from
**LogMeIn Central → Deployment → Deploy Installation Package**. That
package already has `DEPLOYID=<your-id>` baked in, so no extra
properties are needed — the agent installs into the correct LogMeIn
Central account on first run.

If you need to pass extra MSI properties (the LMI Central package
doesn't include `INSTALLMETHOD=5` / `FQDNDESC=1` / `LMIDESCRIPTION=`
by default), set them via `build.ps1 -LogmeinMsiArgs "FOO=bar"` for
local builds, or wire them into `.github/workflows/watchtower-installer.yml`
for CI builds.

## Updating the bundled MSI

LogMeIn rotates the deployment package periodically (when you revoke
a key, change company info, etc). When that happens:

1. Download the fresh MSI from LogMeIn Central
2. Replace `bundles/LogMeIn.msi` in this folder
3. `git add bundles/LogMeIn.msi && git commit -m "Refresh LogMeIn deployment MSI"`
4. Push — CI rebuilds the installer with the new bundled MSI
5. Existing agents will auto-update to the new installer EXE on their
   next check-in cycle (if Auto-update is enabled per host); or push
   from the dashboard via Force update

## Why the bundle directory is gitignored except for known names

The `.gitignore` in this folder only lets through `LogMeIn.msi`,
`README.md`, and `.gitignore` itself. Random downloads, scratch files,
half-renamed MSIs etc. won't get committed by mistake.
