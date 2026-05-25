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

Implementation: uses `net localgroup Administrators` as the primary
path (universally available since NT 4, sub-second response on
every Windows release). Optional PowerShell enrichment via
Get-LocalGroupMember (Win10/Server 2016+) adds PrincipalSource +
SID -- best-effort; if it fails or isn't available we still report
the names from `net localgroup`.

Earlier versions of this probe relied on PowerShell exclusively
(Get-LocalGroupMember with an ADSI fallback). That worked on most
hosts but stalled on Server 2012 R2 boxes -- both code paths can
hang for 10+ seconds on hosts with stale AD references or slow
PSReadLine startup, blowing through the 20-second probe budget.
`net localgroup` is bulletproof: pure Win32 SAM enumeration, no
PowerShell, no .NET CLR, no module loading.

The probe NEVER reads passwords, password hashes, or any other
credential material. It enumerates names, types, and source domains
only.
"""

import json
import os
import subprocess
import winreg

try:
    import logger as _logger
except ImportError:
    class _Stub:
        def log(self, *a, **kw): pass
    _logger = _Stub()


# Probe timeout. Generous because `net localgroup` is fast but the
# optional PS enrichment can be slow on busy hosts; we want neither
# path to ever hit the per-probe timeout in collector.py (60s).
ADMIN_PROBE_TIMEOUT_SEC = 50

# Per-stage timeouts (independent of the overall budget above).
NET_TIMEOUT_SEC = 10        # `net localgroup` -- typically 50-300 ms
PS_ENRICH_TIMEOUT_SEC = 25  # Get-LocalGroupMember enrichment -- best effort


# PowerShell enrichment snippet. Returns SID + PrincipalSource for
# each member when Get-LocalGroupMember is available; silently empty
# otherwise. Faster than the previous full enumeration because we're
# just augmenting names we already have.
_PS_ENRICH_SNIPPET = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $members = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
    $out = @()
    foreach ($m in $members) {
        $sid = $null
        try { if ($m.SID) { $sid = "$($m.SID.Value)" } } catch {}
        $out += [PSCustomObject]@{
            name            = "$($m.Name)"
            sid             = $sid
            principalSource = if ($m.PrincipalSource) { "$($m.PrincipalSource)" } else { 'Unknown' }
        }
    }
    @{ ok = $true; members = @($out) } | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ ok = $false } | ConvertTo-Json -Compress
}
"""


def _run_net_localgroup():
    """
    Walk `net localgroup Administrators` output. Output shape:

      Alias name     administrators
      Comment        Administrators have complete and unrestricted access...

      Members
      -------------------------------------------------------------------------------
      Administrator
      DOMAIN\Domain Admins
      WORKGROUP\someuser
      The command completed successfully.

    Returns a list of {name, type, principalSource} where:
      - principalSource is 'ActiveDirectory' when the name contains '\'
        and the prefix isn't the local computer name / BUILTIN / NT AUTHORITY
      - principalSource is 'Local' otherwise
      - type is best-effort: 'Group' for well-known group SIDs (Domain Admins,
        Everyone, Authenticated Users), 'User' for everything else
    """
    try:
        # /domain: forces SAM-only enumeration; on workgroup hosts net
        # would otherwise sometimes try the domain controller and stall.
        # Actually -- /domain WOULD force domain lookups. We want LOCAL
        # only, which is what `net localgroup Administrators` without
        # any switch does. Just being explicit in the comment.
        r = subprocess.run(
            ["net.exe", "localgroup", "Administrators"],
            capture_output=True,
            text=True,
            timeout=NET_TIMEOUT_SEC,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except subprocess.TimeoutExpired:
        _logger.log(f"  admins._run_net_localgroup: timed out after {NET_TIMEOUT_SEC}s")
        return None
    except OSError as e:
        _logger.log(f"  admins._run_net_localgroup: launch failed: {e}")
        return None

    if r.returncode != 0:
        _logger.log(f"  admins._run_net_localgroup: rc={r.returncode} stderr={r.stderr.strip()[:200]!r}")
        return None

    lines = (r.stdout or "").splitlines()
    members = []
    in_members = False
    local_computer = os.environ.get("COMPUTERNAME", "").upper()
    known_group_names = (
        "Domain Admins", "Domain Users", "Everyone", "Authenticated Users",
        "Users", "Power Users", "Backup Operators",
    )
    for line in lines:
        s = line.strip()
        if not s:
            continue
        # Detect the start of the member list (the dashed separator line).
        if not in_members:
            if s.startswith("---"):
                in_members = True
            continue
        # End-of-output marker.
        if s.startswith("The command completed"):
            break
        # Member name.
        name = s
        if "\\" in name:
            prefix, bare = name.split("\\", 1)
            prefix_u = prefix.upper()
            if prefix_u in ("BUILTIN", "NT AUTHORITY", "NT SERVICE"):
                principal_source = "Local"
            elif prefix_u == local_computer:
                principal_source = "Local"
            else:
                principal_source = "ActiveDirectory"
            mtype = "group" if any(bare.lower() == g.lower() for g in known_group_names) else "user"
        else:
            principal_source = "Local"
            mtype = "group" if any(name.lower() == g.lower() for g in known_group_names) else "user"
        members.append({
            "name": name,
            "type": mtype,
            "principalSource": principal_source,
            "sid": None,  # net localgroup doesn't emit SIDs; PS enrichment fills these in when available
        })
    _logger.log(f"  admins._run_net_localgroup: parsed {len(members)} members from `net localgroup`")
    return members


def _enrich_with_powershell(base_members):
    """
    Optional best-effort enrichment via Get-LocalGroupMember. Adds
    SID + a more reliable PrincipalSource. If PS is missing the
    cmdlet (Server 2012 R2 / older), returns the base list unchanged.
    Matches PS members to base members by case-insensitive name
    comparison.
    """
    try:
        proc = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", _PS_ENRICH_SNIPPET,
            ],
            capture_output=True,
            text=True,
            timeout=PS_ENRICH_TIMEOUT_SEC,
            creationflags=0x08000000,
        )
    except subprocess.TimeoutExpired:
        _logger.log(f"  admins._enrich_with_powershell: PS timed out after {PS_ENRICH_TIMEOUT_SEC}s (using base list as-is)")
        return base_members
    except OSError as e:
        _logger.log(f"  admins._enrich_with_powershell: PS launch failed: {e}")
        return base_members

    raw = (proc.stdout or "").strip()
    if not raw:
        _logger.log("  admins._enrich_with_powershell: empty PS output (using base list as-is)")
        return base_members
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        _logger.log("  admins._enrich_with_powershell: PS JSON parse failed (using base list as-is)")
        return base_members
    if not parsed.get("ok"):
        _logger.log("  admins._enrich_with_powershell: PS reported not-ok (Get-LocalGroupMember unavailable -- using base list as-is)")
        return base_members

    ps_members = parsed.get("members") or []
    if not isinstance(ps_members, list):
        return base_members

    # Build a lookup keyed by case-insensitive bare name AND by full
    # DOMAIN\name string -- net localgroup uses the full form, PS
    # uses either depending on the source.
    ps_by_key = {}
    for pm in ps_members:
        name = (pm or {}).get("name") or ""
        if not name:
            continue
        ps_by_key[name.lower()] = pm
        if "\\" in name:
            bare = name.split("\\", 1)[1]
            ps_by_key[bare.lower()] = pm
    enriched = 0
    for bm in base_members:
        key = bm.get("name", "").lower()
        bare_key = key.split("\\", 1)[1] if "\\" in key else key
        pm = ps_by_key.get(key) or ps_by_key.get(bare_key)
        if pm:
            if pm.get("sid"):
                bm["sid"] = pm["sid"]
            if pm.get("principalSource") and pm["principalSource"] != "Unknown":
                bm["principalSource"] = pm["principalSource"]
            enriched += 1
    _logger.log(f"  admins._enrich_with_powershell: enriched {enriched}/{len(base_members)} members from PS")
    return base_members


def _builtin_admin_enabled():
    """
    Best-effort read of whether the built-in Administrator account
    (SID-500) is enabled. Uses `net user Administrator` -- output line:
      Account active               Yes
    or:
      Account active               No
    Returns True / False / None (when we can't parse the output).
    """
    try:
        r = subprocess.run(
            ["net.exe", "user", "Administrator"],
            capture_output=True,
            text=True,
            timeout=NET_TIMEOUT_SEC,
            creationflags=0x08000000,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        _logger.log(f"  admins._builtin_admin_enabled: net user failed: {e}")
        return None
    if r.returncode != 0:
        return None
    for line in (r.stdout or "").splitlines():
        s = line.strip()
        # Match case-insensitively because some locales return "ACCOUNT ACTIVE"
        if s.lower().startswith("account active"):
            tail = s.split(None, 2)[-1].strip().lower()
            if tail.startswith("y"):
                return True
            if tail.startswith("n"):
                return False
            return None
    return None


def collect():
    """
    Returns the members list + metadata + a flag for whether the
    enrichment path succeeded. Never raises -- on any error returns
    a dict with `_error`.
    """
    try:
        _logger.log("admins.collect: starting (net localgroup primary path)")
        base = _run_net_localgroup()
        if base is None:
            return {"_error": "net localgroup Administrators failed -- check agent permissions or SAM state"}

        # Best-effort enrichment. Doesn't fail the probe if PS times out.
        enriched = _enrich_with_powershell(base)

        builtin_enabled = _builtin_admin_enabled()

        # usedAdsiFallback is now misnamed -- we removed the ADSI path
        # entirely. The flag still exists in the dashboard renderer for
        # backward compat; we report False since the new primary path
        # is neither Get-LocalGroupMember NOR ADSI but `net localgroup`.
        return {
            "members": enriched,
            "memberCount": len(enriched),
            "builtinAdministratorEnabled": builtin_enabled,
            "usedAdsiFallback": False,
            "source": "net localgroup",
        }
    except Exception as e:
        return {"_error": f"admins probe crashed: {e}"}
