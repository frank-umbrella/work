# loadout

Loadout is the shop's inventory tool: what is on each shelf, how many feet are
left in each wire box, who has each expensive unit, and the pick tickets that
turn an accepted Portal proposal into a staged bay. Phone first for the
warehouse, desktop for the office. Internal: no hub tile, no links from other
pages, `noindex, nofollow`, and the shared Watchtower sign-in
(`@umbrellaautomation.com` Google accounts only). The plan is `PLAN.md`; the
chosen look is direction B, Ledger, in `design-preview.html`.

Current version: **0.2.0**.

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
  filters for status, client, and items to order. **New ticket** imports a
  Portal proposal CSV (columns matched by header name, a preview, Labor, Fee,
  and CustomItem rows and blank quantities listed as skipped, unmatched brands
  and models offered as new products) or takes lines typed by hand. Importing
  the same proposal number again adds or adjusts lines on that ticket.
- **Ticket**: lines grouped by area with Pull from stock (pick the shelf, scan
  if you like; the quantity moves to the staging bay), Stage, Deliver to site
  (serialized units on the line check out to whoever delivers), and Note;
  Pull everything in stock; Copy for Portal; Print (a pick list); Show on
  board; and Close, which returns or writes off what is left in the bay and
  marks units out on the ticket installed at the job.
- **Board** (`?board=1`, and the landing view for the board role): the
  warehouse TV. One pinned ticket per screen, rotating, lines grouped by the
  shelf to pull from in rack order; picked lines greyed, to-order amber, short
  red; a red "Not live since" strip when the connection drops.
- **Stock**: the catalog with search, sorting, a Columns manager, and tabs for
  All, Consumables (wire boxes with feet left), Low stock, and Locations.
  Open a product to edit it, set its UPC by scanning, receive, adjust with a
  reason, serialize units, add a box, or print its label.
- **Scan**: point the phone at a UPC or a Loadout label, or type the code.
  Shelf labels set the active location; box labels open the box sheet (mark
  now, cut this time, quick -50 / -100 / -250, Empty, recount); unit labels
  show who has it with Check out and Check in. A product card has Pick for
  ticket, a unit card Stage for ticket, the box sheet a For ticket chip, and a
  bay's label shows the ticket staged there.
- **Items**: every serialized unit, with Out as the Friday list.
- **More**: movements log with filters and CSV, Clients and Jobs (add, edit,
  archive; a job can reserve a staging bay), label sheets (Avery 5160 or
  2 x 4), and for admins the Board settings, the inventory sheet importer,
  Settings, and People.
  Export everything downloads one workbook with a tab per collection.

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
view; `&board=1` opens the wall board; `&empty=1` loads no tickets, for the
empty states and the board's idle screen; `&print=1` opens a label sheet
preview. The New ticket sheet has a Load sample button with a made-up Portal
CSV in demo mode only. No Firebase code loads in demo mode.

## Data

Firestore project `watchtower-6fbe1`, collections `loadout_users`,
`loadout_settings`, `loadout_products`, `loadout_locations`, `loadout_stock`,
`loadout_containers`, `loadout_items`, `loadout_movements`, `loadout_clients`,
`loadout_jobs`, `loadout_proposals`, and `loadout_tickets` with a `lines`
subcollection per ticket (field lists in PLAN section 3). Ticket ids are the
proposal number; line ids are the area plus brand and model, so a change
order re-import finds the line it changes. Settings hold `board` (the wall
board) and `importMap` (the saved CSV column mapping). Line quantities, all in
the product's unit: `qtyNeeded` from the proposal, `qtyFromStock` pulled off
our shelves, `qtyToOrder` what stock cannot cover, `qtyStaged` laid out in the
bay, `qtyDelivered` taken to site. Every record carries readable names next to its ids, so the
database and the export read without the app. Each person's table layout is
saved on their own `/users/{uid}` doc under `loadoutLayout`.

## Rules

The block below is appended to `../watchtower/firestore.rules` (one ruleset per
project). It was tested in the local Firestore emulator (0.2.0 added the
ticket, stock, and board-settings rules near the end); it is **not deployed**.
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
// Everything else under loadout_* (stock, locations, clients, jobs,
// proposals, tickets, and later orders and shipments): everyone on the
// domain reads, warehouse and
// admin write. The prefix check keeps this from touching any other
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
