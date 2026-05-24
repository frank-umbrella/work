@echo off
REM ------------------------------------------------------------------
REM Watchtower diagnostic launcher.
REM
REM Double-click this file (or right-click -> Run as administrator)
REM to generate a single diagnostic report at
REM   C:\ProgramData\Watchtower\diagnostic-YYYY-MM-DD_HH-MM-SS.txt
REM and open it in Notepad. Attach the file when contacting support.
REM
REM This wrapper self-elevates to admin via PowerShell Start-Process
REM -Verb RunAs so the diagnostic script can read protected event log
REM entries + reach Get-WBSummary etc. (which require admin on some
REM Windows editions).
REM ------------------------------------------------------------------

set "PS_SCRIPT=%~dp0diagnostic.ps1"

REM Check if we're already elevated. If not, relaunch this batch via
REM PowerShell with -Verb RunAs.
fltmc >nul 2>&1
if errorlevel 1 (
    echo Requesting admin elevation...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

REM Already elevated. Run the actual diagnostic.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo Diagnostic complete. Notepad should have opened with the report.
echo Press any key to close this window.
pause >nul
