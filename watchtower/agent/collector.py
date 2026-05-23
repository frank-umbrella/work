"""
collector.py — runs every probe, assembles the full report payload,
catches any straggler errors so a broken probe never crashes the
service.

The report shape matches what the dashboard reads out of Firestore;
keep it stable, because changing field names means dashboard changes too.
"""

import importlib
import time
import traceback


# (probe_module_name, report_key) — order is for log readability only.
PROBES = [
    ("system",       "system"),
    ("network",      "network"),
    ("storage",      "storage"),
    ("users",        "users"),
    ("software",     "software"),
    ("defender",     "defender"),
    ("veeam",        "veeam"),
    ("logmein",      "logmein"),
    ("sentinelone",  "sentinelone"),
    ("hotfixes",     "hotfixes"),
    ("usb",          "usb"),
]


def collect_all():
    """
    Returns a dict shaped like:
      {
        "collectedAt": "<iso>",
        "collectionMs": 1234,
        "probeErrors": [{"probe": "veeam", "error": "..."}],
        "system": {...},
        "network": {...},
        ...
      }

    Probes that return None are omitted (e.g. SentinelOne not installed).
    Probes that throw are recorded in probeErrors[] but don't block other
    probes.
    """
    report = {}
    errors = []
    t0 = time.monotonic()

    for module_name, key in PROBES:
        try:
            mod = importlib.import_module(f"probes.{module_name}")
            value = mod.collect()
            if value is not None:
                report[key] = value
        except Exception as e:
            errors.append({
                "probe": module_name,
                "error": str(e),
                "trace": traceback.format_exc(),
            })

    report["collectedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report["collectionMs"] = int((time.monotonic() - t0) * 1000)
    if errors:
        report["probeErrors"] = errors

    # Promote externalIp to the top level so the worker can read it
    # without descending into report.network.externalIp. The worker's
    # IP-change detector reads this exact path.
    if report.get("network", {}).get("externalIp"):
        report["externalIp"] = report["network"]["externalIp"]

    return report
