# scripts

Utility scripts for the Work hub - the things that have to be re-done every time
you get into a new or freshly imaged Windows PC, plus any other handy automation.
This folder is the home for all of them; add new scripts here and list them in
the index below.

Everything Windows-facing here works on **Windows 10 and Windows 11** - each
script detects the OS / mechanism at run time rather than trusting the version
label.

## Index

### Windows PC setup / cleanup

| Script                             | Does                                                       | Admin? |
| ---------------------------------- | ---------------------------------------------------------- | ------ |
| `Show-AllTrayIcons.ps1`            | Show all system-tray icons on the taskbar (no chevron)     | No     |
| `Disable-Copilot-Startup.ps1`      | Stop Microsoft 365 Copilot / Copilot launching at startup  | No     |
| `Disable-Malwarebytes-Startup.ps1` | Stop Malwarebytes launching at startup                     | Maybe  |
| `Disable-StartupApp.ps1`           | Generic engine the two above call (match any app by regex) | Maybe  |

*(add future scripts and their own category heading here)*

## How to run

**One-time use - nothing is left on the PC.** Each script changes a Windows
setting and exits, exactly like flipping the toggle by hand. Run it once, then
delete the `.ps1`; only the setting persists and nothing keeps running in the
background. The single exception is the tray script's optional `-Install`
(registers a logon task to re-apply) - skip it for a one-and-done pass on a
client machine, or run `-Uninstall` later to remove it.

```powershell
powershell -ExecutionPolicy Bypass -File .\<script>.ps1 [switches]
```

### Step by step (example: Show-AllTrayIcons.ps1)

1. **Save the script somewhere simple.** The root of the C: drive (`C:\`) is
   easiest because the path has no spaces; the Desktop works too.
2. **Open PowerShell.** Press Start, type `PowerShell`, press Enter. No admin is
   needed for the tray or Copilot scripts; for the Malwarebytes service option,
   right-click Windows PowerShell and choose *Run as administrator*.
3. **Paste the line that matches where you saved it, then Enter:**

   ```powershell
   # saved to the root of C:
   powershell -ExecutionPolicy Bypass -File C:\Show-AllTrayIcons.ps1

   # saved to the Desktop
   powershell -ExecutionPolicy Bypass -File "$HOME\Desktop\Show-AllTrayIcons.ps1"
   ```

Swap `Show-AllTrayIcons.ps1` for any other script name and add switches on the
end (e.g. `... .ps1 -List`). The full path is in the command, so you do not need
to change folders first. If the Desktop line errors, your Desktop is synced to
OneDrive - use `"$HOME\OneDrive\Desktop\Show-AllTrayIcons.ps1"` instead.

Common switches on these scripts:

- `-List` - show what matches, change nothing (safe to run first)
- `-WhatIf` - dry run; print what would change
- `-Enable` - reverse a previous disable (on the disable scripts)

If a script is blocked by execution policy, the `-ExecutionPolicy Bypass` above
runs it without changing the machine's policy. To unblock a file copied from a
network share once: `Unblock-File .\<script>.ps1`.

---

# 1. Always Show All System Tray Icons

Force every notification-area (system tray) icon to display directly on the
taskbar, instead of being hidden behind the Windows 11 chevron / "Hidden icon
menu" flyout. Includes a one-shot script, an optional auto-reapply-on-logon
install, and the manual steps to do it by hand.

## Why this is annoying on Windows 11

Windows 10 had a single switch: **"Always show all icons in the notification
area."** Flip it once and you were done.

Windows 11 removed that switch and made visibility **per app**. Each app's
state lives in the registry under:

```
HKCU\Control Panel\NotifyIconSettings\<hash>
    IsPromoted (DWORD)   1 = shown on taskbar      0 = hidden in the chevron
    ExecutablePath        full path to the app
```

The catch:

- A subkey only appears **after an app has shown a tray icon at least once.**
- The Taskbar setting "show new icons" is unreliable: freshly installed apps
  routinely land with `IsPromoted = 0` and disappear into the chevron.
- If the "Hidden icon menu" is also off, those icons effectively never show.

So the reliable fix is to set `IsPromoted = 1` on **every** entry, and re-apply
whenever a new app shows up. Once nothing is hidden, the chevron itself
disappears.

## The script: `Show-AllTrayIcons.ps1`

Runs entirely in `HKCU` -> **no administrator rights needed.** It auto-detects
the OS: on Windows 11 it promotes every `NotifyIconSettings` entry; on Windows
10 it sets `EnableAutoTray = 0` (the old "always show all" switch).

### One-shot (apply right now)

```powershell
powershell -ExecutionPolicy Bypass -File .\Show-AllTrayIcons.ps1
```

It promotes all current icons and restarts Explorer so they appear immediately.

### Auto-reapply on every logon (recommended)

Because new apps register with icons hidden, install the logon task. It copies
the script to `%LOCALAPPDATA%\ShowAllTrayIcons\` and registers a scheduled task
that re-runs ~1 minute after each sign-in (so startup apps have time to load):

```powershell
powershell -ExecutionPolicy Bypass -File .\Show-AllTrayIcons.ps1 -Install
```

### Remove the logon task

```powershell
powershell -ExecutionPolicy Bypass -File .\Show-AllTrayIcons.ps1 -Uninstall
```

### Notes

- A brand-new app must run **once** before the script can promote it (its
  registry subkey doesn't exist until its icon first appears). The logon task
  handles this automatically on the next sign-in; for an immediate fix after
  installing something, just re-run the one-shot command.
- The Explorer restart causes a brief taskbar flicker. That's expected.

## Manual steps (no script)

### Windows 11

1. Right-click the taskbar and choose **Taskbar settings**
   (or **Settings > Personalization > Taskbar**).
2. Scroll to and expand **Other system tray icons**.
3. Turn **On** the toggle for every app you want always visible.
4. When no icons are left hidden, the chevron (`^`) disappears on its own.

**Faster trick:** click the chevron to open the flyout, then **drag** an icon
out of the flyout and drop it onto the taskbar. That sets `IsPromoted = 1` for
that app instantly - no Settings trip needed.

> New apps you install later will still start hidden. Re-open **Other system
> tray icons** and toggle them on, or just run the script.

### Windows 10

1. Right-click the taskbar > **Taskbar settings**.
2. Under **Notification area**, click
   **Select which icons appear on the taskbar**.
3. Turn on **Always show all icons in the notification area.**

## What the script changes (for the curious)

| OS          | Key                                                                  | Value          | Set to |
| ----------- | -------------------------------------------------------------------- | -------------- | ------ |
| Windows 11  | `HKCU\Control Panel\NotifyIconSettings\<hash>`                        | `IsPromoted`   | `1`    |
| Windows 10  | `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced`   | `EnableAutoTray` | `0`  |

All changes are per-user (`HKCU`) and fully reversible by setting the values
back (`IsPromoted = 0`, or `EnableAutoTray = 1`).

---

# 2. Stop Microsoft 365 Copilot at Startup

`Disable-Copilot-Startup.ps1` - **no admin required.**

"Microsoft 365 Copilot" is the rebranded Microsoft 365 / Office hub app
(package `Microsoft.MicrosoftOfficeHub_8wekyb3d8bbwe`). The standalone assistant
is "Copilot" (`Microsoft.Copilot_8wekyb3d8bbwe`). Both auto-start through a
**packaged-app startup task** whose state is a `State` DWORD under:

```
HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\<package>\<TaskId>
    State = 1   DisabledByUser  (sticky - what we set)
    State = 2   Enabled
```

```powershell
.\Disable-Copilot-Startup.ps1 -List     # show what would change
.\Disable-Copilot-Startup.ps1           # disable Copilot startup
.\Disable-Copilot-Startup.ps1 -Enable   # put it back
```

It also catches any Copilot/365 `Run` keys or scheduled tasks if a given build
uses those instead. Takes effect at next sign-in.

### Manual steps (Copilot)

- **Settings > Apps > Startup**, find **Microsoft 365 Copilot** (and/or
  **Copilot**) and switch it **Off**, OR
- **Task Manager > Startup apps**, select the Copilot entry, **Disable**.

> To also remove the taskbar Copilot button: **Settings > Personalization >
> Taskbar** and turn off **Copilot**. That is separate from startup launch.

---

# 3. Stop Malwarebytes at Startup

`Disable-Malwarebytes-Startup.ps1`

Malwarebytes changed how it starts over the years, so this script covers both
cases - and is explicit about the trade-off, because the modern version does not
expose a simple registry switch:

- **Older versions / leftovers** add a Windows `Run` key, scheduled task, or
  Startup-folder shortcut. Those are found and disabled automatically.
- **Current Malwarebytes (v4/v5)** launches its tray UI (`mbamtray.exe`) from
  the **MBAMService** service, driven by the in-app toggle in your screenshot
  ("Launch Malwarebytes in the background when Windows starts"). There is **no
  clean Run key** to flip for that, so the script gives you explicit levers:

```powershell
.\Disable-Malwarebytes-Startup.ps1 -List           # show what exists
.\Disable-Malwarebytes-Startup.ps1                 # disable any Run/task/folder entries + stop tray hint
.\Disable-Malwarebytes-Startup.ps1 -StopTrayNow    # also kill mbamtray.exe for this session now
.\Disable-Malwarebytes-Startup.ps1 -DisableService # set MBAMService to Manual (admin) - see warning
.\Disable-Malwarebytes-Startup.ps1 -DisableService -Enable  # restore services to Automatic
```

### Which option do you want?

| Goal                                           | Use                                  |
| ---------------------------------------------- | ------------------------------------ |
| Tray off at boot, **keep** real-time protection | The in-app toggle (manual, below)    |
| Remove any old MB Run/task/shortcut entries     | default run (no switches)            |
| Nothing MB starts at boot, protection included  | `-DisableService` (admin)            |

> **`-DisableService` stops real-time protection too.** It sets MBAMService to
> Manual so nothing auto-launches. Only use it if you want Malwarebytes fully
> dormant at boot. Reverse with `-DisableService -Enable`.

> **Self-protection:** if Malwarebytes self-protection is enabled it can revert
> external edits to its own keys. If a change does not stick, turn self-
> protection off first (Settings > Security in the app), apply, then re-enable.

### Manual steps (Malwarebytes - the surgical option)

This is the exact toggle from your screenshot, and the supported way to turn off
the background launch while **keeping** protection:

1. Open **Malwarebytes**.
2. **Settings** (gear) > **General** (or **Security**, depending on version).
3. Under **Windows startup**, turn **Off**
   *"Launch Malwarebytes in the background when Windows starts."*

That toggle is `On` by default after install - which is why it needs turning off
on every fresh machine.

---

# Tools / on-demand downloads

Official vendor direct downloads, also surfaced on the landing page
(`index.html`), for a quick second-opinion scan or cleanup pass:

| Tool                                  | Direct download                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Malwarebytes for Windows (Free/Personal) | `https://downloads.malwarebytes.com/file/mb-windows` (-> MBSetup.exe)         |
| ESET Online Scanner                   | `https://download.eset.com/com/eset/tools/online_scanner/latest/esetonlinescanner.exe` |

Both links point straight at the vendors' own download servers (verified live).
Run on-demand scanners with administrator rights.
