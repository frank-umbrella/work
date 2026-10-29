# loadout

Loadout is the shop's inventory tool: what is on each shelf, how many feet are
left in each wire box, and who has each expensive unit. Phone first for the
warehouse, desktop for the office. Internal: no hub tile, no links from other
pages, `noindex, nofollow`, and the shared Watchtower sign-in
(`@umbrellaautomation.com` Google accounts only). The plan is `PLAN.md`; the
chosen look is direction B, Ledger, in `design-preview.html`.

Current version: **0.1.0**.

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

- **Stock**: the catalog with search, sorting, a Columns manager, and tabs for
  All, Consumables (wire boxes with feet left), Low stock, and Locations.
  Open a product to edit it, set its UPC by scanning, receive, adjust with a
  reason, serialize units, add a box, or print its label.
- **Scan**: point the phone at a UPC or a Loadout label, or type the code.
  Shelf labels set the active location; box labels open the box sheet (mark
  now, cut this time, quick -50 / -100 / -250, Empty, recount); unit labels
  show who has it with Check out and Check in.
- **Items**: every serialized unit, with Out as the Friday list.
- **More**: movements log with filters and CSV, label sheets (Avery 5160 or
  2 x 4), and for admins the inventory sheet importer, Settings, and People.
  Export everything downloads one workbook with a tab per collection.

Roles: the account named in the rules as the project owner becomes admin on
its first sign-in; everyone else lands as Tech until an admin changes the role
under More, People. Warehouse and admin change stock; techs scan, check out,
check in, and record box readings; accounting and board only read.

### Demo mode

`?demo=1` opens the app on invented sample data with no sign-in. Every write is
refused with a "Demo mode: not saved" toast. `?demo=1&role=tech` shows the
tech's view, and `?demo=1&print=1` opens a label sheet preview. No Firebase
code loads in demo mode.

## Data

Firestore project `watchtower-6fbe1`, collections `loadout_users`,
`loadout_settings`, `loadout_products`, `loadout_locations`, `loadout_stock`,
`loadout_containers`, `loadout_items`, and `loadout_movements` (field lists in
PLAN section 3). Every record carries readable names next to its ids, so the
database and the export read without the app. Each person's table layout is
saved on their own `/users/{uid}` doc under `loadoutLayout`.

## Rules

The block below is appended to `../watchtower/firestore.rules` (one ruleset per
project). It was tested in the local Firestore emulator; it is **not deployed**.
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
// Everything else under loadout_* (stock, locations, and later tickets,
// orders, shipments): everyone on the domain reads, warehouse and
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
