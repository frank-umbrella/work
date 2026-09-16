# Sundial - hours tracker for client work

Plan v0.3 - 2026-09-14 by Fable 5.1 (design/plan pass). Implementation is a later
Opus job. Nothing here is built yet. Open the design switcher at
`file:///T:/ClaudeCodeRepo/work/sundial/design-preview.html` (direction C is the
chosen one; A and B stay for reference).

**Sundial** is the URL and folder name on purpose: time-adjacent but not obviously
a time clock, so a stranger who finds `frank-umbrella.github.io/work/sundial/`
sees nothing suspicious and the sign-in wall stops them anyway. No hub tile, no
link from anywhere, `noindex, nofollow`. Internal tool for your own hours while
a replacement provider is chosen. Designed so a team tier can be added later
without rework (section 10).

Terminology note (2026-09-14, after v0.1.1 shipped): the built app says **Start**
and **Stop** wherever this plan says Punch In and Punch Out. "Punch" reads like a
factory time clock; this is an hours log by client. Switch keeps its name. The
plan text below is left as written.

Reference products looked at for views and features: Harvest (day list, week
grid, calendar, team utilization), Clockify (calendar), Workyard and Jibble
(GPS time cards, shift list). Sundial borrows the views, not the GPS.

---

## 1. What this is

A single-page web app at `work/sundial/index.html`, kept open on a desktop tab
and installed to your phone's home screen. Pick a client and the kind of work,
hit **Punch In**, add notes as you go, hit **Punch Out**. At the end of the day
copy a clean, email-ready block of the day's hours (per client, with notes,
ticket numbers, and totals) and paste it into Gmail, or download a CSV / XLSX /
JSON of any date range. Works offline; syncs when it can.

Three things it tracks, in a fixed hierarchy:

- **Client** - who the work is for. Has a contact email, an optional hourly rate,
  a color, an optional ticket URL pattern, and its own list of job types. Clients
  can be imported and exported in bulk (CSV / XLSX) with a downloadable template.
- **Job type** - the sub-category of work under that client ("Remote support",
  "On-site", "Project", "Travel", "Admin"). Carries the flags: billable, can run
  alongside, travel (mileage), and an optional time limit.
- **Entry** - one clocked span: start, end, client, job type, optional project
  label, optional ticket number, notes, billable flag, and miles when the job
  type is travel. Entries are what get exported.

"Project" is an optional free-text label on the entry ("M365 migration",
"Printer replacement"). It autocompletes from earlier entries for the same
client so recurring projects stay consistent without another management screen.

## 2. Decisions (settled 2026-09-14)

| Decision | Choice | Why |
|---|---|---|
| Home | `frank-umbrella/work`, folder `sundial/` | Same repo and GitHub Pages site as Watchtower and Backup Audits. Deploys on push like everything else there. |
| Design | **C. Ledger** (white cards, blue accent) | Chosen. Reads as business software, matches Backup Audits' light theme. Dark mode follows the OS. |
| Sign-in | Google, `@umbrellaautomation.com` only, **same Firebase project as Watchtower** (`watchtower-6fbe1`) | Zero new setup. Copy the `firebaseConfig`, `ALLOWED_DOMAIN`, `hd` provider parameter, and post-sign-in domain check verbatim from `backups/index.html`. The Pages origin is already an authorized domain. |
| Storage | **Firestore from v0.1**, collections prefixed `sundial_`, scoped per user | Login exists from day one, and the point is punching in on the phone and exporting on the desktop. |
| Offline | **First-class.** Service worker caches the app shell; Firestore persistent cache holds data; every write goes local first | Punching in with no signal must work, and the app must open with no signal. See section 6. |
| Who sees what | Each user sees only their own clients and entries | Personal hours log. Rules gate on `isMSPAdmin()` plus `uid` match. A team tier later adds a manager role (section 10). |
| Mobile | Phone first | Clock screen designed at 390px first. Bottom tab bar under 640px, thumb-sized punch buttons, 16px inputs so iOS does not zoom, safe-area padding, PWA manifest with standalone display. |
| Views | Day list, Week grid, Calendar | The three Harvest timesheet views. Day list is the phone default; Week grid is the desktop review and quick-fill view; Calendar shows where the day went and makes overlaps visible. |
| Running entries | One at a time by default, with a **Switch** action. Jobs flagged **Can run alongside** may overlap. | Prevents accidental overlapping time while allowing "migration running in the background while I take a call". Flag on the client (default) and per job type (override). |
| Billable | Flag on the client (default) and per job type (override); the entry copies it at punch-in and can be changed per entry | Exports filter to billable only, subtotals split, amounts apply only to billable time. |
| Ticket number | Optional free-text field on every entry; the client can hold a URL pattern that turns it into a link | Most MSP work hangs off a ticket. The pattern makes `5421` clickable in the table and the email export. Ties into the Help Desk project later. |
| Travel and mileage | Job types flagged **Travel** ask for miles at punch-out; a mileage export exists for expense reports | Drive time is billable hours plus a reimbursable expense; capturing both at the same moment avoids the end-of-month reconstruction. |
| Time-limit warnings | Optional per job type: warn at X, hard limit at Y; the hard limit asks for a reason to continue and logs it on the entry | Support tickets should not quietly become four-hour jobs. Single-user v1 is self-enforcing; manager approval is the team-tier version. |
| Raw vs rounded | Store raw seconds; round only at export | Rounding (none / 6 min / 15 min) is an export option and a per-client default. Built in v0.2.0: the Export control sits on the Settings default, where a per-client override wins; tapping a different increment pins it on every client for that export, and tapping the default increment again releases it. Each entry rounds half up with a one-increment floor, then the rounded durations are added up, so the printed subtotals always add to the printed total. |
| Timer survives reload | Yes | Running entry stores its start timestamp; elapsed is computed, not counted. |
| Manual entries | Yes | Add or edit start and end directly; overlap shows a warning, not a block. |
| Money | Optional, off by default | Rate per client and a "show amounts" toggle in Settings. Playbook money fields (`$` inside, 2 decimals). |
| Analytics | None | Client names live in it. No GA, no third-party scripts beyond Firebase and lazy-loaded SheetJS. |
| Time format | 12-hour default, 24-hour toggle | Email recipients read "9:02 AM" more easily. |
| Week start | Sunday by default, any weekday in Settings (changed from Monday in v0.1.9) | Weekly views and export ranges follow it. |

## 3. Data model (Firestore, project `watchtower-6fbe1`)

```
/sundial_users/{uid}                          settings doc
  yourName          from Google displayName, editable
  timeFormat        "12h" | "24h"
  weekStart         "mon" | "sun"
  rounding          "none" | "6" | "15"
  defaultJobTypes   ["Remote support","On-site","Project","Travel","Admin"]
  exportTemplate    "grouped" | "flat"
  showAmounts       false
  newClientBillable         true
  newClientAllowConcurrent  false
  weeklyCapacityHours       40        drives the utilization bar
  mileageRate       0.70              $/mile for the mileage export; set yearly
  defaultView       "day" | "week" | "calendar"
  columns, sort     saved table layout
  updatedAt

/sundial_users/{uid}/clients/{clientId}
  name, email, color, rate (number|null), archived (bool)
  billable          true | false                default for this client's job types
  allowConcurrent   true | false                default for this client's job types
  ticketUrl         "" | "https://helpdesk.example/tickets/{n}"   {n} = ticket number
  jobTypes          [{id, name, archived,
                      billable: null|bool, allowConcurrent: null|bool,
                      travel: bool,
                      limit: null | {warnMin, hardMin}}]
                    null on a job type means "use the client's value"
  rounding          null | "none" | "6" | "15"
  createdAt, updatedAt

/sundial_users/{uid}/entries/{entryId}
  clientId, jobTypeId, project (string), ticket (string), notes (string)
  billable          bool    copied from the job type / client at punch-in, editable per entry
  miles             number|null      only when the job type is travel
  mileageNote       string           "Office to Acme Dental and back"
  limitOverride     null | {at: Timestamp, reason: string}   logged when the hard limit was passed
  start (Timestamp), end (Timestamp|null)     end=null means running
  day (string "2026-09-14", local)             lets "today" be one equality query
  createdAt, updatedAt
```

Effective flags for a job type: its own value if set, otherwise the client's.

Rules to add to `watchtower/firestore.rules` (the shared file, deployed with
Watchtower's `firebase.json`, work account `frank@umbrellaautomation.com`):

```
match /sundial_users/{uid} {
  allow read, write: if isMSPAdmin() && request.auth.uid == uid;
  match /{sub=**} { allow read, write: if isMSPAdmin() && request.auth.uid == uid; }
}
```

Queries: today = `entries where day == "2026-09-14"`; running =
`entries where end == null`; ranges = `day >= a && day <= b`. The `day` field
avoids a composite index and keeps "today" correct across time zones.

## 4. Screens

Five views. Desktop: top nav like Backup Audits. Phone (under 640px): bottom tab
bar with Clock, Timesheet, Clients, Export, More. A small **sync pill** sits in
the header on every screen: Synced / Offline, 3 pending / Syncing.

### Clock (home, phone-first)
- **Now card.** Clocked out: Client select, Job type select (filtered to that
  client), Ticket # field, Project field with autocomplete, Notes, big
  **Punch In**. Unset Client and Job type get the amber attention glow.
- Clocked in: big elapsed timer, status pill "Acme Dental / Remote support /
  #5421", Ticket, Project and Notes editable while running (save on blur),
  **Punch Out** (red) and **Switch client** (punch out + fresh Punch In with the
  client preselected). Both buttons are full-width on the phone. A non-billable
  running entry shows a grey "non-billable" tag in the pill. A job type with a
  time limit shows "1h 12m of 2h" under the timer.
- **Running alongside.** Punching in while something is running is allowed
  without punching out when the new job is flagged Can run alongside, or when
  every running job is. Otherwise the Punch In button reads **Switch** and
  asks. Each extra running entry appears as a compact strip under the main
  timer with its own elapsed time and Punch Out. Tapping a strip swaps it to
  the top. Recent chips follow the same rule.
- **Recent chips.** Up to 6 recent client/job pairs. One tap punches in.
- **Today tiles.** Total time, billable time, entries, clients, this week.
- **Today table.** Start, End, Duration, Client, Job type, Ticket, Project,
  Notes, and Edit / Duplicate / Delete on every row. Sortable, Columns manager,
  card-stack under 640px.

### Per-entry actions (every punch, every table, every screen size)
Each row in the Today and Timesheet tables has **Edit**, **Duplicate**, and
**Delete**. On the phone the row is a card and the three actions sit in its
footer; nothing is hidden behind a swipe.

- **Edit** opens the entry modal with every field editable: Client, Job type,
  Ticket #, Project, Notes, Billable toggle, Miles (travel job types only),
  Start date + time, End date + time. Duration recalculates as you type.
  Changing the job type resets Billable to that job type's effective value.
  The running entry can be edited too (fix a late punch-in by moving Start).
  Overlap with another entry shows an inline warning naming the conflicting
  entry; Save is still allowed.
- **Duplicate** opens the entry modal prefilled with the source entry's Client,
  Job type, Ticket #, Project, and Notes, with Start set to now and End blank.
  Two buttons: **Punch in now** (saves it as the running entry, after punching
  out anything already running unless alongside is allowed) and **Save with
  times** (you set Start and End yourself). Duplicate never touches the
  original.
- **Delete** confirms in a modal that shows the entry's client, times, and
  duration. Deleting the running entry is allowed and clears the clock.

The entry modal is the same one "Add manual entry" opens, so there is one form
to learn.

### Timesheet (three views, one range picker)
Range picker with previous / next arrows and a date button (Today / This week
/ Custom), a Client filter, and a **Day / Week / Calendar** segmented control.
The chosen view is remembered per device.

- **Day list** (phone default). Same layout as Harvest's day view: a strip of
  seven day chips across the top, each with its date and total, the selected
  day underlined. Below it, one row per entry with client, job type, ticket,
  project, notes, duration, and a Start button that duplicates the entry as a
  new running one (Punch in now). The running entry's row is tinted and its
  button reads Stop. Day total at the bottom.
- **Week grid** (desktop review view). Harvest's week grid: one row per
  distinct client + job type (+ ticket when present) used that week, seven
  day columns, a cell per day showing that day's total for the row. Row
  totals on the right, column totals at the bottom, week total in the corner.
  **Cells are editable:** typing `1:30` into an empty cell creates a manual
  entry for that day (start defaults to 9:00 AM, adjustable later); typing
  into a cell that already has one entry adjusts that entry's end; a cell
  with several entries opens the day list for that cell instead of editing
  in place. **Add row** picks a client and job type. This is how a missed
  day gets filled in from memory in under a minute.
- **Calendar** (where did the day go). A time axis down the left, one column
  per day (a single column on the phone, seven on desktop), entries drawn as
  colored blocks by client with the job type and ticket inside. Entries that
  run alongside another sit side by side in the same column, so overlaps are
  visible at a glance. The running entry grows live. Drag the bottom edge to
  change End, drag the block to move it, click empty space to add a manual
  entry at that time. Blocks under 15 minutes show only the color.

  Built in v0.2.0. Two decisions the plan left open: the axis defaults to
  6 AM - 8 PM and stretches to hold any entry outside it *and* to keep the
  now line visible, so a late night is not silently clipped off the bottom;
  and drag editing is desktop only (blocks are tap-to-edit under 860px),
  because a drag handle competes with scrolling on a touch screen. The
  running entry is never draggable - it has no end to move.
  Built in v0.2.0 with three decisions the plan did not settle. A cell holding
  a **running** timer is read-only like a multi-entry cell, because setting an
  end time from a grid would silently stop the clock. An empty typing box is
  left alone rather than treated as a delete, so a stray click cannot remove
  time. And the chosen view is remembered in `localStorage` per device rather
  than in the account, so the phone can hold the day list while the desktop
  holds the week grid; `defaultView` in Settings is what a device that has
  never chosen starts on.

- **Utilization bar.** Above the Week grid and Calendar: "This week 21h 40m
  of 40h" with a stacked bar, billable in the accent blue and non-billable in
  the pale blue, against the weekly capacity from Settings. Same idea as
  Harvest's team capacity bar, for one person. The team tier reuses it per
  person.

### Clients
- Card per client: color dot, name, email, rate (when amounts are on), ticket
  URL indicator, job type chips, entries and hours this month. Archived
  clients collapse to a footer.
- Toolbar: **Add client**, **Import**, **Export**, **Template**.
- **Client modal** (Add / Edit): Name, Email, Hourly rate (money field, only
  when amounts are on), Color, Rounding override, **Ticket URL pattern**
  (tooltip: "Paste a ticket link and replace the number with {n}"), two
  client-level toggles (**Billable**, **Can run alongside other jobs**), and
  the Job types chip editor. Each chip carries markers that cycle Use client
  default / Yes / No: `$` for billable, `||` for can-run-alongside, plus a
  car icon toggle for **Travel** and a clock icon that opens the **Time
  limit** popover (Warn at, Hard limit). Closes only via X, Cancel, Save.
  Deleting a client with entries is refused; archive.
- **Import** accepts `.csv` or `.xlsx` (SheetJS lazy-loaded on first use, same
  as Backup Audits). Preview modal: rows to create, rows that match an
  existing client by name (case-insensitive) and will be updated, rows with
  problems. Apply only after confirming. Never deletes.
- **Export** writes every client (including archived, flagged) to CSV or XLSX
  in the template's columns, so an export re-imports cleanly.
- **Template** downloads a blank `.xlsx` with a `Clients` sheet (headers plus
  two example rows) and a `How to fill` sheet listing each column, whether it
  is required, and the allowed values. Also available as `.csv`.

Template columns:

```
name*        Acme Dental
email        office@acmedental.example
rate         75.00                       blank = no rate
color        #1e6fd9                     blank = auto-assigned
billable     yes | no                    client default, blank = yes
concurrent   yes | no                    can run alongside other jobs, blank = no
ticket_url   https://helpdesk.example/tickets/{n}
job_types    Remote support | On-site | Project      pipe-separated
             per-type flags in brackets:
             Admin[nonbillable] | Monitoring[concurrent] | Travel[travel] | Support Ticket[limit=105/120]
             limit=warn minutes/hard minutes
rounding     default | none | 6 | 15
archived     no | yes
```

### Export (hours and mileage)
- Left: range picker, client filter (All or one), **Billable filter** (All /
  Billable only / Non-billable only), options: Include notes, Include project,
  Include ticket #, Group by client, Show amounts (only if enabled), Rounding,
  Template (Grouped / Flat).
- With the filter on All, non-billable lines carry a `[non-billable]` tag and
  each subtotal splits into billable and non-billable when both exist. With
  Billable only, the output is clean for sending to a client. Amounts, when on,
  are computed from billable time only.
- Overlapping time is counted in full for each entry. When the range contains
  overlap, a final line reads "Includes 0h 30m of time logged alongside another
  job" so the total is never a surprise.
- Right: live preview of the exact text, then **Copy as text**, **Copy for
  email**, **Open in email**, **CSV**, **XLSX**, **JSON backup**, **Restore
  from JSON**.
- **Mileage** tab on the same screen: the range's travel entries as a table
  (date, client, ticket, from/to note, miles, amount at the mileage rate),
  a total line, and Copy / CSV / XLSX buttons. This is the expense report
  attachment.
- Every copy shows a top-center toast ("Copied 4h 15m for Sep 14").

### Settings (More on the phone)
- Your name, time format, week start, default rounding, default job types,
  export template, show amounts, weekly capacity hours, mileage rate, default
  timesheet view, theme (System / Light / Dark), Backup / Restore, Erase my
  data (typed-confirm modal), Sign out.
- **Defaults for new clients**: Billable (on) and Can run alongside other jobs
  (off). Changing these never touches existing clients.
- **Offline** panel: cache status, pending writes count, "Retry sync now",
  and a "Clear local cache and reload" button for when something looks stale.

## 5. Export formats

### Copy as text (grouped, default)

```
Hours for Monday, September 14, 2026
Your Name

Acme Dental
  9:02 AM - 10:47 AM   1h 45m   Remote support #5421 (Printer replacement) - Printer queue stuck on front desk PC; cleared spooler, updated driver.
  1:15 PM -  2:00 PM   0h 45m   On-site #5430 - Replaced UPS battery in server closet.
  2:00 PM -  2:20 PM   0h 20m   Admin [non-billable] - Updated asset list.
  Subtotal 2h 50m (billable 2h 30m, non-billable 0h 20m)

Northside Legal
  10:55 AM - 12:40 PM  1h 45m   Project (M365 migration) - Moved 6 mailboxes, verified Outlook profiles.
  Subtotal 1h 45m

Total 4h 35m (billable 4h 15m, non-billable 0h 20m)
```

The same day with the Billable only filter drops the Admin line and the
splits, giving a clean block to forward to the client. Ticket numbers become
links in the email (HTML) version when the client has a ticket URL pattern.

Flat template is one line per entry with the client in front, for pasting into
a spreadsheet. With amounts on, subtotal lines gain `- $187.50` and a Total
amount line is added.

### Copy for email
The same content as an HTML table (Client, Time, Duration, Job type, Ticket,
Project, Notes, bold subtotal rows) written to the clipboard as `text/html`
with the plain text as `text/plain`. Gmail and Outlook paste the table.

Built in v0.2.0 with two changes from the list above. A **Date** column is
added in front when the range covers more than one day, matching what the text
export already does - a week's table with no dates is unreadable. And an
**Amount** column is added at the end when amounts are on, with the subtotal
and total amounts in that column rather than appended to the label.

### Open in email
`mailto:` with Subject "Hours for Mon, Sep 14, 2026" and the plain text as the
body. To is prefilled from the client's email when one client is selected.

### CSV / XLSX (hours)
One row per entry: `date, start, end, duration_hours, duration_hm, client,
job_type, ticket, project, notes, billable, miles, rate, amount`. CSV is UTF-8
with BOM for Excel; XLSX via SheetJS.

### Mileage (CSV / XLSX / text)
One row per travel entry: `date, client, ticket, note, miles, rate, amount`,
plus a total. Text version is a short block for pasting into an expense form.

### JSON backup
Settings, clients, and entries for the signed-in user with `schema: 1`.
Restore validates the schema and asks before merging.

## 6. Offline

Offline is a requirement, not a nice-to-have. Four layers:

1. **App shell offline.** A service worker (`sw.js`, registered from
   `index.html`) precaches `index.html`, `manifest.json`, the icons, and the
   Firebase SDK modules the page imports. Cache-first for those, network-first
   for everything else. The app opens from the home screen with no signal.
   The worker's cache name carries the app version so a release replaces the
   shell cleanly; the page shows a "New version, tap to reload" toast when the
   worker updates.
2. **Data offline.** Firestore initialized with `persistentLocalCache` and
   `persistentMultipleTabManager`. Reads come from the local cache when the
   network is down; writes are queued locally and replayed when it returns.
   Firestore does this itself; the app only has to avoid patterns that block
   on the server (no `getDocFromServer`, no transactions in the punch path).
3. **Honest status.** The sync pill reads the browser's online state plus
   `hasPendingWrites` on snapshots: Synced / Offline, 3 pending / Syncing.
   Punch In and Punch Out never wait on the network; the pill is the only
   place offline is visible.
4. **Conflict rule.** Last write wins on `updatedAt`. With one user on two
   devices that is correct in practice: the phone punching in while the
   desktop is offline just produces two entries, both kept, and the Calendar
   view makes any overlap visible for cleanup.

Sign-in offline: Firebase Auth keeps the session in IndexedDB, so a previously
signed-in device opens straight to the Clock. A never-signed-in device needs
one online sign-in first; the sign-in wall says so.

SheetJS (imports, XLSX exports) is the one feature that needs the network the
first time; it is cached by the service worker after that.

## 7. Ticket numbers

- Optional `Ticket #s` field on every entry, next to Project. Free text so it
  accepts `5421`, `INC-0042`, or a Help Desk id. Several tickets on one entry
  are allowed, separated by commas (built in v0.1.5); each renders as its own
  link and time limits count per ticket.
- Per client, an optional **ticket URL pattern** with `{n}`. When set, the
  ticket shows as a link in the tables, the Calendar block, and the email
  export. When not set it is plain text.
- Autocomplete offers this client's recent ticket numbers, most recent first.
- The Week grid treats client + job type + ticket as the row key, so two
  tickets for the same client on the same day are separate rows.
- Later: when the Umbrella Help Desk project ships, the pattern points at it
  and a "Recent open tickets for this client" picker can replace typing.

## 8. Travel and mileage

- A job type flagged **Travel** (the default list ships with one) behaves like
  any other job type while running, with a car icon in the pill.
- At **Punch Out** of a travel entry, the punch-out completes immediately and
  a small **Miles** sheet slides up: Miles (number field), an optional note
  ("Office to Acme Dental and back"), Save / Skip. Skipping leaves miles
  blank; the entry gets a subtle "no miles" marker in tables so it is easy to
  fill in later from Edit.
- Miles and the note are editable in the entry modal for travel job types.
- The Export screen's **Mileage** tab produces the expense report attachment
  (section 5). The rate comes from Settings; set it once a year.
- Not doing: GPS tracking or automatic odometer. See section 10.

## 9. Time-limit warnings

Per job type, optional: **Warn at** and **Hard limit** in minutes (the
template writes them as `limit=105/120`). Measured against the running
entry's own elapsed time, or, when a ticket number is present, against the
total logged for that ticket across all entries (so a ticket worked in three
sittings still trips at two hours total). Tooltip explains that difference.

- At **Warn at** (1h 45m): a top-center toast that stays until dismissed,
  "Approaching the 2h limit for Support Ticket. #5421 has 1h 45m logged."
  with **Keep going** and **Switch task**. On the phone, a notification if
  the app is installed and notifications were allowed (Notification API from
  the service worker); it fires even if the screen is off.
- At **Hard limit** (2h): a modal, not a toast. "2h limit reached for #5421.
  Continue?" with a required **Reason** field, **Continue** and **Punch out
  now**. Continuing stores `limitOverride {at, reason}` on the entry, which
  shows as a small flag in the tables and as a line in the text export
  ("Continued past 2h limit: waiting on vendor callback"). Punch out now
  ends the entry at the limit.
- Timers are computed from timestamps, so the checks run on a one-second
  tick while the app is open and are re-evaluated on open; a limit crossed
  while the app was closed shows the modal on the next open, with the actual
  elapsed time.
- Team tier (section 10): the same thresholds gain **Notify manager** and
  **Require approval to continue**, where Continue becomes Request approval
  and the manager's decision comes back through the Who's Working dashboard.

## 10. Roadmap and feature sort

The list of ideas, sorted by whether they fit a single-user Umbrella tool now,
belong to a team tier later, or belong to a different product. Ordering
inside each group is my recommendation.

### Built into v0.1 to v0.3 (this plan)
Offline, three timesheet views, utilization bar, ticket numbers with link
pattern, travel job types with mileage and mileage export, time-limit
warnings (self-enforcing), billable and can-run-alongside flags, client
import/export/template, email-ready exports, XLSX exports, PWA install,
calendar view, notifications for limit warnings.

### Near (single user, after v0.3, in this order)
1. **Project budgets** - hours cap per client or per project label, with the
   same warn / hard pattern as ticket limits. Cheap once section 9 exists.
2. **Billing rates per job type** - today rate is per client; on-site vs
   remote often differ. Rate override on the job type, amounts follow.
3. **Client profitability lite** - billable hours and amount per client per
   month, a table plus the utilization bar per client. Reports tab.
4. **Break policies** - a Break button that pauses the running entry and
   records the gap, with an optional "auto-deduct 30 min over 6h" rule per
   day. Useful for the export honesty line.
5. **Overtime** - daily and weekly thresholds with a highlight in the Week
   grid and a line in the export. No pay math, just the flag.
6. **QuickBooks export** - IIF or CSV in the QuickBooks Time import shape,
   from the same rows as the hours CSV. Sync (API) is the team tier.
7. **Scheduling lite** - planned blocks in the Calendar view (grey outline)
   that a punch fills in. Answers "what was I supposed to do today".
8. **PTO** - a Time off job type under an internal "Umbrella" client, with a
   daily-hours default. Shows in the Week grid and the utilization bar.

### Later (team tier, needs a manager role and per-user capacity)
- **Who's Working dashboard** - current client, current task, clock-in time,
  today's total, scheduled end, per person; the Harvest team screen with a
  live column. Needs a `managers` roster in rules and a per-user `capacity`.
- **Manager notifications and approvals** for ticket limits (section 9).
- **Team capacity bar** - the utilization bar per person and in total.
- **Timesheet submission and approval** - Harvest's Submit week for
  approval, with locked weeks.
- **Notifications** beyond limits: missed punch-out at end of day, week not
  submitted.
- **Slack / Teams** - post the daily export to a channel, DM limit warnings.
- **API and webhooks** - read-only entries feed for other Umbrella tools.
- **Xero / QuickBooks sync** - once invoicing is real.
- **Advanced utilization forecasting** - scheduled versus actual over weeks.

### Not planned (different product, or already covered)
- **GPS, geofencing, auto clock-in on arrival** - Workyard and Jibble
  territory; a browser PWA cannot track location in the background reliably,
  and it is more than an MSP hours log should know. Mileage by entry covers
  the expense need without location data.
- **Kiosk mode** - for shared-terminal crews, not remote MSP work.
- **Native mobile apps** - the PWA covers home-screen install, offline, and
  notifications. Native only if push notifications on iOS turn out to be
  unreliable in practice.
- **Invoicing, Stripe payments, expenses with receipts** - invoicing belongs
  in the accounting system; Sundial exports into it. Receipts might join the
  mileage tab later if expense reports move here, but not now.
- **SSO** - already covered: Google Workspace sign-in restricted to the
  domain is the SSO.

## 11. Playbook standards checklist

- Semver in title, `<meta name="version">`, visible in the footer.
- Favicon (SVG + PNG), OG card at an absolute URL, apple-touch-icon,
  theme-color, `manifest.json` with standalone display, `sw.js`, `noindex,
  nofollow`.
- No hub tile, no link from any page. The URL is shared by hand only.
- Toasts top-center, passive confirmations only. Decisions use modals.
- Form modals close only via X / Cancel / confirm, never backdrop.
- No horizontal scrollbars. Tables card-stack under 640px. The Week grid
  becomes a per-day stacked list on the phone. `minmax(0,1fr)`.
- Tables sortable (asc/desc/reset) with a Columns manager, layout saved.
- Unset decision selects get the amber attention glow.
- Money fields: `$` inside, 2 decimals on blur. Hidden unless amounts are on.
- Fields wide enough for their values; dates never truncate.
- Tooltips on every non-obvious field (why, not what).
- No repo link in the UI. No emojis in code. No real client data in commits.
- README changelog updated in the same commit as behavior changes.

## 12. Build phases

### v0.1.0 - punch, clients, copy, offline
1. Scaffold `index.html` (single file like Backup Audits), `manifest.json`,
   `sw.js`, icons, `README.md`. Firebase v12 ES modules, no build step.
2. Auth block copied from `backups/index.html`; sign-in wall with the same
   "Restricted to @umbrellaautomation.com" line and the offline note.
3. Firestore layer per section 3 with persistent cache, seeded default job
   types on first sign-in, sync pill. Add the rules block to
   `watchtower/firestore.rules` and deploy.
4. Clock view: punch in/out/switch, running timer from stored start, running
   alongside, recent chips, today tiles, today table, ticket field.
5. Clients view, client modal with all flags and the ticket URL pattern, job
   type chip editor, Import / Export / Template (CSV and XLSX).
6. Entry modal (manual add / edit / duplicate with "Punch in now" and "Save
   with times"), overlap warning, delete confirm, edit of the running entry.
7. Timesheet: Day list view. Export view: text preview, Copy as text, CSV,
   JSON backup / restore. Settings view.
8. Service worker precache, offline test on the phone (airplane mode punch
   in, punch out, come back online, verify one entry). Playbook pass.

### v0.2.0 - views and sending
1. Week grid with editable cells and Add row.
2. Calendar view with drag to resize and move, side-by-side overlaps.
3. Utilization bar and weekly capacity setting.
4. Copy for email (rich clipboard), Open in email with per-client To, XLSX
   hours export, ticket links in exports.
5. Rounding (default, per-client override, export option). Amounts behind
   the Settings toggle.

### v0.3.0 - travel and limits
1. Travel job types, Miles sheet at punch-out, mileage fields in the entry
   modal, Mileage tab with CSV / XLSX / text.
2. Time-limit warnings: toast at warn, modal with reason at hard limit,
   per-ticket totals, limit flag in tables and exports.
3. Notifications from the service worker for limit warnings (permission
   prompt lives in Settings, never on first open).
4. Dark mode pass, PWA update toast.

### v0.4.0 and on - see section 10, Near list, in order.

## 13. Still open

Nothing blocking. Defaults you can change later:

- Amounts start **off**. Turn on in Settings if you want rates in exports.
- New clients start **Billable: on** and **Can run alongside: off**.
- Weekly capacity starts at 40 hours; mileage rate starts at $0.70 per mile.
  Both are Settings fields.
- Default timesheet view is Day on the phone and Week on the desktop.

## 14. Files

```
work/sundial/
  PLAN.md                 this file
  design-preview.html     switcher (C chosen; A and B kept for reference)
  (after approval)
  index.html  sw.js  manifest.json  README.md
  favicon.svg  favicon-32.png  apple-touch-icon.png  og-image.png  ua-logo.svg
```
