"""
probes/windows_updates.py — pending Windows Updates.

Asks the Windows Update Agent (via COM, the same mechanism PSWindowsUpdate
uses) for updates that are applicable to this host but NOT yet installed.

Search criteria: `IsInstalled=0 and IsHidden=0`
  - IsInstalled=0 — only stuff not already on the box
  - IsHidden=0 — operator-hidden updates stay out of the list (treat
    "operator hid this" as "operator chose not to install it")

The COM search talks to whatever WSUS / WUfB / public WU endpoint the
host is configured to use, so the answer reflects the host's actual
update policy, not the public catalog.

Output shape:
  {
    "pendingCount": 7,
    "rebootRequired": true,
    "severityBreakdown": {"Critical": 2, "Important": 4, "Moderate": 1, "Unspecified": 0},
    "categoryBreakdown": {"Security Updates": 5, "Updates": 1, "Drivers": 1},
    "lastSearchSucceeded": "2026-05-23T14:30:00Z",
    "updates": [
      {
        "title": "2026-05 Cumulative Update for Windows Server 2022 (KB5040437)",
        "kb": "KB5040437",
        "severity": "Critical",
        "category": "Security Updates",
        "sizeMB": 624.3,
        "isBeta": false,
      },
      ...
    ]
  }

Caps `updates` at 30 to keep the check-in payload small even on hosts
that have gone a year without updates -- `pendingCount` carries the full
total separately.

Reboot-pending detection is independent of the search: we check the
registry locations Windows sets when a reboot is needed (CBS Servicing,
Windows Update reboot-required key, PendingFileRenameOperations).

Why this isn't free: the COM search can take 30-90s on a host that
hasn't checked recently. We have a generous timeout but tolerate it
failing (returns `_error` rather than crashing the whole check-in).
"""

import datetime
import re
import winreg


# Regex to pull KBxxxxxxx out of a typical update title. KBs are 6-7
# digits today; tolerant of more to future-proof.
_KB_RE = re.compile(r"\bKB(\d{6,8})\b", re.IGNORECASE)


def _kb_from_title(title):
    if not title:
        return None
    m = _KB_RE.search(title)
    return f"KB{m.group(1)}" if m else None


def _msrc_severity_label(sev):
    """
    The MsrcSeverity property is a free-form string set by the update
    publisher. For Microsoft's own security updates it's one of
    'Critical' / 'Important' / 'Moderate' / 'Low' / 'Unspecified'.
    Non-security updates often report '' or None; we bucket those into
    'Unspecified' so the breakdown is exhaustive.
    """
    if not sev:
        return "Unspecified"
    s = str(sev).strip()
    return s if s else "Unspecified"


def _detect_reboot_pending():
    """
    Heuristic combining the three places Windows signals a pending reboot.
    Any of them being set is enough -- they all mean an interactive user
    would be told 'restart required to finish updates' at next sign-in.
    """
    checks = [
        # Component-Based Servicing -- set when DISM/Setup needs a reboot
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
         "subkey"),
        # Windows Update reboot-required (legacy but still used by some
        # update flavors)
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
         "subkey"),
        # PendingFileRenameOperations -- session-manager queue of file
        # ops deferred until reboot, often populated by patches that
        # need to replace in-use files
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager",
         "value:PendingFileRenameOperations"),
    ]
    for hive, path, mode in checks:
        try:
            if mode == "subkey":
                with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                    return True
            elif mode.startswith("value:"):
                value_name = mode.split(":", 1)[1]
                with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                    try:
                        val, _ = winreg.QueryValueEx(k, value_name)
                        # REG_MULTI_SZ — non-empty list = pending ops queued
                        if val and any(v for v in val):
                            return True
                    except FileNotFoundError:
                        continue
        except (FileNotFoundError, OSError):
            continue
    return False


def collect():
    try:
        # pywin32 import deferred so non-Windows test imports don't crash.
        import pythoncom
        import win32com.client

        pythoncom.CoInitialize()
        try:
            session = win32com.client.Dispatch("Microsoft.Update.Session")
            searcher = session.CreateUpdateSearcher()
            # Empty server selector + default source = whatever the host
            # is configured to talk to (WSUS / WUfB / Microsoft Update).
            results = searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
        finally:
            pythoncom.CoUninitialize()

        updates_collection = results.Updates
        pending_count = updates_collection.Count

        severity_breakdown = {}
        category_breakdown = {}
        updates_out = []

        # Iterate by index — the COM collection is 0-indexed.
        for i in range(min(pending_count, 30)):
            u = updates_collection.Item(i)
            title = str(u.Title or "")
            sev = _msrc_severity_label(getattr(u, "MsrcSeverity", None))

            # Categories collection — typically one main category like
            # "Security Updates" / "Updates" / "Drivers"; take the first.
            category = ""
            try:
                cats = u.Categories
                if cats and cats.Count > 0:
                    category = str(cats.Item(0).Name or "")
            except Exception:
                pass

            size_mb = None
            try:
                # MaxDownloadSize is bytes; some updates report 0 (delivery
                # is server-decided), in which case we leave it None.
                sz = int(getattr(u, "MaxDownloadSize", 0))
                if sz > 0:
                    size_mb = round(sz / (1024 * 1024), 1)
            except Exception:
                pass

            updates_out.append({
                "title": title,
                "kb": _kb_from_title(title),
                "severity": sev,
                "category": category,
                "sizeMB": size_mb,
                "isBeta": bool(getattr(u, "IsBeta", False)),
            })

        # Count ALL pending updates by severity/category, not just the
        # first 30 we listed -- so the breakdown reflects reality on a
        # host that's wildly out of date.
        for i in range(pending_count):
            u = updates_collection.Item(i)
            sev = _msrc_severity_label(getattr(u, "MsrcSeverity", None))
            severity_breakdown[sev] = severity_breakdown.get(sev, 0) + 1
            try:
                cats = u.Categories
                if cats and cats.Count > 0:
                    cn = str(cats.Item(0).Name or "")
                    if cn:
                        category_breakdown[cn] = category_breakdown.get(cn, 0) + 1
            except Exception:
                pass

        return {
            "pendingCount": pending_count,
            "rebootRequired": _detect_reboot_pending(),
            "severityBreakdown": severity_breakdown,
            "categoryBreakdown": category_breakdown,
            "lastSearchSucceeded": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updates": updates_out,
        }

    except Exception as e:
        # Still report reboot-pending state even if the WU search failed
        # — it's read from registry only and doesn't need WUApi.
        out = {"_error": f"windows_updates probe failed: {e}"}
        try:
            out["rebootRequired"] = _detect_reboot_pending()
        except Exception:
            pass
        return out
