"""
health.py -- compute this host's worst health state.

Used by the tray to pick which icon variant to display (ok / warn /
crit) and by anything else in the agent that wants a single-word
summary of the local machine's state. The logic mirrors the dashboard's
statusOf / backupHealthOf / omsaHealthOf / adminHealthOf JavaScript so
the tray and dashboard agree on whether THIS host is in trouble.

Returns one of:
  'ok'    everything green
  'warn'  any non-critical issue (>5 admins, OMSA warn, disk <10%,
          backup failing for <3 days, etc)
  'crit'  any critical issue (admin red-flag, OMSA bad, disk <5%,
          backup failing for >=3 days, host has never checked in
          successfully, etc)

Pure function -- takes the in-memory state dict / report dict, returns
a string. No I/O, no logging, no side effects.
"""


# Same thresholds the dashboard uses (see index.html
# computeFleetWorstState + adminHealthOf). Mirror constants here so a
# change in either place is a one-liner.
DISK_CRIT_PCT = 5
DISK_CRIT_GB = 5
DISK_WARN_PCT = 10
DISK_WARN_GB = 10

ADMIN_WARN_COUNT = 5
ADMIN_CRIT_COUNT = 10
ADMIN_RED_FLAG_PRINCIPALS = (
    "everyone",
    "authenticated users",
    "domain users",
    "users",
    "guests",
    "interactive",
)


def _bare_name(name):
    """Strip 'DOMAIN\\' prefix from a Windows principal name."""
    if not name:
        return ""
    idx = name.rfind("\\")
    return name[idx + 1:] if idx >= 0 else name


def _admin_health(local_admins):
    """Returns 'crit' / 'warn' / 'ok'. None / probe error = 'ok'
    (no information shouldn't bump the host into a warning state)."""
    if not local_admins or local_admins.get("_error"):
        return "ok"
    members = local_admins.get("members") or []
    # Red-flag principals = catastrophic
    for m in members:
        bare = _bare_name(m.get("name", "")).lower()
        if bare in ADMIN_RED_FLAG_PRINCIPALS:
            return "crit"
    n = len(members)
    if n >= ADMIN_CRIT_COUNT:
        return "crit"
    worst = "ok"
    if n >= ADMIN_WARN_COUNT:
        worst = "warn"
    if local_admins.get("builtinAdministratorEnabled") is True and worst == "ok":
        worst = "warn"
    return worst


def _backup_health(wsb):
    """WSB-specific. Returns 'crit' / 'warn' / 'ok'."""
    if not wsb or not wsb.get("installed"):
        return "ok"
    last_result = wsb.get("lastBackupResult")
    if not last_result or last_result == "Success":
        return "ok"
    # Anything non-Success that has gone uncorrected for >= 3 days = crit.
    # Same threshold the dashboard's backupHealthOf uses.
    try:
        import datetime as _dt
        last_success = wsb.get("lastSuccessfulBackup")
        if last_success:
            t = _dt.datetime.fromisoformat(last_success.replace("Z", "+00:00")).replace(tzinfo=None)
            days = (_dt.datetime.utcnow() - t).total_seconds() / 86400.0
            return "crit" if days >= 3 else "warn"
    except (ValueError, AttributeError, KeyError):
        pass
    # No prior success on record + a non-Success result = serious
    return "crit"


def _omsa_health(omsa):
    """OMSA-specific. 'bad' rollup = crit, 'warn' = warn, anything else = ok."""
    if not omsa or not omsa.get("installed"):
        return "ok"
    rollup = (omsa.get("healthRollup") or "").lower()
    if rollup == "bad":
        return "crit"
    if rollup == "warn":
        return "warn"
    return "ok"


def _disk_health(storage):
    """C: drive free space. Returns 'crit' / 'warn' / 'ok'."""
    if not storage:
        return "ok"
    for vol in (storage.get("volumes") or []):
        # Letter may be 'C:' or 'C' depending on the probe. Normalize.
        letter = (vol.get("letter") or "").rstrip(":").upper()
        if letter != "C":
            continue
        free_gb = vol.get("freeGB")
        size_gb = vol.get("sizeGB")
        free_pct = None
        if isinstance(free_gb, (int, float)) and isinstance(size_gb, (int, float)) and size_gb > 0:
            free_pct = free_gb / size_gb * 100.0
        is_crit = (free_pct is not None and free_pct < DISK_CRIT_PCT) or \
                  (isinstance(free_gb, (int, float)) and free_gb < DISK_CRIT_GB)
        is_warn = (free_pct is not None and free_pct < DISK_WARN_PCT) or \
                  (isinstance(free_gb, (int, float)) and free_gb < DISK_WARN_GB)
        if is_crit:
            return "crit"
        if is_warn:
            return "warn"
        return "ok"
    return "ok"


def compute_host_health_state(state):
    """Top-level helper. `state` is the dict loaded from state.json
    (same shape config.load_state() returns). Returns 'ok' / 'warn' /
    'crit'. Designed to be cheap -- no I/O, just dict lookups.

    Precedence: returns 'crit' on the first critical signal found.
    Otherwise returns 'warn' if any signal is warn. Otherwise 'ok'.
    """
    if not isinstance(state, dict):
        return "ok"

    # If the last check-in itself failed, that's a critical signal --
    # the host can't talk to its own monitor. (The dashboard treats
    # 'stale' as bad too.)
    if state.get("ok") is False:
        return "crit"

    # The agent's collector writes report into state['lastResponse'] OR
    # into a separate 'lastReport' summary -- but the FULL report is
    # only ephemerally in memory during run_checkin(), it doesn't end
    # up in state.json. So we have to compute health from the in-flight
    # report (caller passes it via state['_report']) OR from the small
    # 'lastReport' summary that DOES live in state.json.
    #
    # The tray will call this with state.json as-is; checkin.py wires
    # up state['_report'] = report momentarily so the health gets
    # written into state['hostHealthState'] before save_state() drops
    # the underscore field (Python convention: caller writes the field,
    # nothing else reads it again).
    report = state.get("_report") or {}

    worst = "ok"
    for fn, arg in (
        (_admin_health,  report.get("localAdmins")),
        (_omsa_health,   report.get("omsa")),
        (_backup_health, report.get("wsb")),
        (_disk_health,   report.get("storage")),
    ):
        s = fn(arg)
        if s == "crit":
            return "crit"
        if s == "warn":
            worst = "warn"
    return worst
