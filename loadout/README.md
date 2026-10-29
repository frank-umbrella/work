# loadout

Loadout is the shop's inventory tool: what is on each shelf, how many feet are
left in each wire box, who has each expensive unit, and the pick tickets that
turn an accepted Portal proposal into a staged bay. Phone first for the
warehouse, desktop for the office. Internal: no hub tile, no links from other
pages, `noindex, nofollow`, and the shared Watchtower sign-in
(`@umbrellaautomation.com` Google accounts only). The plan is `PLAN.md`; the
chosen look is direction B, Ledger, in `design-preview.html`.

Current version: **0.3.0**.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: markup, styles, and script in one file. |
| `qr.js` | Vendored QR encoder (qrcode-generator 1.4.4, MIT, by Kazuhiko Arase), loaded locally so labels never depend on a CDN. |
| `favicon.svg`, `icon-192.png`, `icon-512.png` | The hard-case mark. The PNGs are rendered from the SVG. |
| `manifest.json` | Add to Home Screen: standalone, named Loadout. |
| `og-image.svg`, `og-image.png` | Link preview card in the house style. |
| `PLAN.md`, `design-preview.html`, `storyboard.html` | Plan, design switcher, and the owner's storyboard. |
| `samples/` | Real data for testing the importer. Git-ignored; never commit it. |

## Using it

- **Tickets** (home on the desktop): pick tickets grouped by status, with
  filters for status, client, install date, items to order, and backorders,
  and an Install column that sorts. **New ticket** imports a
  Portal proposal CSV (columns matched by header name, a preview, Labor, Fee,
  and CustomItem rows and blank quantities listed as skipped, unmatched brands
  and models offered as new products) or takes lines typed by hand. Importing
  the same proposal number again adds or adjusts lines on that ticket.
- **Ticket**: lines grouped by area with Pull from stock (pick the shelf, scan
  if you like; the quantity moves to the staging bay), Stage, Deliver to site
  (serialized units on the line check out to whoever delivers), and Note;
  Pull everything in stock; Copy for Portal (it now lists what is on order,
  with PO, carrier, and dates); Print (a pick list); Show on board; and Close,
  which returns or writes off what is left in the bay and marks units out on
  the ticket installed at the job. The header carries the install date.
  **Order missing** and a line's **Order** put what stock cannot cover on a
  draft purchase order, and each line shows a chip per PO, for example
  "PO 7731 - UPS 1Z999AA1 - shipped 10/23".
- **Orders**: purchase orders with filters for status and vendor. A draft's
  empty Vendor select glows until one is picked; a vendor typed there joins the
  list in Settings. An order shows its lines (ordered, backordered with the
  vendor's ETA, shipped, delivered, received, and the ticket line each serves)
  and its shipments. **Mark ordered** needs the vendor and the vendor's order
  number. **Add shipment** guesses the carrier from the tracking number (1Z is
  UPS, 12 or 15 digits FedEx, 20 to 22 digits starting with 9 USPS; it can be
  changed) and carries some or all of the lines. **Receive** walks a shipment
  line by line: tap to take the quantity, or scan each unit's UPC to count it;
  lines for a ticket go into its staging bay and count as staged, the rest go
  on a shelf; units at or above the QR threshold become serialized units
  ("Product name #n") with a prompt to print their labels.
- **Tracking**: every order line not yet received, grouped by job and then
  stock, with carrier, tracking link, expected date, and days open. Delivered
  but not received rises to the top in amber and late lines say how late.
  Filters for job, vendor, carrier, status, and late; Receive and Note per row.
- **Week**: the staging schedule as a timesheet, one block per day with a card
  per ticket by its install date and each line's status on the right. Previous
  week, This week, Next week; a Work week toggle (remembered per person) hides
  the weekend and shows a chip when a hidden day has work. Past days are faded,
  today has a soft blue border, and tickets with no install date sit in an
  Unscheduled list with a date field. On the phone the days stack, today first.
- **Board** (`?board=1`, and the landing view for the board role): the
  warehouse TV. One pinned ticket per screen, rotating, lines grouped by the
  shelf to pull from in rack order; picked lines greyed, to-order amber (with
  the PO and ETA once ordered), short red; a red "Not live since" strip when
  the connection drops. The Today mode shows the tickets whose install date is
  today, from the Week view.
- **Stock**: the catalog with search, sorting, a Columns manager, and tabs for
  All, Consumables (wire boxes with feet left), Low stock (with Reorder), and
  Locations. A product or location row opens in place under itself: fields in
  two columns, on hand by location, boxes, and one row of buttons (Save,
  Receive, Adjust, Serialize, New box, Reorder, Print label, History). One is
  open at a time; Escape or the chevron closes it, and the address carries it
  (`#stock/p/<id>`, `#stock/l/<id>`), so a link lands on it open. Modals stay
  for the decisions that need a confirm.
- **Scan**: point the phone at a UPC or a Loadout label, or type the code.
  Shelf labels set the active location; box labels open the box sheet (mark
  now, cut this time, quick -50 / -100 / -250, Empty, recount); unit labels
  show who has it with Check out and Check in. A product card has Pick for
  ticket, a unit card Stage for ticket, the box sheet a For ticket chip, and a
  bay's label shows the ticket staged there.
- **Items**: every serialized unit, with Out as the Friday list. A unit opens
  in place the same way (`#items/i/<id>`), with its label, serial, condition,
  Check out, Check in, Move, Retire, and History.
- **More**: movements log with filters, Previous / This / Next week buttons,
  and CSV, Clients and Jobs (add, edit,
  archive; a job can reserve a staging bay), label sheets (Avery 5160 or
  2 x 4), and for admins the Board settings, the inventory sheet importer,
  Settings, and People.
  Export everything downloads one workbook with a tab per collection. On the
  phone the tab bar is Tickets, Scan, Week, Stock, More, and Orders, Tracking,
  and Items sit at the top of More.

Roles: the account named in the rules as the project owner becomes admin on
its first sign-in; everyone else lands as Tech until an admin changes the role
under More, People. Warehouse and admin change stock and build, pull, and close
tickets; techs scan, check out, check in, record box readings, and stage and
deliver ticket lines; accounting and board only read.

### Demo mode

`?demo=1` opens the app on invented sample data with no sign-in. Every write is
refused with a "Demo mode: not saved" toast (the refused batch stays on
`window.Loadout.state.lastOps` for checking by script). `&role=tech`,
`&role=warehouse`, `&role=accounting`, or `&role=board` shows that role's
view; `&board=1` opens the wall board (`&mode=today`, `&mode=pinned`, or
`&mode=all_open` overrides the saved board mode on that screen); `&empty=1`
loads no tickets or orders, for the
empty states and the board's idle screen; `&print=1` opens a label sheet
preview. The New ticket sheet has a Load sample button with a made-up Portal
CSV in demo mode only. The fixture has four purchase orders (a draft with no
vendor, a partial one with two shipments, one ordered with a late shipment,
one received), install dates across this week, and imported rows that show the
0.3.0 name fixes. No Firebase code loads in demo mode.

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
saved on their own `/users/{uid}` doc under `loadoutLayout`.

## Rules

The block below is appended to `../watchtower/firestore.rules` (one ruleset per
project). It was tested in the local Firestore emulator (0.2.0 added the
ticket, stock, and board-settings rules near the end; 0.3.0 added the
vendor-list rule on `settings/general`, 36 of 36 checks passing, including
orders, order lines, and shipments as warehouse-only writes); it is **not
deployed**.
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
// techs may change the fields their scans touch, nothing else
function loadoutItemUpdate() {
  let r = loadoutRole();
  return r in ['admin', 'warehouse']
    || (r == 'tech' && loadoutOnly(['status', 'holderUid', 'holderName', 'jobId', 'jobName',
         'ticketId', 'ticketLineId', 'locationId', 'locationName', 'checkedOutAt',
         'checkedInAt', 'condition', 'updatedAt']));
}
function loadoutContainerUpdate() {
  let r = loadoutRole();
  return r in ['admin', 'warehouse']
    || (r == 'tech' && loadoutOnly(['ftLeft', 'lastMark', 'status', 'pickTicketId',
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

## Changelog

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
