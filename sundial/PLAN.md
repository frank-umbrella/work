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
| Running entries | One at a time by default, with a **Switch** action. Jobs flagged **Can run alongside** may overlap. | Prevents accidental overlapping time, while still allowing "migration running in the background while I take a call". The flag lives on the client (default for its job types) and per job type (override). |
| Billable | Flag on the client (default) and per job type (override); the entry copies it at punch-in and can be changed per entry | Exports can be filtered to billable only, subtotals split billable vs non-billable, and amounts (when on) apply only to billable time. Internal admin under a paying client stays visible but unbilled. |
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
  billable          true | false                default for this client's job types
  allowConcurrent   true | false                default for this client's job types
  jobTypes          [{id, name, archived, billable: null|bool, allowConcurrent: null|bool}]
                    null on a job type means "use the client's value"
  rounding          null | "none" | "6" | "15"
  createdAt, updatedAt

/sundial_users/{uid}/entries/{entryId}
  clientId, jobTypeId, project (string), notes (string)
  billable          bool    copied from the job type / client at punch-in, editable per entry
  start (Timestamp), end (Timestamp|null)     end=null means running
  day (string "2026-09-14", local)             lets "today" be one equality query
  createdAt, updatedAt
```

Effective flags for a job type: its own value if set, otherwise the client's.
Settings holds the defaults applied to **new** clients (`newClientBillable`,
default true; `newClientAllowConcurrent`, default false).

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
  Both buttons are full-width on the phone. A non-billable running entry shows
  a grey "non-billable" tag in the pill.
- **Running alongside.** Punching in while something is running is allowed
  without punching out when the new job is flagged Can run alongside, or when
  every running job is. Otherwise the Punch In button reads **Switch** and
  asks. Each extra running entry appears as a compact strip under the main
  timer with its own elapsed time and Punch Out. The main timer is the most
  recently started entry; tapping a strip swaps it to the top. Recent chips
  follow the same rule.
- **Recent chips.** Up to 6 recent client/job pairs. One tap punches in.
- **Today tiles.** Total time, billable time, entries, clients, this week.
- **Today table.** Start, End, Duration, Client, Job type, Project, Notes, and
  Edit / Duplicate / Delete on every row (see "Per-entry actions" below).
  Sortable, Columns manager, card-stack under 640px.

### Per-entry actions (every punch, every table, every screen size)
Each row in the Today and Entries tables has **Edit**, **Duplicate**, and
**Delete**. On the phone the row is a card and the three actions sit in its
footer as full-width-friendly buttons; nothing is hidden behind a swipe.

- **Edit** opens the entry modal with every field editable: Client, Job type,
  Project, Notes, Billable toggle, Start date + time, End date + time. Duration
  recalculates as you type. Changing the job type resets Billable to that job
  type's effective value; you can flip it again afterwards. The running entry can be edited too (fix a late punch-in by moving
  Start; End stays blank while it runs). Overlap with another entry shows an
  inline warning with the conflicting entry named; Save is still allowed.
- **Duplicate** opens the entry modal prefilled with the source entry's Client,
  Job type, Project, and Notes, with Start set to now and End blank. Two
  buttons at the bottom: **Punch in now** (saves it as the running entry, after
  punching out anything already running) and **Save with times** (you set Start
  and End yourself, for "same job as yesterday, 9 to 11"). Duplicate never
  touches the original.
- **Delete** confirms in a modal that shows the entry's client, times, and
  duration. Deleting the running entry is allowed and clears the clock.

The entry modal is the same one "Add manual entry" opens, so there is one form
to learn. Client select filters the Job type select; the Project field
autocompletes from that client's history.

### Entries
- Same table over Today / Yesterday / This week / Last week / Month / Custom,
  with a Client filter. "Add manual entry" opens the entry modal with start and
  end fields.

### Clients
- Card per client: color dot, name, email, rate (when amounts are on), job type
  chips, entries and hours this month. Archived clients collapse to a footer.
- Toolbar: **Add client**, **Import**, **Export**, **Template**.
- **Client modal** (Add / Edit): Name, Email, Hourly rate (money field, only
  when amounts are on), Color, Rounding override, two client-level toggles
  (**Billable**, **Can run alongside other jobs**), and the Job types chip
  editor. Each job type chip carries two small markers that cycle Use client
  default / Yes / No: a `$` for billable and a `||` for can-run-alongside.
  Tooltips explain both. Closes only via X, Cancel, Save. Deleting a client
  with entries is refused; archive.
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
billable     yes | no                    client default, blank = yes
concurrent   yes | no                    can run alongside other jobs, blank = no
job_types    Remote support | On-site | Project      pipe-separated
             per-type overrides in brackets: Admin[nonbillable] | Monitoring[concurrent] | Retainer[nonbillable,concurrent]
rounding     default | none | 6 | 15
archived     no | yes
```

### Export (hours)
- Left: range picker, client filter (All or one), **Billable filter** (All /
  Billable only / Non-billable only), options: Include notes, Include project,
  Group by client, Show amounts (only if enabled), Rounding, Template
  (Grouped / Flat).
- With the filter on All, non-billable lines carry a `[non-billable]` tag and
  each subtotal splits into billable and non-billable when both exist. With
  Billable only, the output is clean for sending to a client. Amounts, when on,
  are computed from billable time only.
- Overlapping time is counted in full for each entry. When the range contains
  overlap, a final line reads "Includes 0h 30m of time logged alongside another
  job" so the total is never a surprise.
- Right: live preview of the exact text, then **Copy as text**, **Copy for
  email**, **Open in email**, **CSV**, **JSON backup**, **Restore from JSON**.
- Every copy shows a top-center toast ("Copied 4h 15m for Sep 14").

### Settings (More on the phone)
- Your name, time format, week start, default rounding, default job types,
  export template, show amounts, theme (System / Light / Dark), Backup /
  Restore, Erase my data (typed-confirm modal), Sign out.
- **Defaults for new clients**: Billable (on) and Can run alongside other jobs
  (off). Changing these never touches existing clients; edit those in the
  client modal.

## 5. Export formats

### Copy as text (grouped, default)

```
Hours for Monday, September 14, 2026
Your Name

Acme Dental
  9:02 AM - 10:47 AM   1h 45m   Remote support (Printer replacement) - Printer queue stuck on front desk PC; cleared spooler, updated driver.
  1:15 PM -  2:00 PM   0h 45m   On-site - Replaced UPS battery in server closet.
  2:00 PM -  2:20 PM   0h 20m   Admin [non-billable] - Updated asset list.
  Subtotal 2h 50m (billable 2h 30m, non-billable 0h 20m)

Northside Legal
  10:55 AM - 12:40 PM  1h 45m   Project (M365 migration) - Moved 6 mailboxes, verified Outlook profiles.
  Subtotal 1h 45m

Total 4h 35m (billable 4h 15m, non-billable 0h 20m)
```

The same day with the Billable only filter drops the Admin line and the
splits, giving a clean block to forward to the client.

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
job_type, project, notes, billable, rate, amount`. UTF-8 with BOM for Excel.

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
4. Clock view: punch in/out/switch, running timer from stored start, running
   alongside (extra running strips, the Can-run-alongside rule), recent chips,
   today tiles, today table.
5. Clients view, client modal with Billable and Can-run-alongside toggles,
   job type chip editor with per-type overrides, Import / Export / Template
   (CSV and XLSX) including the two flag columns.
6. Entry modal (manual add / edit / duplicate with "Punch in now" and "Save
   with times"), overlap warning, delete confirm, edit of the running entry.
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
- New clients start **Billable: on** and **Can run alongside: off**. Flip
  either per client or per job type in the client modal.

## 9. Files

```
work/sundial/
  PLAN.md                 this file
  design-preview.html     switcher (C chosen; A and B kept for reference)
  (after approval)
  index.html  manifest.json  README.md
  favicon.svg  favicon-32.png  apple-touch-icon.png  og-image.png  ua-logo.svg
```
