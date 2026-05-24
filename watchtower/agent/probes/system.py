"""
probes/system.py — hostname, OS, model, service tag, CPU, RAM, TPM.

Sources:
  Win32_ComputerSystem, Win32_OperatingSystem, Win32_BIOS,
  Win32_Processor, Win32_PhysicalMemory, Win32_PhysicalMemoryArray,
  root\\CIMV2\\Security\\MicrosoftTpm  (Win32_Tpm namespace).
"""

import socket
import platform
import winreg


def _hyperv_parent_host():
    """
    Inside a Hyper-V guest, Integration Services populates a few values
    under HKLM\\SOFTWARE\\Microsoft\\Virtual Machine\\Guest\\Parameters
    that describe the parent host. We read whichever is available:

      HostName                       NetBIOS name (HYPERV-KIPLING)
      PhysicalHostName               NetBIOS name (same in practice)
      PhysicalHostNameFullyQualified FQDN (hyperv-kipling.example.local)

    Available without elevation. Returns None if the registry key isn't
    present, which happens when:
      - Host is not a Hyper-V VM
      - Integration Services aren't running (older guest OS, ICs disabled)
      - KVP exchange is disabled in the VM's settings on the host side
    """
    path = r"SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            def _read(name):
                try:
                    v, _ = winreg.QueryValueEx(k, name)
                    s = (v or "").strip()
                    return s or None
                except FileNotFoundError:
                    return None
            netbios = _read("PhysicalHostName") or _read("HostName")
            fqdn = _read("PhysicalHostNameFullyQualified")
            # Prefer the bare name for matching against other Watchtower
            # endpoints (which report cs.Name = NetBIOS), keep FQDN as
            # a tooltip detail. Empty NetBIOS = nothing to surface.
            if not netbios:
                return None
            return {"name": netbios, "fqdn": fqdn}
    except (FileNotFoundError, OSError):
        return None


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

        # ---- Virtualization detection ----
        # WMI gives us enough to recognize the common hypervisors. Most
        # write a recognizable Manufacturer + Model pair into SMBIOS;
        # we match on substrings rather than exact strings since vendors
        # have shipped slight variations.
        vm_signatures = [
            ("VMware",         ("vmware",)),
            ("Microsoft Hyper-V", ("microsoft corporation", "virtual machine")),
            ("VirtualBox",     ("virtualbox", "innotek")),
            ("Xen",            ("xen",)),
            ("KVM/QEMU",       ("kvm", "qemu", "bochs")),
            ("Parallels",      ("parallels",)),
            ("Nutanix AHV",    ("nutanix",)),
            ("Proxmox",        ("proxmox",)),
        ]
        mfr_l = (cs.Manufacturer or "").lower()
        mdl_l = (cs.Model or "").lower()
        hypervisor = None
        for label, needles in vm_signatures:
            if any(n in mfr_l for n in needles) or any(n in mdl_l for n in needles):
                hypervisor = label
                break
        # cs.HypervisorPresent is True even on Hyper-V *hosts* (where the
        # hypervisor is loaded for VMs running ON this machine), so we
        # don't rely on it solo — only as a tie-breaker when the SMBIOS
        # strings are ambiguous.
        out["isVirtual"] = hypervisor is not None
        out["hypervisor"] = hypervisor

        # ---- Hyper-V parent host correlation ----
        # Only meaningful when we're a Hyper-V guest. Other hypervisors
        # don't expose the parent's identity to the guest (VMware does
        # via vmtools, but that's a later add). When present, the
        # worker promotes this to a top-level `physicalHost` field so the
        # dashboard can link this VM back to its parent endpoint.
        if hypervisor == "Microsoft Hyper-V":
            ph = _hyperv_parent_host()
            if ph:
                out["physicalHost"] = ph

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
