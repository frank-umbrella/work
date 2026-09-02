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
| `Disable-StartupApp.ps1`           | Standalone generic version: disable ANY app's startup by regex | Maybe  |

### Windows maintenance

| Script                    | Does                                                          | Admin? |
| ------------------------- | ------------------------------------------------------------- | ------ |
| `Open-WindowsUpdate.ps1`  | Open Windows Update, pause updates, wait, then check          | To pause |
| `Set-WindowsUpdateOptions.ps1` | Turn on MS-product updates + restart notify, set active hours | Yes |
| `Open-DiskCleanup.ps1`    | Launch Disk Cleanup (cleanmgr) for a drive                    | No     |
| `Open-DevicesAndPrinters.ps1` | Open classic Devices and Printers / old Add Printer wizard | No  |
| `Print-Flush.bat`         | Stop spooler, clear stuck print jobs, restart spooler         | Yes    |
| `Invoke-CheckDisk.ps1`    | Classic chkdsk /f /r (schedules on the Windows drive)         | Yes    |
| `Repair-SystemFiles.ps1`  | DISM /RestoreHealth then SFC /scannow, in the right order     | Yes    |
| `Clear-ComponentStore.ps1` | Trim WinSxS via DISM StartComponentCleanup                   | Yes    |

### Accounts

| Script                          | Does                                                     | Admin? |
| ------------------------------- | -------------------------------------------------------- | ------ |
| `Disable-AdminPasswordExpiry.ps1` | Set "Password never expires" on a local account (default admin) | Yes |

### Software removal

| Script                     | Does                                                         | Admin? |
| -------------------------- | ------------------------------------------------------------ | ------ |
| `Remove-HPWolfSecurity.ps1` | Fully remove HP Wolf Security and stop it reinstalling       | Yes    |
| `Remove-ESETOnlineScanner.ps1` | Remove ESET Online Scanner leftovers (EOSv3 tasks, folder)  | Yes   |
| `Remove-ScreenConnect.ps1` | Fully remove ScreenConnect / ConnectWise Control client(s)     | Yes   |

### Diagnostics (copy-paste checks, no script file)

| Section          | Does                                                          | Admin? |
| ---------------- | ------------------------------------------------------------- | ------ |
| Check RAM type   | Per-stick DDR3/4/5, size, speed, part number, DIMM/SO-DIMM    | No     |
| Check drive type | Per-disk SSD/HDD, bus, size, health + which disk Windows is on | No    |

### Deployment (on-page command generators, no script file)

| Section              | Does                                                              | Admin? |
| -------------------- | ----------------------------------------------------------------- | ------ |
| Deploy SentinelOne   | Paste your site token, copy the exact silent msiexec install line | Yes    |

*(add future scripts and their own category heading here)*

## How to run

**One-time use - nothing is left on the PC.** Each script changes a Windows
setting and exits, exactly like flipping the toggle by hand. Run it once, then
delete the `.ps1`; only the setting persists and nothing keeps running in the
background. The single exception is the tray script's optional `-Install`
(registers a logon task to re-apply) - skip it for a one-and-done pass on a
client machine, or run `-Uninstall` later to remove it.

```powershell
powershell -ExecutionPolicy Bypass -File C:\<script>.ps1 [switches]
```

**Always use the full path** (`-File C:\<script>.ps1`). An *elevated* PowerShell
starts in `C:\windows\system32`, so a relative `.\<script>.ps1` won't find a
script saved to `C:\`. The per-script examples below assume the script sits in
`C:\` - adjust the path if you saved it elsewhere.

**On the web page**, every script has a command builder: click the switch chips
under a command and the copy block updates live, a highlighted "What this
command will do" box explains each selected part, and switches that conflict
deselect each other automatically.

**Running these over LogMeIn** (the usual method - its built-in admin Command
Prompt, so the user isn't interrupted): that shell is already elevated, so
self-elevating scripts run in place with no UAC popup on the user's screen.
Best fit is everything machine-wide or silent (SentinelOne deploy, removals,
Print Flush, chkdsk, DISM/SFC, WinSxS, Windows Update options, password expiry,
Disk Cleanup -Auto). Two exceptions to run in a remote-control session as the
signed-in user instead: the per-user scripts (tray icons, Copilot - they write
HKCU, and the background shell runs as the admin account, so they'd change the
wrong profile) and the window-openers (Devices and Printers, interactive Disk
Cleanup, the Windows Update screen - their windows open where no one can see
them).

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
network share once: `Unblock-File C:\<script>.ps1`.

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
powershell -ExecutionPolicy Bypass -File C:\Show-AllTrayIcons.ps1
```

It promotes all current icons and restarts Explorer so they appear immediately.

### Auto-reapply on every logon (recommended)

Because new apps register with icons hidden, install the logon task. It copies
the script to `%LOCALAPPDATA%\ShowAllTrayIcons\` and registers a scheduled task
that re-runs ~1 minute after each sign-in (so startup apps have time to load):

```powershell
powershell -ExecutionPolicy Bypass -File C:\Show-AllTrayIcons.ps1 -Install
```

### Remove the logon task

```powershell
powershell -ExecutionPolicy Bypass -File C:\Show-AllTrayIcons.ps1 -Uninstall
```

### Notes

- A brand-new app must run **once** before the script can promote it (its
  registry subkey doesn't exist until its icon first appears). The logon task
  handles this automatically on the next sign-in; for an immediate fix after
  installing something, just re-run the one-shot command.
- The Explorer restart causes a brief taskbar flicker. That's expected.

## Manual steps (no script)

### Windows 11

**Run box:** Win+R -> `ms-settings:taskbar` opens Taskbar settings.

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

**Run box:** Win+R -> `control /name Microsoft.NotificationAreaIcons` opens the
classic dialog with the "Always show all icons" checkbox.

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
C:\Disable-Copilot-Startup.ps1 -List     # show what would change
C:\Disable-Copilot-Startup.ps1           # disable Copilot startup
C:\Disable-Copilot-Startup.ps1 -Enable   # put it back
```

It also catches any Copilot/365 `Run` keys or scheduled tasks if a given build
uses those instead. Takes effect at next sign-in.

### Manual steps (Copilot)

**Run box:** Win+R -> `ms-settings:startupapps` opens Startup apps directly (or
`taskmgr` for Task Manager > Startup apps).

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
C:\Disable-Malwarebytes-Startup.ps1 -List           # show what exists
C:\Disable-Malwarebytes-Startup.ps1                 # disable any Run/task/folder entries + stop tray hint
C:\Disable-Malwarebytes-Startup.ps1 -StopTrayNow    # also kill mbamtray.exe for this session now
C:\Disable-Malwarebytes-Startup.ps1 -DisableService # set MBAMService to Manual (admin) - see warning
C:\Disable-Malwarebytes-Startup.ps1 -DisableService -Enable  # restore services to Automatic
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

# 4. Open Windows Update (pause + check)

`Open-WindowsUpdate.ps1` - **admin needed to pause** (self-elevates).

Runs the routine in one shot: opens Settings > Windows Update, pauses updates
for `-PauseDays` (default 7) by writing the pause window to
`HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings`, waits `-WaitSeconds`
(default 10), then triggers a check for updates. On GPO / Intune / WSUS-managed
machines, policy may override the pause.

```powershell
C:\Open-WindowsUpdate.ps1                      # open, pause 7 days, wait, check
C:\Open-WindowsUpdate.ps1 -PauseDays 14        # longer pause
C:\Open-WindowsUpdate.ps1 -Resume              # clear pause (resume), then check
C:\Open-WindowsUpdate.ps1 -NoPause             # just open + check, no admin
```

### Manual steps

**Run box:** Win+R -> `ms-settings:windowsupdate` opens Windows Update directly.

1. Press Win+I -> **Windows Update**.
2. Next to **Pause updates**, pick a duration (e.g. *Pause for 1 week*).
3. Click **Check for updates**; **Resume updates** to un-pause early.

---

# 5. Set Windows Update options (Advanced)

`Set-WindowsUpdateOptions.ps1` - **admin needed** (self-elevates).

Turns on "Receive updates for other Microsoft products" (registers the Microsoft
Update service, GUID `7971f918-...`, with an `AllowMUUpdateService=1` fallback)
and "Notify me when a restart is required" (`RestartNotificationsAllowed2=1`),
and sets Active hours (`ActiveHoursStart`/`ActiveHoursEnd`, or
`SmartActiveHoursState=1` for automatic). GPO / Intune / WSUS may override.
Active hours range max 18 hours.

```powershell
C:\Set-WindowsUpdateOptions.ps1                                  # both on + active hours 7am-11pm
C:\Set-WindowsUpdateOptions.ps1 -ActiveHoursStart 8 -ActiveHoursEnd 22
C:\Set-WindowsUpdateOptions.ps1 -AutoActiveHours                 # let Windows manage active hours
```

### Manual steps

**Run box:** Win+R -> `ms-settings:windowsupdate-options` opens Advanced options.

1. **Settings > Windows Update > Advanced options**.
2. Turn **On** *Receive updates for other Microsoft products* - switches Windows
   Update into "Microsoft Update" so other Microsoft software (Office, Visual
   Studio, SQL Server) patches through Windows Update too, not just Windows.
3. Turn **On** *Notify me when a restart is required to finish updating* - shows
   a "Restart to finish installing updates" notification instead of a silently
   scheduled reboot.
4. Under **Active hours** (the window Windows treats the PC as in-use and won't
   auto-restart for updates - e.g. 7 AM-11 PM means restarts only happen
   overnight, 11 PM-7 AM), choose *Manually* and set start/end (or
   *Automatically* to let Windows learn it).

---

# 6. Launch Disk Cleanup

`Open-DiskCleanup.ps1` - no admin for the basic view.

Opens `cleanmgr.exe` for the C: drive (use `-Drive D` for another). `-SystemFiles`
opens the elevated view with more categories (Windows Update cleanup, old
installations); `-Auto` runs an unattended cleanup of common safe categories
with no UI.

```powershell
C:\Open-DiskCleanup.ps1                # interactive, C:
C:\Open-DiskCleanup.ps1 -SystemFiles  # elevated "system files" view
C:\Open-DiskCleanup.ps1 -Auto         # unattended preset, no clicks
```

### Manual steps

**Run box:** Win+R -> `cleanmgr` (or `cleanmgr /d C:` for a specific drive)
opens Disk Cleanup directly.

1. Press Start, type `Disk Cleanup`, Enter.
2. Choose **C:**, tick categories, **OK**.
3. For more, click **Clean up system files** and approve the admin prompt.

---

# 7. Classic Devices and Printers

`Open-DevicesAndPrinters.ps1` - no admin.

Newer Windows buries the classic Devices and Printers window in Settings. This
opens the old Control Panel window directly, and `-AddPrinter` launches the
legacy Add Printer wizard (add a printer by IP / local port the old way).

```powershell
C:\Open-DevicesAndPrinters.ps1              # classic Devices and Printers window
C:\Open-DevicesAndPrinters.ps1 -AddPrinter  # old Add Printer wizard
```

### Manual steps (Run box)

Paste either into Win+R (or a Command Prompt):

```text
explorer.exe shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}   (Devices and Printers)
rundll32.exe printui.dll,PrintUIEntry /il                      (Add Printer wizard)
```

---

# 8. Print Flush

`Print-Flush.bat` - **admin needed** (right-click > Run as administrator).

Stops the Print Spooler, deletes stuck / corrupt jobs from the spool folder, and
restarts it - the fix for a frozen print queue or a printer that won't print. It
also re-points the spooler's service dependency to `RPCSS` (permanently), which
unbreaks the spooler on machines - often Lexmark - where a bad dependency stops
it starting.

Right-click the `.bat` and choose **Run as administrator**, or elevate it from
PowerShell:

```powershell
Start-Process C:\Print-Flush.bat -Verb RunAs
```

### Manual steps

In an elevated Command Prompt (Win+R -> `cmd` -> Ctrl+Shift+Enter):

```text
net stop spooler
del /Q /F /S "%systemroot%\System32\Spool\Printers\*.*"
net start spooler
```

If the spooler won't start (common with Lexmark), reset its dependency first:
`sc config spooler depend= RPCSS`

---

# 9. Remove HP Wolf Security

`Remove-HPWolfSecurity.ps1` - **admin needed** (self-elevates).

HP Wolf Security / HP Wolf Pro Security is HP's preinstalled endpoint
protection. A plain Control Panel uninstall often isn't enough: the **HP
Security Update Service** re-downloads and reinstalls the agent, so it keeps
coming back. This removes the whole stack in HP's documented order with the
update service **last**, and clears the services, scheduled tasks, and Store /
AppX packages that trigger reinstalls. Discovery-based, so it works across
versions (finds the current MSI product codes itself).

HP's documented uninstall order (support.hpwolf.com, "How to uninstall HP Wolf
Pro Security"): HP Wolf Security -> HP Wolf Security - Console -> HP Security
Update Service, then reboot.

```powershell
C:\Remove-HPWolfSecurity.ps1 -List    # preview every component/service/task/AppX found
C:\Remove-HPWolfSecurity.ps1          # remove everything in order, update service last
C:\Remove-HPWolfSecurity.ps1 -Reboot  # remove, then restart automatically
```

> **Managed / password-protected installs** (deployed by an HP admin console or
> set with an uninstall password) will fail with msiexec 1603 - those need the
> admin console or the uninstall password, not a local uninstall.

### Manual steps

**Run box:** Win+R -> `appwiz.cpl` opens Programs and Features.

1. Open **Programs and Features** (or **Settings > Apps > Installed apps**).
2. Uninstall in this order: **HP Wolf Security** -> **HP Wolf Security -
   Console** -> **HP Security Update Service** (this last one is what
   re-installs the agent - remove it last and it stops coming back).
3. **Reboot.**

---

# 10. Remove ESET Online Scanner leftovers

`Remove-ESETOnlineScanner.ps1` - **admin needed** (self-elevates).

ESET Online Scanner is one-time by default, but if "Periodic scanning" was
accepted it registers scheduled tasks (`EOSv3 Scheduler onLogOn` / `onTime`)
that re-run scans at logon / on a timer - and these survive even after you
"delete" the scanner. This removes those tasks, the data folder
(`%LOCALAPPDATA%\ESET\ESETOnlineScanner` for every user profile), the Desktop
shortcut, and any running scanner. It does NOT touch an installed ESET
antivirus product - only the on-demand scanner's leftovers.

```powershell
C:\Remove-ESETOnlineScanner.ps1 -List   # preview tasks/folders/shortcuts found
C:\Remove-ESETOnlineScanner.ps1         # remove them all
```

> Deleting the data folder also discards any ESET Online Scanner **quarantine**.
> If it quarantined something you might still want, copy it out first.

**Keep it one-and-done in the first place:** when running the scanner, decline
the *Periodic scanning* prompt, tick *"Delete application data on closing"*
before you close it, then delete the Desktop shortcut. Sources:
[ESET - Periodic scan](https://help.eset.com/eos/en-US/periodic_scan.html),
[Getting started](https://help.eset.com/eos/en-US/getting_started.html),
[KB405 FAQ](https://support.eset.com/en/kb405-online-scanner-faq).

### Manual steps

**Run box:** Win+R -> `taskschd.msc` opens Task Scheduler.

1. In Task Scheduler, delete `EOSv3 Scheduler onLogOn` / `EOSv3 Scheduler onTime`.
2. Delete `%LOCALAPPDATA%\ESET\ESETOnlineScanner`.
3. Delete the ESET Online Scanner Desktop shortcut.

---

# 11. Disable admin password expiry

`Disable-AdminPasswordExpiry.ps1` - **admin needed** (self-elevates).

Sets "Password never expires" on the local `admin` account so the standard admin
login doesn't lock out when its password ages. Uses `Set-LocalUser`, the modern
replacement for `wmic UserAccount ... set PasswordExpires=False` (wmic is removed
by default in Windows 11 24H2). Local accounts only - not domain / Microsoft
Entra (Azure AD) accounts.

```powershell
C:\Disable-AdminPasswordExpiry.ps1                    # the admin account
C:\Disable-AdminPasswordExpiry.ps1 -User localadmin   # a different local account
C:\Disable-AdminPasswordExpiry.ps1 -Revert            # turn expiry back on
```

### Manual steps

- **GUI (Pro / Enterprise):** Win+R -> `lusrmgr.msc` -> Users -> double-click
  **admin** -> tick **Password never expires** -> OK.
- **Modern command** (elevated PowerShell):
  `Set-LocalUser -Name 'admin' -PasswordNeverExpires $true`
- **Classic command** (wmic, pre-24H2):
  `wmic UserAccount where Name='admin' set PasswordExpires=False`

---

# 12. Remove ScreenConnect

`Remove-ScreenConnect.ps1` - **admin needed** (self-elevates).

The ScreenConnect / ConnectWise Control access agent installs as `ScreenConnect
Client (<id>)`: a program, a Windows service, and a Program Files folder - and a
PC can carry more than one (agents left by different providers). This finds
every instance and uninstalls each, stops + deletes any leftover service, and
clears leftover Program Files folders. Discovery-based (works across versions).

```powershell
C:\Remove-ScreenConnect.ps1 -List   # preview every product/service/folder found
C:\Remove-ScreenConnect.ps1         # remove them all
```

### Manual steps

Run box: Win+R -> `appwiz.cpl` (Programs and Features) and `services.msc`.

1. In **Programs and Features**, uninstall every **ScreenConnect Client (...)**
   entry (there may be several).
2. If a **ScreenConnect Client** service remains in `services.msc`, delete it
   from an elevated Command Prompt: `sc delete "ScreenConnect Client (<id>)"`
3. Delete any leftover `C:\Program Files (x86)\ScreenConnect Client (<id>)` folder.

---

# 13. Check Disk (chkdsk /f /r)

`Invoke-CheckDisk.ps1` - **admin needed** (self-elevates).

The classic `chkdsk C: /f /r`: fixes filesystem errors (`/f`) and scans the disk
surface for bad sectors, recovering readable data (`/r` - can take HOURS). The
Windows drive can't be locked while Windows runs, so the check is scheduled for
the next restart (the script answers the schedule prompt and confirms with
`chkntfs`).

```powershell
C:\Invoke-CheckDisk.ps1                # chkdsk C: /f /r (scheduled on reboot)
C:\Invoke-CheckDisk.ps1 -SkipSurface   # /f only - much faster, no surface scan
C:\Invoke-CheckDisk.ps1 -ReadOnly      # report-only, changes nothing
C:\Invoke-CheckDisk.ps1 -Drive D       # another drive (runs immediately)
C:\Invoke-CheckDisk.ps1 -Reboot        # restart now so the check runs right away
C:\Invoke-CheckDisk.ps1 -Status        # is a check already scheduled? (chkntfs)
```

### Manual steps

Elevated Command Prompt (Win+R -> `cmd` -> Ctrl+Shift+Enter):
`chkdsk C: /f /r` - answer `Y` to schedule on the next restart. Check the queue
with `chkntfs C:`.

---

# 14. Repair system files (DISM + SFC)

`Repair-SystemFiles.ps1` - **admin needed** (self-elevates).

The standard corruption-repair pass in the correct order: DISM
`/Online /Cleanup-Image /RestoreHealth` first (repairs the component store -
the source SFC repairs from - downloading known-good files from Windows Update),
then `sfc /scannow` (replaces corrupted system files from that repaired store).
DISM-first matters: a corrupt store makes SFC repair from a bad source. Both
steps can sit at certain percentages for a while - normal; don't close the
window.

```powershell
C:\Repair-SystemFiles.ps1              # DISM RestoreHealth, then SFC /scannow
C:\Repair-SystemFiles.ps1 -ExportLog   # + write SFC results to Desktop\SFCDETAILS.TXT
C:\Repair-SystemFiles.ps1 -SfcOnly     # only sfc /scannow
C:\Repair-SystemFiles.ps1 -DismOnly    # only the DISM store repair
```

### Manual steps

Elevated Command Prompt, in order:

```text
DISM.exe /Online /Cleanup-Image /RestoreHealth
sfc /scannow
findstr /C:"[SR]" %windir%\Logs\CBS\CBS.log > "%USERPROFILE%\Desktop\SFCDETAILS.TXT"
```

(The findstr line is optional - it dumps the SFC results to the Desktop. CBS.log
accumulates, so earlier runs appear too.)

---

# 15. Clean the component store (WinSxS)

`Clear-ComponentStore.ps1` - **admin needed** (self-elevates).

Trims WinSxS with `DISM /Online /Cleanup-Image /StartComponentCleanup` -
removes superseded component versions to reclaim disk space (often several GB).
Run `-Analyze` first to see if it's worth it.

```powershell
C:\Clear-ComponentStore.ps1 -Analyze    # report-only: store size + recommendation
C:\Clear-ComponentStore.ps1             # the cleanup
C:\Clear-ComponentStore.ps1 -UseTask    # background servicing task instead (quiet)
C:\Clear-ComponentStore.ps1 -ResetBase  # max space - NON-REVERSIBLE (updates can't be uninstalled)
```

### Manual steps

Elevated Command Prompt:

```text
Dism.exe /Online /Cleanup-Image /StartComponentCleanup
schtasks.exe /Run /TN "\Microsoft\Windows\Servicing\StartComponentCleanup"
```

(The schtasks line runs the built-in background task instead - same cleanup.)

---

# 16a. Check RAM type (DDR3/4/5)

Copy-paste check, no script file, no admin. Reads `Win32_PhysicalMemory`'s
`SMBIOSMemoryType` (the reliable property - the old `MemoryType` often reports
0). Shows per stick: slot, maker, part number, GB, rated + running speed, DDR
generation (incl. LPDDR3/4/5 on laptops), DIMM vs SO-DIMM. The full block is on
the page; key fallbacks when Type = Unknown:

1. Google the Part number the check returned (part numbers encode the type).
2. CPU-Z portable ghost mode: `cpuz_x64.exe -txt=report` - silent full report
   incl. SPD (background-shell friendly).
3. Crucial System Scanner (crucial.com/store/systemscanner) - also shows
   compatible upgrades / max capacity, but opens results in a browser and has
   no silent mode: remote-control sessions only.

# 16b. Check drive type (SSD or HDD)

Copy-paste check, no script file, no admin:

```powershell
Get-PhysicalDisk | ForEach-Object {
    [PSCustomObject]@{
        Disk = $_.DeviceId; Name = $_.FriendlyName; Type = $_.MediaType
        Bus = $_.BusType; SizeGB = [math]::Round($_.Size / 1GB)
        Health = $_.HealthStatus
    }
} | Sort-Object {[int]$_.Disk} | Format-Table -AutoSize

"Windows (C:) is on Disk $((Get-Partition -DriveLetter C).DiskNumber)"
```

Type = SSD/HDD; *Unspecified* is usually a USB enclosure hiding the type
(Bus = NVMe means SSD regardless; otherwise Google the model name). Health
anything but *Healthy* deserves a look.

---

# 16. Deploy SentinelOne agent (silent install)

No script file - the page has a command generator: paste your **site token**
(and adjust the installer filename if your console serves a newer version) and
copy the exact line. The token is used client-side only to build the command;
nothing is saved or sent.

```text
msiexec.exe /i "C:\SentinelInstaller_windows_64bit_v26_1_2_177.msi" SITE_TOKEN="YOUR_SITE_TOKEN" /qn /norestart
```

- `/i "...msi"` installs the agent; `SITE_TOKEN` enrolls the endpoint into your
  SentinelOne site; `/qn` = fully silent; `/norestart` suppresses auto-reboot.
- **Run as admin.** The absolute path assumes the MSI at the root of C: - no
  `cd` needed; edit the path if it lives elsewhere.
- Verify with `sc.exe query SentinelAgent` (sc.exe, not sc - in PowerShell `sc` is an alias for Set-Content) - `STATE : 4 RUNNING` means installed and
  running ("service does not exist" = the install didn't take). The endpoint
  appears in the console within minutes. Broader sweep (any state, catches
  helper services too): `sc.exe query type= service state= all | findstr /i sentinel`
  - no output = nothing SentinelOne installed. One-line full check (PowerShell;
  field-tested): `sc.exe query SentinelAgent; tasklist | findstr /i sentinel; dir "C:\Program Files\SentinelOne"`
  - service + processes + install folder in one paste (in classic cmd, use `&`
  between commands instead of `;`).

---

# Tools / on-demand downloads

Official vendor direct downloads, also surfaced on the landing page
(`index.html`), for a quick second-opinion scan or cleanup pass:

| Tool                                  | Direct download                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Malwarebytes for Windows (Free/Personal) | `https://downloads.malwarebytes.com/file/mb-windows` (-> MBSetup.exe)         |
| ESET Online Scanner                   | `https://download.eset.com/com/eset/tools/online_scanner/latest/esetonlinescanner.exe` |
| Malwarebytes AdwCleaner (portable, no install) | `https://downloads.malwarebytes.com/file/adwcleaner` (logs/quarantine in `C:\AdwCleaner` - delete when done) |

Both links point straight at the vendors' own download servers (verified live).
Run on-demand scanners with administrator rights.
