"""
probes/admins.py -- members of the local Administrators group.

Adds visibility into who has admin access on each host so the dashboard
can flag classic security-hygiene problems:
  - too many local admins (privilege creep)
  - the built-in Administrator account left enabled
  - well-known principals like 'Everyone' / 'Authenticated Users' /
    'Domain Users' present in admins (catastrophic - effectively no
    auth on this host)
  - stale local accounts holding admin rights
  - service-account naming patterns (svc_*, *_svc) so the operator
    can audit which automation has admin

Implementation: PowerShell subprocess (same pattern network.py uses
for Get-NetIPConfiguration). Two paths inside the same PS invocation:

  1. Get-LocalGroupMember (Win10 / Server 2016+) -- modern, returns
     PrincipalSource + ObjectClass natively.
  2. ADSI [ADSI]"WinNT://./Administrators,group" -- universal fallback
     for Server 2012 R2 and any older host where the modern cmdlet
     isn't available. Returns Name, Class (User/Group), AdsPath
     (WinNT://DOMAIN/name => we derive Local vs ActiveDirectory from
     the path's middle segment).

The probe NEVER reads passwords, password hashes, or any other
credential material. It enumerates names, types, and source domains
only.
"""

import json
import subprocess


ADMIN_PROBE_TIMEOUT_SEC = 20


# PowerShell that emits a single JSON object with the admin-group
# member list + the built-in Administrator account's enabled state.
# Suppress every non-stdout stream so the JSON output is clean -- same
# defensive pattern wsb.py uses.
#
# Tries Get-LocalGroupMember first; on CommandNotFoundException (i.e.
# Server 2012 R2 or older Windows) falls through to an ADSI WinNT://
# enumeration, which has worked since NT 4 and returns the same shape
# we need. PrincipalSource is synthesized from the AdsPath -- the
# middle segment of "WinNT://<domain-or-machine>/<name>" tells us
# Local vs ActiveDirectory.
#
# COMPUTER_NAME comparison is case-insensitive (Windows treats hostnames
# that way) and avoids treating "BUILTIN" as ActiveDirectory.
_PS_SNIPPET = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $members = @()
    $usedFallback = $false

    try {
        # ---- Primary: Get-LocalGroupMember (Win10 / Server 2016+) ----
        $raw = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
        foreach ($m in $raw) {
            $type = if ($m.ObjectClass -eq 'User') { 'user' }
                    elseif ($m.ObjectClass -eq 'Group') { 'group' }
                    else { 'unknown' }
            $source = if ($m.PrincipalSource) { "$($m.PrincipalSource)" } else { 'Unknown' }
            $sid = $null
            try { if ($m.SID) { $sid = "$($m.SID.Value)" } } catch { $sid = $null }
            $members += [PSCustomObject]@{
                name            = "$($m.Name)"
                type            = $type
                principalSource = $source
                sid             = $sid
            }
        }
    } catch [System.Management.Automation.CommandNotFoundException] {
        # ---- Fallback: ADSI WinNT (universal, including Server 2012 R2) ----
        # Get-LocalGroupMember doesn't exist on this OS. The WinNT ADSI
        # provider has been there since NT 4.0; works the same on every
        # Windows release.
        $usedFallback = $true
        $localComputer = $env:COMPUTERNAME
        $group = [ADSI]"WinNT://./Administrators,group"
        $rawMembers = @($group.psbase.Invoke('Members'))
        foreach ($m in $rawMembers) {
            $name = [string]$m.GetType().InvokeMember('Name', 'GetProperty', $null, $m, $null)
            $class = [string]$m.GetType().InvokeMember('Class', 'GetProperty', $null, $m, $null)
            $adsPath = [string]$m.GetType().InvokeMember('AdsPath', 'GetProperty', $null, $m, $null)
            $sidBytes = $null
            try { $sidBytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null) } catch {}
            $sidStr = $null
            try {
                if ($sidBytes) {
                    $sidObj = New-Object System.Security.Principal.SecurityIdentifier($sidBytes, 0)
                    $sidStr = $sidObj.Value
                }
            } catch { $sidStr = $null }

            # PrincipalSource derivation from AdsPath shape
            # "WinNT://<COMPUTER-OR-DOMAIN>/<name>" -- the middle segment
            # vs $env:COMPUTERNAME tells us local vs AD. Server 2012 R2
            # workgroup machines see "WinNT://./Name" or
            # "WinNT://COMPUTERNAME/Name" -- both are local.
            $principalSource = 'Local'
            if ($adsPath -match '^WinNT://([^/]+)/[^/]+$') {
                $segment = $Matches[1]
                if ($segment -and $segment -ne '.' -and $segment -ne $localComputer) {
                    $principalSource = 'ActiveDirectory'
                }
            }

            $type = if ($class -eq 'User') { 'user' }
                    elseif ($class -eq 'Group') { 'group' }
                    else { 'unknown' }
            $members += [PSCustomObject]@{
                name            = $name
                type            = $type
                principalSource = $principalSource
                sid             = $sidStr
            }
        }
    }

    # Built-in Administrator account state. Well-known SID ends with -500.
    # Get-LocalUser is also Win10/2016+; ADSI fallback for Server 2012 R2.
    $builtinAdminEnabled = $null
    try {
        $builtin = Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -match '-500$' }
        if ($builtin) { $builtinAdminEnabled = [bool]$builtin.Enabled }
    } catch [System.Management.Automation.CommandNotFoundException] {
        # ADSI fallback: walk WinNT://./<computername> for User accounts,
        # find the one whose SID ends in -500, read its UserFlags. Bit
        # 0x0002 (ADS_UF_ACCOUNTDISABLE) means disabled.
        try {
            $computer = [ADSI]"WinNT://."
            foreach ($child in $computer.psbase.Children) {
                if ($child.SchemaClassName -ne 'User') { continue }
                $childSidBytes = $null
                try { $childSidBytes = $child.GetType().InvokeMember('objectSid', 'GetProperty', $null, $child, $null) } catch {}
                if (-not $childSidBytes) { continue }
                $childSid = New-Object System.Security.Principal.SecurityIdentifier($childSidBytes, 0)
                if ($childSid.Value -match '-500$') {
                    $flags = [int]($child.GetType().InvokeMember('UserFlags', 'GetProperty', $null, $child, $null))
                    $builtinAdminEnabled = (($flags -band 0x0002) -eq 0)
                    break
                }
            }
        } catch {
            $builtinAdminEnabled = $null
        }
    } catch {
        $builtinAdminEnabled = $null
    }

    $out = [PSCustomObject]@{
        ok                          = $true
        members                     = $members
        memberCount                 = $members.Count
        builtinAdministratorEnabled = $builtinAdminEnabled
        usedAdsiFallback            = $usedFallback
    }
    $out | ConvertTo-Json -Depth 4 -Compress
} catch {
    $err = [PSCustomObject]@{ ok = $false; error = "$($_.Exception.Message)" }
    $err | ConvertTo-Json -Compress
}
"""


def collect():
    try:
        proc = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", _PS_SNIPPET,
            ],
            capture_output=True,
            text=True,
            timeout=ADMIN_PROBE_TIMEOUT_SEC,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except subprocess.TimeoutExpired:
        return {"_error": f"admins probe timed out after {ADMIN_PROBE_TIMEOUT_SEC}s"}
    except Exception as e:
        return {"_error": f"admins probe failed to launch: {e}"}

    raw = (proc.stdout or "").strip()
    if not raw:
        err_tail = (proc.stderr or "").strip()[-300:]
        return {"_error": f"admins probe produced no stdout (rc={proc.returncode}; stderr={err_tail!r})"}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return {"_error": f"admins JSON parse failed: {e}; first 200 chars: {raw[:200]!r}"}

    if isinstance(parsed, dict) and parsed.get("ok") is False:
        return {"_error": f"PowerShell reported error: {parsed.get('error')}"}

    if not isinstance(parsed, dict):
        return {"_error": "admins probe returned unexpected JSON shape"}

    # Coerce shape just in case PowerShell returned a single member (which
    # ConvertTo-Json would render as an object, not an array).
    members = parsed.get("members")
    if isinstance(members, dict):
        members = [members]
    elif not isinstance(members, list):
        members = []

    return {
        "members": members,
        "memberCount": len(members),
        "builtinAdministratorEnabled": parsed.get("builtinAdministratorEnabled"),
        # True when the probe fell back to the ADSI path (Server 2012 R2
        # / older Windows without Get-LocalGroupMember). Surfaced so the
        # dashboard can show a small "via ADSI fallback" hint -- useful
        # for the operator deciding whether to push these hosts to a
        # newer Windows release.
        "usedAdsiFallback": bool(parsed.get("usedAdsiFallback")),
    }
