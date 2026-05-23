# Watchtower — design doc

Umbrella Automation's lightweight Windows monitoring agent + dashboard.

## Goal

Drop a small agent on every client PC/server we manage. Once a day it
phones home with:

- Current external IP (alert by email + webhook if it changed)
- Veeam Agent install state + version + last backup result/timestamp
- LogMeIn install state + service running/stopped + computer description
- SentinelOne / Defender state
- Belarc-lite asset inventory (hostname, OS, model, service tag, CPU, RAM,
  TPM, drives, volumes, NICs, local users, installed software, hotfixes,
  USB device history)

A Google-auth-gated dashboard at `frank-umbrella.github.io/work/watchtower/`
shows the fleet, lets us drill into any PC, and lets us flip kill-switches
(Disable notifications / Decommission) per host.

## Architecture

```
[ Client PC ]                          [ Cloudflare ]                 [ Firebase ]
                                                                          
 watchtower-svc.exe  ── HTTPS POST ──>  watchtower-worker  ── JWT ──>  Firestore
   (Windows service,                    /checkin                       /agents/{pcId}
    LocalSystem,                                                       /agents/{pcId}/config
    runs probes                         Resend ──>  email alert         /agents/{pcId}/history
    once daily)                                                        /msp_admins/{uid}
                                        webhook POST ──>  (optional)
 watchtower-tray.exe
   (user session, shows
    last check, "Check now")                                          [ GitHub Pages ]
                                                                          
                                                                       dashboard SPA
                                                                       (Google auth,
                                                                        reads Firestore)
```

### Components

1. **`agent/`** — Python source for two PyInstaller --onefile builds:
   - `watchtower-svc.exe` — Windows service, LocalSystem, does the actual
     data collection + check-in. Runs once daily via internal timer, with
     a "first run on service start" fast path.
   - `watchtower-tray.exe` — tray icon in the user session. Shows last
     check time, current external IP, service status, "Check now" button,
     and version. Does NOT collect data itself (the service does).

2. **`installer/`** — Inno Setup `.iss` + `build.ps1`. Bundles both EXEs,
   registers the service (LocalSystem, auto-start), drops a Run-key entry
   for the tray, embeds per-install token at build time, handles upgrade
   in place, clean uninstall.

3. **`worker/`** — Cloudflare Worker (`watchtower-worker.sevendwarfs.workers.dev`).
   - `POST /checkin` — validates token, writes status doc, returns config.
   - `GET /healthz` — liveness probe.
   - Writes to Firestore via service-account JWT (jose pattern reused
     from usage-worker + stocks-worker).
   - Sends Resend email on IP change.
   - POSTs to per-PC webhook if configured.

4. **`firestore.rules` / `firestore.indexes.json` / `firebase.json`** —
   new Firebase project `umbrella-watchtower` (Spark plan to start;
   upgrade only if we hit quota).

5. **`index.html`** — dashboard SPA. Single file. Firebase Auth (Google
   provider, restricted to Umbrella workspace domain via `hd` param + an
   allowlist check against `/msp_admins/{uid}`).

## Firestore data model

```
/msp_admins/{uid}
  email: string
  addedAt: timestamp
  addedBy: string (uid)

/agents/{pcId}                       # pcId = stable per-install UUID, NOT hostname
  hostname: string
  workgroup: string
  client: string                     # which client this PC belongs to (e.g. "OPFD")
  installedAt: timestamp
  lastCheckin: timestamp
  agentVersion: string
  externalIp: string
  externalIpChangedAt: timestamp
  os: { name, version, build, installDate, edition }
  hardware: { manufacturer, model, serviceTag, cpu, ramGB, tpm }
  network: { nics[], dnsServers[], gateway }
  storage: { drives[], volumes[] }
  users: { local[] }                 # name, disabled, lastLogon, privilege
  software: { installed[] }          # name, version, publisher
  veeam: {
    installed: bool
    edition: "agent-free" | "agent-paid" | "br" | null
    version: string
    lastJob: { name, result, timestamp }
  }
  logmein: {
    installed: bool
    serviceState: "running" | "stopped" | "disabled" | null
    version: string
    description: string              # The Central computer description
  }
  sentinelone: { installed, version }
  defender: { enabled, definitionsVersion, lastScan, realtimeOn }
  hotfixes: { installed[], lastCheck }
  usbHistory: { devices[] }          # past 30 days

/agents/{pcId}/config/current        # MSP-admin-writable, agent reads each check-in
  enabled: bool                      # master kill: agent stops everything but check-in
  emailEnabled: bool
  webhookEnabled: bool
  webhookUrl: string
  notes: string                      # MSP-admin notes about this host
  uninstall: bool                    # one-shot: agent self-removes on next check-in

/agents/{pcId}/history/{checkinId}   # rolling, retain last 90 days
  ts: timestamp
  externalIp: string
  changed: bool
  fields: { ...delta from previous... }
```

## Security model

- **Agent → Worker**: per-install shared-secret token (32 random bytes,
  base64). Embedded into the installer at build time via build.ps1
  parameter. Token is bound to `pcId` in Firestore on first check-in;
  subsequent check-ins from a *different* pcId with the same token are
  rejected.
- **Worker → Firestore**: service-account JWT, secret stored in CF
  encrypted env (`FIREBASE_SERVICE_ACCOUNT_JSON`).
- **Dashboard → Firestore**: Firebase Auth Google provider, `hd` param
  set to Umbrella workspace domain, rules enforce membership in
  `/msp_admins/{uid}`. Direct Firestore reads; the dashboard never talks
  to the Worker.
- **Resend**: `onboarding@resend.dev` sender for now (sandbox sender
  allowed because recipient is always the MSP admin = Resend account
  owner). Verify a real Umbrella subdomain later for branding.

## Kill-switch behavior

Each daily check-in reads `/agents/{pcId}/config/current` *before*
deciding whether to send email/webhook. So:

| `config.enabled` | `config.emailEnabled` | `config.uninstall` | Behavior |
|---|---|---|---|
| true | true  | false | Full data collection + email on IP change |
| true | false | false | Data collection continues, no email |
| false | —    | false | Check-in still reports liveness, no probes, no alerts |
| —    | —    | true  | Self-removes service + tray + state, exits |

Effective latency for any flip: up to 24h (one check cycle). If we ever
need faster, add a separate `/check-config` call on a 1h timer.

## Belarc-lite probe sources

| Field | Source |
|---|---|
| Hostname / workgroup | `Win32_ComputerSystem` |
| OS version + build | `Win32_OperatingSystem` |
| Install date | `Win32_OperatingSystem.InstallDate` |
| Make / model / service tag | `Win32_ComputerSystem` + `Win32_BIOS.SerialNumber` |
| CPU | `Win32_Processor` |
| RAM | `Win32_PhysicalMemory` + `Win32_PhysicalMemoryArray` |
| TPM | `Win32_Tpm` namespace `root\CIMV2\Security\MicrosoftTpm` |
| Drives + volumes | `Get-PhysicalDisk`, `Get-Volume` (run via subprocess) |
| NICs + IPs + MACs | `Win32_NetworkAdapter` + `Win32_NetworkAdapterConfiguration` |
| External IP | `https://api.ipify.org` |
| Local users | `net user` parse + `Win32_UserAccount` |
| Installed software | registry walk: `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` + `WOW6432Node\...\Uninstall` |
| Hotfixes | `Win32_QuickFixEngineering` |
| USB history | registry `HKLM\SYSTEM\CurrentControlSet\Enum\USBSTOR` |
| Defender | `Get-MpComputerStatus` via subprocess |
| Veeam — Agent | registry `HKLM\SOFTWARE\Veeam\Veeam Endpoint Backup` + `veeamconfig.exe session list` |
| Veeam — B&R    | registry `HKLM\SOFTWARE\Veeam\Veeam Backup and Replication` + `Get-VBRComputerBackupJobSession` |
| LogMeIn install | registry `HKLM\SOFTWARE\LogMeIn` |
| LogMeIn service | `Get-Service LogMeIn` |
| LogMeIn description | registry `HKLM\SOFTWARE\LogMeIn\V5\Description` (verify on live install) |
| SentinelOne | registry walk for `Sentinel Agent` + version from install dir |

Each probe is its own module under `agent/probes/` and returns `None` if
the product isn't installed. Probes that throw never crash the check-in —
errors are collected into the status doc as `probeErrors[]` so we can see
in the dashboard which probes failed and why.

## Build & deploy

- **Agent**: `installer/build.ps1 -ClientName "OPFD" -Token <generated>`
  produces `installer/dist/Watchtower-Setup-OPFD.exe`. Token + client
  name are baked into the installer; the installer drops them into
  `%ProgramData%\Watchtower\config.json` on first run.
- **Worker**: `cd worker && wrangler deploy`.
- **Dashboard**: pushed to `frank-umbrella/work` → GitHub Pages auto-
  publishes at `frank-umbrella.github.io/work/watchtower/`.

## Open questions (deferred)

- Should the agent also report Hyper-V VM list? (Belarc does — easy add)
- Network LAN map (ARP table) — useful but feels intrusive on client LAN
- Should the dashboard show a side-by-side diff between check-ins so we
  can see software-installed/removed deltas?
- Long-term: graduate from `onboarding@resend.dev` to verified
  `alerts.<umbrella-domain>` Resend sender for proper branding even
  though it only emails us.
