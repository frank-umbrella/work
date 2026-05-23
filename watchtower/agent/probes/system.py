"""
probes/system.py — hostname, OS, model, service tag, CPU, RAM, TPM.

Sources:
  Win32_ComputerSystem, Win32_OperatingSystem, Win32_BIOS,
  Win32_Processor, Win32_PhysicalMemory, Win32_PhysicalMemoryArray,
  root\\CIMV2\\Security\\MicrosoftTpm  (Win32_Tpm namespace).
"""

import socket
import platform


def collect():
    out = {}
    try:
        import wmi
        c = wmi.WMI()

        # ---- Computer system ----
        cs = c.Win32_ComputerSystem()[0]
        out["hostname"] = cs.Name
        out["workgroup"] = cs.Domain  # "WORKGROUP" or the AD domain
        out["partOfDomain"] = bool(cs.PartOfDomain)
        out["manufacturer"] = cs.Manufacturer
        out["model"] = cs.Model

        # ---- BIOS / serial ----
        bios = c.Win32_BIOS()[0]
        out["serviceTag"] = (bios.SerialNumber or "").strip()
        out["biosVersion"] = (bios.SMBIOSBIOSVersion or "").strip()
        out["biosDate"] = (bios.ReleaseDate or "")[:8]  # YYYYMMDD prefix

        # ---- OS ----
        os_info = c.Win32_OperatingSystem()[0]
        out["os"] = {
            "name": os_info.Caption,
            "version": os_info.Version,
            "build": os_info.BuildNumber,
            "installDate": (os_info.InstallDate or "")[:14],  # CIM date prefix
            "lastBoot": (os_info.LastBootUpTime or "")[:14],
            "edition": os_info.OperatingSystemSKU,  # numeric SKU code
            "architecture": os_info.OSArchitecture,
        }

        # ---- CPU ----
        cpus = c.Win32_Processor()
        if cpus:
            cpu = cpus[0]
            out["cpu"] = {
                "name": (cpu.Name or "").strip(),
                "cores": cpu.NumberOfCores,
                "logicalProcessors": cpu.NumberOfLogicalProcessors,
                "speedMhz": cpu.MaxClockSpeed,
                "socketCount": len(cpus),
            }

        # ---- Memory ----
        modules = c.Win32_PhysicalMemory()
        total_bytes = sum(int(m.Capacity or 0) for m in modules)
        out["memory"] = {
            "totalGB": round(total_bytes / (1024 ** 3), 2),
            "modules": [
                {
                    "slot": m.DeviceLocator,
                    "sizeGB": round(int(m.Capacity or 0) / (1024 ** 3), 2),
                    "speedMhz": m.Speed,
                    "manufacturer": (m.Manufacturer or "").strip(),
                }
                for m in modules
            ],
        }

        # ---- TPM (separate namespace) ----
        try:
            tpm_wmi = wmi.WMI(namespace="root\\CIMV2\\Security\\MicrosoftTpm")
            tpms = tpm_wmi.Win32_Tpm()
            if tpms:
                tpm = tpms[0]
                out["tpm"] = {
                    "present": True,
                    "enabled": bool(tpm.IsEnabled_InitialValue),
                    "activated": bool(tpm.IsActivated_InitialValue),
                    "specVersion": tpm.SpecVersion,
                }
            else:
                out["tpm"] = {"present": False}
        except Exception as e:
            out["tpm"] = {"present": False, "_error": str(e)}

        return out

    except Exception as e:
        # Last-resort fallback: at least get a hostname so the agent
        # shows up in the dashboard even if WMI is wedged.
        return {
            "hostname": socket.gethostname(),
            "os": {"name": platform.platform()},
            "_error": f"system probe failed: {e}",
        }
