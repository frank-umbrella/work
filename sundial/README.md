# Sundial

A personal hours tracker for client work. Pick a client and the kind of work,
start the timer, add notes as you go, stop it. At the end of the day copy a clean,
email-ready block of the day's hours and paste it wherever it needs to go, or
download a CSV.

Single page, no build step: `index.html` holds the markup, the styles and the
script. Firebase is loaded as ES modules from Google's CDN; SheetJS is loaded
only when an import, an export or a template actually needs it.

Live at `frank-umbrella.github.io/work/sundial/`. There is no tile for it on
the hub and nothing links to it; the page is `noindex, nofollow` and the URL is
shared by hand.

The full design and the v0.2 / v0.3 roadmap live in `PLAN.md` next to this file.
The approved visual direction is "C. Ledger" in `design-preview.html`.

## Sign-in

Google sign-in, restricted to `@umbrellaautomation.com` accounts. It is the same
Firebase project as Watchtower and Backup Audits (`watchtower-6fbe1`), the same
provider, and the same post-sign-in domain check: an account from any other
domain is signed straight back out.

Each person sees only their own clients and entries. Everything lives under
`/sundial_users/{uid}` with `clients` and `entries` subcollections.

**The Firestore rules live in `../watchtower/firestore.rules`** - one ruleset per
project, deployed with Watchtower's `firebase.json` from the work account. Do not
add a second rules file here.

## Offline

Offline is a requirement, not a bonus. Four layers:

1. **The app shell.** `sw.js` precaches `index.html`, `manifest.json` and the
   icons, so the page opens from the home screen with no signal. The Firebase
   SDK modules and SheetJS are cached the first time they are fetched and then
   served stale-while-revalidate. The cache name carries the app version, so a
   release replaces the shell cleanly and the page offers a "New version
   available, tap to reload" toast.
2. **The data.** Firestore runs with a persistent local cache and multi-tab
   support. Reads come from the cache when the network is down and writes queue
   up locally. Start and Stop never wait on the network.
3. **Honest status.** The sync pill in the header reads the browser's online
   state plus the number of writes Firestore still has pending: `Synced`,
   `Syncing`, or `Offline, 3 pending`.
4. **Conflict rule.** Last write wins on `updatedAt`. With one person on two
   devices that is the right answer in practice.

Sign-in itself needs the network once. Firebase Auth keeps the session, so a
device that has signed in before opens straight to the Clock with no signal; a
device that never has needs one online sign-in. The sign-in wall says so.

## How exports work

The Export screen has a range picker (Today, Yesterday, This week, Last week,
This month, Custom), a client filter, a billable filter, and switches for notes,
project, ticket number and grouping. The preview is exactly the text that gets
copied - nothing is generated a second time on the way to the clipboard.

- **Copy as text** puts the preview on the clipboard and confirms with a toast
  naming the hours and the date.
- **Download CSV** writes one row per entry (`date, start, end, duration_hours,
  duration_hm, client, job_type, ticket, project, notes, billable, miles, rate,
  amount`), UTF-8 with a byte-order mark so Excel opens it without a wizard.
- **Download JSON backup** writes everything in the account - settings, clients
  and entries - as `schema: 1`.
- **Restore from JSON** validates the schema, shows what the file holds, and
  merges by id after you confirm. Nothing is ever deleted.

With the billable filter on All, non-billable lines are tagged `[non-billable]`
and every subtotal splits into billable and non-billable. When entries in the
range overlap each other, a final line says how much time was logged alongside
another job, so the total is never a surprise.

Clients import and export separately, on the Clients screen, in the template's
columns. **Template** downloads a workbook with example rows and a "How to fill"
sheet; **Import** shows a preview of what will be created, what will be updated
by name, and which rows have problems, and applies nothing until you confirm.

## Development

Serve the folder over HTTP (a `file://` page cannot register a service worker):

    cd sundial
    python -m http.server 3497 --bind 127.0.0.1

Then open `http://127.0.0.1:3497/`.

`?mock=1` on `127.0.0.1` or `localhost` skips Firebase entirely and runs the whole
app against an in-memory store seeded with three example clients and a handful of
entries. It is how the signed-in UI gets exercised without touching a real
account, and it is inert anywhere else because of the hostname check:

    http://127.0.0.1:3497/?mock=1

Nothing is persisted in mock mode; a reload starts over.

## Changelog

### v0.1.2 - 2026-09-14

Start and Stop instead of Punch In and Punch Out.

"Punch" is factory time-clock language and this is an hours log by client, so
the words felt wrong next to Start time and End time on the fields. Every
button, status pill, toast, and tooltip now says Start, Stop, or Switch, the
same vocabulary Harvest and Clockify use for a timer. Nothing else changed.

### v0.1.1 - 2026-09-14

Start with explicit times, not only "now".

Punch In always started the clock at the moment you pressed it, which meant a
forgotten punch-in became a two-step fix (punch in, then edit the start) and a
block of work already finished had to go through the manual entry modal. The
start panel now has a "Set start and end times instead" link. A start time
alone starts the entry running from that time, so the timer shows the real
elapsed time. A start and an end log a finished entry straight from the Clock
screen. The button label says which one will happen, overlaps are named before
you save, and the switch rule still applies to anything that starts running.

Also fixed: between about 640 and 860 pixels wide (a tablet, or a narrow desktop
window) the today table scrolled sideways inside its card. Tables now switch to
the stacked card layout below 860 pixels, so nothing scrolls sideways at any width.

### v0.1.0 - 2026-09-14

The first working version: punch, clients, copy, offline.

Hours were being reconstructed from memory at the end of the week, which is both
slow and wrong. This version exists to make the recording part cost nothing - one
tap on a recent chip starts the clock - and to make the reporting part a copy and
a paste instead of an evening of arithmetic.

What is in it:

- Google sign-in restricted to the Umbrella domain, with the same wall and the
  same domain check as Backup Audits, so there is nothing new to set up or
  remember.
- The Clock screen: punch in, punch out, switch, and jobs that are allowed to run
  alongside each other (a migration in the background while you take a call) with
  every extra timer visible under the main one. The timer is computed from the
  stored start time, so a reload or a closed lid does not lose it.
- Clients with their own job types, billable and can-run-alongside flags, colors,
  and a ticket URL pattern that turns a ticket number into a link. Bulk import
  and export with a template, because typing a client list twice is a waste.
- One entry form for adding, editing and duplicating, including the entry that is
  running, so a late punch-in is a thirty-second fix rather than a reason to give
  up on the log.
- A day-list timesheet, a today table you can sort and choose columns for, and an
  export that produces the exact text you are going to send.
- Offline throughout, because the punch that matters most is the one made in a
  server closet with no signal.

Deliberately not in it yet: the week grid and calendar views, rich email copy,
rounding, amounts, travel mileage, and time-limit warnings. Those are v0.2 and
v0.3 in `PLAN.md`. The data model already carries every field they need, so
nothing will have to be migrated when they arrive.
