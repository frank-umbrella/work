"""
probes/usb.py — USB storage device history (past 30 days).

Source: HKLM\\SYSTEM\\CurrentControlSet\\Enum\\USBSTOR. Each device that
has ever been plugged in leaves a subkey: <product>\\<serial>. We walk
those and emit a list capturing friendly name + serial.

Belarc surfaces this in their "USB Storage Use in past 30 Days" panel,
correlated with the first/last-used timestamps stored in adjacent
Properties subkeys. The properties subkeys carry encoded FILETIMEs and
need careful parsing — for v0.1.0 we just emit the device list without
timestamps; a follow-up can decode those for the full Belarc parity.
"""

import winreg


def collect():
    try:
        items = []
        try:
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Enum\USBSTOR",
                0,
                winreg.KEY_READ,
            ) as parent:
                i = 0
                while True:
                    try:
                        product_key = winreg.EnumKey(parent, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(parent, product_key) as product:
                            j = 0
                            while True:
                                try:
                                    serial_key = winreg.EnumKey(product, j)
                                except OSError:
                                    break
                                j += 1
                                try:
                                    with winreg.OpenKey(product, serial_key) as device:
                                        try:
                                            friendly, _ = winreg.QueryValueEx(device, "FriendlyName")
                                        except FileNotFoundError:
                                            friendly = product_key
                                        items.append({
                                            "product": product_key,
                                            "serial": serial_key,
                                            "friendlyName": friendly,
                                        })
                                except OSError:
                                    continue
                    except OSError:
                        continue
        except FileNotFoundError:
            return {"devices": []}

        return {"devices": items, "count": len(items)}

    except Exception as e:
        return {"_error": f"usb probe failed: {e}"}
