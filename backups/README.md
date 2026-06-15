# Backup Audits

Internal tool for Umbrella Automation employees to submit and track **backup
audits** for client servers — the digital replacement for the
`Backup Audits.xlsx` spreadsheet.

Live: <https://frank-umbrella.github.io/work/backups/>

## What it does

- **Google sign-in, restricted to `@umbrellaautomation.com`.** It shares
  Watchtower's login — the **same Firebase project** (`watchtower-6fbe1`), so
  a signed-in employee is signed into both. Nobody else can see anything.
- **Submit / edit audits** per server or workstation. A short **Core** form
  (client, server, auditor, date, priority, backup solutions, last backup,
  drive state, recovery media, errors, notes) plus an expandable **Advanced**
  section covering everything the spreadsheet tracked: Veeam agent state,
  Carbonite, Windows Server Backup disks + rotation, iDRAC / OpenManage,
  credentials, system state, and the important backup paths.
- **Dashboard** with summary stats, search, client / auditor / priority
  filters, a "Focus only" toggle, a column chooser, and sortable columns. The
  table wraps to fit the screen — no horizontal scrolling. Click any row for
  the full detail drawer.
- **Import / export** — pull rows in from a filled `.xlsx` or `.csv`, export
  the current view to Excel or CSV, and download a **blank template** (`.xlsx`
  with a "How to fill" sheet listing the allowed values). Powered by SheetJS,
  lazy-loaded only when used.
- **Light / dark theme** toggle (remembers your choice; defaults to your OS
  preference).
- **Activity log** — every create / edit / delete / import, with a per-field
  diff. Visible only to an owner-managed allowlist (Settings tab).
- **End-of-day email digest** of all changes, sent to
  `frank@umbrellaautomation.com` by `backups-worker` (see `worker/`).

## Architecture

- `index.html` — single-file SPA. Firebase Auth (Google) + Firestore.
  No build step.
- Firestore collections (in `watchtower-6fbe1`): `/backup_audits`,
  `/backup_activity`, `/backup_settings/activity_viewers`, `/backup_users`.
- Security rules live in **`../watchtower/firestore.rules`** (a Firebase
  project has one ruleset; Backups' rules were appended there). Deploy from
  `work/watchtower` with the account that owns `watchtower-6fbe1`.
- `worker/` — `backups-worker`, a Cloudflare Worker on the Umbrella account
  that emails the daily digest. See `worker/README.md`.

## Access control

- Any verified `@umbrellaautomation.com` user can read and submit audits.
- The **Activity** tab is gated: `frank@umbrellaautomation.com` (owner) always
  sees it and is the only one who can add/remove other viewers via **Settings**.
- Passwords entered in the Advanced section are masked in the table and detail
  drawer (click "reveal" to show), and never displayed in the digest email.

## Deploying

The SPA is static — pushing to `frank-umbrella/work` publishes it via GitHub
Pages. Two server-side pieces are deployed separately:

1. **Firestore rules** (required before reads/writes work):
   ```sh
   cd work/watchtower
   firebase deploy --only firestore:rules --project watchtower-6fbe1
   ```
   Must be run by the Google account that owns `watchtower-6fbe1`.
2. **Digest worker**: see `worker/README.md`.

## Changelog

### v0.5.0 — 2026-06-15
- **Clients editor** in Settings: rename a client or set its ID; the change
  applies to every audit for that client (and is logged to Activity).
- **30-day staleness highlight**: the WSB "Last local backup", the Veeam "Last
  backup", the rotation-disk copies, and the OMSA/iDRAC "Drive health last
  checked" date cells turn amber when older than 30 days.
- **Health highlight**: drive-state / OME-state / system-state cells turn red
  when the value reads as a problem (failure, non-critical, predicted, etc.)
  and green when healthy.
- **Windows icon** marks every Windows Server Backup / local column (the sheet's
  "LOCAL" section) in the table headers and detail drawer.
- (Last WSB backup was already a default column.)

### v0.4.1 — 2026-06-15
Columns now size to their content (auto layout): short columns like Client ID,
dates, and status shrink to fit, while wide columns (backup-solution tags, long
free text) are capped so their content wraps instead of stretching the table.
Still fits the width without a horizontal scrollbar.

### v0.4.0 — 2026-06-15
- **Reorder columns by drag-and-drop.** A "Reorder" button unlocks the table
  headers so you can drag them into the order you want; click "Done" to lock.
  The order saves to your profile. While locked, headers sort as before.
- Fixed the **light theme** not recoloring the top bar / active tab (they used
  hardcoded dark values; now themed).

### v0.3.0 — 2026-06-15
- **Per-audit export** from the detail drawer: branded **PDF** (Umbrella
  Automation logo), **Excel**, **CSV**, and a **screenshot** (PNG). Passwords
  are masked in the PDF/screenshot.
- **Column layout + theme now save to your profile** (`/backup_users/{uid}`),
  so they follow your account across devices (localStorage still paints first).
- **Colour-coded backup-solution tags** (Veeam Cloud, Veeam USB, Carbonite,
  Windows Server Backup, None).
- Imported the **Client ID** column from the sheet and turned it on by default.
- Disambiguated the backup dates: **"Last backup (Veeam)"** (Veeam Cloud) vs
  **"Last local backup [Disk 1]"** (Windows Server Backup) — both shown by
  default — matching the sheet's grouped headers.

### v0.2.1 — 2026-06-15
Dropped the spreadsheet-only "Focus / needs attention" data column. In its
place, every row has a checkbox in a leading column that **highlights the row**
(amber tint + left bar) when ticked — toggled inline without opening the record.
The "Highlighted only" filter and stat still work off the same flag.

### v0.2.0 — 2026-06-15
Spreadsheet round-trip and polish. Added Excel/CSV import, Excel/CSV export,
and a downloadable blank template (with a "How to fill" sheet) so the tool can
fully replace passing the `.xlsx` around — people can still work in Excel when
they want and load it back in. Added a light/dark theme toggle. Fixed the
dashboard's horizontal scrollbar (the table now wraps to fit any width).
Added a proper favicon set, an Open Graph share image, and theme-color meta.

### v0.1.0 — 2026-06-15
Initial release. Replaces the `Backup Audits.xlsx` "Data" sheet with a
collaborative web tool so any employee can submit audits and everyone sees a
live dashboard instead of passing a spreadsheet around. Built on Watchtower's
existing Google login so there's nothing new to authorize. Adds a
viewer-restricted Activity log and an end-of-day digest email — the two things
a shared spreadsheet couldn't do.
