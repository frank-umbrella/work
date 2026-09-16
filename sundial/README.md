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

The Export screen has an **Hours / Mileage** switch at the top, a range picker
(Today, Yesterday, This week, Last week, This month, Custom) and a client filter
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
working hours** hands that number to the utilization bar on the Clock and the
Timesheet. While it is on, the Weekly capacity hours field in Tracking shows the
computed number and cannot be typed into. It is off until you switch it on, so
nothing about the bar changes on its own.

None of it ever blocks a timer. Working hours are there so the screen can tell
you - and later a team dashboard can tell someone else - when you are expected
to be working; a job that runs at 11 PM still starts, stops and exports exactly
as it always did.

## Google Calendar

Finished entries can be mirrored into a calendar called **Sundial** in the
Google account you signed in with, so the week shows up next to your meetings.
It is off until you switch it on, and it is set up entirely in Settings.

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

### When there is no signal

A write that cannot reach Google does not hold up the hours: the entry is
flagged and the status line says how many are waiting. They go up on the next
successful connection - when the browser comes back online, when you reconnect,
or when you press **Sync now**.

### Disconnect

**Disconnect** hands the permission back to Google and forgets which calendar
was in use. Nothing is deleted: the Sundial calendar and every event on it stay
where they are, the client ID stays in Settings, and entries keep the id of the
event they created - so connecting again to the same calendar carries on
instead of making a second copy of everything. (Erasing your Sundial data does
not remove the calendar either; delete it in Google Calendar if you want it
gone.)

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

### v0.5.0 - 2026-09-16

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
