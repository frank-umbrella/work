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

### v0.1.11 - 2026-09-14

The Now card is now a stack of short rows.

The three-column attempt in v0.1.10 only helped on very wide windows. The card
is now laid out in rows: the status row puts the pill, the timer, the "since"
time and the Stop / Switch buttons on one line; the running entry's ticket,
project and notes fields are folded behind an **Edit details** button that
slides them open (a one-line summary of what is recorded sits under the timer
so you rarely need to); and the start form puts client, job type, ticket,
project and notes on a single line with Start beside them. While a timer runs
and nothing is open the card is about one row tall. Phones keep the stacked
layout with the big buttons.

### v0.1.10 - 2026-09-14

A shorter Now card while a timer runs.

Opening "Start another job" while something was running stacked the running
entry's fields and the whole start form in one column beside an empty timer
column, and the card grew taller than the screen. The card now lays out as
three columns when the window is wide enough (timer, running entry, start
form); below about 1100 pixels the start form drops under the other two at full
width with its own fields two-up. Client and job type sit on one row, the note
boxes start shorter, and Cancel still folds the start form away.

### v0.1.9 - 2026-09-14

Week start on any day, a Client ID per client, and readable job-type markers.

Settings now lets the week start on any day of the week, not only Monday or
Sunday, and the default is Sunday, so the Timesheet strip runs Sunday to
Saturday and "This week" and "Last week" in Export follow the same choice.

Each client has an optional Client ID, your own reference such as an accounting
or PSA customer code. It shows beside the name on the client card, in
parentheses after the client name in the grouped text export, and as a
`client_id` column in both the hours CSV and the clients template / import /
export.

The four markers on each job type chip were single symbols (a dollar sign, two
bars, TRV, LIM) that needed a tooltip to decode. They are now the words
billable, alongside, travel and limit, and a legend under the Job types label
explains what each one means and what dashed, blue and red stand for.

### v0.1.8 - 2026-09-14

A light / dark button in the header.

The theme choice lived only in Settings, three taps away, and the app was
following the device (dark, for most of us at night). The header now has a
round sun / moon button next to the sync pill, on desktop and phone: the sun
shows while dark is in effect and switches to light, the moon shows while light
is in effect and switches to dark. The choice is saved to your account. Settings
keeps the third option, "follow my device".

### v0.1.7 - 2026-09-14

More room for Notes, folded notes, and icon actions.

Notes is the column you actually read, and it was getting squeezed by three
text buttons in Actions. Edit, Duplicate and Delete are now small round icon
buttons (pencil, two squares, bin) with tooltips and screen-reader labels, which
hands about eighty pixels back to Notes, and Notes now has a guaranteed minimum
of two hundred pixels on desktop.

Long notes show two lines with an ellipsis and a "more" link. Clicking the note
or the link shows the whole thing; clicking again folds it back. Short notes are
unchanged and are not clickable.

### v0.1.6 - 2026-09-14

The play and stop buttons in the End column now sit in one fixed slot at the
right edge of the cell, vertically centered, instead of trailing the time text.
They line up straight down the column whatever the time reads.

### v0.1.5 - 2026-09-14

Several tickets on one entry, a play button to resume, and a clock icon.

One block of work often covers more than one ticket, and splitting the entry
just to satisfy a single field was the wrong trade. The Ticket field on every
form now takes several numbers separated by commas (spaces or semicolons work
too). Each one becomes its own link in the tables and the email export, and the
running pill and text export list them all.

Resume moved out of the Actions column and into the End column as a small green
play button, right where the red stop square sits on the running row. Same
behavior as before: it starts the same client, job, tickets, project and notes
from now and stops anything running unless it may run alongside.

The favicon, home-screen icons and the header mark are now a clock face with
hands and four ticks instead of the sundial gnomon, so the tab reads as a time
tool at a glance. The OG card was regenerated to match.

### v0.1.4 - 2026-09-14

The small Stop button on the running row is now a stop square icon in a round
red button instead of the word, so the End column stays narrow and the control
reads as a media-style stop at a glance. Hover or long-press still says "Stop
this timer now", and screen readers get the same label.

### v0.1.3 - 2026-09-14

Resume from the table, and a Stop button on the running row.

Going back to a job you already logged today meant Duplicate, then Start now,
two taps and a modal. Every finished row in the today table and the day list now
has a **Resume** button: it starts the same client, job type, ticket, project and
notes again from now. It does not ask. Anything already running is stopped,
unless that timer (or the resumed job) is flagged to run alongside other jobs,
in which case both keep going. The toast names what was stopped.

The running row's "running" label also gets a small red **Stop** button, so a
timer can be stopped from the table without scrolling up to the Now card.

And a **Copy today** button above the today table puts the day's hours on the
clipboard as the same email-ready text the Export screen produces, all clients,
using whatever notes / project / ticket / grouping options you last chose there.
End of day is one tap on the Clock screen, no trip to Export.

The today table's columns can be **resized by dragging a header edge**, and a
dragged width is saved to your account like the column layout. Double-click a
handle to reset that column. The Client column sizes itself to the longest
client name in the table so names never wrap, and Notes takes whatever room is
left. Widths are clamped to the table, so the no-sideways-scroll rule holds.

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
