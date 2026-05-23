"""
probes/storage.py — physical drives + logical volumes.

Sources: Win32_DiskDrive (physical) and Win32_LogicalDisk (volumes).
We deliberately use the older Win32_* classes rather than the newer
Storage Spaces / MSFT_Disk WMI namespace because the older surface is
the same on every Windows version since 7 — no version-specific
fallback paths needed.
"""


def collect():
    try:
        import wmi
        c = wmi.WMI()

        drives = [
            {
                "model": (d.Model or "").strip(),
                "interfaceType": d.InterfaceType,
                "sizeGB": round(int(d.Size or 0) / (1024 ** 3), 2),
                "serial": (d.SerialNumber or "").strip(),
                "status": d.Status,
                "partitions": d.Partitions,
            }
            for d in c.Win32_DiskDrive()
        ]

        # DriveType values: 2=Removable, 3=Local, 4=Network, 5=CD, 6=RAM disk
        DRIVETYPE_NAMES = {2: "Removable", 3: "Local", 4: "Network", 5: "Optical", 6: "RAM"}
        volumes = [
            {
                "letter": v.DeviceID,
                "label": v.VolumeName,
                "filesystem": v.FileSystem,
                "type": DRIVETYPE_NAMES.get(int(v.DriveType or 0), "Unknown"),
                "sizeGB": round(int(v.Size or 0) / (1024 ** 3), 2) if v.Size else None,
                "freeGB": round(int(v.FreeSpace or 0) / (1024 ** 3), 2) if v.FreeSpace else None,
            }
            for v in c.Win32_LogicalDisk()
        ]

        return {"drives": drives, "volumes": volumes}

    except Exception as e:
        return {"_error": f"storage probe failed: {e}"}
