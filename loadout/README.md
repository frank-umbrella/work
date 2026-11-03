# loadout

Loadout is the shop's inventory tool: what is on each shelf, how many feet are
left in each wire box, who has each expensive unit, and the pick tickets that
turn an accepted Portal proposal into a staged bay. Phone first for the
warehouse, desktop for the office. Internal: no hub tile, no links from other
pages, `noindex, nofollow`, and the shared Watchtower sign-in
(`@umbrellaautomation.com` Google accounts only). The plan is `PLAN.md`; the
chosen look is direction B, Ledger, in `design-preview.html`.

Current version: **0.6.1**.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: markup, styles, and script in one file. |
| `qr.js` | Vendored QR encoder (qrcode-generator 1.4.4, MIT, by Kazuhiko Arase), loaded locally so labels never depend on a CDN. |
| `favicon.svg`, `icon-192.png`, `icon-512.png` | The hard-case mark. The PNGs are rendered from the SVG. |
| `manifest.json` | Add to Home Screen: standalone, named Loadout, opens on Scan (`start_url` `./#scan`). |
| `sw.js` | Service worker: keeps the app shell, the zxing barcode fallback, and the Firebase modules on the device so Loadout opens with no signal. The cache name carries the version. |
| `og-image.svg`, `og-image.png` | Link preview card in the house style. |
| `PLAN.md`, `design-preview.html`, `storyboard.html` | Plan, design switcher, and the owner's storyboard. |
| `samples/` | Real data for testing the importer. Git-ignored; never commit it. |

## Using it

- **Tickets** (home on the desktop): pick tickets grouped by status, with a
  search (ticket number, client, job, proposal, or bay; `/` jumps to it),
  filters for status, client, install date, items to order, and backorders,
  and an Install column that sorts. **New ticket** imports a
  Portal proposal CSV (columns matched by header name, a preview, Labor, Fee,
  and CustomItem rows and blank quantities listed as skipped, unmatched brands
  and models offered as new products) or takes lines typed by hand. Importing
  the same proposal number again adds or adjusts lines on that ticket. Each
  ticket says where it came from (Imported from CSV, Imported from Portal, or
  Built by hand), and a ticket Zapier made from Portal carries an "Imported
  from Portal, review" chip until someone checks it.
- **Ticket**: lines grouped by area with Pull from stock (pick the shelf, scan
  if you like; the quantity moves to the staging bay), Stage, Deliver to site
  (serialized units on the line check out to whoever delivers), and Note;
  Pull everything in stock; Copy for Portal (it now lists what is on order,
  with PO, carrier, and dates); Print (a pick list); Show on board; and Close,
  which returns or writes off what is left in the bay and marks units out on
  the ticket installed at the job. The header carries the install date.
  Each line leads with its state: Pull, Staged (or "Staged 2 of 4"),
  Delivered, On order (with the ETA, or "Delivered, not received"), or Short
  (red: the shelves and open POs do not cover it). **Order missing** and a
  line's **Order** put the Short quantity on a draft purchase order, and each
  line shows a chip per PO, for example "PO 7731, UPS 1Z999AA1: Shipped,
  Oct 23". The Tickets list, its "Has items to order" filter, the ticket's
  strip, the board, and Week all count Short the same way. A ticket flagged for review has a
  **Mark reviewed** button (warehouse and admin) that clears the flag and logs who
  did it.
- **Orders**: purchase orders with filters for status and vendor. A draft's
  empty Vendor select glows until one is picked; a vendor typed there joins the
  list in Settings. An order shows its lines (ordered, backordered with the
  vendor's ETA, shipped, delivered, received, and the ticket line each serves)
  and its shipments. **Mark ordered** needs the vendor and the vendor's order
  number, and asks where it ships: the office, or straight to the job's site
  (the select glows until picked; left alone it means the office; a stock PO
  always ships to the office). With Show costs on it also lists each line's
  unit cost, filled from the product's last cost and editable; with costs off
  the last cost is stored without asking. **Add shipment** guesses the carrier from the tracking number (1Z is
  UPS, 12 or 15 digits FedEx, 20 to 22 digits starting with 9 USPS; it can be
  changed), carries some or all of the lines, takes the expected date, and
  can send that one box somewhere other than the PO says. **Receive** walks a shipment
  line by line: tap to take the quantity, or scan each unit's UPC to count it;
  lines for a ticket go into its staging bay and count as staged, the rest go
  on a shelf; units at or above the QR threshold become serialized units
  ("Product name #n") with a prompt to print their labels.
- **Tracking**: split down the middle. Left, packages coming to the office;
  right, packages going straight to a client's site, grouped by client and job;
  along the bottom, Recently delivered, the last 30 days newest first (a
  sortable table with Columns). Each package is a card with the carrier, the
  tracking number as a link (a 44 px target), what is in it, the PO and vendor,
  who it is for, and its status with the date and time of that status. Late
  packages say "Expected Oct 30, 3 days late" in amber; a box delivered to the
  office and not received floats to the top in amber. Office cards have
  Receive, job-site cards have **Mark delivered** (the lines count as received
  on the PO and staged on the ticket; nothing goes into stock), and both have
  Note. Lines no shipment carries yet show as one card per PO (Ordered or
  Backordered, with Add shipment). Filters for client and job, vendor,
  carrier, status, and late apply to all three parts, and each column header
  counts its packages. Under 900 px the columns stack, office first.
- **Week**: the staging schedule as a timesheet, one block per day with a card
  per ticket by its install date and each line's status on the right. Previous
  week, This week, Next week; a Work week toggle (remembered per person) hides
  the weekend and shows a chip when a hidden day has work. Past days are faded,
  today has a soft blue border, and tickets with no install date sit in an
  Unscheduled list with a date field. On the phone the days stack, today first.
- **Board** (`?board=1`, and the landing view for the board role): the
  warehouse TV. One pinned ticket per screen, rotating, lines grouped by the
  shelf to pull from in rack order; staged lines greyed (a line staged from a
  PO under Staged), on-order amber with the PO and ETA, short red; a 32 px red
  "Not live since 8:14 AM" strip when the connection drops. Type is sized to
  read from four meters (product lines 32 px, counts 48 px, headers 26 px,
  nothing under 24 px); a list longer than the screen scrolls at 40 px a
  second with a 3 second pause at each end while the header and progress bar
  stay put; a 6 px bar along the top shows when the next ticket comes up.
  Against burn-in the whole board steps 2 px on every rotation (once a minute
  when nothing rotates), and the idle screen walks its clock. The Today mode shows the tickets whose install date is
  today, from the Week view.
- **Stock**: the catalog with search, sorting, a Columns manager, and tabs for
  All, Consumables (wire boxes with feet left), Low stock (with Reorder), and
  Locations. A product or location row opens in place under itself: fields in
  two columns, on hand by location, boxes, and one row of buttons (Save,
  Receive or Receive a box, Pull for ticket, Move, Count, Adjust, Serialize,
  Reorder, Print label, Show history); the Scan card shows the first of the
  same buttons, in the same order. One is open at a time, marked by a blue
  bar down its left edge; Escape or the chevron at its top right closes it,
  and the address carries it
  (`#stock/p/<id>`, `#stock/l/<id>`), so a link lands on it open. Modals stay
  for the decisions that need a confirm.
- **Scan**: point the phone at a UPC or a Loadout label, or type the code.
  Shelf labels set the active location; box labels open the box sheet (mark
  now, cut this time, quick -50 / -100 / -250, Empty, recount); unit labels
  show who has it with Check out and Check in. Product and unit cards have
  Pull for ticket, the box sheet a For ticket chip, and a bay's label shows
  the ticket staged there. On a phone or tablet, a label that explains itself
  has a ? beside it that opens the explanation (a mouse shows it on hover).
- **Units** (called Items before 0.6.0): every serialized unit, with Out as
  the Friday list. A unit opens in place the same way (`#items/i/<id>`), with
  its label, serial, condition, Check out, Check in, Move, Retire, and Show
  history.
- **Console** (admin and accounting; also linked from More): **Reports**,
  each with a From and To date (this month by default, with This month and
  Last month buttons), a sortable table with the Columns manager, a one-line
  total, and Export CSV / Export XLSX of the rows and columns shown: Stock on
  hand (by product and location, category, or location, with value at last
  cost when costs are on), Spend (POs marked ordered, by vendor and month),
  Delivered (every Deliver to site, by delivery or by client and job), Units
  out (who held which unit and for how long), Wire usage (box cuts by cut, job,
  person, or both), Movements (the raw trail for the range, filtered by type
  and person), and Aging (open tickets, open POs, and delivered-not-received
  shipments in age bands). Reports read the range fresh from the database, not
  the latest-500 list. **People** (admin): confirm newcomers, change a role
  (including the wall board TV's Board account), deactivate or reactivate.
  **Settings** (admin): show costs, QR threshold, week start, the Work week
  default for the Week view, label sheet, box start lengths, carriers,
  vendors, the Portal tier, and the wall board (mode, rotation, grouping,
  theme, picked lines, pinned tickets), all saved by one button. **About**:
  the data dictionary for every collection, rendered from `DATA_DICTIONARY`
  in the code, with the readability rules. **Export everything**: every
  collection as one workbook or as zipped CSVs, file names stamped with the
  date and time. **Backups** (0.6.1): the nightly copies loadout-worker
  writes to the project's Storage bucket, newest day first with a status
  line from `loadout_settings/worker` (the last run's time in UTC, file and
  row counts, or the last error); a day opens in place to its 18 CSVs with
  their sizes and Download links. The first 30 days show, then Show older.
  The list comes straight from Storage, so it needs a connection.
  `#console/backups` opens it. Accounting sees Reports, About, Export, and
  Backups with no edit controls at all.
- **More**: movements log with filters, Previous / This / Next week buttons,
  and CSV, Clients and Jobs (add, edit,
  archive; a job can reserve a staging bay), label sheets (Avery 5160 or
  2 x 4), and for admins the inventory sheet importer. Admins and accounting
  get a row of Console links (Reports, People, Settings, Board, About, Export
  everything, Backups); warehouse and techs keep About and Export everything as tabs
  here. On the phone the tab bar is Tickets, Week, Scan, Stock, More, and
  Orders, Tracking, Units, and the Console sit at the top of More. More also
  carries the Add to home screen card until it is dismissed on that device.
- **Offline**: Loadout opens and works with no signal once it has been opened
  online on that device. Every change saves on the device first; the sync
  pill in the header reads Synced, Offline, or "3 pending" (changes waiting
  for the server), and a row changed while offline carries a small dashed
  "pending" chip until the server has it. The first change made offline says
  "Saved on this device. It syncs when you are back online." Scan works
  offline too: the camera, the zxing fallback on iOS, and lookups against what
  the device already holds. A change the server refuses later toasts and the
  row goes back to what it was. When a new release takes over a page that is
  still open, a "New version available, reload" toast offers a Reload button.
- **Desktop**: tables keep their header row in view under the app header on
  a long list, and show a sort arrow on hover; Edit columns opens a small
  panel under its button instead of a dialog; an empty list says so inside
  the table under its headers, with the next step. Forms put two fields side
  by side from 900 px up and one below; the first field takes focus, Enter
  saves a form that has one text field, and a required field that is not a
  choice says "required". `/` jumps to the view's search field.
- **Photos**: a product's panel (Stock, open a row) has a Photo slot with Add
  photo, Replace photo, and Remove photo for admin and warehouse. The photo
  is shrunk to 1200 px and saved as JPEG before upload, and shows on the Scan
  product card and in an optional Photo column (off by default; turn it on in
  Columns). Adding or removing a photo needs a connection.

Roles: the account named in the rules as the project owner becomes admin on
its first sign-in; everyone else lands as Tech until an admin changes the role
under Console, People. Warehouse and admin change stock and build, pull, and close
tickets; techs scan, check out, check in, record box readings, and stage and
deliver ticket lines; accounting and board only read.

### Demo mode

`?demo=1` opens the app on invented sample data with no sign-in. Every write is
refused with a "Demo mode: not saved" toast (the refused batch stays on
`window.Loadout.state.lastOps` for checking by script). `&role=tech`,
`&role=warehouse`, `&role=accounting`, or `&role=board` shows that role's
view (`&role=accounting` is the read-only Console); `&costs=1` turns Show
costs on so the reports show values; `&board=1` opens the wall board (`&mode=today`, `&mode=pinned`, or
`&mode=all_open` overrides the saved board mode on that screen); `&empty=1`
loads no tickets or orders, for the
empty states and the board's idle screen; (0.6.1) `&backups=error` shows the
Backups tab after a failed night, `&backups=many` gives 45 days so Show older
appears, and `&backups=empty`, `&backups=denied`, and `&backups=offline` show
those states (the plain demo has three days, the oldest one stopped at 9
files, and its Download links are dead `#` links marked Demo); `&print=1` opens a label sheet
preview. The New ticket sheet has a Load sample button with a made-up Portal
CSV in demo mode only. The fixture has four purchase orders (a draft with no
vendor, a partial one with two shipments, one ordered with a late shipment,
one received), install dates across this week, and imported rows that show the
0.3.0 name fixes. 0.5.1 adds two POs drop-shipped to job sites (three boxes on
the client side for two clients, one late, one out for delivery, and one
already delivered to the site), a draft PO 7739 with its vendor picked for
trying Mark ordered, unit costs on the ordered lines, status logs with clock
times on the newer shipments (the older ones read through the migration), and
ticket #1056, made by Zapier from Portal and still flagged for review. 0.4.0 adds costs on the catalog, a closed ticket and four
more POs from last month and this month (one still open and backordered), and
the deliveries, box cuts, and check-outs around them, dated inside this month
and last month so every report has rows on any day, plus a roster with Lead
tech, Accounting, Board TV, and a deactivated Former tech. 0.5.0 gives the
Ubiquiti U6-Pro and the Sonos Amp a drawn placeholder labeled "Sample photo";
Add, Replace, and Remove photo answer with the usual "Demo mode: not saved".
The demo hook adds `window.Loadout.sync({online: false, pending: 3})` to drive
the sync pill (`sync(null)` goes back to Demo),
`window.Loadout.pending("products", id, true)` to put the pending chip on a
row, `window.Loadout.install("prompt" | "ios" | "menu" | "none")` to pick
which Add to home screen card shows, and (0.5.2) `window.Loadout.exportTables()`
to read the Export everything tables without downloading, and (0.6.0)
`window.Loadout.boardRotate(6)` to set the board's rotation for watching the
scroll and the 2 px shift. 0.5.2 adds a Short
line with stock elsewhere (ticket #1053 needs 80 keystones; 64 are on the
shelves and 24 ride in Van 1, which a ticket never pulls from, so 16 are
Short), a draft started with no connection (no PO number until Mark ordered
numbers it), and PO 7738 with an office box out for delivery, so every
shipment state shows. `sync({online: false})` also makes the demo act offline
for numbering: a new PO becomes a draft with no number, and Mark ordered on it
says "Connect to assign the PO number". No Firebase code loads in demo mode. The
service worker does register in demo mode, since the demo is how the offline
shell is checked.

## On the phone

Loadout is laid out for one hand: a tech holding a box in one hand and the
phone in the other. Everything you press sits in the lower half of the
screen, where the thumb already is.

- **The tab bar** along the bottom: Tickets, Week, Scan, Stock, More. Scan is
  the raised button in the middle. Nothing on a page ends up hidden behind
  the bar; the page always scrolls far enough.
- **Every dialog is a sheet that slides up from the bottom.** The button that
  does the job is the last one, full width, right above the bar; Cancel sits
  above it. The body scrolls between the title and the buttons, so the
  confirm button never moves off screen. Swipe the handle at the top down, or
  tap it, to close; Escape on a keyboard does the same. A tap on the dimmed
  page above does nothing, so a stray thumb never throws away what was typed.
- **Cards, not tables.** Each row of a list is a card. Its buttons sit at the
  bottom of the card: at most two, the likely one first and blue, the rest
  under the **...** button, which opens them in a sheet.
- **Filters fold away.** A list with filters shows one Filters button (it says
  how many are on); the filters open in a sheet with Clear filters and Done.
  Search fields stay on the page and have their own clear button.
- **The header shrinks** to 48 px once you scroll, and messages appear just
  under it, never behind the notch.
- **Scan** gives the camera as much of the screen as it can, with the type-it
  field right under it and the result card peeking above the tab bar. The
  box sheet keeps -50, -100, -250, Empty, and Save cut in the bottom bar.
- **Typing**: number fields open the number pad; fields use 16 px text so the
  phone does not zoom in; dates use the phone's own date picker.
- **Reading**: card text is 15 px, small grey text 13 px, nothing smaller; every
  button is at least 44 px tall with 8 px between neighbors. A field whose
  reason is not obvious has a ? that opens the reason.
- **On its side** the full desktop menu shows, the header scrolls away with
  the page, sheets put their buttons in one row, and Scan puts the camera and
  the result side by side.

## Install on a phone

Open Loadout once with signal and sign in, then add it to the home screen. It
opens straight to Scan, full screen, and keeps working in the warehouse with
no signal.

- **Android (Chrome)**: tap **Add to home screen** on the card under More, or
  on the strip that shows once under the header. Chrome asks to confirm.
  Without the card, use the Chrome menu and pick **Add to Home screen** or
  **Install app**.
- **iPhone or iPad (Safari)**: tap **Share** (the square with the arrow) in
  Safari's toolbar, scroll down, and tap **Add to Home Screen**. The card under
  More shows the same two steps.

The card and the strip each go away for good on that device once dismissed.
The first sign-in needs a connection; after that the phone stays signed in
and opens offline. Changes made offline go up the next time the phone has
signal with Loadout open.

## Data

Firestore project `watchtower-6fbe1`, collections `loadout_users`,
`loadout_settings`, `loadout_products`, `loadout_locations`, `loadout_stock`,
`loadout_containers`, `loadout_items`, `loadout_movements`, `loadout_clients`,
`loadout_jobs`, `loadout_proposals`, `loadout_tickets` with a `lines`
subcollection per ticket, `loadout_orders` with a `lines` subcollection per
purchase order, and `loadout_shipments` (field lists in PLAN section 3). Ticket ids are the
proposal number; line ids are the area plus brand and model, so a change
order re-import finds the line it changes. Settings hold `board` (the wall
board) and `importMap` (the saved CSV column mapping). Line quantities, all in
the product's unit: `qtyNeeded` from the proposal, `qtyFromStock` pulled off
our shelves, `qtyToOrder` what stock cannot cover, `qtyStaged` laid out in the
bay, `qtyDelivered` taken to site. A ticket's `installAt` is the day it
installs (the Week view), and a ticket line's `orderLineRefs` names the order
lines that serve it. Order ids are the PO number (from 7701 up); order line
quantities are `qtyOrdered`, `qtyShipped`, and `qtyReceived`, and each order
line carries the ticket number and line it serves. A shipment carries its
carrier, tracking number and link, dates, and the lines with the quantity on
it and received. Received units carry `label` ("Sonos Amp #2"), `orderId`, and
`shipmentId`; receive movements carry `orderId`, `orderNumber`, and
`shipmentId`. Movements written by the inventory importer are dated from the
sheet's count date and keep `importedAt`, `importTab`, `importRow`, and
`importKey`, so a re-import skips what is already written. Every record
carries readable names next to its ids, so the
database and the export read without the app. Each person's table layout is
saved on their own `/users/{uid}` doc under `loadoutLayout`. Settings
`general` gained `workWeek` in 0.4.0. `loadout_settings/worker` is written by
loadout-worker after each nightly backup (`lastExportAt`, `lastExportFolder`
(the day), `lastExportBucket`, `lastExportPrefix`, `lastExportFiles`,
`lastExportRows`, `lastExportPruned`, `lastExportError`,
`lastExportErrorAt`); the Console's Backups tab reads it. Products gained `imageUrl` (the photo's
download link), `imagePath` (`loadout/products/{id}.jpg` in Firebase Storage),
and `imageAt` in 0.5.0. In 0.5.1 purchase orders gained `shipTo` ("office"
or "client") and `shipToAddress`; order lines gained `unitCost`, fixed at
Mark ordered; shipments gained `shipTo`, `shipToAddress`, `note`,
`deliveredBy` and `deliveredByName`, and `statusLog`, a list of every status
change (`status`, `at`, `by`, `byName`, `note`) that Tracking reads the last
entry of. A shipment written before 0.5.1 has no log and reads its status with
the matching date; its first change seeds the log from its dates. Tickets
gained `reviewedAt`, `reviewedBy`, and `reviewedByName` beside the worker's
`needsReview`.

0.5.2 (audit-002):

- PO numbers come from `loadout_settings/counters` (`po`, the last number
  handed out, with `updatedAt`, `updatedBy`, `updatedByName`), read and bumped
  in one transaction with the PO it numbers, so two people never take the
  same number. On first use it starts from the highest PO in Loadout. A draft
  started with no connection has the id `draft-<random>` and an empty
  `number` until Mark ordered gives it one (online only); its id stays as it
  is, so its history and the ticket lines that point at it keep working.
- A new box is written with a create precondition: online, in a transaction
  that stops if the label exists; offline, the rules refuse a write that would
  replace another box (its `createdAt` may not change).
- Units carry `ticketNumber` and `clientName` beside `ticketId` and `jobId`,
  and boxes received for a ticket carry `pickTicketNumber`. A unit received
  on a PO takes the PO line's `unitCost` as its `cost` (the product's last
  cost only when the line has none), and the QR threshold reads the same cost.
- A ticket line's `qtyToOrder` is now a cache, rewritten with every
  warehouse save: needed minus staged minus what the shelves hold for that
  product (bays and vans left out) minus what open PO lines for that line
  still bring. The screens work the same sum out live and never read the
  cache alone.
- Movement types: `receive`, `pull` (shelf to a bay for a ticket), `move`
  (shelf to shelf, no ticket), `stage`, `deliver`, `cut`, `reading`,
  `adjust`, `checkout`, `checkin`, `return` (a unit back from a client's
  site), `writeoff`, and `edit`. Rows written before 0.5.2 keep what they say
  in the database (`pick`, `transfer`, `return` for close leftovers, `adjust`
  for write-offs and retirements); the app reads them as the new words.
- Export everything writes a shipment's `statusLog` as its own file,
  `loadout_shipments_status.csv` (shipment id first, one row per change), and
  its `lines` as `loadout_shipments_lines.csv` (one row per line); the
  shipments file no longer carries either. A ticket line's `orderLineRefs`
  reads as one `orderId/orderLineId; ...` column. Nothing in the export is
  JSON text any more.
- Each person's saved table layout (`loadoutLayout` on `/users/{uid}`)
  carries `updatedAt`; at sign-in the newer of the device's copy and the
  account's wins.

The Console's About tab lists every field of every collection.

## Rules

The block below is appended to `../watchtower/firestore.rules` (one ruleset per
project). It was tested in the local Firestore emulator (0.2.0 added the
ticket, stock, and board-settings rules near the end; 0.3.0 added the
vendor-list rule on `settings/general`, 36 of 36 checks passing, including
orders, order lines, and shipments as warehouse-only writes); it is **not
deployed**. 0.4.0 changed no rules: the Console writes only `loadout_users`
and `loadout_settings`, which were already admin-only (apart from the
warehouse carve-outs for board pins, the import mapping, and the vendor list),
and accounting and board appear in no writer list, so they read everything
and write nothing. 0.5.1 changed no rules either: the new fields on purchase
orders, order lines, and shipments fall under the wildcard (warehouse and
admin write, techs do not), and clearing a ticket's `needsReview` is a ticket
update a tech's carve-out (`status`, `summary`, `updatedAt`) does not allow.
0.5.2 changes three things, checked in the local Firestore emulator on a
scratch port (34 of 34 checks passing): `loadout_settings/counters` (the PO
number) may be created and bumped by warehouse and admin, holding only `po`
and who took it, and `po` only goes up; a warehouse or admin write to a box
may not change its `createdAt`, so a box write never replaces another box;
and a tech's unit update may also write `ticketNumber` and `clientName`
(Deliver to site and check-in), and a tech's box update `pickTicketNumber`.
**Not deployed.**
The owner of the Firebase project deploys it from `work/watchtower` with:

`firebase deploy --only firestore:rules --account frank@umbrellaautomation.com --project watchtower-6fbe1`

```
// -------- Loadout (work/loadout) --------
// Shop inventory. Shares THIS project's login like Backup Audits and
// Sundial. Data lives in loadout_* collections shared by everyone on
// the domain; what differs per person is the role on
// /loadout_users/{uid}: admin, warehouse, tech, accounting, board.
// Accounting and board appear in no writer list, so they only read.
// A signed-in account with no roster doc counts as tech; a paused one
// (active == false) counts as 'none' and only reads.
//
// Firestore allows a request when ANY matching statement allows it,
// so the wildcard match at the end leaves out the collections that
// have their own rules here. Without that, a warehouse user could
// update the append-only movements through the wildcard.
//
// loadoutRole() reads one document. exists() and get() on the same
// path count once toward the per-request lookup limit, and every rule
// below calls loadoutRole() once (the update rules bind it with let).
function loadoutRole() {
  let path = /databases/$(database)/documents/loadout_users/$(request.auth.uid);
  return !exists(path) ? 'tech'
    : (get(path).data.get('active', true) == true ? get(path).data.get('role', 'tech') : 'none');
}
function loadoutAdmin()  { return isMSPAdmin() && loadoutRole() == 'admin'; }
function loadoutWriter() { return isMSPAdmin() && loadoutRole() in ['admin', 'warehouse']; }
function loadoutTech()   { return isMSPAdmin() && loadoutRole() in ['admin', 'warehouse', 'tech']; }
function loadoutOnly(keys) {
  return request.resource.data.diff(resource.data).affectedKeys().hasOnly(keys);
}
// techs may change the fields their scans touch, nothing else.
// 0.5.2: a unit also carries ticketNumber and clientName beside its
// ticket and job ids (PLAN 16 rule 3), so a tech's Deliver to site and
// check-in may write those two as well.
function loadoutItemUpdate() {
  let r = loadoutRole();
  return r in ['admin', 'warehouse']
    || (r == 'tech' && loadoutOnly(['status', 'holderUid', 'holderName', 'jobId', 'jobName',
         'clientName', 'ticketId', 'ticketNumber', 'ticketLineId', 'locationId', 'locationName',
         'checkedOutAt', 'checkedInAt', 'condition', 'updatedAt']));
}
// 0.5.2: a box write never replaces another box. A new box is written
// with createdAt, so a write that would land on a label another device
// already took (two people receiving offline) changes createdAt and is
// refused, instead of overwriting that box's feet and shelf.
function loadoutKeepsCreated() {
  return request.resource.data.get('createdAt', null) == resource.data.get('createdAt', null);
}
function loadoutContainerUpdate() {
  let r = loadoutRole();
  return (r in ['admin', 'warehouse'] && loadoutKeepsCreated())
    || (r == 'tech' && loadoutOnly(['ftLeft', 'lastMark', 'status', 'pickTicketId', 'pickTicketNumber',
         'lastReadingAt', 'lastReadingBy', 'locationId', 'locationName', 'confirmLocation']));
}
// a tech's cut or check-out moves the product's denormalized on-hand total
function loadoutProductUpdate() {
  let r = loadoutRole();
  return r in ['admin', 'warehouse'] || (r == 'tech' && loadoutOnly(['onHand', 'updatedAt']));
}

// Roster. A person's first sign-in writes their own doc as tech; the
// project's hardwired owner (backupsOwner() above, PLAN D2) may write
// it as admin. Everyone may refresh their own lastSeen and name;
// only admins change roles.
match /loadout_users/{uid} {
  allow read: if isMSPAdmin();
  allow create: if loadoutAdmin()
    || (isMSPAdmin() && request.auth.uid == uid
        && request.resource.data.email == request.auth.token.email.lower()
        && (request.resource.data.role == 'tech'
            || (request.resource.data.role == 'admin' && backupsOwner())));
  allow update: if isMSPAdmin()
    && ((request.auth.uid == uid && loadoutOnly(['lastSeen', 'name'])) || loadoutAdmin());
  allow delete: if loadoutAdmin();
}
match /loadout_settings/{key} {
  allow read: if isMSPAdmin();
  allow write: if loadoutAdmin();
}
// Audit trail: append-only, and each entry names its own author.
match /loadout_movements/{id} {
  allow read: if isMSPAdmin();
  allow create: if loadoutTech() && request.resource.data.by == request.auth.token.email.lower();
  allow update, delete: if false;
}
match /loadout_items/{id} {
  allow read: if isMSPAdmin();
  allow create, delete: if loadoutWriter();
  allow update: if isMSPAdmin() && loadoutItemUpdate();
}
match /loadout_containers/{id} {
  allow read: if isMSPAdmin();
  allow create, delete: if loadoutWriter();
  allow update: if isMSPAdmin() && loadoutContainerUpdate();
}
match /loadout_products/{id} {
  allow read: if isMSPAdmin();
  allow create, delete: if loadoutWriter();
  allow update: if isMSPAdmin() && loadoutProductUpdate();
}
// Pick tickets (0.2.0). Tickets, their lines, clients, jobs, and
// proposals fall under the wildcard below (warehouse and admin write).
// These add only what a tech's Stage, Deliver to site, and box cut for
// a ticket need. The board role is in no list, so it still only reads.
function loadoutTechOnly(keys) {
  return isMSPAdmin() && loadoutRole() == 'tech' && loadoutOnly(keys);
}
match /loadout_tickets/{tid} {
  // status and line counts are rewritten with every line change
  allow update: if loadoutTechOnly(['status', 'summary', 'updatedAt']);
  match /lines/{lineId} {
    allow update: if loadoutTechOnly(['qtyStaged', 'qtyDelivered', 'updatedAt']);
  }
}
// Deliver to site takes counted units out of the bay: a tech may only
// lower a stock count, never raise it or change anything else.
match /loadout_stock/{id} {
  allow update: if loadoutTechOnly(['qty', 'updatedAt'])
    && request.resource.data.qty < resource.data.qty;
}
// Warehouse may pin tickets to the wall board (Show on board) and save
// the CSV column mapping; the rest of settings stays admin-only above.
match /loadout_settings/board {
  allow create: if loadoutWriter()
    && request.resource.data.keys().hasOnly(['ticketIds', 'updatedAt', 'updatedBy', 'updatedByName']);
  allow update: if loadoutWriter()
    && loadoutOnly(['ticketIds', 'updatedAt', 'updatedBy', 'updatedByName']);
}
match /loadout_settings/importMap {
  allow write: if loadoutWriter();
}
// 0.5.2: the shared PO number counter. Warehouse and admin take the next
// number in the same transaction as the PO it numbers; it holds only the
// number and who took it, and it only goes up.
match /loadout_settings/counters {
  allow create: if loadoutWriter()
    && request.resource.data.keys().hasOnly(['po', 'updatedAt', 'updatedBy', 'updatedByName'])
    && request.resource.data.po is int;
  allow update: if loadoutWriter()
    && loadoutOnly(['po', 'updatedAt', 'updatedBy', 'updatedByName'])
    && request.resource.data.po is int
    && request.resource.data.po > resource.data.po;
}
// A vendor typed on a purchase order (0.3.0) joins the vendor list in
// settings/general. Warehouse may add to that list and nothing else
// there; the rest of general stays admin-only above.
match /loadout_settings/general {
  allow create: if loadoutWriter()
    && request.resource.data.keys().hasOnly(['vendors', 'updatedAt', 'updatedBy', 'updatedByName']);
  allow update: if loadoutWriter()
    && loadoutOnly(['vendors', 'updatedAt', 'updatedBy', 'updatedByName']);
}
// Everything else under loadout_* (stock, locations, clients, jobs,
// proposals, tickets, orders with their lines, and shipments): everyone
// on the domain reads, warehouse and admin write. Techs write none of
// the order collections; receiving is warehouse and admin. The prefix
// check keeps this from touching any other
// tool's collections.
match /{coll}/{docId} {
  allow read: if isMSPAdmin() && coll.matches('loadout_.*');
  allow write: if coll.matches('loadout_.*')
    && !(coll in ['loadout_users', 'loadout_settings', 'loadout_movements',
                  'loadout_items', 'loadout_containers', 'loadout_products'])
    && loadoutWriter();
  // subcollections (ticket lines, order lines). {rest=**} sits under a
  // named segment because a bare {sub=**} also matches zero segments,
  // which would re-match the parent documents and undo the exclusion above.
  match /{subcoll}/{rest=**} {
    allow read: if isMSPAdmin() && coll.matches('loadout_.*');
    allow write: if coll.matches('loadout_.*') && loadoutWriter();
  }
}
```

### Storage rules (0.5.0, backups 0.6.1)

Product photos live in Firebase Storage in the same project, under
`loadout/products/{productId}.jpg`. The rules are in `../watchtower/storage.rules`
(new in 0.5.0, holding only the Loadout block), and `../watchtower/firebase.json`
gained the matching `storage` entry. Admin and warehouse (read from the
`loadout_users` roster, the same way the Firestore rules do) may add, replace,
and delete a photo; anyone signed in with a verified `@umbrellaautomation.com`
account may read one. Each file must be under 2 MB and JPEG, PNG, or WebP, by
both its content type and its name. Tested in the local Storage and Firestore
emulators (25 of 25 checks passing: role, paused account, no roster doc,
outside account, unverified email, type, name, size at the 2 MB edge, other
paths, read, and delete); it is **not deployed**. Before the first deploy the
owner turns on Storage for `watchtower-6fbe1` in the Firebase console (the
default bucket `watchtower-6fbe1.firebasestorage.app` the app already names).
The first deploy of a rule that reads Firestore also asks to let Storage read
Firestore; answer yes. Deploy from `work/watchtower` with:

`firebase deploy --only storage --account frank@umbrellaautomation.com --project watchtower-6fbe1`

0.6.1 adds the nightly backups, `loadout/backups/YYYY-MM-DD/<collection>.csv`,
written by loadout-worker through its service account (which skips these
rules). `loadoutReader()` lets admin and accounting read them, reading the
roster exactly as `loadoutWriter()` does; nobody may write them from the app.
A list of the day folders is a list request one level up, on
`loadout/backups/`, which the per-file match does not cover, so a second
match allows only `list` there for the same two roles. Checked in the local
Storage and Firestore emulators: admin and accounting read, download, and
list both levels; warehouse, tech, an account with no roster doc, a paused
admin, an outside account, and a signed-out request get 403 on all of them;
nobody can write or delete. Not deployed; until it is, the Backups tab shows
its "Storage rules do not allow your role" message.

```
rules_version = '2';

// Umbrella Automation - watchtower-6fbe1 project
// Cloud Storage security rules.
//
// Only Loadout (work/loadout) stores files in this project so far: one
// photo per catalog product, and the nightly CSV backups loadout-worker
// writes. A path no block matches is denied, so nothing else in the
// bucket is reachable. A tool that adds files later adds its own block
// beside this one.

service firebase.storage {
  match /b/{bucket}/o {

    // -------- Loadout (work/loadout) --------
    // Same domain check as isMSPAdmin() in firestore.rules.
    function loadoutSignedIn() {
      return request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email.matches('.*@umbrellaautomation[.]com');
    }
    // Admin and warehouse, read from the Loadout roster in Firestore. A
    // missing roster doc counts as tech and a paused one (active == false)
    // as nobody, exactly as loadoutRole() does in firestore.rules.
    function loadoutWriter() {
      let path = /databases/(default)/documents/loadout_users/$(request.auth.uid);
      return loadoutSignedIn()
        && firestore.exists(path)
        && firestore.get(path).data.get('active', true) == true
        && firestore.get(path).data.get('role', 'tech') in ['admin', 'warehouse'];
    }
    // Admin and accounting: the two roles that see the Console, where the
    // Backups tab lists the nightly files. Reads the roster exactly as
    // loadoutWriter() does.
    function loadoutReader() {
      let path = /databases/(default)/documents/loadout_users/$(request.auth.uid);
      return loadoutSignedIn()
        && firestore.exists(path)
        && firestore.get(path).data.get('active', true) == true
        && firestore.get(path).data.get('role', 'tech') in ['admin', 'accounting'];
    }
    // Product photos: loadout/products/{productId}.{jpg|jpeg|png|webp}.
    // The app shrinks a photo to 1200 px and uploads JPEG; the rule holds
    // the line at 2 MB and the three image types whatever the client does.
    match /loadout/products/{file} {
      allow read: if loadoutSignedIn();
      allow create, update: if loadoutWriter()
        && file.matches('[A-Za-z0-9_-]+[.](jpg|jpeg|png|webp)')
        && request.resource.size < 2 * 1024 * 1024
        && request.resource.contentType in ['image/jpeg', 'image/png', 'image/webp'];
      allow delete: if loadoutWriter();
    }
    // Nightly backups (loadout-worker 0.2.0): loadout/backups/YYYY-MM-DD/
    // <collection>.csv. Every collection is in them, the roster and costs
    // included, so only admin and accounting may read or list them. The
    // worker writes and prunes through its service account, which skips
    // these rules, so no one writes here from the app.
    match /loadout/backups/{day}/{file} {
      allow read: if loadoutReader();
      allow write: if false;   // only the worker writes, through the service account
    }
    // Listing the days themselves (the Backups tab's first call) is a list
    // one level up, which the match above does not cover: a list request
    // on loadout/backups/ is checked against loadout/backups/{day}. Only
    // list is allowed here; nothing is stored at that level.
    match /loadout/backups/{day} {
      allow list: if loadoutReader();
    }
  }
}
```

## Worker

`worker/` is loadout-worker, a Cloudflare Worker on the umbrella account. It
takes accepted Portal proposals from a Zap (PLAN section 6, T1) and writes the
proposal, the pick ticket, and its lines with the same ids the CSV import uses,
flagged `needsReview` until someone looks. Every night at 09:00 UTC it writes
one CSV per collection to this project's Storage bucket under
`loadout/backups/YYYY-MM-DD/` and deletes days older than 90 (PLAN section 16
rule 7); the Console's Backups tab lists them for admin and accounting. It
writes through a service account, so the Firestore rules do not change and
the Storage rules only need to let the two roles read. The
Portal API intake (T2) is a stub until D1 is answered. Secrets, owner setup,
the Zap, and deploy steps are in `worker/README.md`.

## Changelog

### 0.6.1 (2026-11-03)

The nightly backup moves from Google Drive to the project's own Storage
bucket, and the Console gets a Backups tab to find it. The shop's Google
Workspace cannot make a Shared Drive, and a service account cannot upload
into a folder in someone's My Drive, so the Drive plan had nowhere to put
the files. The bucket that already holds product photos needs no new
account or sharing, and admins are already signed in to the app.

- **Console > Backups**, after Export everything, for admin and accounting:
  when the last backup ran (in UTC, the worker's clock), how many files and
  rows, or the error if the last night failed; then the days, newest first.
  A day opens in place to its 18 CSVs, each with its size and a Download
  link. The first 30 days show; Show older lists the rest. It needs a
  connection, and says so offline. Accounting gets the same tab: it has
  nothing to change.
- Storage rules: admin and accounting may read and list the backups; nobody
  writes them from the app (watchtower/storage.rules, copied above). Not
  deployed; until then the tab says the rules do not allow reading.
- loadout-worker 0.2.0 writes the files (worker/README.md). Still not
  deployed.
- No Firestore rule changes.

### 0.6.0 (2026-11-02)

The clean pass (PLAN 12c). Nothing new to learn; everything gets easier to
reach with one thumb, reads like one product on the desktop, and reads from
across the shop on the TV.

- On the phone every dialog is now a sheet from the bottom, with the button
  that does the job at the bottom, full width, and Cancel above it. Before,
  the confirm button sat at the top right of a dialog that could run off the
  screen, which meant two hands or a scroll for every pull and every cut.
  The sheet's body scrolls on its own, so Save is always in reach. A swipe
  down on the handle closes it; a tap outside still does not.
- Card buttons on the phone sit at the bottom of each card, two at most, the
  likely one first. A ticket line with five buttons used to wrap into a
  block of small ones; the rest are now under a ... button.
- Filters fold into one Filters button on the phone, so a list starts with
  the list, not with five dropdowns. Search fields gain a clear button, and
  Tickets gains a search.
- The header drops to 48 px as soon as you scroll, and messages show just
  under it. The tab bar puts Scan in the middle, raised, where the thumb rests.
- Scan's camera fills the screen above the result card. The box sheet keeps
  the quick -50 / -100 / -250 buttons and Save cut at the bottom, under the
  thumb. On a touch screen a sheet no longer pops the keyboard up over itself.
- Text on the phone is 15 px on cards and never under 13 px; number fields
  open the number pad (the Adjust field keeps the minus key).
- Desktop: one spacing scale and one corner radius across every view; table
  headers stay in view on long lists; Edit columns opens under its button;
  an empty list shows inside its table; forms go two-up only from 900 px;
  Enter saves a one-field form; `/` jumps to search; the open row in Stock,
  Units, and Locations has a blue bar and its chevron.
- The TV board is sized for four meters: 32 px lines, 48 px counts, nothing
  under 24 px. A long list scrolls at a steady 40 px a second with a pause at
  each end, the "Not live since" strip is 32 px with the time, and the board
  moves 2 px every rotation so a ticket left up all day does not burn in. On
  the light theme the counts now pass 7:1 for a bright shop.
- Details: one date format everywhere ("Nov 2" this year, "Nov 2, 2025"
  otherwise); "3 days ago" only next to the date it counts from; button
  labels are verbs (Edit columns, Print label, Open details, Show history,
  Mark reviewed); one word per thing, so Items is now Units and a label sheet
  picks locations, boxes, and units; the check mark on the board's staged
  lines is gone (the word Staged says it); nothing moves except sheets and
  panels opening (150 ms) and the board's rotation bar.
- No Firestore rule changes.

### 0.5.2 (2026-11-02)

The fixes from the second audit (audit-002, all 36 findings), so the app
says the same thing in every view, cannot lose a PO or a box to a second
device, and works for a keyboard, a thumb, and a tablet.

- A short line can now be ordered from its ticket. "To order" used to read a
  number saved when the line last changed, so stock taken by another ticket
  never made a line orderable and Order missing stayed off. It is now worked
  out live everywhere it shows: what the line still needs, less what the
  shelves hold (bays and vans do not count), less what open POs for that
  line still bring. The Tickets list, its filter, the ticket, the board, and
  Week all agree.
- One set of words and colors for every state, in every view, the board,
  Week, Tracking, and the exports. Lines read Pull, Staged ("Staged 2 of 4"
  when part of it is), Delivered, On order, or Short; "Picked" is gone, since
  it meant two different things. A box delivered and not scanned in reads
  "Delivered, not received" everywhere, instead of seven different phrasings.
  Delivered and installed are a green outline, closed, cancelled, and retired
  a grey one, so finished things no longer look like things in progress.
- Movement history uses one word per thing: pull (shelf to a bay for a
  ticket), move (shelf to shelf), return (a unit back from a client's site),
  write off. Older entries read in the new words without being rewritten.
- PO numbers come from one shared counter, so two people starting a PO at
  the same time, or one of them offline, can no longer take the same number
  and merge two orders. A PO started with no signal is a draft with no number
  until Mark ordered, which needs a connection. A new box label works the same
  way: if someone else already used it, Loadout says so and offers the next
  free one, rather than writing over their box.
- Every field, button, and chevron edge is dark enough to see (3:1 or
  better), and grey pills and links inside open panels pass 4.5:1, because
  a secondary button used to be found by its text alone.
- Keyboard: Tab stays inside an open dialog and focus goes back where it came
  from when it closes; the file pickers are real buttons; a Skip to content
  link starts every page.
- Phones in landscape and tablets get the same 44 px controls as a phone in
  portrait, and on any touch screen the "why" behind a field is a ? you can
  tap, since nothing there ever shows a hover tooltip.
- Units keep the cost on their PO line, so Items out and stock value match
  what was paid. Units and boxes carry the ticket number and client name, so a
  row reads on its own in the database and the export.
- Export everything gives a shipment's status history and its lines their own
  files, one row each, instead of JSON text in a cell.
- A saved column layout follows you: the newest change wins on every device.
- Smaller things: dates read "Nov 2" or "Nov 2, 2026" everywhere; "Mark
  backordered" and "Change ETA" say what they do; a deactivated person reads
  Deactivated, not Paused; "Low stock" everywhere; one "Receive a box" button;
  an error the rules cause says so instead of blaming the connection; the
  board's title carries the version; the link preview uses a full image URL;
  the label print preview fits a 360 px phone.
- The Firestore rules changed (the PO counter, the box guard, and two unit
  fields a tech's delivery writes); checked in the local emulator, not
  deployed.

### 0.5.1 (2026-11-02)

Tracking now answers "where is it" the way the shop asks it: what is coming
here, and what is going straight to a client.

- Tracking is split down the middle. Packages coming to the office are on the
  left; packages the vendor ships straight to a job site are on the right,
  grouped by client and job; the last 30 days of deliveries run along the
  bottom. Before, everything sat in one long table and a drop-shipped box
  looked like one waiting to be scanned in.
- Each package is a card with its current status and the time of that status
  ("Out for delivery, Nov 2, 8:14 AM"), so nobody has to open the carrier page
  to see whether today's box is on the truck. Late boxes say how late, in
  amber, and a box delivered here but never scanned stays at the top of the
  office side until someone receives it.
- A box sent to a job site has Mark delivered instead of Receive. It counts
  the lines as received on the PO and staged on the ticket without adding
  anything to the shelves, because the box never came through the building.
- Every status change on a shipment is now kept with who made it and when, so
  the history of a box reads in order, and a later carrier lookup can add to
  the same list. Older shipments show their last known status and date.
- Mark ordered asks where the order ships, office or the job's site, and a
  single shipment can be sent elsewhere when the vendor splits an order.
- Purchase order lines keep the unit cost from the day they were ordered.
  Spend and Delivered now use it, so last month's numbers stay put when a
  product's price changes.
- Tickets made by Zapier from Portal now say so, with an "Imported from
  Portal, review" chip on the list and the ticket until someone presses
  Reviewed. Every ticket names its source: CSV, Portal, or built by hand.
- Tracking links are a full thumb-sized target on the phone, on Tracking and
  on the order page, so tapping one opens the carrier page and not the card.
- A ticket line with many buttons no longer pushes the table past the edge of
  a laptop-width window: the buttons wrap instead.

### 0.5.0 (2026-10-29)

Offline use, the home screen, and photos, so the phone keeps working in the
corner of the warehouse with no signal and a new tech can tell one gray box
from another.

- Loadout now opens with no signal once it has been opened online on that
  phone. A service worker keeps the app, the iPhone barcode decoder, and the
  database code on the device, and the database already kept its own copy, so
  Scan, counts, cuts, and check-outs all work in a dead spot.
- Every change saves on the device first and goes up when there is signal.
  The pill in the header says Synced, Offline, or how many changes are still
  waiting, and a row changed offline carries a small "pending" chip until the
  server has it, so nobody wonders whether a count stuck. The first change
  made offline says so in a toast, once, instead of on every tap.
- Screens no longer wait on a slow connection before moving on: if the server
  has not answered in a couple of seconds the change counts as saved on the
  device. A change the server refuses later still toasts, and the row goes
  back to what it was.
- When a new release reaches a phone that has Loadout open, a toast offers a
  Reload button, rather than leaving the old version running all day.
- Add to home screen: a card under More (and once, a strip under the header on
  the phone) with Chrome's own install button on Android and the two Share
  steps on iPhone, because iPhones never offer it on their own. The home
  screen icon opens straight to Scan.
- Product photos: Add, Replace, and Remove in the product panel, a thumbnail
  on the Scan card, and an optional Photo column on Stock. Photos are shrunk
  to 1200 px and saved as JPEG on the phone first, which keeps uploads small on
  a weak signal and drops the camera's location data. The Storage rules keep
  photos to admin and warehouse for writing and the domain for reading.

### 0.4.0 (2026-10-29)

The Console, so the office can answer money and accountability questions
(what is on the shelves worth, what did we spend, what went to which job, who
has the gateway) without exporting the database and building the sum by hand.

- Seven reports with a date range that starts on this month: stock on hand
  and its value, spend by vendor and month, product delivered per client and
  job, items out, wire usage per job and person, the movement trail, and
  aging. Each sorts, keeps its column layout, ends with a one-line total, and
  exports to CSV or Excel, because the reports exist to be checked against
  invoices.
- Reports read the range straight from the database instead of the latest
  500 movements the app keeps live, so a month-end report is complete.
- Accounting gets the Console with no buttons that change anything, rather
  than greyed ones, so there is no doubt about what the role can do.
- People and Settings moved into the Console with the wall board settings,
  so the admin screens live in one place; More keeps links. Deactivate keeps
  a person's name on everything they touched.
- A shop-wide Work week default for the Week view, for anyone who has not
  chosen for themselves.
- About shows the data dictionary from the code itself, so the description
  of the database cannot drift from what the app writes.
- Export everything is in the Console, adds zipped CSVs beside the workbook,
  and stamps the file name with the date and time, so a weekly copy never
  overwrites the last one.

### 0.3.0 (2026-10-29)

Purchase orders, tracking, and the week, so "what is missing for Thursday"
and "where is that box" have answers without opening three screens, plus the
fixes from the first live run.

- Lines stock cannot cover go onto a draft purchase order from the ticket
  (Order missing, or Order on one line) or from the low-stock list (Reorder).
  The ticket then shows a chip per PO instead of "no PO yet", and Copy for
  Portal says what is on order and when it is due, because that is the
  question the office answers on the phone.
- Mark ordered asks for the vendor's order number, since that is what you
  quote when you call them. Shipments guess the carrier from the tracking
  number and link straight to its tracking page.
- Receive walks a shipment line by line, by tap or by scanning each UPC.
  What serves a ticket lands in its staging bay and counts as staged; the rest
  goes on a shelf. Units worth following get their own QR on the spot, so
  nothing expensive reaches a van without a label.
- Tracking lists everything on order and not received in one place. A box
  marked delivered but not scanned in floats to the top in amber, because
  that is the one sitting in a corner of the shop.
- The Week view lays the staging schedule out like a timesheet by install
  date, so the warehouse sees the week at a glance and what is short today.
  The wall board can follow it (Today mode), and Movements gained week
  buttons for "what moved this week".
- Products, units, and locations open in place under their row instead of in
  a modal, so you keep your place in a long list; the decisions (Receive,
  Adjust, Serialize, Check out) still confirm in a modal.
- Inventory sheet fixes from the first live run: "A/v" reads "A/V"; the
  sheet's stray hyphen spacing ("Cable- Black Band") reads as a comma in names
  while the type stays as typed, and a connector keeps its hyphen ("Edison-M");
  imported units are labeled "Product name #n" instead of the tail of an id;
  import movements are dated from the sheet's count date, with the import time
  kept beside it. Running the import again renames products and units in place
  and skips movements it already wrote.
- Warehouse may add a vendor to the list in Settings and nothing else there;
  the rules change was checked in the local emulator.

### 0.2.0 (2026-10-29)

Pick tickets, so an accepted proposal becomes a list the warehouse can pull,
stage, and send to site without retyping it, and the office can see how far
each job has got.

- A Portal proposal CSV becomes a pick ticket in one pass. Columns are matched
  by header name and the mapping is remembered, because Portal does not
  publish its export format. Labor, fees, custom items, and rows with no
  quantity are listed as skipped instead of vanishing, and a change order
  imported later adjusts the same ticket rather than making a second one.
- Pull from stock moves the quantity from the shelf to the job's staging bay
  and logs it with your name, so the bay and the ticket agree on what is
  ready. Pull everything in stock does the whole ticket and says what is left
  to order.
- Deliver to site checks the line's serialized units out to the person taking
  them, and closing the ticket marks them installed at the job, so a unit
  scanned years later still says which job it went to. Leftovers in the bay
  go back to a shelf or are written off with a reason.
- Copy for Portal builds the status block for the proposal's internal notes,
  since Loadout cannot write to Portal until the API question is settled.
- The wall board turns the TV by the bays into the pick path: lines grouped by
  shelf in rack order, picked lines greyed as the scans land, and a red strip
  when it stops being live, so nobody trusts a stale screen.
- Techs can stage and deliver, and only lower a stock count when they do; the
  board account still reads only. Orders and backorders arrive in 0.3.0; until
  then Order missing is shown but off.

### 0.1.0 (2026-10-29)

First release, so the shop can start counting, labeling, and signing things out
before the owner settles the open decisions in PLAN section 13 (the build uses
the defaults listed there).

- The shop's current inventory workbook imports in one pass with a dry run
  first, because starting from the sheet beats starting from zero. Spellings
  are merged (makes, shelves, colors, units), each row becomes an audit entry
  dated from the sheet, and running it again on a newer copy updates counts
  instead of adding duplicates.
- Wire boxes keep their existing codes and get a box sheet, so a cut of 360 ft
  is logged with the person's name in two taps instead of guessed at the end
  of the month.
- Units worth following one by one (at or above the QR threshold, $250 by
  default) get their own QR, Check out, and Check in, so "who has the gateway"
  has an answer.
- Every change writes a movement, and the rules make that log append-only,
  so a count can always be explained.
- Pick tickets, purchase orders, tracking, and offline use come in later
  versions (PLAN section 12).
