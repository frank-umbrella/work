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

## The Clock

The Now card is the home screen. With nothing running it shows a **Not
running** pill and, under it, the four fields that decide when the work
happened: **Start date**, **Start time**, **End date**, **End time**, laid out
two up where there is room and one up on a narrow phone. They are always
there - there is no link to press first - because the two things anybody does
on this screen are "start it now" and "I forgot to start it", and the second
one should not be hidden behind the first.

- Leave both times blank and the button reads **Start**: the timer begins at
  the moment you press it.
- Type a **start time** only and the button reads **Start at 9:02 AM**: the
  entry runs from then, so the timer opens showing the real elapsed time.
- Type **both** and it reads **Log 9:02 AM - 10:47 AM**: a finished entry is
  written and nothing starts running.

Beside the button, in the button's own size, is the duration - `1h 45m` for a
finished block, `1h 24m so far` for a start time on its own, ticking with the
clock. It is the number you check before you press the button, so it is not in
the small print. The line under the fields keeps what the button cannot say: a
time that cannot be used, an overlap with something already logged, and an end
that has not happened yet.

The dates sit on today and go back to today after every Start, so the usual
case is two time boxes and nothing else. To the side (or below, on a phone)
sits the rest of the entry - client, job type, location, tickets, project and
notes - and under that the Recent chips, the week card and the Today table.

While a timer is running the card shows the timer instead, with Pause, Stop
and Switch client, and the start form becomes **Start another job**.

### The week card

One card under the Recent chips answers "how is today going, and how is the
week going" in three columns:

- **Today** - the day's total as the big number, then the billable part, the
  number of entries (and of clients, when there is more than one), and while
  anything runs a **Running** line with the time on the timers, added together
  if there are several. A day past the overtime threshold gets its amber flag
  here.
- **This week** - seven small bars, one per day of the current week starting
  on your week-start day: the same seven days the Timesheet strip shows. The
  busiest day is full height and the others are drawn against it; today is in
  the accent color, and while a timer runs the hatched top of today's bar is
  the part still counting. Each bar has the day's total over it and in its
  tooltip, and tapping one opens that day on the Timesheet.
- **Clients** today, **Avg / day** (the week's total over the days that have
  time on them, so a day off does not drag it down), and **Capacity** - how
  full the week is against your weekly capacity, with the billable and
  non-billable split under it.

The numbers follow a running timer minute by minute. On a tablet the card
goes to two columns with the bars underneath, and on a phone to one.

## How exports work

The Export screen has an **Hours / Mileage** switch at the top, a range picker
(Today, Yesterday, This week, Last week, This month, All time, Custom) and a client filter
that both halves share. Hours adds a billable filter, a rounding control, and
switches for notes, project, ticket number, grouping and amounts. The preview is
exactly the text that gets copied - nothing is generated a second time on the
way to the clipboard.

- **Copy as text** puts the preview on the clipboard and confirms with a toast
  naming the hours and the date.
- **Copy for email** puts the same hours on the clipboard twice at once: as an
  HTML table that Gmail and Outlook paste as rows and columns, and as the plain
  text for anything that cannot take one.
- **Open in email** opens the device's mail app with the subject and the plain
  text filled in, addressed to the client when one is picked and has an email.
- **CSV** writes one row per entry (`date, start, end, duration_hours,
  duration_hm, client, client_id, job_type, ticket, project, notes, billable,
  miles, rate, amount`), UTF-8 with a byte-order mark so Excel opens it without
  a wizard. **XLSX** writes the same rows as a workbook.
- **Download JSON backup** writes everything in the account - settings, clients
  and entries - as `schema: 1`.
- **Restore from JSON** validates the schema, shows what the file holds, and
  merges by id after you confirm. Nothing is ever deleted.

**Mileage** is the other half of the switch: the range's travel entries as a
table (date, client with its Client ID, tickets, the mileage note, miles, and
the amount at the Settings rate) with a total, and Copy as text, CSV and XLSX
beside it. Entries with no miles on them are listed and tagged rather than
dropped, so nothing gets forgotten on the way to an expense report.

Durations everywhere in an export are rounded first and then added up, to the
increment the rounding control shows. That control starts on the Settings
default, and while it sits there a client with its own rounding override wins
for that client's hours. Stored times are never rounded.

## Reports

Export makes the block you send somebody. **Reports** answers the questions you
ask yourself - how much did I do for this client this quarter, how long has
ticket 5421 taken across every sitting, where did the non-billable time go last
month - without copying anything into a spreadsheet. It is its own tab, between
Export and Settings (the phone tab bar carries it as **Reports** too).

**Filters.** The range picker has everything Export has plus **Last month** and
**This year**; **All time** loads your whole history, not just the last 400
days the app normally keeps in memory. Clients and job types are rows of toggle
chips, all on to start with, with **All** and **None** beside each row, so a
report about one client is None and then that one. Job types are the ones the
picked clients have, each name once - Remote support under three clients is one
chip. Location chips appear when anything in the range has a location, with a
**No location** chip for entries that never got one. Then Billable (All,
Billable only, Non-billable only), three **contains** boxes for ticket, project
and notes that filter as you type, **Include running entries** (off, so a report
does not change while you read it; on counts a running timer up to now), and
**Raw time**. **Reset filters** puts everything back.

**Durations follow your export rounding** - the Settings default, with a
client's own rounding winning - so a report agrees with what was sent. Tick
**Raw time** to see the time exactly as logged. Stored times never change
either way, and the unpaid-break rule stays an Export thing.

**What you get.** Tiles for total, billable and non-billable hours, entries,
days worked, average per day worked, and the amount when Show amounts is on in
Settings (billable time at each client's rate, from the same durations). Under
them the **Breakdown**: one row per group - client, job type, project, ticket,
day, week, month, location or billable - with hours, billable, non-billable, its
share of the total with a small bar, entries and amount, and a total row. Pick a
**Then by** and each row opens with its arrow into a second level (a client's
hours by job type, say); **Expand all** opens the lot. The headers sort
ascending, descending, then back to the default order (date order for day,
week and month; biggest first for everything else). An entry against several
tickets groups under that set of tickets, so every entry is counted once and
the shares add up to 100. Last comes **Matching entries**, newest first, in a
compact version of the timesheet row with the notes underneath and Edit on each;
it shows the first 300, and says so when there are more.

**Taking it with you.** **Copy as text** writes a header line - `Report: This
month (Sep 1 - Sep 30, 2026) - Example Co; Billable only` - then the totals, the
breakdown as a lined-up table and every matching entry in the Export style.
**Copy for email** puts the same thing on the clipboard as tables for Gmail and
Outlook, with the plain text beside it. **CSV** asks whether you want the
breakdown or the entries (a CSV holds one table); **XLSX** puts a Summary, the
Breakdown and the Entries in one workbook, with the hours as numbers Excel can
add up.

**Saved reports.** **Save report** keeps the range, every filter and the
grouping under a name, as a chip at the top of the tab; tap it to load it, and
the chip lights up while what is on screen matches it. It saves the question,
not the answer: a saved This month is always the current month. Saving under a
name that already exists asks before replacing it; the pencil renames and the
bin deletes (after asking). They live in your settings, so they follow you to
every device and ride along in the JSON backup.

## The three timesheet views

**Day** lists the selected day's entries with Resume and Edit on each.
**Week** is a grid: one row per client and job type used that week (a ticket
number makes its own row), seven day columns you can type durations straight
into, row and day totals, and + Add row for a client you have not logged yet.
**Calendar** draws the week on a time axis with a block per entry, side by side
where two jobs overlapped, editable by dragging on a desktop.

Which view you are on is remembered on the device, so the phone and the desktop
can sit on different ones; Settings' "Default timesheet view" is what a device
that has never chosen starts with. Above the views, a utilization bar shows the
week against the weekly capacity in Settings, billable and non-billable split.

With the billable filter on All, non-billable lines are tagged `[non-billable]`
and every subtotal splits into billable and non-billable. When entries in the
range overlap each other, a final line says how much time was logged alongside
another job, so the total is never a surprise.

Clients import and export separately, on the Clients screen, in the template's
columns. **Template** downloads a workbook with example rows and a "How to fill"
sheet; **Import** shows a preview of what will be created, what will be updated
by name, and which rows have problems, and applies nothing until you confirm.

## Drafts

While a new entry is being typed, Sundial keeps a copy of it on the device.
Two forms qualify: the Clock's start form, and the entry modal while it is
adding or duplicating. An edit is not kept, because the entry it is editing
already exists and is already safe.

- It is written after a second and a half of not typing, and again when the
  page is hidden or closed, so a draft is never more than a sentence behind.
- Nothing is written until something meaningful is in the form - a ticket, a
  project, a note, or a time. Picking a client is not typing an entry.
- On opening, a start-form draft goes straight back into the form with a
  **Draft restored from 14 minutes ago** toast and a **Discard** on it. If a
  timer is already running the form belongs to the next job, so the draft is
  left in Settings instead of being pushed into it.
- An entry-modal draft is **offered, not applied**: the next Add manual entry
  says "You have an unsaved entry from ..." with Restore and Discard, and
  fills nothing in until Restore is pressed.
- A draft is deleted the moment its entry is started or saved, when it is
  discarded, or by itself after 48 hours.

**Settings > Drafts** lists whatever this device is holding, with Restore and
Discard on each.

Drafts live in `localStorage` and never go near Firestore. A draft is not a
fact about the hours - it is a half-finished sentence on one device - and
syncing half-finished sentences between a phone and a desktop produces two of
them and an argument about which one is newer. The sync pill and the offline
queue are a separate thing entirely and are untouched by any of this.

## Breaks

A running entry can be paused. **Pause** opens a gap on the entry
(`breaks: [{start, end}]`, with `end` null while it is open) and **Resume**
closes it; stopping while paused closes it at the stop time. The gap is taken
out of the entry's duration everywhere, because every screen computes a
duration through one function.

Two things worth knowing about how it looks:

- **The timer stands still while a break is open.** It counts worked time. The
  amber line under it - "Paused 12m - since 2:40 PM" - is the part that keeps
  moving.
- **A calendar block keeps its place on the axis.** It spans start to end,
  breaks and all, with each break hatched out of it. Shrinking the block would
  move it off the hours it actually occupied.

The entry form lists the breaks on an entry and can remove one, which puts its
time back.

## Job types and the defaults

A job type is a kind of work under one client - Remote support, On-site,
Admin - and it carries four flags: **billable**, **alongside** (may run at the
same time as another job), **travel** (asks for miles when it stops) and
**limit** (a warn point and a hard limit in minutes). Billable and alongside
are three-state: dashed follows the client's own setting, blue is yes, red is
no.

**Settings > Default job types** is the list a brand new client starts with,
and since v0.7.0 those defaults carry the same four flags, edited with the
same chip. Set Admin to non-billable there and every client that gets Admin
from then on gets it non-billable, so the flag is recorded once instead of on
each client in turn.

A client's job type is its own from the moment it is created. Changing a
flag on a default never reaches back into a type somebody is already logging
against - that hour was recorded under the rules in force at the time, and
rewriting them afterwards would quietly change what has already been billed.
Removing a default only removes it from the list; clients that have it keep
it.

Defaults still reach clients by themselves: whenever settings and clients are
both loaded, an active client missing a default gets it, matched by name and
ignoring case. A client that already has a type of that name - even an
archived one - is left alone.

## Locations

Each client carries a list of locations - **On-site** and **Remote** to start
with - and an entry carries the one you picked. It rides through the start
panel, the running entry, the entry form, the Start dialog on a client card,
Resume and Duplicate; it is an optional Location column in the tables, `@
On-site` in the text export, a Location column in the email table when anything
in the range has one, and a `location` field in the hours CSV and XLSX. Client
import, export and the template carry a pipe-separated `locations` column.

**There is no GPS.** No map, no lookup, nothing that knows where you are. It is
a label you pick from a list you wrote, which is the part anybody actually
wanted; location *tracking* is in PLAN.md under "Not planned" and stays there.

A client that has never been given locations reads as having the default two.
Nothing is written until you save that client's form, so an account that has
not thought about locations does not acquire a field it never asked for.

## Budgets

A budget is an hours cap on a client, or on one project label inside a client,
with optional dates around it. They live in Settings > Budgets, stored on the
settings document rather than on any entry, because a budget is a fact about an
arrangement.

- **The Clock** shows the running entry's tightest budget under the timer,
  amber past 80 per cent and red past 100.
- **One warning at 80 per cent, one when it is used up**, per entry per budget,
  sticky and dismiss-only. Nothing is blocked and nothing is offered: a budget
  is somebody else's number.
- **The Export preview** ends with every budget belonging to a client in the
  range, and where it stands over the budget's own dates - not only the
  exported range.

Used hours are raw time, never rounded, and they include whatever is running.

## Overtime

Two thresholds in Settings > Tracking, a day (8 hours) and a week (40), each
with its own switch and both off by default. A total past one gets an amber
**OT +1h 20m** in the Week grid, the Today figure on the Clock says **over 8h**, and
the text export adds a line under the day.

It is a flag and nothing else. No pay is worked out, and no timer is ever
blocked or delayed - a long day is a fact about the week, not a thing to
prevent. Overtime is separate from **Weekly capacity**: capacity is what the
utilization bar measures fullness against, overtime is the line past which a
day or a week is worth remarking on.

**The unpaid break rule** in Settings > Tracking is separate and off by default:
on a day over H hours, the export deducts N minutes once for that day, prints a
line saying so, and takes it off billable hours first. Nothing stored changes -
it is an export-time rule, exactly like rounding.

## Working hours

**Settings > Working hours** is where you say when you are normally working:
one row per weekday in whatever order your week start puts them, each with a
switch, a start time, an end time and an unpaid break in minutes, and the hours
that row comes to. A **Copy to other days** button puts one row's times on every
other day that is switched on, so a normal week takes about ten seconds to
describe. A row that cannot be true - an end before its start, or a break as
long as the day - says so in red under the row and is simply not saved until it
is fixed; the day keeps the last hours that made sense.

Under the rows, **Normal week** adds the days up, and **Weekly capacity follows
working hours** hands that number to the capacity bar on the Clock and the
utilization bar on the Timesheet. While it is on, the Weekly capacity hours field in Tracking shows the
computed number and cannot be typed into. It is off until you switch it on, so
nothing about the bar changes on its own.

The Clock carries a line under the timer (or under the "pick a client" line
when nothing is running) that says where you are in the day: **Working hours
today 9:00 AM - 5:00 PM - ends in 2h 10m** inside the window, **starts in 40m**
before it, and how long ago it ended after it. A timer running before or after
the window turns that line amber and says **Outside working hours**, and a day
switched off reads **Day off** - amber too, if something is running on it. It
ticks with the timer, so it is right to the minute rather than right when the
page was last painted.

The Timesheet shows the same thing without a word. In the **Calendar** view the
hours outside your working window are shaded on every day column, and a day
switched off is shaded top to bottom, so the shape of the week reads at a
glance; the time axis stretches to hold your working hours as well as your
entries, so an early start is never shaded off the bottom of the screen. It is
decoration only - blocks still drag, empty space still adds an entry. In the
**Week** grid, a day that is off carries a small muted **off** under its date,
and the day totals are untouched: a day off with hours on it is a fact, not an
error.

None of it ever blocks a timer. Working hours are there so the screen can tell
you - and later a team dashboard can tell someone else - when you are expected
to be working; a job that runs at 11 PM still starts, stops and exports exactly
as it always did.

## Google Calendar

Finished entries can be mirrored into a calendar called **Sundial** in the
Google account you signed in with, so the week shows up next to your meetings.
It is off until you switch it on, and it is set up entirely in Settings.

**The client ID is already filled in.** Since v0.5.0 Sundial ships with the
Web application client ID for the `watchtower-6fbe1` project in the box, so a
new device needs nothing pasted into it: open Settings > Google Calendar and
press **Connect**. A browser OAuth client ID is a public identifier - it is
visible to anyone who opens the page, there is no secret beside it, and it only
works from the origins listed against it in the console - so shipping it is the
same kind of thing as shipping the Firebase `apiKey` that is already in the
file. The field stays editable for the day this app moves to another Google
Cloud project; emptying it comes back to the built-in one. The console steps
below are the record of how that client was set up, and what to repeat if a new
one is ever needed.

### What the owner has to do once, in the Google Cloud console

The Firebase sign-in does not hand back a token the Calendar API will accept,
so the calendar needs its own OAuth client. Everything below is in the console
for the **`watchtower-6fbe1`** project, the same project Watchtower, Backup
Audits and Sundial already share.

1. **APIs & Services > Library** - search for **Google Calendar API** and press
   Enable. Nothing works until this is on.
2. **APIs & Services > Credentials** - use the **OAuth 2.0 Client ID** of type
   *Web application* that Firebase created for you ("Web client (auto created
   by Google Service)"), or press Create credentials and make a new Web
   application client. Open it and add to **Authorized JavaScript origins**:

       https://frank-umbrella.github.io
       http://127.0.0.1:3497

   (the second one only matters for local testing). Copy the **Client ID** -
   the long `...apps.googleusercontent.com` string.
3. **APIs & Services > OAuth consent screen** - Internal is fine, since this is
   a Workspace account and nobody outside the domain will ever sign in. Add the
   scope `https://www.googleapis.com/auth/calendar.app.created`.
4. In Sundial: **Settings > Google Calendar**, paste the client ID into
   **Google OAuth client ID**, press **Connect**, and accept Google's
   permission window. Sundial finds or creates the **Sundial** calendar and
   remembers which one it is.

Nothing secret is involved. A browser OAuth client ID is a public identifier -
it is visible to anyone who opens the page - and no client secret, API key or
server is needed anywhere in this feature.

### What it can and cannot see

The only permission asked for is `calendar.app.created`, which covers calendars
this app created itself. Sundial can create the Sundial calendar and read and
write events on it. It **cannot** list, read or change your work calendar, your
personal calendar, or anything else in the account, and it never touches an
event that does not carry its own entry id. The access token lives in a
variable for as long as the page is open and is never written to Firestore,
`localStorage` or a cookie; closing the tab throws it away. A token that has
expired is asked for again silently, and only if Google insists on a fresh
consent does a toast appear with a **Reconnect** button on it - a permission
window that opens without you pressing anything is a popup, not a feature.

### What gets mirrored

One event per **finished** entry:

- **Title** - `Client - Job type`, with the ticket numbers on the end
  (`Acme Dental - Remote support #5421 #INC-0042`).
- **Description** - Project, Tickets, Notes, `Billable: yes/no`, the
  "continued past the limit" line when there is one, and a last line reading
  `sundial:<entry id>`.
- **Times** - the entry's own start and end with this device's time zone, so
  9:02 AM stays 9:02 AM wherever the calendar is read.
- **Color** - the nearest of Google's eleven event colors to the client's own
  color, so a day on the calendar is scannable the same way the app is.

A **running** timer is never mirrored - it has no end, and a calendar cannot
draw that honestly. It becomes an event the moment you stop it. Editing a
mirrored entry (times, client, job type, tickets, project, notes, billable)
updates the event it already made rather than adding a second one, and deleting
the entry deletes the event. An entry edited back into a running one loses its
event until it stops again.

**Mirror entries automatically** is on once connected. Turning it off stops new
events being created, but entries already on the calendar are still kept in
step, because a calendar showing times you have since corrected is worse than
no calendar at all.

**Sync this week** and **Sync this month** walk that range one entry at a time -
creating what is missing, updating what is there - and finish with a
`3 created, 12 updated, 0 skipped` toast. Running timers are skipped.

### The hour-long token, and why a click renews it

Google's access token lasts about an hour, and it is only renewable **during a
click**. The renewal normally happens through a window that opens and closes
again by itself in a fraction of a second - but a browser will only allow that
window while a gesture is still fresh, and every calendar write in Sundial
happens somewhere else: the mirror queue runs a moment after a Stop, and a
backfill is several requests deep by the time it needs a token.

So Sundial renews the token **on the click itself** - but only on a click
that actually ends in a calendar write. Stop, Resume, a Start that stops
something already running, a Log with an end time, saving or deleting an
entry, a week-grid cell, a calendar drag, and each of the three Sync buttons
ask Google for the token first, before doing anything else, and then carry on
without waiting for the answer. The write that follows finds the token already
in hand. A plain Start, Switch, Pause and the end of a break do not ask: a
running entry has no end to put on a calendar, so nothing is written and there
is no reason to open a window. (Before v0.7.1 every one of those clicks asked,
which is why a Google window flashed on each new Start.)

What you may see: a Google window flashing open and closed on the first Stop
after a reload, or once an hour. That is the renewal, and there is nothing to
do about it - the token lives only in memory, on purpose, so a reload always
starts without one. If your browser blocks it anyway, a toast says so with a
**Reconnect** button that asks again from inside your click on that button.
When entries are waiting and there is no token, the Settings status line says
**Google needs a click to continue: press Sync now.**

### When there is no signal

A write that cannot reach Google does not hold up the hours: the entry is
flagged and the status line says how many are waiting. They go up on the next
successful connection - when the browser comes back online, when you reconnect,
or when you press **Sync now**.

### Finding the calendar again: by id, never by list

The `calendar.app.created` scope covers calendars this app created. It does
**not** cover listing calendars - `calendarList.list` comes back `403
insufficientPermissions` even for a calendar the app made itself. So Sundial
never asks for a list. It stores the calendar's id and, on every Connect, asks
for that one calendar by id (`calendars.get`, which the scope does cover). If
Google says that calendar is gone, a new one is made; a permission or network
problem is reported rather than quietly treated as "gone", because making a
second calendar over a dropped connection would be the wrong answer.

Two consequences worth knowing:

- **The stored id is how the calendar is found.** Nothing matches on the name
  "Sundial", so two calendars with that name would both be invisible to each
  other.
- **Changing the OAuth client ID, or erasing your data, drops the stored id**,
  and the next Connect makes a second `Sundial` calendar beside the first. That
  is recoverable in ten seconds - delete the old one in Google Calendar - but
  it is worth knowing before you do it.

### Disconnect

**Disconnect** hands the permission back to Google and stops writing. Nothing
is deleted: the Sundial calendar and every event on it stay where they are, the
client ID stays in Settings, and entries keep the id of the event they created.
**Which calendar it was is remembered on purpose**, so pressing Connect again
goes back to that one rather than building a second. (Erasing your Sundial data
does not remove the calendar either; delete it in Google Calendar if you want it
gone.)

## Demo

**`?demo=1`** opens Sundial with no sign-in, on any origin including the live
page, against a dataset held entirely in memory. A banner across the top says
**Demo - fictional data, nothing is saved, reload to reset** and links back out;
the footer carries a **Try the demo** link the other way.

    https://frank-umbrella.github.io/work/sundial/?demo=1

**Nothing in it is real and nothing in it is saved.** The clients, people,
tickets, projects and notes are all references to a television programme, every
address is at `example.com`, and the hours belong to Cosmo Kramer. That is the
requirement rather than a flourish: a demo is a thing you send to somebody, and
a demo carrying a real client list is not a demo.

**Nothing in it can reach anything, either**, and that is structural rather than
a matter of care:

- The Firebase modules are **not imported** on the demo path, so there is no
  object through which a write to Firestore could happen.
- The real Google Calendar layer is **never constructed**; the fake one is, with
  a calendar that exists only inside the page and already reads as connected.
- The **service worker is not registered**. A page somebody opens once from a
  link has no business leaving a worker and a shell cache on their device.

The dataset is deliberately complete: two weeks of entries, a timer already
running when the page opens, a drive with miles, an entry with a break taken out
of the middle, one carried past its limit with a reason, three budgets, working
hours Monday to Friday, and a day long enough to trip the overtime flag.

`?demo=1` and `?mock=1` share the in-memory store and the fake Google layer.
They differ in two ways: `?mock=1` is localhost-only and seeded with dull
example data for development, and `?demo=1` works anywhere and is meant to be
looked at.

## Roadmap

`roadmap.html` sits beside `index.html` and holds four lists: **Shipped**, one
line per release; **Next**, the single-user work in the order it is worth doing;
**Later**, the team tier and the two things it needs first; and **Not planned**,
each with the reason it was ruled out.

The last list is the point of the page. A roadmap that only ever says yes is a
wish list, and the questions people actually ask - is it going to track where I
am, will it invoice - are answered there in one line each.

It is a static page: same design tokens as the app, its own light/dark toggle
remembered on the device, `noindex, nofollow`, no Firebase and no account. The
app footer links to it and nothing else does. It is precached by `sw.js`, so it
opens offline like the rest of the shell.

Its source of truth is section 10 of `PLAN.md` and the changelog below. When a
release changes either, the page changes in the same commit.

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

Mock mode also replaces the Google Calendar layer with a fake one behind the
same internal interface: a fake token client and an in-memory calendar and
event store, so Connect, mirroring, editing, deleting, backfill and the offline
path can all be exercised without a client ID and without touching a real
account. Anything - `x` will do - is accepted as the client ID. The fake store
is on `window.__sundialGcal` for poking at from the console:

    __sundialGcal.calendars            the calendars "created"
    __sundialGcal.events[calendarId]   the events written to one
    __sundialGcal.offline = true       every call fails the way no signal does
    __sundialGcal.denyToken = true     Google refuses the grant
    __sundialGcal.clearToken()         throws the current token away

`denyToken` plus `clearToken()` is how the "Reconnect" toast is reproduced. The
real Google layer is chosen everywhere else, because the same hostname check
that gates mock mode gates it.

## Changelog

### v0.8.2 - 2026-09-25

Every Stop reaches Google Calendar now. It did not before, and the reason is
worth spelling out because it hid behind three earlier fixes.

When a timer stops, Sundial writes the end time to the database and, a moment
later, hands the entry to the calendar queue. The queue looked the entry up
in the in-memory list before writing, so that it would send whatever the
entry looked like by then (a note typed straight after the Stop, say). But
the database write does not update that list until its own snapshot comes
back, and the queue ran first. The copy it found still had no end time, which
it read as "this entry went back to running" and skipped - with no error and
no flag. Manual entries and edits of already-stopped entries were fine, which
is why the Sync buttons always worked and why everything looked connected.
The catch-up added in v0.7.1 only retried entries that had *failed*, and a
skipped entry had not failed, so it never saw them either. That is why whole
days were missing from the calendar while the status line said all was well.

Two changes. The queue now trusts the entry it was handed when the in-memory
copy has not caught up, and only prefers the fresher copy when that copy has
an end. And "waiting for Google Calendar" now means any finished entry from
the last two weeks with no event, not only the flagged ones - so the three
minute flush, the ten minute sweep, the click that stands in for Sync, and
the status line's count all pick up the days that were missed. Older gaps are
left to the Sync buttons on purpose, so connecting Google to an account with a
year of history does not push the whole year up on the first click.

### v0.8.1 - 2026-09-24

The Clock's stats are one card instead of six boxes.

Five equal tiles - Today, Billable, Entries, Clients, This week - were mostly
padding: five boxes the same size for numbers of very different weight, and
the week's capacity bar sat in a card of its own underneath. Now a single card
says how today is going on the left, shows the week as seven small bars in the
middle, and keeps the counts and the capacity bar on the right.

The seven bars are the same seven days the Timesheet strip shows, so "how is
the week going" no longer means leaving the Clock. Today's bar is in the accent
color, and while a timer runs its top is hatched to show the part still
counting. Tap any day to open it on the Timesheet. The average per day counts
only days with time on them, so a day off does not pull it down.

The Today figure, the Running line and today's bar follow the timer minute by
minute, on the same minute as the running strip. Reports keeps its tiles.

### v0.8.0 - 2026-09-24

A Reports tab.

Two requests kept coming back. One was lifetime exports - every hour ever
logged, not just a week or a month. The other was a question: "how much did I
do for client X on ticket Y this quarter?" Export could not answer it. It
filters by one client and a billable switch, because it was built to produce
the block you send somebody, so the answer meant exporting a CSV and filtering
it in a spreadsheet. Reports answers it on the screen.

Pick a range - anything from Today to **All time**, now with **Last month** and
**This year** - then narrow it with client and job type chips, billable,
location, and "contains" boxes for ticket, project and notes. The tiles say the
total, the billable split, the entries, the days worked and the average per
day; the breakdown groups the result by client, job type, project, ticket, day,
week, month, location or billable, with a second level under each row if you
want one, and a share bar so the big numbers stand out. The matching entries
sit underneath with Edit on each, so a wrong entry spotted in a report is one
tap from fixed.

Durations are rounded the same way your exports round them, so a report
matches what was billed; a **Raw time** switch shows the time as logged.
Copy as text, Copy for email, CSV and XLSX take the report with you, and **Save
report** keeps a set of filters under a name for the questions that come round
every month. A saved report keeps the question, not the numbers, so "This
month" is always this month.

**All time now means all time**, in Export as well. The app keeps the last 400
days in memory, so before this an All time export by somebody with a longer
history quietly started 400 days ago. Choosing All time now loads the rest.

Under the hood, Export and Reports share one piece of code that turns "This
week" into dates, so the two tabs can never disagree about which week that is.

### v0.7.1 - 2026-09-24

Six small things that were each in the way once a day.

**The start date is today.** The Clock's Start date and End date only filled
themselves in when they were empty, so a tab left open overnight, or a draft
saved yesterday and offered back this morning, quietly carried yesterday's date
into today's first entry. A date with no time typed beside it is only a
default now, and a default follows the calendar: it is today on load, on
sign-in, and after midnight. A date you typed a time next to is yours and
stays.

**No more Google window on Start.** Every click that could end in a calendar
write used to ask Google for its hour-long token first, and a plain Start was
on that list even though a running entry is never written to the calendar
(it has no end). Every fresh page load therefore began with a Google window
flashing open and shut on the first Start, which read as a stray login. Only
clicks that will write ask now: Stop, Resume, a Start that stops something,
a Log with an end time, edits, deletes and Sync. The window still appears
once after a reload on the first of those, and once an hour after that; the
Google Calendar section explains why that part cannot go away.

**Billable as a column.** The `non-billable` tag lives under the job type
name and wraps the cell onto a second line, which looks cluttered on a row
that is otherwise one line tall. The Columns manager now has a **Billable**
column, off by default: turn it on and every row reads Yes or No in its own
place, the tag leaves the Job type cell, and the column sorts like any other.

**Google Calendar catches up on its own.** An entry that could not be
mirrored the moment it stopped - no token in hand, a blocked window, a phone
that was offline - used to sit flagged as waiting until somebody pressed
**Sync now**. Three things now happen without that button: a second write
goes out three minutes after any Stop or edit, which also carries the notes
that usually get typed right after the Stop; a sweep every ten minutes sends
whatever is still waiting while the tab is open, which is the end-of-day
catch-up; and, because Google only hands out its token during a click, any
click in the app while entries are waiting asks for the token and sends them,
at most once a minute. Since v0.8.2 "waiting" also covers any finished entry
from the last two weeks that has no event, whether or not a write was ever
attempted. Google's script is also fetched at sign-in rather than
the first time Settings is opened, so the renewal on a Stop has it ready. The
event description has always carried the project, tickets and notes lines;
what was missing was the update that put them there after an edit.

**The hours on the day strip are readable.** The seven-day strip on the
Timesheet showed each day's total in 11px under a 16px date, which is the
number people scan the strip for. It is now the date's size.

**All time in Export.** The Range strip has an **All time** button beside
Custom, covering the first entry on record through today, for a lifetime
total or a full backup of the hours without guessing at a From date.

The footer is centered. It was left-justified under a centered page, which
looked like an accident.

### v0.7.0 - 2026-09-22

The times you actually worked are on the Clock, not behind a link.

The idle Now card spent its whole life showing a timer that read `00:00:00`.
It was decoration: nothing had started, nothing was counting, and the one
number on the screen was a zero. Meanwhile the fields that answer the question
people actually arrive at this screen with - "I forgot to start it at nine" -
sat folded away behind a **Set start and end times instead** link, which you
had to know was there before it could help you. The zero is gone and the four
fields have its place: **Start date**, **Start time**, **End date**, **End
time**, always visible, two up on a desktop and one up on a narrow phone so a
date is never cut in half. The link, and the `Hide times` half of it, are gone
with it.

Nothing about what the button does has changed, only how far away it was. No
times still means Start now. A start time on its own still reads **Start at
9:02 AM** and runs the timer from then. Both still read **Log 9:02 AM - 10:47
AM** and write a finished entry without starting anything. The dates sit on
today and go back to today after each Start, so the ordinary case is two time
boxes and nothing else to think about.

The duration moved up beside the button, in the button's own size - `1h 45m`
for a finished block, `1h 24m so far` for a start time on its own, counting up
on the same tick the running timer uses. It was in the small print underneath,
which is the wrong place for the number you check before you press Log. The
hint line keeps the things the button cannot say: a time that cannot be used,
an overlap with a job already logged, and an end that has not happened yet.

A half-typed entry survives a closed tab.

Everything in Sundial is written the instant it exists - a Start is an entry
before the button has finished animating. The one thing that was not was the
part that takes the longest to type: the note. Four sentences about what you
actually did, a phone that decides to reload the tab, and it was four
sentences you now have to remember. **Drafts** fix that, and only that. While
you are typing into the Clock's start form or into Add manual entry, a copy
goes into this browser's own storage a second and a half after you stop
typing, and again the moment the page is hidden or closed.

It waits until there is something worth keeping - a ticket, a project, a note
or a time - because picking a client is not typing an entry and a list full of
"Acme Dental, nothing else" is a list nobody reads. Open the app again and a
start-form draft is already back in the form, with a **Draft restored from 14
minutes ago** toast carrying a Discard. An entry-modal draft is offered rather
than applied: the next Add manual entry says it has one and fills nothing in
until you press Restore, because that form may well have been opened to type
something else entirely and writing over somebody mid-thought is worse than
losing the draft. Each one is deleted the moment its entry is started or
saved, when it is discarded, or by itself after 48 hours. **Settings >
Drafts** lists whatever the device is holding.

None of it goes to Firestore, deliberately. A draft is not a fact about the
hours - it is a half-finished sentence on one device - and syncing
half-finished sentences between a phone and a desktop gives you two of them
and an argument about which is newer. The sync pill and the offline queue are
a different thing and nothing here touches them.

A default job type is a whole job type now, not just its name.

**Settings > Default job types** held a list of words. A job type is not a
word - it is a name and four flags - so "Admin" seeded onto a new client
arrived billable, because nothing had ever said otherwise, and the fix was to
open each client in turn and tell it the same thing again. The defaults now
carry **billable**, **alongside**, **travel** and **limit**, edited with the
same chip and the same markers the client form uses, so a marker cannot come
to mean one thing in Settings and another on a client. Set a default
non-billable once and every client that gets it from then on gets it
non-billable.

**From then on** is the whole of it. A client's job type belongs to that
client the moment it is created, and changing a flag on a default never
reaches back into one somebody is already logging against - those hours were
recorded under the rules in force at the time, and rewriting them afterwards
would quietly change what has already been billed. The chips say so on hover.
Removing a default removes it from the list and from nothing else.

Older accounts and older backups are unaffected: a plain name is still read as
a default with no flags on it, exactly as it behaved, and the object form is
what gets written from then on.

Google Calendar was mirroring nothing at all.

With the calendar connected and automatic mirroring on, not one entry was
reaching it. "Sync this month" found 32 finished entries and mirrored none of
them. The cause was a rule about pop-ups rather than anything to do with
calendars: Google's access token lasts an hour, and the window that renews it
- the one that opens and closes again by itself - may only open while a click
is still fresh. Sundial never asked during a click. It asked from the mirror
queue, which runs a moment after a Stop, and from a backfill loop several
requests deep, so the browser refused the window and every write died with
"Your browser blocked the Google sign-in window". Nobody saw it, because a
blocked renewal on a background write is a message in a place nobody is
looking.

The renewal now rides on the click. Start, Stop, Pause, Resume, Switch, a
Start from a client card, saving or deleting an entry, a week-grid cell, a
calendar drag and all three Sync buttons ask Google for the token first, as
the first thing they do and with nothing awaited in front of it, then carry
on without waiting for the answer; the write that follows finds the token
already there. The Reconnect button on the blocked-pop-up toast asks from
inside its own click for the same reason, and the Settings status line now
says **Google needs a click to continue: press Sync now** when entries are
waiting and there is no token - a state that was previously invisible.

Also fixed: the running row in the Today table stood a line taller than every
other row. The End cell has held a Pause button beside the Stop square since
v0.6.0, and the squeeze folded the **running** pill in half - the dot on one
line, the word on the next. The pill keeps one line now, the two buttons never
give way, and the End column's default width has been measured against what
that row actually needs rather than what a finished row needs. A column
somebody has dragged narrower is still theirs: the text truncates with an
ellipsis instead of gaining a line.

### v0.6.2 - 2026-09-16

Default job types reach every client on their own.

The v0.6.1 button worked but still had to be pressed, and a default that is
not on a client is a default nobody can use. Now, whenever settings and
clients are both loaded, every active client that lacks a default job type
gets it, matched by name and ignoring case, with a toast saying how many were
added. A client that already has a type of that name, even an archived one,
is left alone, so dropping a type from one client still sticks. Adding a new
default in Settings applies it to existing clients immediately instead of
asking. The button stays as a manual nudge but should rarely be needed.

### v0.6.1 - 2026-09-16

There is a demo you can send somebody.

Showing Sundial to anyone meant signing in, which meant showing them real client
names and real hours - so mostly it meant not showing them. **`?demo=1`** now
opens the app on any origin, live page included, with no sign-in wall, the whole
thing running inside the page and a banner across the top reading **Demo -
fictional data, nothing is saved, reload to reset**, with a **Leave demo** link
back to the ordinary app. The footer has a **Try the demo** link.

Nothing in demo mode can reach anything. That is a fact about the code rather
than a promise about behaviour: on the demo path the Firebase modules are never
imported, the real Google Calendar layer is never constructed, and the service
worker is never registered - a demo somebody opens once from a link has no
business leaving a worker and a shell cache behind on their device. The
calendar panel shows itself connected to a calendar that exists only in the
page.

The data is Seinfeld. Vandelay Industries, Kramerica, Pendant Publishing, Monk's
Cafe, the J. Peterman Catalog and Kruger Industrial Smoothing; latex sales,
importing and exporting, bagel service, rickshaw logistics, catalog copy and
industrial smoothing; tickets FEST-0023, YADA-0421 and SOUP-0007; a Festivus
pole install and a puffy shirt recall. Every address is at `example.com`. The
hours belong to Cosmo Kramer. Two weeks of them, including a timer that is
running when you open it, a drive with miles on it, an entry with a break taken
out of the middle, one that was carried past its limit with a reason, three
budgets and a day long enough to trip the overtime flag - so every feature in
the app has something to demonstrate itself with.

None of it is real, and that is the requirement, not a detail. A demo is a thing
you send to somebody. A demo carrying an actual client list is not a demo.

There is a page that says where this is going.

Everything anybody knows about Sundial's direction has been in `PLAN.md`, which
is a build document: fifteen sections of data model and phases, written to be
worked from rather than read. `roadmap.html` is the readable version - four
lists, linked from the app footer and nowhere else. **Shipped** is one line per
release, newest first. **Next** is the single-user work in the order it is worth
doing. **Later** is the team tier, with the two things it needs before any of it
is possible. And **Not planned** is each ruled-out idea with the reason beside
it, because a roadmap that only ever says yes is a wish list, and the questions
people actually ask - will it track where I am, will it do invoices, will it
work out overtime pay - deserve an answer in one line rather than a silence.

It is a static page with the app's own design tokens, its own light and dark
toggle remembered on the device, and no Firebase or account behind it. The
service worker precaches it, so it opens with no signal like the rest of the app.

An hour can say where it happened.

An hour on-site and an hour on the phone are the same hour in a timesheet and
very much not the same hour to the person paying for it. Clients now carry a
list of **locations** - a new one starts with **On-site** and **Remote**, and a
client that has never had any reads as having those two without anything being
written down - and an entry carries whichever one you picked. It is in the start
panel, in the running entry's details, in the entry form, in the Start dialog on
a client card, and it comes along when you Resume or Duplicate. The Today table
has a **Location** column in the Columns manager, off by default because a
column nobody asked for is a column in the way. The text export prints **@
On-site** after the job type, the email table grows a Location column when
anything in the range has one, and the hours CSV and XLSX get a `location`
field. Client import, export and the template gain a `locations` column, pipe
separated, exactly like job types.

What it is not: there is no GPS, no map, no lookup and nothing that knows where
you are. PLAN.md put location tracking under **Not planned** and meant it - a
browser cannot do it reliably and it is more than an hours log should know about
a person. This is a label you pick from a list you wrote. That is the entire
feature, and it answers the question anybody actually had.

While adding the `locations` column to the client template, the example rows
turned out to have been one cell short since `client_id` was added: every value
in them sat one column to the left of its heading, so anyone filling the
template in by example was filling in the wrong boxes. Fixed.

Budgets, for the hours somebody already agreed to.

A retainer, a quoted project, a month with a number on it - Sundial could
record every hour of one and never once mention that there were only forty.
Settings has a **Budgets** panel now. A budget is a client, an optional project
label, a number of hours, and optionally a pair of dates around it; leave the
project blank and it covers everything that client has. Each one shows what has
gone against it with a bar that turns amber near the end and red past it.

Where it actually earns its place is the Clock. Start a timer that falls inside
a budget and a line under it reads **Budget: 12h 30m of 40h used**, amber past
80 per cent and red past 100, counting the running time as it goes. If two
budgets cover the same entry it shows the tightest one, because the other is
not the one you are about to run out of. You get one warning at 80 per cent and
one when it is used up, both sticky so they are still there when you look up
from what you were doing - and neither offers to do anything about it. A budget
is somebody else's number, agreed in advance. Stopping work over it is a
conversation, not a button.

The Export preview ends with a **Budgets** block listing every budget belonging
to a client in the range and where it stands. Those figures are the budget's
own - counted over its whole span, not just the range above, which the last line
says out loud, because half a budget is not a useful thing to be told.

Adding a default job type now offers to add it where you wanted it.

**Default job types** in Settings seed a brand new client, and that is all they
ever did. Add **Backup Audits** to the list and it appears on the Clock for
precisely no one: every client you already have keeps the types it already had,
so the new type sits in Settings looking added and is not in a single job-type
picker. The name of the setting is honest and the behaviour was still wrong,
because nobody types a job type into a box in order to use it later on a client
that does not exist yet.

So it asks. Adding a default now counts the active clients that have no type of
that name, lists them, and offers **Add to existing clients** or **New clients
only**. Nothing is renamed or removed, no entry or export changes, and a client
that already has a type of that name - even an archived one - is left alone,
because archiving it was a decision and re-adding it would quietly undo one.
Under the chips there is now a line saying plainly that these seed new clients,
with **Add all defaults to existing clients** beside it for catching everything
up in one press.

A long day says so.

Sundial could tell you a week was 46 hours and never once suggest that was
worth noticing. Settings > Tracking has **Overtime** now: a daily threshold
(8 hours) and a weekly one (40), each with its own switch and both off until
you turn them on. When they are on, a day total past the daily figure gets an
amber **OT +1h 20m** beside it in the Week grid - in the seven-column table and
in the phone's stacked list - the week total gets the same treatment against
the weekly figure, the Clock's **Today** tile says **over 8h**, and the text
export adds **Overtime: 1h 20m over the 8h day** under the day it belongs to.

That is the whole feature, deliberately. No pay is worked out: Sundial has no
idea what your ninth hour is worth and guessing would be worse than silence.
Nothing is blocked, delayed or refused either - a long day is a fact about the
week you have already had, not something to be prevented at half past five. The
export's flag is computed from the same numbers printed above it, rounded and
after any unpaid break has come off, so the note and the hours can never
disagree.

Overtime is a separate idea from **Weekly capacity**, which is what the
utilization bar measures fullness against. One answers "how full is this week",
the other "was that day longer than it should have been", and they are allowed
to be different numbers.

### v0.6.0 - 2026-09-16

Google Calendar: Connect works against a real account.

The first real Connect got its permission from Google and then failed on the
very next request with `403 insufficientPermissions`. The cause was a wrong
assumption in v0.4.0: Sundial looked for its calendar by fetching the account's
calendar list. The `calendar.app.created` scope covers calendars this app
created, and listing calendars is not one of the things it covers - not even to
list the app's own. The obvious fix, asking for a wider scope, would have meant
requesting read access to somebody's entire calendar in order to write one
calendar, which is the trade this feature was built to avoid.

So the list is gone. Sundial remembers its calendar's **id** and asks for that
one calendar by id, which the scope does allow. If Google says it is gone, a new
one is made; a permission or network failure is reported instead, because
silently creating a second calendar over a dropped connection is the wrong
answer to "I could not reach Google". **Disconnect now keeps the id** - without a
list there is no way to find that calendar by name again, so forgetting the id
was the one thing guaranteed to produce a second `Sundial` calendar. It stops
writing and remembers where it was writing, and Connect goes straight back
there. Changing the OAuth client ID still drops the id, because to Google that
is a different app, and the toast now says so before you find out later.

And a refusal from Google now says what Google said. The 403 toast carries the
reason and message out of the response body, so the next problem of this kind
is diagnosable from the screen instead of from a network tab.

You can step away from a timer without lying about it.

Until now the only two things a running entry could do were carry on and stop.
A twenty-minute interruption left you with three bad options: let it run and
bill time you did not work, stop and start again and end up with two entries
where there was one job, or fix it up afterwards from memory. There is a
**Pause** button beside Stop now, and a small pause square on the running row
in the Today table. Pausing records a gap on the entry itself - a start and an
end, nothing more - and Resume closes it. Stopping while paused closes the gap
at the stop time, so a break can never outlive the entry it belongs to.

The gap comes out of the duration **everywhere**, because every screen asks the
same function how long an entry took: the timer, the Today table, the day list,
the week grid, the utilization bar, the calendar and every export. While a
break is open the big timer stands still - it is counting worked time, and no
work is happening - and an amber line under it says **Paused 12m - since 2:40
PM**, growing on the same one-second tick. The pill reads **Paused** and its dot
stops blinking, because a blinking dot on something that is not counting is a
lie told once a second.

In the Calendar the block stays exactly where it was. A block has to sit on the
time axis where the work actually happened, so it still spans start to end, and
each break is **hatched out of it** instead of shrinking it. The block says when;
its duration says how long. The entry form lists every break with its times and
an **x** to remove one, which puts that time straight back into the entry - a
Pause you forgot to Resume is a mistake, not a record.

And the lunch nobody presses Pause for. Settings > Tracking has **Auto-deduct an
unpaid break of N minutes on days over H hours**, off by default and set to 30
minutes over 6 hours when you switch it on. Like rounding, it happens on the way
out and never touches a stored time: the export takes the minutes off once for
that day, prints **Unpaid break deducted: 30m (Sep 15)** so the person reading it
can see what happened, and comes off billable hours first, because that is the
hour somebody would otherwise be charged for. A day's deduction only comes off a
client's subtotal when every hour on that day belongs to that one client; split a
day between two clients and there is no honest way to say whose lunch it was, so
it comes off the total alone and the line says so. Entries with real breaks on
them print **(breaks 25m)** after their duration, so the hours and the clock
times in the same row can be reconciled by whoever reads them.

### v0.5.0 - 2026-09-16

Google Calendar: Connect actually connects, and the calendar gets a link.

The first real Connect against Google failed quietly with "Failed to open popup
window". The cause: the app fetched Google's sign-in script only after the
click, and by the time the script was ready and asked to open the sign-in
window, Chrome no longer counted it as something the click had asked for and
blocked it. Google's script is now loaded as soon as the Settings panel shows,
so the click opens the window at once. If a browser still blocks it, the toast
says so and explains where to allow pop-ups. The status line, once connected,
also names the calendar in bold and links straight to it in Google Calendar so
you can confirm the mirrored entries for yourself.

Sundial knows when you are meant to be working.

Everything in here has been about hours already spent. Nothing said when the
day was supposed to start or finish, which is the first thing anyone wants to
know when they look at somebody else's clock - and the first thing a team
screen will have to answer when there is more than one person in this. Settings
has a **Working hours** panel now: a row per weekday with a switch, a start, an
end, and an unpaid break in minutes, with the hours that row comes to printed
beside it and a **Normal week** total under them all. The rows start on whatever
day your week starts on, and **Copy to other days** puts one row's times onto
every other working day, because five identical rows typed five times is not a
setting, it is a chore.

A day that cannot be true is caught where you typed it. An end before its start,
or a break as long as the day, gets a red line under that row and is **not
saved** - the day keeps the last hours that made sense, so a half-typed time can
never quietly become your normal week. New accounts start Monday to Friday, 9 to
5, with no break.

The Clock says where you are in it. Under the timer there is now a quiet line
reading **Working hours today 9:00 AM - 5:00 PM - ends in 2h 10m**, counting
down on the same one-second tick the timer uses; before the day starts it says
**starts in 40m**, and afterwards how long ago it ended. Start a timer outside
that window and the line turns amber and says so - **Outside working hours
(today 9:00 AM - 5:00 PM)** - and on a day switched off it simply reads **Day
off**, amber if a timer is running on it. It is a statement, not a rule: it has
no button on it and it cannot stop, delay or flag a thing. Working late is
allowed; not noticing you are is the part worth fixing.

Google Calendar no longer asks for a client ID: the one for this project is
built in and filled into the Settings field, so connecting a new device is one
press of **Connect**. It is a public identifier with no secret attached, the
box stays editable, and emptying it comes back to the built-in one.

A block of work that starts and stops inside the same minute is an entry like
any other now. The date and time fields have no seconds box, so re-reading one
used to throw the seconds away and the Edit form would refuse its own entry
with "End must be after start" - a twenty-second phone call could be recorded
but never edited. A field nobody touches now keeps the seconds it already had,
and only a time somebody actually types snaps to the whole minute. When there
are no seconds left to keep and the two times still land in the same minute,
the entry is given length by moving its **start** back a minute, with a toast
saying so, rather than by refusing to save. The same rule settles a Switch, a
Resume or a Start from a client card that lands in the minute the old timer
began: the new task always keeps the minute it started in, and the old one is
nudged a minute earlier so it reads as a minute of work instead of nothing.
Nothing the app itself created is ever refused by the form that edits it.

The utilization bar can follow the panel instead of a fixed number. **Weekly
capacity follows working hours** takes the computed week - 40h 00m, or 37h 30m
once you have taken lunch out of it - and measures the bar on the Clock and the
Timesheet against that, so changing a working day changes the target with it
rather than leaving two numbers to disagree. It is **off by default**, and the
old Weekly capacity hours field carries on exactly as it did until you turn it
on; when you do, that field shows the computed number and stops accepting typing,
since a box that ignores what you type into it is worse than one that is clearly
read-only.

### v0.4.0 - 2026-09-16

Finished hours can mirror themselves into a Google Calendar.

The hours were only ever visible inside Sundial, which meant the honest record
of where the week went sat in one tab while the calendar everyone else looks at
sat in another. Settings has a **Google Calendar** panel now: connect it once
and every entry you stop turns into an event on a calendar called **Sundial**
in your own account, titled `Client - Job type #5421`, colored to match the
client, with the project, tickets, notes and whether it was billable in the
description. Editing the entry moves the event, deleting the entry deletes it,
and a running timer stays out of it until you stop it, because a block with no
end is not something a calendar can draw truthfully.

The permission is the narrow one on purpose. Sundial asks Google only for
`calendar.app.created`, which covers calendars this app made itself - it can
write on the Sundial calendar and it cannot see, read or change your work
calendar or your personal one. The access token is held in memory for as long
as the tab is open and is never stored anywhere, and when it expires Sundial
asks for a new one quietly; only if Google wants a fresh consent does a toast
appear with a **Reconnect** button, rather than a permission window opening
while you are typing a note.

Connecting takes one number. Because the Firebase sign-in cannot hand over a
token the Calendar API accepts, the calendar needs its own OAuth client ID from
the Google Cloud console - a public identifier, no secret, no server, no key.
The README's new Google Calendar section names the three console screens: turn
the Calendar API on, copy the Web application client ID and add this site to
its authorized origins, and add the scope to the consent screen. Paste the ID
into Settings, press Connect, and Sundial finds or creates the calendar itself
and asks nothing else.

There is a **Sync this week** and a **Sync this month** for the hours that were
already logged before any of this existed; they create what is missing, update
what is there, skip anything still running, and report the three numbers when
they finish. **Mirror entries automatically** can be switched off if you would
rather push weeks up by hand - entries already on the calendar are still kept
in step, since a calendar showing times you have since corrected is worse than
no calendar. And an entry stopped in a server closet with no signal is not
lost: it is flagged, the status line says how many are waiting, and they go up
the next time the connection or the permission comes back, by themselves or
with **Sync now**.

**Disconnect** is deliberately gentle. It hands the permission back and forgets
which calendar was in use, but deletes nothing and keeps the event ids on the
entries, so connecting again later carries on with the same calendar instead of
producing a second copy of the month.

### v0.3.2 - 2026-09-16

Editing a running entry: end date pre-filled, future end times ask first.

When an entry has no end yet (it is running, or it is a duplicate or manual
entry being typed), the End date now starts on the Start date, so only the time
needs typing. And an end time that is later than right now shows a note under
the duration ("that end is 2h 10m in the future") and asks before saving, since
it has not happened yet. Saving is still allowed after the prompt, for planned
time or a device with the wrong clock.

### v0.3.1 - 2026-09-16

Clearer names on the copy buttons.

"Copy day" and "Copy for email" sat side by side on the Timesheet (and "Copy
today" and "Copy for email" on the Clock), and the first of each pair did not
say what it produced, so one day got pasted as a block of text and the next as
a table depending on which was pressed. They now read "Copy day as text" /
"Copy day for email" and "Copy today as text" / "Copy today for email". Nothing
else changed: the text one is the plain block, the email one is the table with
the same text underneath for anything that cannot take a table.

### v0.3.0 - 2026-09-15

Travel job types ask for the miles while you still remember them.

Drive time has always been recordable - a job type could be flagged **travel**
since v0.1 - but the miles that go with it were not, and reconstructing a
month of trips from a calendar at expense-report time is exactly the kind of
evening this app exists to avoid. Stopping an entry whose job type is flagged
travel now logs the time immediately and then slides a small **Miles for
&lt;client&gt;** sheet up: the distance, and an optional note saying where you
drove ("Office to Acme Dental and back"). Save records both, **Skip** leaves
them blank. It does not matter which Stop you used - the big button on the
Now card, the red square in the table, a Switch, a Resume, starting a timer
from a client card, or putting an end time on the running entry in the entry
form - they all end up in the same place, so there is no route that quietly
loses a drive. If two travel timers stop at the same moment the second sheet
waits for the first rather than stacking dialogs on top of each other.

A travel job type now carries a small car beside its name in the running
pill and in the tables, so you can see which timer is going to ask for miles
before you stop it rather than after. A finished travel entry with no miles
on it gets a quiet **no miles** tag in the same place, because a skipped
sheet should be a reminder and not a hole. Miles and the mileage note are
also editable any time from Edit, where the two fields appear only for a
travel job type and disappear again if you change the entry to something
else - miles on a phone call would only ever be a mistake.

A Mileage tab on Export, which is the expense report attachment.

The Export screen opens with an **Hours / Mileage** switch at the top. Mileage
keeps the range picker and the client filter - the two things that decide
which trips you are claiming - and puts everything else away, because
rounding, billable filters and templates are about durations and a drive is a
distance. What you get is a table of the range's travel entries: date,
client with its Client ID, the tickets, the note you wrote in the Miles
sheet, the miles, and the amount at the mileage rate from Settings, with a
total line under it. Entries you skipped are listed with a **no miles** tag
rather than dropped, so the claim shows you what is still missing instead of
quietly shrinking. **Copy as text** gives a short plain block that pastes
into an expense form, and **CSV** and **XLSX** write `date, client,
client_id, ticket, note, miles, rate, amount` for anything that wants the
numbers. The Settings mileage rate is a proper money field now, and its
tooltip says what it actually is: the IRS standard rate, set once a year.

Time limits, which finally do something.

A job type has been able to carry a **warn at** and a **hard limit** since
v0.1, and until now the numbers just sat there. They are enforced on the same
one-second tick that draws the timer, which means they are computed from
timestamps: a limit crossed while the laptop lid was shut shows up the moment
you open it again, with the real elapsed time and not a guess.

What gets measured is the interesting part. An entry with no ticket number is
measured against its own elapsed time. An entry **with** a ticket is measured
against everything ever logged against that ticket, on any day, plus the time
running right now - so a ticket picked up three afternoons in a row trips at
two hours in total instead of three times at nothing, which is the case the
whole feature exists for. The popover where you set the numbers says so, and
it now refuses a warn point that is not below the hard limit; clearing both
boxes removes the limit.

While a limited job runs, the line under the timer reads "1h 12m of 2h
limit", quiet until it matters and then amber, then red. At the warn point a
toast appears that **stays until you dismiss it** - "Approaching the 2h limit
for Support Ticket. #5421 has 1h 45m logged." - with **Keep going** and
**Switch task** on it, and it is not allowed to be pushed off the screen by
an ordinary "Saved." confirmation. If notifications are switched on in
Settings and the app is in the background, the same sentence arrives as a
system notification.

The hard limit is not a toast, because it is a decision. A modal says how
much is logged against what, asks for a **reason**, and will not take an
empty one. **Continue** records the reason on the entry and lets the timer
run; **Stop now** ends the entry at the exact moment the limit was reached,
so the logged time is the limit and not the limit plus however long the
dialog sat there. The timer keeps running the whole time the modal is open -
the clock is computed from timestamps, and stopping it behind your back would
be worse than running over.

An entry that was carried past its limit keeps an amber **over limit** tag in
the tables with the reason on hover, gains a line under it in the text export
("Continued past the 2h limit: waiting on a vendor callback"), and the same
line in the Notes cell of the email table. The hour past the limit ends up
with its explanation attached rather than an argument a month later.

A Warnings panel in Settings, and the only permission prompt in the app.

An on-screen toast only reaches you when Sundial is the tab you are looking
at, which is exactly not the case when a job has quietly run long. Settings
has a **Warnings** panel with one switch: also warn with a system
notification when the app is in the background. Turning it on is the only
thing in Sundial that ever asks your browser for notification permission -
nothing asks on first open, where a permission prompt is noise from an app
you have not decided to trust yet - and the line under it says where you
stand afterwards: Granted, Blocked, or Not supported, with the note that an
iPhone needs Sundial added to the home screen before a notification can
reach it at all. Notifications only ever fire for limit warnings, only while
the tab is hidden, and everything about them is guarded, so a browser with no
notifications at all just carries on with the on-screen warning.

Everything new in this release was walked through in dark mode as well as
light, at a phone, a tablet and a desktop width, and nothing scrolls
sideways anywhere. The one accidental thing that turned up was a class name:
the limit line under the timer was borrowing the styling of the warning box
inside modals by sharing the word `warn` with it. It has its own names and
its own deliberate amber and red chips now, so changing one can no longer
change the other by surprise.

### v0.2.0 - 2026-09-15

Copy for email, and Open in email.

Pasting the text export into Gmail gave a wall of monospaced lines that lost
its alignment the moment the recipient's font was not fixed-width. **Copy for
email** now puts a real table on the clipboard as well: Client (with the Client
ID in brackets when you use one), Time, Duration, Job type, Ticket, Project and
Notes, with a bold subtotal row per client and a bold total, and a Date column
in front when the range covers more than one day. Ticket numbers are links
wherever the client has a ticket URL pattern. The whole thing is styled inline,
because email clients throw stylesheets away, and it is deliberately plain -
thin grey borders and one light grey header row - so it still reads correctly
in someone else's dark mode. The plain text goes on the clipboard at the same
moment, so anything that cannot take a table gets exactly the block it always
got. The button sits next to Copy as text on Export, next to Copy today on the
Clock, and next to Copy day on the Timesheet.

**Open in email** hands the same plain text to whatever mail app the device
has: subject "Hours for Mon, Sep 14, 2026", the export as the body, and the
client's email already in the To line when the Client filter is set to one
client that has one. A mailto link cannot carry a table, which is what the
button's tooltip says, so the rich version stays a copy and a paste.

Rounding finally does something, and amounts arrive with it.

Rounding has been stored since v0.1 - in Settings as a default, on each client
as an override - and it has been quietly ignored until now. The Export screen
has a **None / 6 min / 15 min** control that starts on your Settings default;
while it sits there a client with its own override wins for that client's
hours, and tapping a different increment forces it on everybody for that one
export. Each entry is rounded on its own, half up, never down to nothing, and
then the rounded durations are added up - so the subtotals a client checks
actually add to the total printed under them. Your stored times are untouched:
the Clock and the Timesheet always show the real elapsed minutes, because the
honest record and the invoice are two different documents.

When **Show amounts** is on in Settings, exports gain money. Subtotal lines in
the text pick up `- $636.00`, a `Total amount` line closes it out, the email
table gains an Amount column with the subtotal and total amounts in it, and the
CSV's rate and amount columns compute from the **rounded** billable hours so
the money always matches the hours printed beside it. Non-billable time never
carries an amount. There is also a Show amounts checkbox among the export
options, so you can send the same hours without the money without going back to
Settings; it only appears when the Settings toggle is on.

An XLSX button sits beside CSV.

The hours CSV has always needed Excel to guess at what the columns were. XLSX
writes the same rows as a real workbook - one `Hours` sheet, no import wizard,
no date column turning into something else - using the same spreadsheet library
the client import and export already load on demand, so nothing new is
downloaded until the first time you press it. The file lands as
`sundial-hours-2026-09-14.xlsx`, or with `_to_` and the end date for a range.

A utilization bar, so the week is visible before Friday.

"This week 9h 35m of 40h" now sits under the tiles on the Clock and above the
views on the Timesheet, with a stacked bar - billable in the accent color,
non-billable in the same color faded - measured against the weekly capacity you
set in Settings. The Clock always shows the current week; the Timesheet shows
the week containing whichever day is selected, and says "Week of Sep 7" instead
of "This week" when that is not the current one. Going over capacity is called
out rather than hidden by a full bar. These numbers are raw time, never
rounded: the bar is the honest picture of the week, and rounding belongs to the
invoice. With no capacity set, the bar still shows the billable split and the
line tells you where to set one.

The Week grid, for filling a missed day in from memory.

The Timesheet's Day / Week / Calendar control has had Week greyed out since
v0.1. It works now: one row per client and job type used that week (a ticket
number makes its own row, because that is how the hours get reported), seven
day columns, row totals down the right, day totals along the bottom and the
week total in the corner. Today's column is tinted.

The point of it is that the cells are typing boxes. Put `1:30` into an empty
one and it logs ninety minutes on that day starting at 9:00 AM; `1.5`, `90m`
and `1h 30m` all mean the same thing. Type into a cell that already holds one
entry and it moves that entry's end time instead. A cell holding several
entries, or a running timer, is not a box you can type in - there is no
sensible way to split one number across them - so it becomes a button that
opens the day view, and says so on hover. **+ Add row** puts an empty row in
for a client and job type you have not touched this week; an empty row can be
removed again with the bin on the right, and since it has no time on it,
nothing is deleted. The prev / next arrows step a week at a time here, and
Today becomes This week.

Phones do not get a seven-column table - it would scroll sideways, which this
app does not do. They get one block per day instead, with the day's total and
the rows that have time on it underneath, and the same typing boxes.

Which view you are in is remembered on the device, not in your account, so the
phone can sit on the day list while the desktop sits on the week grid. The
Settings field now sets the starting view for a device that has never chosen.

The Calendar, for seeing where the day actually went.

The third view draws the week on a time axis: 6 AM to 8 PM by default, stretched
automatically to hold anything that started earlier or ran later, and stretched
again to keep the red "now" line on screen when you are working at an odd hour.
One column per day on a desktop, one column - the day the strip has selected -
on a phone. Each entry is a block in its client's color with the job type and
ticket inside; anything shorter than fifteen minutes is just the color, with
the details on hover, because four lines of text in a nine-pixel block help
nobody. Two jobs running at the same time sit side by side rather than on top
of each other, which is the entire argument for having this view: an overlap
you cannot see is an overlap you will not fix. The running block grows every
second.

On a desktop the blocks are editable by hand. Click one to open the entry form.
Drag its bottom edge to change the end time, or drag the block itself to move
it, keeping its length; both snap to five minutes and nothing is written until
you let go. Click an empty spot in a column to add half an hour starting right
there, with the day and time already filled in. Phones get tap-to-edit and
tap-empty-space-to-add, and the hint under the calendar says that dragging is a
desktop thing rather than leaving you poking at it.

### v0.1.14 - 2026-09-15

Start a timer from the Clients screen.

Every live client card has a green Start button. It opens a small confirmation:
pick the job type (ticket and project are optional), and the dialog says
whether anything already running will be stopped or will keep running
alongside, using the same rule as Resume. Start now starts the timer at the
current time and takes you to the Clock. Clients with no job types are asked to
add one first.

### v0.1.13 - 2026-09-14

Copy day on the Timesheet.

The Clock screen's Copy today only ever copied today. The Timesheet day view now
has a Copy day button that copies whichever day is selected in the strip, in
the same email-ready text, following the day view's client filter and your
saved export options. Yesterday's hours are one tap away without a trip to
Export.

### v0.1.12 - 2026-09-14

Notes as a sub-row under each entry.

Notes was the widest column and still cramped. It is no longer a column: when
Notes is switched on in the Columns manager, each entry gets a full-width
sub-row beneath it holding the note, indented and in a quieter grey, joined to
the row above so the two read as one entry. Long notes still show two lines
with an ellipsis and a "more" link that expands them. Project takes the slack
that Notes used to take, so the main columns get more room.

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

(The link itself is gone as of v0.7.0: the four fields are always on the idle
Now card. The three button labels described here are unchanged.)

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
