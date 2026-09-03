<#
================================================================================
 RECENT FILE ACTIVITY SCANNER
================================================================================

PURPOSE:
    Searches a folder and all of its subfolders for the most recently
    modified or accessed files.

    Results are:
      1. Displayed clearly on screen
      2. Saved to a timestamped log file in the root of C:\

EXAMPLE LOG:
    C:\RecentFileActivity_20260903_091500.log


HOW TO RUN:
-------------------------------------------------------------------------------

OPTION 1 - From PowerShell:

    1. Save this script as:
           RecentFileActivity.ps1

    2. Open Windows PowerShell as Administrator.

    3. Navigate to the folder containing the script, or run it directly:

           & "C:\Path\RecentFileActivity.ps1"


OPTION 2 - If Windows blocks PowerShell scripts:

    Open PowerShell as Administrator and run:

           Set-ExecutionPolicy -Scope Process Bypass

    Then run the script:

           & "C:\Path\RecentFileActivity.ps1"

    The Process setting only applies to the current PowerShell window and
    does NOT permanently change the server's execution policy.


USAGE:
-------------------------------------------------------------------------------

    The script will ask which folder you want to scan.

    Examples:

        D:\Shares
        D:\Shares\Accounting
        C:\Users
        E:\Data

    Press ENTER without typing anything to use the default:

        D:\Shares

    You will then be asked whether you want files sorted by:

        1 - Last Modified Time
        2 - Last Access Time

    Modified Time is generally more reliable.

IMPORTANT:
-------------------------------------------------------------------------------

    Windows may disable or delay updates to LastAccessTime for performance
    reasons. Therefore, LastAccessTime should NOT always be treated as proof
    that a file has or has not recently been opened.

================================================================================
#>


Clear-Host

# ============================================================================
# SETTINGS
# ============================================================================

$DefaultFolder = "D:\Shares"

# Create a unique log file for every scan.
$TimeStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFile = "C:\RecentFileActivity_$TimeStamp.log"


# ============================================================================
# HEADER
# ============================================================================

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "             RECENT FILE ACTIVITY SCANNER" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "This utility searches a folder AND all of its subfolders." -ForegroundColor White
Write-Host ""

Write-Host "Examples:" -ForegroundColor DarkGray
Write-Host "  D:\Shares" -ForegroundColor DarkGray
Write-Host "  D:\Shares\Accounting" -ForegroundColor DarkGray
Write-Host "  C:\Users" -ForegroundColor DarkGray
Write-Host "  E:\Data" -ForegroundColor DarkGray
Write-Host ""


# ============================================================================
# ASK WHERE TO SEARCH
# ============================================================================

$Folder = Read-Host "Enter the folder to scan [$DefaultFolder]"

# If the user just presses Enter, use D:\Shares.
if ([string]::IsNullOrWhiteSpace($Folder)) {
    $Folder = $DefaultFolder
}

# Remove quotation marks if the user pasted a quoted path.
$Folder = $Folder.Trim('"')


# ============================================================================
# VERIFY FOLDER EXISTS
# ============================================================================

if (-not (Test-Path $Folder -PathType Container)) {

    Write-Host ""
    Write-Host "=========================================================" -ForegroundColor Red
    Write-Host " ERROR: FOLDER NOT FOUND" -ForegroundColor Red
    Write-Host "=========================================================" -ForegroundColor Red
    Write-Host ""

    Write-Host "PowerShell could not find:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  $Folder" -ForegroundColor White
    Write-Host ""

    Read-Host "Press Enter to exit"
    exit
}


# ============================================================================
# ASK WHAT ACTIVITY TO SEARCH
# ============================================================================

Write-Host ""
Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
Write-Host "What would you like to find?"
Write-Host "---------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""

Write-Host "  1 - Most recently MODIFIED files" -ForegroundColor White
Write-Host "  2 - Most recently ACCESSED files" -ForegroundColor White
Write-Host ""

Write-Host "Modified is usually the best choice for troubleshooting." `
    -ForegroundColor DarkYellow

Write-Host ""

$Choice = Read-Host "Choose 1 or 2 [1]"

if ([string]::IsNullOrWhiteSpace($Choice)) {
    $Choice = "1"
}

if ($Choice -eq "2") {

    $SortProperty = "LastAccessTime"
    $SearchDescription = "MOST RECENTLY ACCESSED FILES"

}
else {

    $SortProperty = "LastWriteTime"
    $SearchDescription = "MOST RECENTLY MODIFIED FILES"

}


# ============================================================================
# ASK HOW MANY RESULTS TO RETURN
# ============================================================================

Write-Host ""

$ResultCount = Read-Host "How many results would you like to see? [20]"

if ([string]::IsNullOrWhiteSpace($ResultCount) -or
    $ResultCount -notmatch '^\d+$') {

    $ResultCount = 20
}

$ResultCount = [int]$ResultCount

if ($ResultCount -lt 1) {
    $ResultCount = 20
}


# ============================================================================
# CONFIRM SEARCH
# ============================================================================

Clear-Host

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "                  SCAN STARTING" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Folder:" -ForegroundColor Gray
Write-Host "  $Folder" -ForegroundColor White
Write-Host ""

Write-Host "Search:" -ForegroundColor Gray
Write-Host "  $SearchDescription" -ForegroundColor White
Write-Host ""

Write-Host "Results requested:" -ForegroundColor Gray
Write-Host "  $ResultCount" -ForegroundColor White
Write-Host ""

Write-Host "Scanning the folder and ALL subfolders..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Please wait. Large file shares may take several minutes." `
    -ForegroundColor Yellow
Write-Host ""
Write-Host "PowerShell may appear idle while it examines the files." `
    -ForegroundColor DarkGray
Write-Host ""


# ============================================================================
# PERFORM SCAN
# ============================================================================

$StartTime = Get-Date

$Errors = @()

$Results = @(

    Get-ChildItem $Folder `
        -File `
        -Recurse `
        -ErrorAction SilentlyContinue `
        -ErrorVariable +Errors |

    Sort-Object $SortProperty -Descending |

    Select-Object -First $ResultCount `
        FullName,
        LastWriteTime,
        LastAccessTime

)

$EndTime = Get-Date
$Elapsed = $EndTime - $StartTime


# ============================================================================
# CREATE REPORT
# ============================================================================

$Report = @()

$Report += "============================================================"
$Report += "RECENT FILE ACTIVITY REPORT"
$Report += "============================================================"
$Report += ""

$Report += "Computer:      $env:COMPUTERNAME"
$Report += "Scan Folder:   $Folder"
$Report += "Search Type:   $SearchDescription"
$Report += "Scan Date:     $(Get-Date -Format 'MM/dd/yyyy hh:mm:ss tt')"
$Report += "Scan Duration: $([math]::Round($Elapsed.TotalSeconds,1)) seconds"
$Report += "Results:       $($Results.Count)"
$Report += ""

if ($Errors.Count -gt 0) {

    $Report += "************************************************************"
    $Report += "WARNING"
    $Report += "************************************************************"
    $Report += ""
    $Report += "$($Errors.Count) file or folder item(s) could not be read."
    $Report += ""
    $Report += "Some locations may have been skipped because of permissions"
    $Report += "or another filesystem error."
    $Report += ""
}

$Report += "============================================================"
$Report += "RESULTS"
$Report += "============================================================"
$Report += ""


# ============================================================================
# ADD EACH FILE TO REPORT
# ============================================================================

if ($Results.Count -gt 0) {

    $Number = 1

    foreach ($File in $Results) {

        $Report += "[$Number]"

        $Report += "File:"
        $Report += "  $($File.FullName)"

        $Report += ""

        $Report += "Modified:"
        $Report += "  $($File.LastWriteTime.ToString('MM/dd/yyyy hh:mm:ss tt'))"

        $Report += ""

        $Report += "Accessed:"
        $Report += "  $($File.LastAccessTime.ToString('MM/dd/yyyy hh:mm:ss tt'))"

        $Report += ""
        $Report += "------------------------------------------------------------"
        $Report += ""

        $Number++
    }

}
else {

    $Report += "No files were found."
    $Report += ""

}


# ============================================================================
# ADD IMPORTANT LAST-ACCESS WARNING
# ============================================================================

$Report += "============================================================"
$Report += "IMPORTANT NOTE"
$Report += "============================================================"
$Report += ""

$Report += "LastAccessTime may NOT reliably indicate the last time a file"
$Report += "was opened."

$Report += ""

$Report += "Windows Server may disable or delay LastAccessTime updates for"
$Report += "performance reasons."

$Report += ""

$Report += "LastWriteTime (Modified) is generally more reliable when"
$Report += "determining when files were last changed."

$Report += ""


# ============================================================================
# SAVE REPORT
# ============================================================================

try {

    $Report | Out-File $LogFile -Encoding UTF8 -ErrorAction Stop

    $LogSaved = $true

}
catch {

    $LogSaved = $false

}


# ============================================================================
# DISPLAY REPORT ON SCREEN
# ============================================================================

Clear-Host

$Report | ForEach-Object {
    Write-Host $_
}


# ============================================================================
# FINAL STATUS
# ============================================================================

Write-Host ""

if ($LogSaved) {

    Write-Host "=========================================================" `
        -ForegroundColor Green

    Write-Host " REPORT SAVED SUCCESSFULLY" `
        -ForegroundColor Green

    Write-Host "=========================================================" `
        -ForegroundColor Green

    Write-Host ""

    Write-Host "Log file:" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  $LogFile" -ForegroundColor Green

}
else {

    Write-Host "=========================================================" `
        -ForegroundColor Red

    Write-Host " WARNING: LOG COULD NOT BE SAVED" `
        -ForegroundColor Red

    Write-Host "=========================================================" `
        -ForegroundColor Red

    Write-Host ""

    Write-Host "The results were displayed, but PowerShell could not write:" `
        -ForegroundColor Yellow

    Write-Host ""
    Write-Host "  $LogFile" -ForegroundColor White

    Write-Host ""
    Write-Host "Try running PowerShell as Administrator." `
        -ForegroundColor Yellow

}

Write-Host ""
Read-Host "Press Enter to exit"
