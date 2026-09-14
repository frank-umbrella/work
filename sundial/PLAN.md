# Sundial - hours tracker for client work

Plan v0.2 - 2026-09-14 by Fable 5.1 (design/plan pass). Implementation is a later
Opus job. Nothing here is built yet. Open the design switcher at
`file:///T:/ClaudeCodeRepo/work/sundial/design-preview.html` (direction C is the
chosen one; A and B stay for reference).

**Sundial** is the URL and folder name on purpose: time-adjacent but not obviously
a time clock, so a stranger who finds `frank-umbrella.github.io/work/sundial/`
sees nothing suspicious and the sign-in wall stops them anyway. No hub tile, no
link from anywhere, `noindex, nofollow`. Internal tool for your own hours while
a replacement provider is chosen.

---

## 1. What this is

A single-page web app at `work/sundial/index.html`, kept open on a desktop tab
and installed to your phone's home screen. Pick a client and the kind of work,
hit **Punch In**, add notes as you go, hit **Punch Out**. At the end of the day
copy a clean, email-ready block of the day's hours (per client, with notes and
totals) and paste it into Gmail, or download a CSV / JSON of any date range.

Three things it tracks, in a fixed hierarchy:

- **Client** - who the work is for. Has a contact email, an optional hourly rate,
  a color, and its own list of job types. Clients can be imported and exported
  in bulk (CSV / XLSX) with a downloadable template.
- **Job type** - the sub-category of work under that client ("Remote support",
  "On-site", "Project", "Consulting", "Admin"). New clients are seeded from a
  default list in Settings; add per-client types any time.
- **Entry** - one clocked span: start, end, client, job type, optional project
  label, notes. Entries are what get exported.

"Project" is an optional free-text label on the entry ("M365 migration",
"Printer replacement"). It autocompletes from earlier entries for the same
client so recurring projects stay consistent without another management screen.

## 2. Decisions (settled 2026-09-14)

| Decision | Choice | Why |
|---|---|---|
| Home | `frank-umbrella/work`, folder `sundial/` | Same repo and GitHub Pages site as Watchtower and Backup Audits. Deploys on push like everything else there. |
| Design | **C. Ledger** (white cards, blue accent) | Chosen. Reads as business software, matches Backup Audits' light theme. Dark mode follows the OS like Backup Audits does. |
| Sign-in | Google, `@umbrellaautomation.com` only, **same Firebase project as Watchtower** (`watchtower-6fbe1`) | Zero new setup. Copy the `firebaseConfig`, `ALLOWED_DOMAIN`, `hd` provider parameter, and post-sign-in domain check verbatim from `backups/index.html`. A signed-in employee is signed into all three tools. The Pages origin is already an authorized domain. |
| Storage | **Firestore from v0.1**, collections prefixed `sundial_`, scoped per user | Login exists from day one, and the point is punching in on the phone and exporting on the desktop. Firestore's persistent local cache gives offline punch-in with no extra code. |
| Who sees what | Each user sees only their own clients and entries | It is a personal hours log. Rules gate on `isMSPAdmin()` plus `uid` match, so another employee signing in gets an empty Sundial, not yours. |
| Mobile | Phone first | The Clock screen is designed at 390px wide before anything else. Bottom tab bar under 640px, thumb-sized punch buttons, 16px inputs so iOS does not zoom, safe-area padding, PWA manifest with standalone display. |
| One running entry at a time | Yes, with a **Switch** action | Punching in on a new client auto-punches out the current one. Prevents overlapping time. |
| Raw vs rounded | Store raw seconds; round only at export | Rounding (none / 6 min / 15 min) is an export option and a per-client default. |
| Timer survives reload | Yes | The running entry stores its start timestamp; elapsed is computed, not counted. |
| Manual entries | Yes | Add or edit start and end directly; overlap shows a warning, not a block. |
| Money | Optional, off by default | Rate per client and a "show amounts" toggle in Settings. Hidden everywhere until switched on. Playbook money fields (`$` inside, 2 decimals). |
| Analytics | None | Client names live in it. No GA, no third-party scripts beyond Firebase and lazy-loaded SheetJS. |
| Time format | 12-hour default, 24-hour toggle | Email recipients read "9:02 AM" more easily. |
| Week start | Monday, configurable | Weekly export range follows it. |

## 3. Data model (Firestore, project `watchtower-6fbe1`)

```
/sundial_users/{uid}                          settings doc
  yourName          from Google displayName, editable
  timeFormat        "12h" | "24h"
  weekStart         "mon" | "sun"
  rounding          "none" | "6" | "15"
  defaultJobTypes   ["Remote support","On-site","Project","Consulting","Admin"]
  exportTemplate    "grouped" | "flat"
  showAmounts       false
  columns, sort     saved table layout
  updatedAt

/sundial_users/{uid}/clients/{clientId}
  name, email, color, rate (number|null), archived (bool)
  jobTypes          [{id, name, archived}]
  rounding          null | "none" | "6" | "15"
  createdAt, updatedAt

/sundial_users/{uid}/entries/{entryId}
  clientId, jobTypeId, project (string), notes (string)
  start (Timestamp), end (Timestamp|null)     end=null means running
  day (string "2026-09-14", local)             lets "today" be one equality query
  createdAt, updatedAt
```

Rules to add to `watchtower/firestore.rules` (the shared file, deployed with
Watchtower's `firebase.json`, work account `frank@umbrellaautomation.com`):

```
match /sundial_users/{uid} {
  allow read, write: if isMSPAdmin() && request.auth.uid == uid;
  match /{sub=**} { allow read, write: if isMSPAdmin() && request.auth.uid == uid; }
}
```

Queries: today = `entries where day == "2026-09-14"`; running =
`entries where end == null limit 1`; ranges = `day >= a && day <= b`. The `day`
field avoids a composite index and keeps "today" correct across time zones.

## 4. Screens

Five views. Desktop: top nav like Backup Audits. Phone (under 640px): bottom tab
bar with Clock, Entries, Clients, Export, More.

### Clock (home, phone-first)
- **Now card.** Clocked out: Client select, Job type select (filtered to that
  client), Project field with autocomplete, Notes, big **Punch In**. Unset Client
  and Job type get the amber attention glow.
- Clocked in: big elapsed timer, status pill "Acme Dental / Remote support",
  Project and Notes editable while running (save on blur), **Punch Out** (red)
  and **Switch client** (punch out + fresh Punch In with the client preselected).
  Both buttons are full-width on the phone.
- **Recent chips.** Up to 6 recent client/job pairs. One tap punches in.
- **Today tiles.** Total time, entries, clients, this week.
- **Today table.** Start, End, Duration, Client, Job type, Project, Notes,
  actions. Sortable, Columns manager, card-stack under 640px. Delete confirms
  in a modal.

### Entries
- Same table over Today / Yesterday / This week / Last week / Month / Custom,
  with a Client filter. "Add manual entry" opens the entry modal with start and
  end fields.

### Clients
- Card per client: color dot, name, email, rate (when amounts are on), job type
  chips, entries and hours this month. Archived clients collapse to a footer.
- Toolbar: **Add client**, **Import**, **Export**, **Template**.
- **Client modal** (Add / Edit): Name, Email, Hourly rate (money field, only
  when amounts are on), Color, Rounding override, Job types chip editor. Closes
  only via X, Cancel, Save. Deleting a client with entries is refused; archive.
- **Import** accepts `.csv` or `.xlsx` (SheetJS lazy-loaded on first use, same
  as Backup Audits). Shows a preview modal: rows to create, rows that match an
  existing client by name (case-insensitive) and will be updated, rows with
  problems (missing name, bad email, unknown rounding value). Apply only after
  confirming. Never deletes.
- **Export** writes every client (including archived, flagged) to CSV or XLSX
  with the same columns as the template, so an export re-imports cleanly.
- **Template** downloads a blank `.xlsx` with a `Clients` sheet (headers plus
  two example rows) and a `How to fill` sheet listing each column, whether it is
  required, and the allowed values. Also available as `.csv`.

Template columns:

```
name*        Acme Dental
email        office@acmedental.example
rate         75.00                       blank = no rate
color        #1e6fd9                     blank = auto-assigned
job_types    Remote support | On-site | Project      pipe-separated
rounding     default | none | 6 | 15
archived     no | yes
```

### Export (hours)
- Left: range picker, client filter (All or one), options: Include notes,
  Include project, Group by client, Show amounts (only if enabled), Rounding,
  Template (Grouped / Flat).
- Right: live preview of the exact text, then **Copy as text**, **Copy for
  email**, **Open in email**, **CSV**, **JSON backup**, **Restore from JSON**.
- Every copy shows a top-center toast ("Copied 4h 15m for Sep 14").

### Settings (More on the phone)
- Your name, time format, week start, default rounding, default job types,
  export template, show amounts, theme (System / Light / Dark), Backup /
  Restore, Erase my data (typed-confirm modal), Sign out.

## 5. Export formats

### Copy as text (grouped, default)

```
Hours for Monday, September 14, 2026
Your Name

Acme Dental
  9:02 AM - 10:47 AM   1h 45m   Remote support (Printer replacement) - Printer queue stuck on front desk PC; cleared spooler, updated driver.
  1:15 PM -  2:00 PM   0h 45m   On-site - Replaced UPS battery in server closet.
  Subtotal 2h 30m

Northside Legal
  10:55 AM - 12:40 PM  1h 45m   Project (M365 migration) - Moved 6 mailboxes, verified Outlook profiles.
  Subtotal 1h 45m

Total 4h 15m
```

Flat template is one line per entry with the client in front, for pasting into
a spreadsheet. With amounts on, subtotal lines gain `- $187.50` and a Total
amount line is added.

### Copy for email
The same content as an HTML table (Client, Time, Duration, Job type, Project,
Notes, bold subtotal rows) written to the clipboard as `text/html` with the
plain text as `text/plain`. Gmail and Outlook paste the table.

### Open in email
`mailto:` with Subject "Hours for Mon, Sep 14, 2026" and the plain text as the
body. To is prefilled from the client's email when one client is selected.

### CSV (hours)
One row per entry: `date, start, end, duration_hours, duration_hm, client,
job_type, project, notes, rate, amount`. UTF-8 with BOM for Excel.

### JSON backup
Settings, clients, and entries for the signed-in user with `schema: 1`.
Restore validates the schema and asks before merging.

## 6. Playbook standards checklist

- Semver in title, `<meta name="version">`, visible in the footer.
- Favicon (SVG + PNG), OG card at an absolute URL, apple-touch-icon,
  theme-color, `manifest.json` with standalone display, `noindex, nofollow`.
- No hub tile, no link from any page. The URL is shared by hand only.
- Toasts top-center, passive confirmations only. Decisions use modals.
- Form modals close only via X / Cancel / confirm, never backdrop.
- No horizontal scrollbars. Tables card-stack under 640px. `minmax(0,1fr)`.
- Tables sortable (asc/desc/reset) with a Columns manager, layout saved.
- Unset decision selects get the amber attention glow.
- Money fields: `$` inside, 2 decimals on blur. Hidden unless amounts are on.
- Fields wide enough for their values; dates never truncate.
- Tooltips on every non-obvious field (why, not what).
- No repo link in the UI. No emojis in code. No real client data in commits.
- README changelog updated in the same commit as behavior changes.

## 7. Build phases

### v0.1.0 - punch, clients, copy
1. Scaffold `index.html` (single file like Backup Audits), `manifest.json`,
   icons, `README.md`. Firebase v12 ES modules, no build step.
2. Auth block copied from `backups/index.html`; sign-in wall with the same
   "Restricted to @umbrellaautomation.com" line.
3. Firestore layer per section 3, persistent local cache enabled, seeded
   default job types on first sign-in. Add the rules block to
   `watchtower/firestore.rules` and deploy.
4. Clock view: punch in/out/switch, running timer from stored start, recent
   chips, today tiles, today table.
5. Clients view, client modal, job type chip editor, Import / Export /
   Template (CSV and XLSX).
6. Entry modal (manual add / edit), overlap warning, delete confirm.
7. Export view: text preview, Copy as text, CSV, JSON backup / restore.
8. Settings view. Phone pass at 390px, bottom tab bar, PWA install check on
   iPhone. Playbook pass from section 6.

### v0.2.0 - sending
1. Copy for email (rich clipboard).
2. Open in email with per-client To.
3. Entries view with ranges and client filter.
4. Rounding (default, per-client override, export option).
5. Amounts behind the Settings toggle.

### v0.3.0 - polish
1. Weekly summary view (hours per client per day).
2. Project autocomplete improvements, archived job types cleanup.
3. Dark mode pass.

## 8. Still open

Nothing blocking. Two defaults you can change later:

- Amounts start **off**. Turn on in Settings if you want rates in exports.
- One running entry at a time. If you ever need overlapping entries, it is a
  Settings toggle to add, not a redesign.

## 9. Files

```
work/sundial/
  PLAN.md                 this file
  design-preview.html     switcher (C chosen; A and B kept for reference)
  (after approval)
  index.html  manifest.json  README.md
  favicon.svg  favicon-32.png  apple-touch-icon.png  og-image.png  ua-logo.svg
```
