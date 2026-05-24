"""
probes/network.py -- external IP + NIC list with addresses.

External IP: queried from api.ipify.org (text response, ~5KB of overhead,
deliberately simple; no API key). Fallback to icanhazip.com if ipify is
unreachable so a single provider outage doesn't blind the agent.

NICs (v0.14.25 rewrite): we now try Get-NetIPConfiguration via a
PowerShell subprocess as the PRIMARY source, falling back to the WMI
path only if PowerShell fails or comes up empty. Background:

  v0.14.8 switched the WMI join key from GUID/SettingID to
  InterfaceIndex which fixed Celtic-HyperV. But fresh Hyper-V hosts
  (CCD-HYPERV most recently) and some Hyper-V guests (CPSERVER) keep
  showing up with no internal IP. The common factor is virtualization:
  WMI's Win32_NetworkAdapterConfiguration.IPEnabled occasionally
  returns False on vEthernet / synthetic NICs that DO have IPs bound,
  and our filter dropped them silently.

  Get-NetIPConfiguration is the modern API (Windows 8 / 2012 R2+) and
  enumerates every interface with an IP regardless of binding state.
  It also returns gateway + DNS + IPv4 + IPv6 in one structured shape
  -- no two-class WMI join to keep in sync. We emit the same shape
  the worker expects so pickPrimaryInternalIp() doesn't need to know
  the difference.

We always populate `_source` so the diagnostic / drawer can show
whether the data came from "powershell" or "wmi" -- helpful when
something looks wrong. If BOTH paths fail we emit an empty `nics`
list plus `_diagnostics` explaining what was tried; the worker's
NIC-less rendering already handles this gracefully.
"""

import json
import subprocess

import requests


EXTERNAL_IP_PROBES = [
    ("https://api.ipify.org", 5),
    ("https://icanhazip.com", 5),
    ("https://ifconfig.me/ip", 5),
]

NIC_PROBE_TIMEOUT_SEC = 25


# PowerShell snippet that emits one JSON object per IP-bound interface.
# Join Get-NetIPConfiguration (the primary view) with Get-NetAdapter for
# speed + MAC. NetConnectionID maps to .Name on the adapter; PhysicalAddress
# maps to .MacAddress with hyphens. Suppress all non-stdout streams so
# stdout is pure JSON -- same pattern wsb.py uses.
_PS_SNIPPET = r"""
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
    $cfgs = @(Get-NetIPConfiguration -All -ErrorAction SilentlyContinue)
    $adapters = @{}
    foreach ($a in (Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue)) {
        $adapters[[int]$a.ifIndex] = $a
    }
    $nics = @()
    foreach ($c in $cfgs) {
        $ifIdx = [int]$c.InterfaceIndex
        $a = $adapters[$ifIdx]
        $ipv4 = @()
        foreach ($x in @($c.IPv4Address)) { if ($x -and $x.IPAddress) { $ipv4 += $x.IPAddress } }
        $ipv6 = @()
        foreach ($x in @($c.IPv6Address)) { if ($x -and $x.IPAddress) { $ipv6 += $x.IPAddress } }
        $gws = @()
        foreach ($g in @($c.IPv4DefaultGateway)) { if ($g -and $g.NextHop) { $gws += $g.NextHop } }
        $dns = @()
        foreach ($d in @($c.DNSServer)) {
            if ($d -and $d.ServerAddresses) {
                foreach ($s in $d.ServerAddresses) { if ($s) { $dns += $s } }
            }
        }
        $speedMbps = $null
        if ($a -and $a.LinkSpeed) {
            # LinkSpeed is bps as a uint64; convert to Mbps.
            try { $speedMbps = [int]([uint64]$a.LinkSpeed / 1000000) } catch { $speedMbps = $null }
        }
        $nics += [PSCustomObject]@{
            description  = if ($a) { "$($a.InterfaceDescription)" } else { "$($c.InterfaceDescription)" }
            name         = if ($a -and $a.Name) { "$($a.Name)" } elseif ($c.InterfaceAlias) { "$($c.InterfaceAlias)" } else { "$($c.InterfaceDescription)" }
            mac          = if ($a -and $a.MacAddress) { ($a.MacAddress -replace '-', ':') } else { $null }
            speedMbps    = $speedMbps
            ipv4         = $ipv4
            ipv6         = $ipv6
            gateways     = $gws
            dnsServers   = $dns
            dhcpEnabled  = $null  # Get-NetIPConfiguration doesn't surface this cleanly; rely on WMI if needed
            dhcpServer   = $null
            interfaceIndex = $ifIdx
            ifOperStatus = if ($a) { "$($a.Status)" } else { $null }
        }
    }
    $out = [PSCustomObject]@{ ok = $true; nics = $nics }
    $out | ConvertTo-Json -Depth 6 -Compress
} catch {
    $err = [PSCustomObject]@{ ok = $false; error = "$($_.Exception.Message)" }
    $err | ConvertTo-Json -Compress
}
"""


def _external_ip():
    for url, timeout in EXTERNAL_IP_PROBES:
        try:
            r = requests.get(url, timeout=timeout)
            if r.ok:
                ip = r.text.strip()
                if ip and len(ip) <= 45:
                    return ip
        except requests.RequestException:
            continue
    return None


def _collect_via_powershell():
    """
    Run Get-NetIPConfiguration in a subprocess and parse the JSON it emits.
    Returns (nics_list, error_str). On success error_str is None.
    Returns ([], "...") on any failure path so the caller can decide to
    fall back to WMI.
    """
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
            timeout=NIC_PROBE_TIMEOUT_SEC,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except subprocess.TimeoutExpired:
        return [], "Get-NetIPConfiguration subprocess timed out"
    except Exception as e:
        return [], f"Get-NetIPConfiguration subprocess failed to launch: {e}"

    raw = (proc.stdout or "").strip()
    if not raw:
        # Stderr may contain a clue but we don't want to ship megabytes of
        # PS warnings -- truncate to something human-sized.
        err_tail = (proc.stderr or "").strip()[-300:]
        return [], f"Get-NetIPConfiguration produced no stdout (rc={proc.returncode}; stderr={err_tail!r})"

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return [], f"Get-NetIPConfiguration JSON parse failed: {e}; first 200 chars: {raw[:200]!r}"

    if isinstance(parsed, dict) and parsed.get("ok") is False:
        return [], f"Get-NetIPConfiguration reported error: {parsed.get('error')}"

    if isinstance(parsed, dict) and "nics" in parsed:
        nics = parsed.get("nics") or []
    else:
        return [], "Get-NetIPConfiguration returned unexpected JSON shape"

    # Filter to NICs that actually have at least one IPv4 OR IPv6 address.
    # Operationally-down interfaces with empty IP lists are noise.
    return [n for n in nics if (n.get("ipv4") or n.get("ipv6"))], None


def _collect_via_wmi():
    """
    Legacy WMI path. Used as fallback when PowerShell didn't work or
    produced an empty NIC list.

    v0.14.25 change: we ALSO emit cfgs that aren't IPEnabled but DO have
    a non-empty IPAddress list. Some Hyper-V virtual interfaces report
    IPEnabled=False while still owning bound IPs -- the IPEnabled filter
    was the silent reason these hosts came up with "-" for internal IP.
    """
    try:
        import wmi
        c = wmi.WMI()
    except Exception as e:
        return [], f"WMI bootstrap failed: {e}"

    nics = []
    adapters_by_idx = {}
    try:
        for adapter in c.Win32_NetworkAdapter():
            try:
                idx = adapter.InterfaceIndex
            except AttributeError:
                idx = None
            if idx is not None:
                adapters_by_idx[int(idx)] = adapter

        for cfg in c.Win32_NetworkAdapterConfiguration():
            ip_list = list(cfg.IPAddress or [])
            # Take ANY cfg with an IP, regardless of IPEnabled flag.
            # Falls back to the IPEnabled flag only when there are no IPs.
            if not ip_list and not cfg.IPEnabled:
                continue

            adapter = None
            try:
                if cfg.InterfaceIndex is not None:
                    adapter = adapters_by_idx.get(int(cfg.InterfaceIndex))
            except (AttributeError, TypeError, ValueError):
                adapter = None

            ipv4, ipv6 = [], []
            for ip in ip_list:
                (ipv6 if ":" in ip else ipv4).append(ip)

            description = (adapter.Description if adapter else None) or cfg.Description or ""
            connection_id = (adapter.NetConnectionID if adapter else None) or description
            mac = (adapter.MACAddress if adapter else None) or cfg.MACAddress

            speed_mbps = None
            if adapter:
                try:
                    if adapter.Speed and str(adapter.Speed).isdigit():
                        speed_mbps = int(int(adapter.Speed) / 1_000_000)
                except (AttributeError, ValueError):
                    pass

            nics.append({
                "description": description,
                "name": connection_id,
                "mac": mac,
                "speedMbps": speed_mbps,
                "ipv4": ipv4,
                "ipv6": ipv6,
                "gateways": list(cfg.DefaultIPGateway or []),
                "dnsServers": list(cfg.DNSServerSearchOrder or []),
                "dhcpEnabled": bool(cfg.DHCPEnabled),
                "dhcpServer": cfg.DHCPServer,
                "interfaceIndex": (int(cfg.InterfaceIndex) if cfg.InterfaceIndex is not None else None),
            })

        return nics, None
    except Exception as e:
        return nics, f"WMI enumeration failed mid-loop: {e}"


def collect():
    out = {"externalIp": _external_ip(), "nics": [], "_source": None, "_diagnostics": {}}

    # Primary: PowerShell Get-NetIPConfiguration. This is the modern API
    # and handles Hyper-V vEthernet + synthetic NICs correctly.
    ps_nics, ps_err = _collect_via_powershell()
    if ps_nics:
        out["nics"] = ps_nics
        out["_source"] = "powershell"
        # Still record the WMI dhcpEnabled / dhcpServer if we can quickly
        # enrich -- the PS path leaves these null. Best-effort; ignore on
        # any failure so we don't take the IP data down with us.
        try:
            wmi_nics, _ = _collect_via_wmi()
            by_idx = {n.get("interfaceIndex"): n for n in wmi_nics if n.get("interfaceIndex") is not None}
            for n in out["nics"]:
                w = by_idx.get(n.get("interfaceIndex"))
                if w:
                    if n.get("dhcpEnabled") is None:
                        n["dhcpEnabled"] = w.get("dhcpEnabled")
                    if not n.get("dhcpServer"):
                        n["dhcpServer"] = w.get("dhcpServer")
        except Exception:
            pass
        if ps_err:
            out["_diagnostics"]["powershell_warning"] = ps_err
        return out

    # Fallback: WMI. Either PowerShell errored OR it returned zero NICs
    # with IPs (rare but possible on a totally idle box).
    if ps_err:
        out["_diagnostics"]["powershell_error"] = ps_err

    wmi_nics, wmi_err = _collect_via_wmi()
    out["nics"] = wmi_nics
    out["_source"] = "wmi"
    if wmi_err:
        out["_diagnostics"]["wmi_error"] = wmi_err

    if not out["nics"]:
        # Neither path produced anything. Set _error so the dashboard
        # surfaces "Probe error" instead of silently showing a blank
        # NIC list, and keep the structured diagnostics so we can see
        # WHY without needing the operator to ship a fresh report.
        out["_error"] = "no NICs returned by Get-NetIPConfiguration or WMI"

    return out
