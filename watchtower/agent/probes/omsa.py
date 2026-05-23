"""
probes/omsa.py — Dell OpenManage Server Administrator (OMSA).

Pulls storage health from `omreport` (the OMSA CLI). Three layers:

  1. Controllers — RAID/HBA controllers. `omreport storage controller`.
  2. Physical disks — per-controller. `omreport storage pdisk
     controller=<N>`. The failure mode we care most about — a single
     disk going non-Healthy is the headline indicator a server admin
     needs to see.
  3. Virtual disks — RAID arrays. `omreport storage vdisk
     controller=<N>`. Tells us if an array is degraded.

Uses `-fmt ssv` (semicolon-separated values) which is OMSA's least
human-friendly but most stable parse target. Falls back to `omreport
about` for version detection if OMSA's installed but storage queries
fail (e.g. on a host with no RAID controller).

Returns None if OMSA isn't installed. Returns a populated dict with
{"installed": True} otherwise — even if all the storage subcommands
fail, the dashboard still shows OMSA is present.

The probe times out generously (45s total) because `omreport storage
pdisk` on a big array can take 10+ seconds per controller.
"""

import os
import subprocess


OMREPORT_CANDIDATES = [
    r"C:\Program Files\Dell\SysMgt\oma\bin\omreport.exe",
    r"C:\Program Files (x86)\Dell\SysMgt\oma\bin\omreport.exe",
    r"C:\Program Files\Dell\SysMgt\bin\omreport.exe",  # older OMSA layout
]


def _find_omreport():
    for p in OMREPORT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def _run(omreport, args, timeout=20):
    """Run `omreport <args> -fmt ssv`. Returns stdout on success, None on failure."""
    try:
        r = subprocess.run(
            [omreport] + args + ["-fmt", "ssv"],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=0x08000000,
        )
        # omreport returns 0 even when there's nothing to report (e.g. no
        # controllers), so we don't gate on returncode — just on whether
        # stdout has any data rows.
        return r.stdout
    except (subprocess.TimeoutExpired, OSError):
        return None


def _parse_ssv_table(stdout, header_marker=None):
    """
    omreport -fmt ssv emits sections separated by blank lines, each
    section is a labeled table. Example:

      Storage Controller Information
      Controller PERC H730P Mini (Embedded)
      ID;0
      Status;Ok
      Name;PERC H730P Mini
      ...

    Records are key;value lines. Multiple records are separated by
    blank lines. We yield a list of dicts, one per record.

    If header_marker is given, skip everything until a section heading
    containing that string is found.
    """
    records = []
    current = {}
    in_target = header_marker is None

    for raw in stdout.splitlines():
        line = raw.strip()
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        if header_marker and not in_target:
            if header_marker.lower() in line.lower():
                in_target = True
            continue
        if ";" not in line:
            # Section heading or table label — flush current record.
            if current:
                records.append(current)
                current = {}
            continue
        key, _, val = line.partition(";")
        current[key.strip()] = val.strip()

    if current:
        records.append(current)
    return records


def _version(omreport):
    """OMSA version via `omreport about`."""
    out = _run(omreport, ["about"], timeout=10)
    if not out:
        return None
    for record in _parse_ssv_table(out):
        v = record.get("Version") or record.get("Build")
        if v:
            return v
    return None


def _controllers(omreport):
    out = _run(omreport, ["storage", "controller"], timeout=20)
    if not out:
        return []
    controllers = []
    for record in _parse_ssv_table(out):
        cid = record.get("ID")
        if cid is None:
            continue
        controllers.append({
            "id": cid,
            "name": record.get("Name"),
            "status": record.get("Status"),
            "firmware": record.get("Firmware Version"),
            "driver": record.get("Driver Version"),
        })
    return controllers


def _pdisks(omreport, controller_id):
    out = _run(omreport, ["storage", "pdisk", f"controller={controller_id}"], timeout=30)
    if not out:
        return []
    disks = []
    for record in _parse_ssv_table(out):
        if not record.get("ID"):
            continue
        disks.append({
            "id": record.get("ID"),
            "status": record.get("Status"),
            "state": record.get("State"),
            "name": record.get("Name"),
            "vendor": record.get("Vendor ID"),
            "product": record.get("Product ID"),
            "serial": record.get("Serial No."),
            "capacity": record.get("Capacity"),
            "mediaType": record.get("Media"),
            "predictiveFailure": record.get("Failure Predicted"),
        })
    return disks


def _vdisks(omreport, controller_id):
    out = _run(omreport, ["storage", "vdisk", f"controller={controller_id}"], timeout=20)
    if not out:
        return []
    arrays = []
    for record in _parse_ssv_table(out):
        if not record.get("ID"):
            continue
        arrays.append({
            "id": record.get("ID"),
            "status": record.get("Status"),
            "state": record.get("State"),
            "name": record.get("Name"),
            "layout": record.get("Layout"),  # RAID level
            "size": record.get("Size"),
        })
    return arrays


def _rollup_status(controllers, pdisks_by_ctl, vdisks_by_ctl):
    """
    Combine all status fields into a single worst-case rollup so the
    dashboard can show a one-glance OMSA badge.

    OMSA status values: "Ok", "Non-Critical", "Critical", "Unknown".
    We map to "ok" / "warn" / "bad" / "unknown".
    """
    def bucket(s):
        if not s:
            return "unknown"
        s_low = s.lower()
        if s_low == "ok":
            return "ok"
        if s_low in ("non-critical", "warning"):
            return "warn"
        if s_low in ("critical", "non-recoverable"):
            return "bad"
        return "unknown"

    severity = {"ok": 0, "unknown": 1, "warn": 2, "bad": 3}
    worst = "ok"
    sources = [c.get("status") for c in controllers]
    for disks in pdisks_by_ctl.values():
        sources.extend(d.get("status") for d in disks)
    for arrays in vdisks_by_ctl.values():
        sources.extend(a.get("status") for a in arrays)
    for s in sources:
        b = bucket(s)
        if severity[b] > severity[worst]:
            worst = b
    return worst


def collect():
    try:
        omreport = _find_omreport()
        if not omreport:
            return None

        out = {
            "installed": True,
            "version": _version(omreport),
        }

        controllers = _controllers(omreport)
        out["controllers"] = controllers

        pdisks_by_ctl = {}
        vdisks_by_ctl = {}
        for ctl in controllers:
            cid = ctl["id"]
            pdisks_by_ctl[cid] = _pdisks(omreport, cid)
            vdisks_by_ctl[cid] = _vdisks(omreport, cid)

        # Flatten for the dashboard — easier to render than nested.
        out["physicalDisks"] = []
        for cid, disks in pdisks_by_ctl.items():
            for d in disks:
                d["controllerId"] = cid
                out["physicalDisks"].append(d)

        out["virtualDisks"] = []
        for cid, arrays in vdisks_by_ctl.items():
            for a in arrays:
                a["controllerId"] = cid
                out["virtualDisks"].append(a)

        out["healthRollup"] = _rollup_status(controllers, pdisks_by_ctl, vdisks_by_ctl)

        return out

    except Exception as e:
        return {"_error": f"omsa probe failed: {e}"}
