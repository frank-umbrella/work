#Requires -Version 5.1
<#
.SYNOPSIS
    Set "Password never expires" on a local account (default: admin) so it
    doesn't lock out when the password ages. Windows 10 and 11. Admin required
    (self-elevates).

.DESCRIPTION
    Uses Set-LocalUser -PasswordNeverExpires, the modern replacement for the
    classic one-liner:
        wmic UserAccount where Name='admin' set PasswordExpires=False
    (wmic still works on older builds but is deprecated and removed by default
    in Windows 11 24H2, so this uses the built-in cmdlet instead.)

    Applies to LOCAL accounts only - not domain or Microsoft Entra (Azure AD)
    accounts, whose password policy is managed centrally.

.PARAMETER User
    Local account name to change. Default 'admin'.

.PARAMETER Revert
    Turn password expiry back ON (PasswordNeverExpires = false).

.PARAMETER NoElevate
    Do not auto-elevate.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-AdminPasswordExpiry.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-AdminPasswordExpiry.ps1 -User localadmin
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Disable-AdminPasswordExpiry.ps1 -Revert
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$User = 'admin',
    [switch]$Revert,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Invoke-Elevate {
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
           '-User', ('"{0}"' -f $User))
    if ($Revert) { $a += '-Revert' }
    Write-Host "Elevating (changing a local account needs administrator)..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
}

# --- main --------------------------------------------------------------------
if (-not (Test-Admin) -and -not $NoElevate) { Invoke-Elevate; return }

$acct = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
if (-not $acct) {
    Write-Warning "No local account named '$User' was found. Local accounts on this PC:"
    Get-LocalUser | Select-Object Name, Enabled, PasswordExpires | Format-Table -AutoSize
    Write-Host "Re-run with -User <name> to target one of these."
    return
}

$never = -not $Revert
if ($PSCmdlet.ShouldProcess("local account '$User'", "set PasswordNeverExpires = $never")) {
    Set-LocalUser -Name $User -PasswordNeverExpires:$never
    $after = Get-LocalUser -Name $User
    $state = if ($after.PasswordExpires) { "expires $($after.PasswordExpires)" } else { "never expires" }
    Write-Host ("Done. Password for '{0}' now {1}." -f $User, $state) -ForegroundColor Green
    $after | Format-List Name, Enabled, PasswordExpires, PasswordLastSet
}
