# loadout

Loadout is the shop's inventory tool: what is on each shelf, how many feet are
left in each wire box, who has each expensive unit, and the pick tickets that
turn an accepted Portal proposal into a staged bay. Phone first for the
warehouse, desktop for the office. Internal: no hub tile, no links from other
pages, `noindex, nofollow`, and the shared Watchtower sign-in
(`@umbrellaautomation.com` Google accounts only). The plan is `PLAN.md`; the
chosen look is direction B, Ledger, in `design-preview.html`.

Current version: **0.5.0**.

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
- **Console** (admin and accounting; also linked from More): **Reports**,
  each with a From and To date (this month by default, with This month and
  Last month buttons), a sortable table with the Columns manager, a one-line
  total, and Export CSV / Export XLSX of the rows and columns shown: Stock on
  hand (by product and location, category, or location, with value at last
  cost when costs are on), Spend (POs marked ordered, by vendor and month),
  Delivered (every Deliver to site, by delivery or by client and job), Items
  out (who held what and for how long), Wire usage (box cuts by cut, job,
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
  date and time. Accounting sees Reports, About, and Export with no edit
  controls at all.
- **More**: movements log with filters, Previous / This / Next week buttons,
  and CSV, Clients and Jobs (add, edit,
  archive; a job can reserve a staging bay), label sheets (Avery 5160 or
  2 x 4), and for admins the inventory sheet importer. Admins and accounting
  get a row of Console links (Reports, People, Settings, Board, About, Export
  everything); warehouse and techs keep About and Export everything as tabs
  here. On the phone the tab bar is Tickets, Scan, Week, Stock, More, and
  Orders, Tracking, Items, and the Console sit at the top of More. More also
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
empty states and the board's idle screen; `&print=1` opens a label sheet
preview. The New ticket sheet has a Load sample button with a made-up Portal
CSV in demo mode only. The fixture has four purchase orders (a draft with no
vendor, a partial one with two shipments, one ordered with a late shipment,
one received), install dates across this week, and imported rows that show the
0.3.0 name fixes. 0.4.0 adds costs on the catalog, a closed ticket and four
more POs from last month and this month (one still open and backordered), and
the deliveries, box cuts, and check-outs around them, dated inside this month
and last month so every report has rows on any day, plus a roster with Lead
tech, Accounting, Board TV, and a deactivated Former tech. 0.5.0 gives the
Ubiquiti U6-Pro and the Sonos Amp a drawn placeholder labeled "Sample photo";
Add, Replace, and Remove photo answer with the usual "Demo mode: not saved".
The demo hook adds `window.Loadout.sync({online: false, pending: 3})` to drive
the sync pill (`sync(null)` goes back to Demo),
`window.Loadout.pending("products", id, true)` to put the pending chip on a
row, and `window.Loadout.install("prompt" | "ios" | "menu" | "none")` to pick
which Add to home screen card shows. No Firebase code loads in demo mode. The
service worker does register in demo mode, since the demo is how the offline
shell is checked.

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
`general` gained `workWeek` in 0.4.0. Products gained `imageUrl` (the photo's
download link), `imagePath` (`loadout/products/{id}.jpg` in Firebase Storage),
and `imageAt` in 0.5.0. The Console's About tab lists every field of every
collection.

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
and write nothing.
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

### Storage rules (0.5.0)

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

```
rules_version = '2';

// Umbrella Automation - watchtower-6fbe1 project
// Cloud Storage security rules.
//
// Only Loadout (work/loadout) stores files in this project so far: one
// photo per catalog product. A path no block matches is denied, so
// nothing else in the bucket is reachable. A tool that adds files later
// adds its own block beside this one.

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
  }
}
```

## Worker

`worker/` is loadout-worker, a Cloudflare Worker on the umbrella account. It
takes accepted Portal proposals from a Zap (PLAN section 6, T1) and writes the
proposal, the pick ticket, and its lines with the same ids the CSV import uses,
flagged `needsReview` until someone looks. Every night at 09:00 UTC it writes
one CSV per collection to the "Loadout backups" Drive folder in a dated
subfolder and prunes folders older than 90 days (PLAN section 16 rule 7). It
writes through a service account, so the rules above do not change. The
Portal API intake (T2) is a stub until D1 is answered. Secrets, owner setup,
the Zap, and deploy steps are in `worker/README.md`.

## Changelog

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
