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
for Get-NetIPConfiguration). Get-LocalGroupMember is the modern API
(Win10 / Server 2016+) and returns each member's PrincipalSource
(Local / ActiveDirectory / AzureAD / MicrosoftAccount) plus its
ObjectClass (User / Group) so the dashboard can render type chips
without re-querying.

Older Windows (Server 2012 R2 and earlier) doesn't have
Get-LocalGroupMember -- the probe returns _error and the dashboard
shows 'Probe error, OS too old' rather than guessing.

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
_PS_SNIPPET = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $members = @()
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

    # Built-in Administrator account state. Well-known SID ends with -500.
    # Get-LocalUser is also Win10/2016+. Swallow failures because some
    # workstations have Get-LocalUser disabled by policy.
    $builtinAdminEnabled = $null
    try {
        $builtin = Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -match '-500$' }
        if ($builtin) { $builtinAdminEnabled = [bool]$builtin.Enabled }
    } catch {
        $builtinAdminEnabled = $null
    }

    $out = [PSCustomObject]@{
        ok                          = $true
        members                     = $members
        memberCount                 = $members.Count
        builtinAdministratorEnabled = $builtinAdminEnabled
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
    }
