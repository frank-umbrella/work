"""
probes/hotfixes.py — installed Windows hotfixes (KB numbers + dates).

Source: Win32_QuickFixEngineering. Same data as `Get-HotFix` but
queried directly via WMI to avoid the PowerShell subprocess overhead.

For payload-size reasons we cap to the most recent 50 hotfixes (more
than enough to verify "this server is patched"). The dashboard can
show "and 200 older" if we want a count.
"""

import datetime


def collect():
    try:
        import wmi
        c = wmi.WMI()

        items = []
        for qfe in c.Win32_QuickFixEngineering():
            installed_on = None
            if qfe.InstalledOn:
                # WMI returns the date in M/D/YYYY format, sometimes with
                # zone suffix. Parse leniently — datestrings like
                # "5/20/2026" or "5/20/2026 12:00:00 AM" both show up.
                raw = str(qfe.InstalledOn).strip()
                for fmt in ("%m/%d/%Y", "%m/%d/%Y %I:%M:%S %p", "%Y-%m-%d"):
                    try:
                        installed_on = datetime.datetime.strptime(raw, fmt).date().isoformat()
                        break
                    except ValueError:
                        continue
                if not installed_on:
                    installed_on = raw  # leave raw if parsing failed

            items.append({
                "id": qfe.HotFixID,        # e.g. "KB5087539"
                "description": qfe.Description,  # "Security Update", etc.
                "installedOn": installed_on,
                "installedBy": qfe.InstalledBy,
            })

        # Most-recent first; cap at 50.
        items.sort(key=lambda x: x.get("installedOn") or "", reverse=True)
        total = len(items)
        items = items[:50]

        return {"total": total, "recent": items}

    except Exception as e:
        return {"_error": f"hotfixes probe failed: {e}"}
