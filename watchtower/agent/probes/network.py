"""
probes/network.py — external IP + NIC list with addresses.

External IP: queried from api.ipify.org (text response, ~5KB of overhead,
deliberately simple; no API key). Fallback to icanhazip.com if ipify is
unreachable so a single provider outage doesn't blind the agent.

NICs: Win32_NetworkAdapterConfiguration is the source of truth for
IP-enabled interfaces. We join Win32_NetworkAdapter (for the friendly
NetConnectionID like "Ethernet" / "vEthernet (External)") via the
InterfaceIndex property -- NOT via GUID/SettingID.

v0.14.8 fix: previously joined via adapter.GUID == cfg.SettingID. That
silently failed on Hyper-V management OSes because the vEthernet
adapter's GUID property frequently comes back empty or doesn't match
the bound configuration's SettingID. Result: every vNIC was dropped,
the dashboard showed "—" for the host's internal IP. InterfaceIndex
is reliably populated on both classes across all Windows editions,
so it's the correct join key.

We also now iterate Win32_NetworkAdapterConfiguration as the primary
list -- if there's an IP-enabled config but no matching adapter (which
can happen for some teamed / hyper-v synthetic NICs), we still emit
the NIC using the config's own Description as the name. That way
the IP doesn't disappear just because the adapter lookup misses.
"""

import requests


EXTERNAL_IP_PROBES = [
    ("https://api.ipify.org", 5),
    ("https://icanhazip.com", 5),
    ("https://ifconfig.me/ip", 5),
]


def _external_ip():
    for url, timeout in EXTERNAL_IP_PROBES:
        try:
            r = requests.get(url, timeout=timeout)
            if r.ok:
                ip = r.text.strip()
                # Sanity check — should be a v4 or v6 literal
                if ip and len(ip) <= 45:
                    return ip
        except requests.RequestException:
            continue
    return None


def collect():
    out = {"externalIp": _external_ip(), "nics": []}

    try:
        import wmi
        c = wmi.WMI()

        # Index Win32_NetworkAdapter by InterfaceIndex -- the reliable
        # join key for both WMI classes. Some adapters report
        # InterfaceIndex as None (logical-only entries); skip those.
        adapters_by_idx = {}
        for adapter in c.Win32_NetworkAdapter():
            try:
                idx = adapter.InterfaceIndex
            except AttributeError:
                idx = None
            if idx is not None:
                adapters_by_idx[int(idx)] = adapter

        # Iterate IP-enabled configurations (this is the canonical
        # source of "which interface actually has an IP bound").
        for cfg in c.Win32_NetworkAdapterConfiguration():
            if not cfg.IPEnabled:
                continue

            adapter = None
            try:
                if cfg.InterfaceIndex is not None:
                    adapter = adapters_by_idx.get(int(cfg.InterfaceIndex))
            except (AttributeError, TypeError, ValueError):
                adapter = None

            ipv4 = []
            ipv6 = []
            for ip in (cfg.IPAddress or []):
                (ipv6 if ":" in ip else ipv4).append(ip)

            # Prefer adapter's friendly fields; fall back to the
            # configuration's own description when no adapter matched.
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

            out["nics"].append({
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
            })

        return out

    except Exception as e:
        out["_error"] = f"NIC enumeration failed: {e}"
        return out
