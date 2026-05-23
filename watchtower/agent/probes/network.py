"""
probes/network.py — external IP + NIC list with addresses.

External IP: queried from api.ipify.org (text response, ~5KB of overhead,
deliberately simple; no API key). Fallback to icanhazip.com if ipify is
unreachable so a single provider outage doesn't blind the agent.

NICs: Win32_NetworkAdapter + Win32_NetworkAdapterConfiguration joined by
SettingID. Only includes adapters with at least one IP address bound,
filtering out the inevitable virtual / disconnected forest of "Local
Area Connection* 14" entries.
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

        # Build a SettingID → IP info map first
        configs = {
            cfg.SettingID: cfg
            for cfg in c.Win32_NetworkAdapterConfiguration()
            if cfg.IPEnabled
        }

        for adapter in c.Win32_NetworkAdapter():
            cfg = configs.get(adapter.GUID)
            if not cfg:
                continue
            ipv4 = []
            ipv6 = []
            for ip in (cfg.IPAddress or []):
                (ipv6 if ":" in ip else ipv4).append(ip)
            out["nics"].append({
                "description": adapter.Description,
                "name": adapter.NetConnectionID,
                "mac": adapter.MACAddress,
                "speedMbps": (
                    int(int(adapter.Speed) / 1_000_000)
                    if adapter.Speed and str(adapter.Speed).isdigit()
                    else None
                ),
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
