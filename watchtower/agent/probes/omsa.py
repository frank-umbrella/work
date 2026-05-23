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

import csv
import io
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


def _parse_csv_table(stdout):
    """
    omreport `storage controller`, `storage pdisk`, `storage vdisk` (and
    other resource-listing subcommands) emit -fmt ssv as CSV-style: one
    header row + one data row per record, all semicolon-separated.

    Returns a list of dicts (one per data row), keyed by the header
    column names. Empty rows and section-header lines (no semicolons)
    are skipped automatically.
    """
    if not stdout or not stdout.strip():
        return []
    # Strip blank lines + any leading non-CSV section headers. A real CSV
    # header line will have multiple semicolons (≥ 3 to be safe vs a
    # stray punctuation match).
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    start = next((i for i, ln in enumerate(lines) if ln.count(";") >= 3), -1)
    if start < 0:
        return []
    csv_text = "\n".join(lines[start:])
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=";")
    out = []
    for row in reader:
        # Drop rows that are entirely empty (csv.DictReader emits one for
        # trailing newlines).
        if not any((v or "").strip() for v in row.values()):
            continue
        # Strip whitespace + None-out empties for consistency.
        out.append({k.strip(): (v.strip() if v else None) for k, v in row.items() if k})
    return out


def _parse_kv_table(stdout):
    """
    omreport `about` and a handful of metadata subcommands emit -fmt ssv
    as key;value pairs — one field per line. Different format from the
    storage CSV-style tables above.

    Returns a list of dicts, where blank-line-separated blocks become
    separate records (rare — `about` is usually one block).
    """
    records = []
    current = {}
    for raw in (stdout or "").splitlines():
        line = raw.strip()
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        if ";" not in line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, val = line.partition(";")
        current[key.strip()] = val.strip()
    if current:
        records.append(current)
    return records


def _pick(record, *keys):
    """Return the first non-empty value from `record` matching any of `keys`.
    Used to absorb OMSA's field-name drift across versions (e.g. older
    OMSA 8.x uses 'Controller Status' where 10.x uses 'Status')."""
    for k in keys:
        v = record.get(k)
        if v not in (None, ""):
            return v
    return None


def _version(omreport):
    """OMSA version via `omreport about` (key;value format)."""
    out = _run(omreport, ["about"], timeout=10)
    if not out:
        return None
    for record in _parse_kv_table(out):
        v = _pick(record, "Version", "Build")
        if v:
            return v
    return None


def _controllers(omreport):
    out = _run(omreport, ["storage", "controller"], timeout=20)
    if not out:
        return []
    controllers = []
    for record in _parse_csv_table(out):
        # OMSA field-name variations: 8.x uses "Slot ID" + "Controller Status";
        # 10.x uses "ID" + "Status". We accept both.
        cid = _pick(record, "ID", "Slot ID", "Controller Slot ID")
        if not cid:
            continue
        controllers.append({
            "id": cid,
            "name": _pick(record, "Name"),
            "status": _pick(record, "Status", "Controller Status"),
            "firmware": _pick(record, "Firmware Version"),
            "driver": _pick(record, "Driver Version"),
        })
    return controllers


def _pdisks(omreport, controller_id):
    out = _run(omreport, ["storage", "pdisk", f"controller={controller_id}"], timeout=30)
    if not out:
        return []
    disks = []
    for record in _parse_csv_table(out):
        did = _pick(record, "ID")
        if not did:
            continue
        disks.append({
            "id": did,
            "status": _pick(record, "Status"),
            "state": _pick(record, "State"),
            "name": _pick(record, "Name"),
            "vendor": _pick(record, "Vendor ID", "Vendor"),
            "product": _pick(record, "Product ID", "Product"),
            "serial": _pick(record, "Serial No.", "Serial Number", "Serial"),
            "capacity": _pick(record, "Capacity"),
            "mediaType": _pick(record, "Media", "Media Type"),
            "predictiveFailure": _pick(record, "Failure Predicted", "Predictive Failure"),
        })
    return disks


def _vdisks(omreport, controller_id):
    out = _run(omreport, ["storage", "vdisk", f"controller={controller_id}"], timeout=20)
    if not out:
        return []
    arrays = []
    for record in _parse_csv_table(out):
        vid = _pick(record, "ID")
        if not vid:
            continue
        arrays.append({
            "id": vid,
            "status": _pick(record, "Status"),
            "state": _pick(record, "State"),
            "name": _pick(record, "Name"),
            "layout": _pick(record, "Layout"),  # RAID level
            "size": _pick(record, "Size"),
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
