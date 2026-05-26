@echo off
REM ensure-tray-running.cmd
REM
REM Safety-net watchdog for watchtower-tray.exe. Run by a Task Scheduler
REM entry that fires at user logon AND every hour during the session.
REM Checks whether the tray is in the running task list; if not, starts
REM it. Idempotent -- safe to run as often as you want, no-ops when the
REM tray is already up.
REM
REM This is a backstop for scenarios where the tray dies but the
REM service is still healthy (e.g. installer crash mid-update killed
REM the tray but didn't relaunch it, user accidentally killed the
REM process from Task Manager, transient PIL/pystray initialization
REM failure on logon). Check-ins keep working without the tray --
REM see docs.html "tray vs service" for why -- but the operator
REM loses the on-host status indicator. This script restores it.
REM
REM Designed to run as the INTERACTIVE user (not SYSTEM) so the
REM spawned tray lands in the user's desktop session. The installer
REM registers the scheduled task with /RL LIMITED + /RU "%USERNAME%"
REM so it runs in the correct context.

setlocal

REM Image name check. tasklist returns a non-zero exit code only on
REM tasklist itself failing; the /FI filter approach is more
REM reliable than parsing output for an absent process.
tasklist /FI "IMAGENAME eq watchtower-tray.exe" 2>NUL | find /I "watchtower-tray.exe" >NUL
if %ERRORLEVEL%==0 (
  REM Already running -- nothing to do.
  exit /b 0
)

REM Not running. Launch it. Use START so the .cmd returns immediately
REM (the tray runs as a long-lived process; we don't want the
REM scheduled-task action to stay "running" for the lifetime of the
REM tray).
REM
REM %~dp0 is the directory containing this script -- assumed to be the
REM Watchtower install dir's scripts\ subfolder, so the EXE is one
REM level up. Adjust if you ever move scripts.
start "" "%~dp0..\watchtower-tray.exe"
exit /b 0
