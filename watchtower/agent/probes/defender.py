"""
probes/defender.py — Windows Defender state.

We call `Get-MpComputerStatus | ConvertTo-Json -Compress` via subprocess
because the Defender WMI namespace (root\\Microsoft\\Windows\\Defender)
is finicky to enumerate from Python — the wmi library trips over its
typed properties. PowerShell handles it natively.

Returns null on machines where Defender isn't present (server cores
with it uninstalled) or where the cmdlet isn't available.
"""

import json
import subprocess


def collect():
    try:
        # -NoProfile keeps it fast; -OutputFormat Text avoids the XML
        # serialization layer that's slow for one-shot cmdlet calls.
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command",
                "Get-MpComputerStatus | Select-Object "
                "AntivirusEnabled, AMServiceEnabled, RealTimeProtectionEnabled, "
                "AntivirusSignatureVersion, AntivirusSignatureLastUpdated, "
                "QuickScanEndTime, FullScanEndTime, AMEngineVersion, AMProductVersion "
                "| ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=0x08000000,  # CREATE_NO_WINDOW so no console flashes
        )
        if result.returncode != 0:
            return {"_error": f"Get-MpComputerStatus failed: {result.stderr[:200]}"}
        stdout = result.stdout.strip()
        if not stdout:
            return None
        data = json.loads(stdout)
        return {
            "enabled": bool(data.get("AntivirusEnabled")),
            "realtimeOn": bool(data.get("RealTimeProtectionEnabled")),
            "serviceEnabled": bool(data.get("AMServiceEnabled")),
            "definitionsVersion": data.get("AntivirusSignatureVersion"),
            "definitionsUpdated": data.get("AntivirusSignatureLastUpdated"),
            "lastQuickScan": data.get("QuickScanEndTime"),
            "lastFullScan": data.get("FullScanEndTime"),
            "engineVersion": data.get("AMEngineVersion"),
            "productVersion": data.get("AMProductVersion"),
        }
    except subprocess.TimeoutExpired:
        return {"_error": "Get-MpComputerStatus timed out"}
    except Exception as e:
        return {"_error": f"defender probe failed: {e}"}
