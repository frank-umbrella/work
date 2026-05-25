"""
collector.py — runs every probe, assembles the full report payload,
catches any straggler errors so a broken probe never crashes the
service.

The report shape matches what the dashboard reads out of Firestore;
keep it stable, because changing field names means dashboard changes too.

v0.14.4: per-probe timeout via threading. Before this, a single probe
that hung indefinitely (windows_updates blocking on an unreachable WSUS,
WMI hung from corrupt repository, omreport stuck on Dell controller
hardware fault, Get-WBSummary hanging on a wedged VSS) would halt the
ENTIRE check-in forever -- the service would sit RUNNING with no
state.json ever appearing in %ProgramData%\\Watchtower. Now each probe
runs on a daemon thread with a 60s wall-clock cap. Timeouts are recorded
in probeErrors with a `timeout: true` marker and the check-in continues
to the POST step.
"""

import importlib
import threading
import time
import traceback

import logger as _logger  # writes to %ProgramData%\Watchtower\watchtower.log


# Per-probe wall-clock cap. 60s is generous -- the slowest healthy probe
# (windows_updates COM search) finishes in ~30s on a typical host, the
# rest are sub-second. Anything past 60s is almost certainly a hung
# external dependency (WSUS unreachable, WMI broken, OMSA frozen).
PROBE_TIMEOUT_SEC = 60


# (probe_module_name, report_key) — order is for log readability only.
PROBES = [
    ("system",       "system"),
    ("network",      "network"),
    ("storage",      "storage"),
    ("users",        "users"),
    ("admins",       "localAdmins"),
    ("software",     "software"),
    ("defender",     "defender"),
    ("veeam",        "veeam"),
    ("wsb",          "wsb"),
    ("carbonite",    "carbonite"),
    ("ibackup",      "ibackup"),
    ("logmein",      "logmein"),
    ("sentinelone",  "sentinelone"),
    ("omsa",         "omsa"),
    ("idrac",        "idrac"),
    ("hotfixes",     "hotfixes"),
    ("windows_updates", "windowsUpdates"),
    ("usb",          "usb"),
]


def _run_probe_with_timeout(module_name, timeout_sec):
    """
    Runs probes.<module_name>.collect() on a daemon thread, returns the
    result if it finishes within timeout_sec, or raises TimeoutError if
    it doesn't.

    We can't safely kill a Python thread from outside, so a hung probe's
    thread keeps running in the background until the process dies. The
    daemon flag means it doesn't keep the service alive on shutdown.
    Subsequent check-ins spawn fresh threads -- they'll accumulate if
    the underlying issue isn't fixed, but the service stays responsive
    and state.json keeps getting written, which is what matters.

    v0.14.26: we now call pythoncom.CoInitialize() at the start of
    every probe thread. The wmi library (which six probes depend on)
    requires per-thread COM initialization or it returns the
    enigmatic "WMI returned a syntax error: you're probably running
    inside a thread without first calling pythoncom.CoInitialize[Ex]"
    error -- which is what CCD-HYPERV hit and why its internal IP came
    back blank. Before this fix the probe threads were getting lucky on
    most hosts (some platform-level COM init was already in place from
    pywin32's service host), but not all. CoInitialize is idempotent
    when COM is already up in this thread (returns S_FALSE rather than
    raising), so it's safe to call unconditionally.
    """
    result_box = {"value": None, "exc": None}

    def _target():
        # Per-thread COM init. Try/except because pythoncom isn't
        # importable on non-Windows test beds AND because some unusual
        # apartment states (e.g. STA already set by a host process)
        # surface as pywintypes.com_error -- which is fine to ignore;
        # the WMI call further down will succeed if COM is up at all.
        try:
            import pythoncom
            try:
                pythoncom.CoInitialize()
            except Exception:
                pass
        except ImportError:
            pass
        try:
            mod = importlib.import_module(f"probes.{module_name}")
            result_box["value"] = mod.collect()
        except Exception as e:
            result_box["exc"] = (e, traceback.format_exc())

    t = threading.Thread(target=_target, name=f"probe-{module_name}", daemon=True)
    t.start()
    t.join(timeout_sec)
    if t.is_alive():
        raise TimeoutError(f"probe {module_name!r} exceeded {timeout_sec}s wall-clock cap")
    if result_box["exc"] is not None:
        # Re-raise so the caller logs it through the same path as other
        # probe failures.
        raise result_box["exc"][0]
    return result_box["value"]


def collect_all():
    """
    Returns a dict shaped like:
      {
        "collectedAt": "<iso>",
        "collectionMs": 1234,
        "probeErrors": [{"probe": "veeam", "error": "...", "timeout": false}],
        "system": {...},
        "network": {...},
        ...
      }

    Probes that return None are omitted (e.g. SentinelOne not installed).
    Probes that throw are recorded in probeErrors[] but don't block other
    probes. Probes that hang past PROBE_TIMEOUT_SEC are recorded with
    `timeout: true` and skipped -- the check-in always completes.
    """
    report = {}
    errors = []
    t0 = time.monotonic()
    _logger.log(f"collect_all: starting {len(PROBES)} probes (per-probe timeout {PROBE_TIMEOUT_SEC}s)")

    for module_name, key in PROBES:
        probe_t0 = time.monotonic()
        try:
            value = _run_probe_with_timeout(module_name, PROBE_TIMEOUT_SEC)
            if value is not None:
                report[key] = value
            _logger.log(f"  probe {module_name}: ok ({int((time.monotonic() - probe_t0) * 1000)}ms)")
        except TimeoutError as e:
            _logger.log(f"  probe {module_name}: TIMEOUT after {PROBE_TIMEOUT_SEC}s -- thread orphaned, continuing")
            errors.append({
                "probe": module_name,
                "error": str(e),
                "timeout": True,
            })
        except Exception as e:
            _logger.log(f"  probe {module_name}: error -- {e}")
            errors.append({
                "probe": module_name,
                "error": str(e),
                "trace": traceback.format_exc(),
                "timeout": False,
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

    _logger.log(f"collect_all: done in {report['collectionMs']}ms ({len(errors)} probe errors)")
    return report
