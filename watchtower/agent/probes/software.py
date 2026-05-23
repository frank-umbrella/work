"""
probes/software.py — installed software inventory.

Walks the four Uninstall keys (32/64-bit × HKLM/HKCU). This is the same
source that Add/Remove Programs and `Get-Package -ProviderName Programs`
both use. Matches what Belarc Advisor shows in its "Software Versions"
section closely enough for our purposes.

Filters out the noisy stuff (Windows component updates, language packs,
Visual C++ runtimes — none of which we care about for fleet inventory)
to keep the report payload small.
"""

import winreg


UNINSTALL_KEYS = [
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "64"),
    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "32"),
    (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "user-64"),
]


# Display-name prefixes we suppress because they're noise for fleet inventory.
NOISE_PREFIXES = (
    "Update for",
    "Security Update for",
    "Hotfix for",
    "Microsoft Visual C++ ",         # tons of side-by-side runtime entries
    "Microsoft .NET ",                # similar
    "Windows Software Development Kit",
    "Microsoft Windows Desktop Runtime",
)


def _read_str(key, name):
    try:
        v, _ = winreg.QueryValueEx(key, name)
        return v if isinstance(v, str) else None
    except FileNotFoundError:
        return None


def _walk(hive, subkey, scope):
    items = []
    try:
        with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as parent:
            i = 0
            while True:
                try:
                    sub_name = winreg.EnumKey(parent, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(parent, sub_name) as k:
                        display = _read_str(k, "DisplayName")
                        if not display:
                            continue
                        if any(display.startswith(p) for p in NOISE_PREFIXES):
                            continue
                        # SystemComponent=1 means it's hidden from Add/Remove —
                        # almost always a noisy MS update or shim.
                        try:
                            sys_comp, _ = winreg.QueryValueEx(k, "SystemComponent")
                            if sys_comp == 1:
                                continue
                        except FileNotFoundError:
                            pass
                        items.append({
                            "name": display,
                            "version": _read_str(k, "DisplayVersion"),
                            "publisher": _read_str(k, "Publisher"),
                            "installDate": _read_str(k, "InstallDate"),  # YYYYMMDD
                            "scope": scope,
                        })
                except OSError:
                    continue
    except FileNotFoundError:
        pass
    return items


def collect():
    try:
        all_items = []
        seen = set()
        for hive, subkey, scope in UNINSTALL_KEYS:
            for item in _walk(hive, subkey, scope):
                # Dedup on (name, version) across hives/scopes — 64-bit and
                # WOW6432Node often both list the same MSI.
                key = (item["name"], item.get("version"))
                if key in seen:
                    continue
                seen.add(key)
                all_items.append(item)

        # Sort alphabetically for stable diffs check-in over check-in.
        all_items.sort(key=lambda x: (x["name"] or "").lower())
        return {"count": len(all_items), "installed": all_items}

    except Exception as e:
        return {"_error": f"software probe failed: {e}"}
