"""
probes/storage.py — physical drives + logical volumes.

Sources: Win32_DiskDrive (physical) and Win32_LogicalDisk (volumes).
We deliberately use the older Win32_* classes rather than the newer
Storage Spaces / MSFT_Disk WMI namespace because the older surface is
the same on every Windows version since 7 — no version-specific
fallback paths needed.

Physical-drive fields captured per drive:
  model, interfaceType, sizeGB, serial, status, partitions
  firmwareRevision      -- for fleet-wide firmware tracking (e.g. the
                           Samsung 870 EVO firmware-death bug a couple
                           years back; now we can filter by exact rev)
  manufacturer          -- often "(Standard disk drives)" on Windows but
                           sometimes real (Dell PERC virtual disks, USB
                           enclosures) -- harmless when generic, useful
                           when not
  vendorId / productId  -- extracted from PNPDeviceID. For SCSI/IDE
                           drives these come as "VEN_<vendor>" and
                           "PROD_<product>" substrings; for USB enclosures
                           as "VID_<4hex>" and "PID_<4hex>". Lets you
                           spot counterfeit / relabelled drives (Model
                           says Samsung, vendor says something else) and
                           cross-reference against known-vulnerable
                           hardware revisions.
  pnpDeviceId           -- raw Windows device path, kept for diagnostics
                           when the parsed VEN/PROD strings look weird.
"""

import re

# Regexes evaluated once at import. Case-insensitive because WMI
# capitalization varies across driver vendors.
#
# SCSI / IDE / NVMe pattern -- VEN_<vendor>&PROD_<product>:
#   SCSI\DISK&VEN_SAMSUNG&PROD_SSD_870_EVO_4TB\5&2A99F0C0...
#   IDE\DISK&VEN_WDC&PROD_WD40EFRX-68N32N0\5&2A...
#
# USB pattern -- VID_<4hex>&PID_<4hex> (also captures VEN_/PROD_ when
# the enclosure chip populates them as readable strings):
#   USBSTOR\DISK&VEN_SEAGATE&PROD_EXPANSION&REV_0912\7XZ5A6R9&0
#   USB\VID_0BC2&PID_2322\NA7W2X8K
_RX_VEN      = re.compile(r"VEN_([^\\&]+)", re.I)
_RX_PROD     = re.compile(r"PROD_([^\\&]+)", re.I)
_RX_USB_VID  = re.compile(r"VID_([0-9A-F]{4})", re.I)
_RX_USB_PID  = re.compile(r"PID_([0-9A-F]{4})", re.I)


def _parse_pnp(pnp):
    """Split a PNPDeviceID string into (vendorId, productId).

    Prefers VEN_/PROD_ (readable strings) when present, falls back to
    USB VID_/PID_ (4-hex ids) otherwise. Returns (None, None) when the
    string has no recognizable pattern -- e.g. VM paravirtual disks
    whose IDs look like "SCSI\\DISK&VEN_&PROD_" with empty fields.
    """
    if not pnp:
        return None, None
    vendor = None
    product = None
    m = _RX_VEN.search(pnp)
    if m:
        v = m.group(1).strip().replace("_", " ").strip()
        if v:
            vendor = v
    m = _RX_PROD.search(pnp)
    if m:
        p = m.group(1).strip().replace("_", " ").strip()
        if p:
            product = p
    # USB fallbacks -- only used when VEN_/PROD_ didn't yield anything.
    if not vendor:
        m = _RX_USB_VID.search(pnp)
        if m:
            vendor = f"VID_{m.group(1).upper()}"
    if not product:
        m = _RX_USB_PID.search(pnp)
        if m:
            product = f"PID_{m.group(1).upper()}"
    return vendor, product


def collect():
    try:
        import wmi
        c = wmi.WMI()

        drives = []
        for d in c.Win32_DiskDrive():
            pnp = (getattr(d, "PNPDeviceID", None) or "").strip() or None
            vendor_id, product_id = _parse_pnp(pnp)
            drives.append({
                "model": (d.Model or "").strip(),
                "interfaceType": d.InterfaceType,
                "sizeGB": round(int(d.Size or 0) / (1024 ** 3), 2),
                "serial": (d.SerialNumber or "").strip(),
                "status": d.Status,
                "partitions": d.Partitions,
                "firmwareRevision": (getattr(d, "FirmwareRevision", None) or "").strip() or None,
                "manufacturer": (getattr(d, "Manufacturer", None) or "").strip() or None,
                "vendorId": vendor_id,
                "productId": product_id,
                "pnpDeviceId": pnp,
            })

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
