# Spool - office inventory, pick tickets, and product tracking

Plan v0.3 - 2026-10-27 by Fable 5.1 (design/plan pass; v0.1 was 2026-10-23,
v0.2 was 2026-10-26; v0.3 adds the warehouse wall board, section 4).
Nothing here is built yet. Implementation is a later Opus job once the
decisions in section 13 are answered and the owner has read the storyboard.
Open the design switcher at
`file:///T:/ClaudeCodeRepo/work/spool/design-preview.html` and the storyboard
and functional SOP for the owner at
`file:///T:/ClaudeCodeRepo/work/spool/storyboard.html` (section 15).

v0.2 adds, from the 2026-10-26 notes: serialized items with their own QR and
a check-out / check-in log (section 8b), a cut log on wire boxes (section 7),
roles with an accounting console (sections 3, 4), a tracking dashboard for
product on order (section 4), and the storyboard (section 15).

**Spool** is the working name and folder (`work/spool/`). It is deliberately
not "inventory" or "warehouse": internal tools on the work site get a neutral
name, no hub tile, no links from other pages, `noindex, nofollow`, and the
shared Watchtower sign-in wall (`@umbrellaautomation.com` Google accounts only).
The name fits the job: wire comes on spools, and orders get spooled up for a
client. Alternatives if you want a different one: Depot, Manifest, Crate.

Reference products looked at: Portal's own warehouse pick list export, Sortly
and inFlow (bin and photo-first stock apps), ProjX360 (imports won Portal
proposals into inventory and work orders, which is the closest thing to what
this plan builds in-house).

---

## 1. What this is

A phone-first web app that the office uses to:

1. **Turn an approved Portal proposal into a pick ticket** and lay the product
   out for that client in a staging bay, pulling from stock where we have it
   and ordering the rest.
2. **Track product acquisition** per line: ordered, backordered, shipped,
   delivered, checked in, staged, delivered to site, with vendor order number,
   carrier, and tracking number, all tied back to the client, job, and
   proposal number.
3. **Keep a running inventory** of what is on the shelves: new product that
   has not been assigned to a job, and consumables such as Cat5e/Cat6 boxes,
   conduit, connectors, with **feet left** readings for anything sold by
   length.
4. **Write status back to Portal** as an internal note on the proposal when
   it can (API tier), or hand you a ready-to-paste status block when it cannot.

Everyone on the domain shares one dataset. There are no per-user silos: the
warehouse is one warehouse. What differs by person is the role (section 3):
admins and warehouse staff change stock, techs scan, check out, and check in,
and accounting reads the console and reports without touching counts.

Six things it tracks, in a fixed hierarchy:

- **Client > Job > Proposal.** A client has jobs (site addresses or projects);
  a job has one or more Portal proposals, each identified by Portal's
  sequential proposal number. Portal has no separate project object, so the
  job is ours; it exists to group several proposals and change orders for the
  same site.
- **Pick ticket.** One per approved proposal (or per change order). Lines are
  the proposal's Part items grouped by area, with quantity needed, from stock,
  to order, staged, delivered to site. The pick ticket is the working document
  of the whole flow and the thing a tech looks at when loading the van.
- **Product and stock.** A catalog of products keyed by brand + model (what
  Portal gives us), with UPC/barcode captured the first time one is scanned.
  Stock is on-hand quantity per product per location. Products sold by length
  are tracked as **containers** (one record per box or spool) with a
  feet-left reading, and the product's on-hand is the sum.
- **Order and shipment.** A purchase order to a vendor with its lines, each
  line pointing at the pick ticket line it serves (or at stock, for
  replenishment). Shipments carry carrier + tracking and can be partial. A
  product can exist as "on order" before anything is received, so the order
  number and tracking are attached from day one and watched on the Tracking
  dashboard.
- **Item.** One physical unit of a product that is worth following on its
  own: anything received at or above the QR threshold (a cost in Settings,
  default $250), or anything you choose to serialize. An item gets its own
  QR sticker on receive. Scanning it shows where it is, who has it, and its
  history; Check out and Check in record who took it, for which job, and when
  it came back from a client's home.
- **Wire box.** A box or spool of a by-the-foot product. Received by the UPC
  printed on the box, then given a QR sticker. Scanning the QR opens the box
  sheet: the footage mark the box is stopped at now, and the length cut this
  time. Each entry is logged with the employee and the ticket it was cut for.

Every change writes a **movement** (receive, pick, stage, deliver, adjust,
reading, cut, checkout, checkin, return, transfer) so a count can always be
explained. Every record carries the readable names of what it points at, so
the database reads without the app (section 16).

## 2. Decisions (proposed; settle in section 13)

| Decision | Choice | Why |
|---|---|---|
| Home | `frank-umbrella/work`, folder `spool/` | Same repo and Pages site as Watchtower, Backup Audits, Sundial. Deploys on push. |
| Sign-in | Google, `@umbrellaautomation.com` only, Firebase project `watchtower-6fbe1` | Zero new setup. Copy `firebaseConfig`, `ALLOWED_DOMAIN`, the `hd` parameter, and the post-sign-in domain check from `backups/index.html`. |
| Storage | Firestore, collections prefixed `spool_`, shared by everyone on the domain | Same trade-off as Watchtower's rules: every employee has full read/write. Movements are the audit trail, so mistakes are visible, not prevented. |
| Portal integration | **Tiered** (section 6): T0 manual import works on any plan today; T1 Zapier push needs Premium; T2 full API needs Unlimited plus an approved application | We do not know the current Portal plan. The pick ticket must not depend on an API we may not have. |
| Notes back to Portal | Append to the proposal's internal notes via API when allowed; otherwise a **Copy for Portal** button | Portal has no comment thread object. Internal notes is a single text field that the update call replaces, and accepted proposals may return 409. Copy-paste is the guaranteed path. |
| Units | `each` or `ft` per product; `ft` products are tracked per container with a feet-left reading | "Feet left" is a reading you take, not a calculation. Picking 150 ft from a 1000 ft box is a movement against that box. |
| Barcodes | UPC scanned with the phone camera; falls back to typing | Portal's item model has no SKU or UPC, so the catalog learns barcodes on first receive. Chrome on Android has `BarcodeDetector`; a lazy-loaded zxing fallback covers iOS Safari. |
| Mobile | Phone first | Scan, pick, and count happen in the warehouse. Bottom tab bar under 640px, thumb-sized buttons, 16px inputs, PWA manifest, offline shell cache plus Firestore persistent cache. |
| Costs and prices | Off by default; a Settings toggle shows Portal cost per line | The warehouse does not need prices. Salespeople might. Playbook money fields when shown. |
| Labels | Printable QR labels for bins, staging bays, wire boxes, and serialized items | A spool with a QR sticker takes a feet-left reading in two taps; an item with one answers "who has it" in one scan. Inline QR generator, no CDN. |
| Roles | `admin`, `warehouse`, `tech`, `accounting`, stored per user; the first admin is seeded by hand | Accounting needs to read everything and write nothing. Techs need scan, check out, check in, and readings, not product edits. The rules enforce it, so the UI is not the only guard. |
| Serialized items | Automatic at or above the QR threshold (Settings, default $250); manual for anything else | Cheap stock is counted; expensive stock is followed. One scan answers where an AP, a camera, or a processor is and who signed it out. |
| Wire cuts | Every box entry records the mark now and the length cut, by whom, for which ticket | "Feet left" alone does not say who used 360 ft on Tuesday. The cut log does, and the job gets charged the right footage. |
| Tracking dashboard | Its own view: every line on order, grouped by job, with carrier status and ETA | The office asks "where is the UDM for Acme" more than anything else. One page answers it without opening the PO. |
| Wall board | A read-only full-screen view for the warehouse TV: the active pick tickets, lines grouped by the shelf to pull from, picked lines greyed, live from Firestore | A 50-inch screen by the bays answers "what is left and where is it" without anyone picking up a phone. Nothing on it can be tapped, so a stray hand cannot change a count. |
| Analytics | None | Client names and job addresses live in it. |

## 3. Data model (Firestore, project `watchtower-6fbe1`)

```
/spool_clients/{clientId}
  name, portalContactId (string|null), notes, archived
  createdAt, updatedAt

/spool_jobs/{jobId}
  clientId, name ("Main office buildout"), address, status ("open"|"closed")
  stagingLocationId (string|null)      the bay/pallet reserved for this job
  createdAt, updatedAt

/spool_proposals/{proposalId}          doc id = Portal proposal number as string
  jobId, clientId
  portalId (string|null)               Portal's internal id, when known
  number, name, status                 Accepted | Completed | ...
  acceptedAt, importedAt, importSource ("csv"|"zapier"|"api"|"manual")
  lastNoteSyncAt, lastNoteStatus       for the Portal note push (section 6)

/spool_products/{productId}
  brand, model, description
  unit            "each" | "ft"
  upc             string|null          learned on first scan
  category        string               "Wire", "Network", "Camera", "Mount"...
  consumable      bool                 shows in the Consumables view, has a par level
  parLevel        number|null          reorder point in the product's unit
  defaultLocationId (string|null)
  imageUrl        string|null          Storage path, optional
  onHand          number               denormalized sum; recomputed on each movement
  portalItemId    string|null          Portal referencedItemId, when imported
  createdAt, updatedAt

/spool_users/{uid}
  email, name, role ("admin"|"warehouse"|"tech"|"accounting"|"board"), active
                  "board" is the TV's own account: reads everything, writes
                  nothing, and is sent straight to the Board view on sign-in
  addedBy, addedAt, lastSeen
  First admin seeded in the Firebase console; admins manage the rest from
  the console's People tab. A signed-in domain account with no doc gets
  role "tech" and is listed for an admin to confirm.

/spool_items/{itemId}                  one physical unit, serialized
  productId, serial (string|null), cost (number|null)
  qr              "spool:item:{itemId}"
  status          "on_order" | "in_stock" | "staged" | "checked_out" |
                  "installed" | "returned" | "retired"
  locationId      where it sits when in stock or staged
  holderUid, holderName                who has it while checked out
  jobId, ticketId, ticketLineId        what it is out for
  checkedOutAt, checkedInAt, condition ("good"|"damaged"|"missing")
  orderId, shipmentId                  where it came from
  createdAt, updatedAt

/spool_locations/{locationId}
  name ("Rack A3", "Bay 2", "Van 1"), kind ("shelf"|"bay"|"van"|"other")
  jobId (string|null)                  set while a bay is reserved for a job
  qr              string               payload printed on the label

/spool_stock/{productId_locationId}    one doc per product per location
  productId, locationId, qty           qty in the product's unit

/spool_containers/{containerId}        only for unit == "ft" products
  productId, locationId
  upc             the barcode printed on the box, scanned at receive
  label ("Cat6 blue box 3"), startLength (1000), ftLeft (640)
  lastMark        the footage mark the box is stopped at (boxes count down
                  from startLength; ftLeft = lastMark on a count-down box)
  status ("open"|"empty"|"assigned"), pickTicketId (string|null)
  qr, createdAt, lastReadingAt, lastReadingBy

/spool_tickets/{ticketId}              pick ticket
  proposalId, jobId, clientId
  status      "open" | "picking" | "staged" | "delivered" | "closed"
  stagingLocationId
  createdAt, createdBy, updatedAt
  summary     {lines, needed, fromStock, toOrder, staged, delivered}  denormalized

/spool_tickets/{ticketId}/lines/{lineId}
  area ("Living Room"), option, sort
  productId (string|null)              null until matched to the catalog
  brand, model, description            copied from the proposal so the line reads
                                       even before the product exists
  qtyNeeded, qtyFromStock, qtyToOrder, qtyStaged, qtyDelivered
  portalItemId, orderLineRefs [{orderId, orderLineId}]
  notes

/spool_orders/{orderId}                purchase order
  vendor, orderNumber, orderedAt, orderedBy
  status      "draft" | "ordered" | "partial" | "received" | "cancelled"
  jobId, clientId, proposalId          null for stock replenishment
  notes

/spool_orders/{orderId}/lines/{lineId}
  productId, brand, model, qtyOrdered, qtyReceived
  ticketId, ticketLineId               what this line serves; null = stock
  status      "ordered" | "backordered" | "shipped" | "delivered" | "received"

/spool_shipments/{shipmentId}
  orderId, carrier ("UPS"|"FedEx"|"USPS"|"Other"), tracking, trackingUrl
  status ("shipped"|"out_for_delivery"|"delivered"|"received")
  shippedAt, deliveredAt, receivedAt
  lines [{orderLineId, qty}]           partial shipments carry only their lines

/spool_movements/{movementId}          append-only audit trail
  type        "receive"|"pick"|"stage"|"deliver"|"adjust"|"reading"|"cut"|
              "checkout"|"checkin"|"return"|"transfer"
  productId, containerId (null), itemId (null), qty
  fromLocationId, toLocationId
  ticketId, ticketLineId, orderId, shipmentId   whichever apply
  cut         {fromMark, toMark, length}        type == "cut" only
  holderUid, holderName, condition             checkout / checkin only
  by (email), byName, at (Timestamp), note

/spool_settings/{key}
  "general"   {showCosts, carriers: {UPS: urlPattern, ...}, labelSize,
               qrThreshold: 250}            cost at or above which a received
                                            unit becomes a serialized item
  "portal"    {tier: "t0"|"t1"|"t2", lastPollAt}   no secrets here
  "importMap" {header -> field} saved CSV column mapping
  "board"     {mode: "pinned"|"all_open", ticketIds: [], rotateSec: 20,
               groupBy: "location"|"area", showStaged: true,
               theme: "dark"|"light"}   set from the ticket's "Show on board"
                                        button and the Console's Board tab
```

Rules to add to `watchtower/firestore.rules` (shared file, deployed with
Watchtower's `firebase.json`, work account `frank@umbrellaautomation.com`):

```
function spoolRole() {
  return exists(/databases/$(database)/documents/spool_users/$(request.auth.uid))
    ? get(/databases/$(database)/documents/spool_users/$(request.auth.uid)).data.role
    : 'tech';
}
// 'accounting' and 'board' are read-only: they appear in no writer list below
function spoolAdmin()  { return isMSPAdmin() && spoolRole() == 'admin'; }
function spoolWriter() { return isMSPAdmin() && spoolRole() in ['admin', 'warehouse']; }
function spoolTech()   { return isMSPAdmin() && spoolRole() in ['admin', 'warehouse', 'tech']; }

match /spool_users/{uid}   { allow read: if isMSPAdmin(); allow write: if spoolAdmin(); }
match /spool_settings/{k}  { allow read: if isMSPAdmin(); allow write: if spoolAdmin(); }
match /spool_movements/{id} {
  allow read: if isMSPAdmin();
  allow create: if spoolTech();
  allow update, delete: if false;          // audit trail is append-only
}
// techs may change the fields their scans touch, nothing else
match /spool_items/{id}      { allow read: if isMSPAdmin(); allow create, delete: if spoolWriter();
  allow update: if spoolWriter() || (spoolTech() && request.resource.data.diff(resource.data).affectedKeys()
    .hasOnly(['status','holderUid','holderName','jobId','ticketId','ticketLineId','locationId',
              'checkedOutAt','checkedInAt','condition','updatedAt'])); }
match /spool_containers/{id} { allow read: if isMSPAdmin(); allow create, delete: if spoolWriter();
  allow update: if spoolWriter() || (spoolTech() && request.resource.data.diff(resource.data).affectedKeys()
    .hasOnly(['ftLeft','lastMark','status','pickTicketId','lastReadingAt','lastReadingBy','locationId'])); }
match /{coll}/{docId} {
  allow read: if isMSPAdmin() && coll.matches('spool_.*');      // accounting reads everything
  allow write: if spoolWriter() && coll.matches('spool_.*');
  match /{sub=**} { allow read: if isMSPAdmin() && coll.matches('spool_.*');
                    allow write: if spoolWriter() && coll.matches('spool_.*'); }
}
```

(Firestore evaluates the specific matches first; the wildcard match must not
grant anything to non-spool collections, hence the prefix check. Each
`get()` in `spoolRole()` counts against the per-request limit of ten, so
keep it to one lookup per rule. Verify in the rules playground before
deploying.)

The worker (section 6, T1/T2) writes through a service account and bypasses
rules, same as watchtower-worker.

Queries that must stay index-free: open tickets = `status in [open, picking,
staged]`; low stock = client-side filter over `consumable == true` (the
catalog is small); a ticket's lines = subcollection read. Add
`firestore.indexes.json` only when a composite query appears.

## 4. Screens

Six views. Desktop: top nav like Backup Audits. Phone (under 640px): bottom
tab bar with Tickets, Scan, Stock, Orders, More. A sync pill in the header on
every screen: Synced / Offline, 3 pending.

### Tickets (home)
- List of pick tickets grouped by status, newest first. Each row: client, job,
  proposal number, status pill, progress (staged / needed), staging bay, last
  activity. Sortable, Columns manager, card-stack under 640px.
- **New ticket** opens the import sheet (section 5): paste or upload a Portal
  CSV, or pick an already-imported proposal, or build one by hand.
- Filters: status, client, has items to order, has backorders.
- **States.** Empty: "No pick tickets yet. Import a Portal CSV or build one by
  hand." with the New ticket button under it. Filtered to nothing: "No tickets
  match these filters." with a Clear filters link. Loading: the table header
  with three grey rows and the words "Loading tickets". Error: "Could not load
  tickets. Check your connection and try again." with a Retry button; the sync
  pill shows Offline at the same time.

### Ticket detail
- Header: client, job, proposal number with link to Portal, status, staging
  bay, created by/at, **Copy for Portal** and **Print** buttons.
- Lines grouped by Portal area. Each line: brand/model/description, needed,
  from stock, to order, staged, delivered, order/tracking chips, product match
  state (matched to catalog / new product / unmatched).
- Row actions: **Pull from stock** (choose location, scans allowed, writes a
  pick movement and moves qty to the staging bay), **Order** (adds the line to
  a draft PO; see Orders), **Stage** (marks qty laid out), **Deliver to site**,
  **Note**.
- Bulk: "Pull everything we have in stock" fills from-stock using on-hand and
  the product's default location, then lists what still needs ordering.
- Status moves automatically: any line staged = picking; all lines staged =
  staged; all delivered = delivered; Close is manual and asks about leftovers
  (return to stock or write off).
- Bottom panel: timeline of movements and notes for this ticket.
- **States.** No lines (hand-built ticket, nothing typed yet): "This ticket
  has no lines. Add a line or import a CSV." Timeline empty: "Nothing has
  moved yet." Offline write: the row saves locally, the sync pill counts it,
  and the row gets a small "pending" chip until it reaches the server. Save
  failure after reconnect: toast "Could not save Stage on Ubiquiti U6-Pro.
  Try again." and the row keeps its previous values.
- **Show on board** button in the header pins this ticket to the warehouse
  TV (next screen); it toggles to **Remove from board** while pinned.

### Board (warehouse TV)
- A full-screen, read-only view at `?board=1` (also the landing view for the
  `board` role), meant for a 50-inch TV by the bays, read from three to five
  meters away. No nav, no buttons, no cursor, nothing tappable. Type sizes:
  product line 30px, counts 44px, headers 24px; minimum 4.5:1 on the dark
  theme (default; a light theme exists for a bright shop).
- **What it shows.** The pinned tickets (or every open ticket when the mode
  is "all open"), one ticket per screen, rotating every 20 seconds (set in
  Settings) with a thin progress bar along the top so people know when it
  will flip. Each screen: client, job, ticket number, bay, and a big
  "18 of 24 lines staged" with a bar. Below it the lines, **grouped by the
  shelf to pull from** (the product's location, or its default location when
  stock sits in several), in walking order of the rack labels (A1, A2, A3,
  B1...), so the board is the pick path. Each line: product, quantity still
  to pull, bay, and a state: **Pull** (white, with the shelf), **Picked**
  (greyed, with a check and who picked it), **On order** (amber, with the
  PO and ETA), **Short** (red: shelf count below what the line needs).
  Picked lines sink to the bottom of their shelf group; a shelf group with
  nothing left to pull collapses to one line. With more lines than fit, the
  list scrolls slowly and wraps rather than cutting off.
- **Live.** Firestore listeners update the screen within a second of a
  scan, so a tech watching the board sees the line grey out as the phone
  saves. Offline or disconnected: a red "Not live since 2:14 PM" strip at
  the top; the last data stays on screen.
- **Idle.** No open tickets: the Spool mark, "Nothing to pick", the three
  lowest consumables with feet left, and the clock. The board never goes to
  a sign-in screen on its own: the TV's account is signed in once and the
  token refreshes in the background.
- **Setup.** Any browser on the TV opens the URL full-screen. The plan's
  recommendation is a small Windows or Linux mini PC in kiosk mode, because
  TV-stick browsers throttle background tabs and lose sign-ins. An admin
  signs it in as the board account and picks the tickets from the Console's
  Board tab or any ticket's Show on board button. Nothing is configured on
  the TV itself.
- **States.** No pinned tickets in pinned mode: "Nothing pinned. Open a
  ticket and press Show on board." Ticket closed while pinned: it drops off
  the rotation on its own.

### Scan (phone)
- Full-screen camera with a scan box. Decoded UPC looks up the product.
  - Known product: shows name, on-hand by location, and three buttons:
    **Receive**, **Pick for ticket**, **Count**.
  - Unknown UPC: "New product" form with brand/model prefilled from the last
    import line that has no UPC yet (one-tap link) or blank.
  - Location or bay QR: switches the active location (shows as a chip).
  - Product QR (a shelf or bin label for a product): the product card,
    same as a UPC hit.
  - Item QR (a serialized unit): the **Item card**: product, serial, where it
    is, who has it, last five movements, and the buttons **Check out**,
    **Check in**, **Move**, **Stage for ticket**. Check out asks for the job
    (or "personal van stock") and notes; the holder is the signed-in user
    unless an admin picks someone else. Check in asks where it went back
    (default: the product's default location) and its condition.
  - Container QR (a wire box): opens the **Box sheet** (section 7): the mark
    the box is stopped at now, the length cut this time (computed from the
    last mark, editable), optional ticket, and Save. The entry is logged with
    the employee's name.
  - Receiving by barcode: with a PO open in Receive mode, each UPC scanned
    counts one unit against the matching line (or asks which line when the
    UPC matches none). Units at or above the QR threshold get an item record
    and a label prompt on the spot.
- Manual entry field under the camera for a typed UPC, model, or QR payload.
- Torch toggle where the browser allows it.
- **States.** Camera permission denied or no camera: the camera area becomes
  a card reading "Camera is off. Allow it in the browser, or type the code
  below." and the manual field takes focus. Nothing recognized after a few
  seconds: "Still looking. Hold steady, or type the code below." Unknown code:
  the New product form, headed "Not in the catalog yet". Lookup error: "Could
  not look that up. It is saved to retry when you are back online."

### Stock
- Catalog table: product, category, unit, on-hand, by location, par level,
  low-stock badge, last movement. Sortable, Columns manager, search.
- **Consumables** tab: only `consumable == true`, with containers expanded
  under each `ft` product: label, location, feet left, last reading. Low
  stock rises to the top with the amber attention treatment.
- Product detail: edit fields, UPC (scan to set), photo, movements history,
  containers list, **New container** (prints a label), **Adjust** (with
  required reason).
- Locations tab: bins, bays, vans; what is in each; print labels.
- **States.** Empty catalog: "No products yet. Scan a box on the shelf or
  import a proposal to start the catalog." Search with no hits: "Nothing
  matches 'U7-Pro'. Add it as a new product?" with a button that opens the
  form prefilled. No consumables flagged: "No products are marked consumable.
  Edit a product and tick Consumable to see it here with a par level."
  Loading and error states follow the Tickets wording.

### Orders
- List: PO number, vendor, client/job/proposal, status, lines, received /
  ordered, oldest open shipment. Filters by status and vendor.
- Order detail: lines with per-line status and the pick ticket line each
  serves; shipments with carrier, tracking (auto-detected from the number
  pattern: 1Z = UPS, 12/15 digits = FedEx, 20-22 digits starting 9 = USPS),
  link to the carrier page, and dates. **Add shipment** picks the lines it
  carries. **Receive** on a shipment walks each line: scan or tap, qty, into
  the ticket's staging bay (if the line serves a ticket) or into stock.
- Receiving a line serving a ticket bumps that ticket line's staged qty and
  writes a receive movement with ticket, order, and shipment ids.
- **States.** No orders: "No purchase orders yet. Order from a pick ticket
  line or from the low-stock list and the PO appears here." Draft with no
  vendor: the Vendor select carries the amber attention glow and Mark ordered
  is disabled with the tooltip "Pick a vendor first". Tracking number not
  recognized: carrier select stays on Other with "Could not tell the carrier
  from this number. Pick one." Shipment with no lines: "Add at least one line
  to this shipment."

### Tracking (dashboard)
- One page for everything on order that has not been received, so nobody
  opens a PO to answer "where is it". Grouped by job (then stock), one row
  per order line: product, qty, vendor, PO, order date, line status
  (ordered / backordered with ETA / shipped / out for delivery / delivered,
  not received), carrier chip, tracking number as a link, expected date, days
  open. Rows that are delivered but not received float to the top with the
  amber treatment, because that is a box sitting somewhere unscanned.
- Filters: job, vendor, carrier, status, "late" (past expected date).
- Each row has **Receive** (opens the shipment receive flow) and **Note**.
- Carrier status is typed by hand or set by the shipment dates in v1; a
  worker cron that polls the carriers' tracking APIs is the later upgrade
  (section 8) and fills the same fields.
- **States.** Nothing on order: "Nothing in transit. Lines you order from a
  ticket or the low-stock list show here until they are received." Late:
  the row says "Expected 10/24, 2 days late".

### Items (serialized units)
- Table of every serialized item: product, serial, status, location or
  holder, job, days out, last movement. Tabs: Out (checked out), In stock,
  Staged, Installed, Returned, All. Sortable, Columns manager, card-stack.
- **Out** is the page a manager checks on Friday: who has what, since when,
  for which job. Each row has Check in and Nudge (copies a one-line reminder
  to the clipboard; no email in v1).
- Item detail: full history, print label, retire (with reason).
- **States.** No items: "No serialized items yet. Receive something at or
  above the QR threshold (Settings), or open a product and choose Serialize."

### Console (admin and accounting)
- A separate top-level view, visible to `admin` and `accounting` roles. It
  is read-only for accounting and the management surface for admins.
- **Reports** (each with a date range, a table, and Export CSV / XLSX via the
  lazy-loaded SheetJS pattern from Backups):
  - Stock on hand and value (quantity x last cost), by category and location.
  - Spend by vendor and by month, from POs marked ordered.
  - Product delivered per client and job (from deliver movements), with cost
    when costs are on, for job costing and invoicing checks.
  - Items out: who holds what and for how long.
  - Wire usage: cuts per job and per employee, feet and cost.
  - Movements export: the raw audit trail, filtered.
  - Aging: open tickets by age, open POs by age, delivered-not-received.
- **People** (admin only): the roster from `spool_users`, role per person,
  confirm newcomers, deactivate.
- **Settings** (admin only): show costs, QR threshold, carriers, label
  size, Portal tier and status, default start length for wire boxes.
- **States.** Reports with no rows in range: "No deliver movements between
  10/01 and 10/26." Accounting sees no edit controls at all, not greyed ones.

### More
- Clients and Jobs management (small tables; most clients arrive by import).
- Movements log (everything, filterable), export CSV.
- Labels: pick locations, containers, or items, print a sheet.
- Link to the Console for admin and accounting roles.
- **States.** Movements log empty: "No movements yet. The first scan, pick,
  or reading lands here." Label sheet with nothing selected: Print is
  disabled with "Pick at least one location or container."

Import sheet errors (section 5): a file with no recognizable header row shows
"Could not find column headers. Pick them below." and the mapping table; a
row with a blank quantity is listed under "Skipped rows" with the reason;
nothing is created until Create ticket is pressed.

## 5. Importing a proposal (T0, works on any Portal plan)

Portal exports a proposal as CSV, PDF, installer PDF, and a warehouse pick list
(with unit of measure since June 2026). The CSV is the import source.

1. In Portal, open the accepted proposal, download the CSV.
2. In Spool, **New ticket > Import CSV**: drop the file or paste its text.
3. The parser reads area, item type, brand, model, description, quantity, and
   unit where present. Labor, Fee, and CustomItem rows are skipped and listed
   so nothing is silently dropped. Nested accessories keep their parent's
   area.
4. Each row is matched to the catalog by `brand + model` (case-insensitive,
   whitespace-collapsed). Unmatched rows are shown with a **Create product**
   checkbox, ticked by default.
5. You pick or create the client, job, and type the proposal number (prefilled
   when the CSV carries it). Staging bay optional.
6. Create ticket. Lines carry the Portal item id when the CSV has one.

Because Portal's export columns are not published, the parser maps columns by
header name with a preview table so you can fix a mapping once; the mapping is
saved in `spool_settings/importMap`. The first real CSV decides the final
mapping, so the build needs one sample file from you (section 13, D3).

The same sheet accepts a hand-built ticket (type lines) and a re-import of a
change order, which adds or adjusts lines on the existing ticket rather than
creating a second one.

## 6. Portal integration tiers

What the research found (2026-10-23, docs.portal.io and help.portal.io):

- Public REST API, HMAC-SHA256 signed requests, keys issued by Portal after an
  application; **Unlimited plan only** ($349/mo). Sandbox at
  `sandbox.api.portal.io`; production base URL not published.
- Proposals: list (filter by status, modified-after), get, update. Items are
  readable with brand, model, quantity (decimal), supplier, and `linkedOrders`
  (order id, number, supplier, status). No SKU or UPC anywhere.
- Internal notes: `POST /public/proposals/{id}/internalnotes` replaces the
  field. Accepted and Completed proposals return 409 on edits; whether notes
  are exempt is unconfirmed.
- Webhooks: `proposal.status_changed` and three others; signed; retried.
  No order or shipment events; no tracking numbers anywhere in Portal.
- Zapier (Premium and up, plus the $49/mo Integrations add-on): instant
  triggers for proposal status, order status, payment, change order. The
  proposal payload includes areas, options, items, and CSV/PDF links.
  No Zapier actions, so nothing can be written back this way.

The tiers, each a superset of the one before:

**T0 - Manual (any plan).** CSV import (section 5). **Copy for Portal** builds
a status block and copies it; you paste it into the proposal's internal notes.
Format:

```
[Spool 2026-10-23 14:05] Pick ticket #1042 - Acme Dental, Main office
Staged 18/24 lines in Bay 2. To order: 4 lines (PO 7731 to ADI, ordered 10/22,
UPS 1Z999AA10123456784 shipped 10/23). Backordered: Ubiquiti U6-Pro x2.
```

**T1 - Zapier push (Premium).** A Zap on "Update Proposal Status" filtered to
Accepted posts the payload to `spool-worker` (Cloudflare Worker on the
umbrella account, `cf umbrella`). The worker verifies a shared secret, parses
areas/items, writes `spool_proposals/{number}` and a draft pick ticket through
the Firestore service account, same pattern as watchtower-worker. The ticket
appears in Spool with "Imported from Portal, review" before anyone touches it.
Order-status triggers can also update order lines to Received when Portal's
own PO is marked received. Still no write-back.

**T2 - API (Unlimited + approved application).** The worker holds the Portal
app id and user key as secrets (`wrangler secret put`, never in chat). It
subscribes to `proposal.status_changed`, pulls the proposal on Accepted, and
on every Spool status change appends to the proposal's internal notes by
reading the current text, appending the status block, and writing it back.
If accepted proposals return 409 for notes, T2 falls back to T0's copy button
and the plan notes it. Also lets Spool show Portal's `linkedOrders` beside our
own PO lines.

Build T0 first. T1 and T2 are worker work and need the plan tier known.

## 7. Wire boxes: feet left and the cut log

- A `ft` product has containers (boxes or spools). **Receive** scans the UPC
  printed on the box, which identifies the product; the box gets a container
  record with `startLength` (1000 by default for Cat5e/Cat6 boxes, editable),
  a label like "Cat6 blue box 3", and a QR sticker from the label sheet.
- **Box sheet** (opened by scanning the box QR, or from the product's
  containers list). Two numbers and a Save:
  - **Mark now**: the footage printed on the cable where it leaves the box.
    Pull boxes count down from 1000, so the mark is the feet left.
  - **Cut this time**: computed as last mark minus mark now, editable when
    the box was stopped mid-day and the user knows the real figure.
  - Optional **For ticket** chip (prefilled with the ticket whose bay the
    box sits in), optional note.
  - Save writes one `cut` movement with `{fromMark, toMark, length}`, the
    employee's name, and the ticket, then sets `lastMark` and `ftLeft`. The
    product's on-hand drops by the cut length.
  - Quick buttons -50 / -100 / -250 remain for the common pulls; **Empty**
    writes a final cut to zero and closes the box.
- **Reading** without a cut (a recount) is the same sheet with Cut set to
  zero and the note "recount"; it writes a `reading` movement instead. A
  reading replaces the estimate the picks built up.
- The end-of-day habit the SOP asks for: before the box goes back on the
  rack or the van, scan its QR and enter the mark. Thirty seconds, and the
  job is charged the right footage with the right name on it.
- **Pick for ticket** against a container subtracts the typed feet and tags
  the ticket. The container can be marked assigned to the ticket so it travels
  to the site with the staging bay.
- `Empty` sets `ftLeft = 0`, status `empty`, and drops it from on-hand.
- On-hand for the product = sum of open containers' `ftLeft` plus any
  `spool_stock` rows (for a `ft` product those should stay at zero; the UI
  hides them).
- Par level on a `ft` product is in feet; low stock shows "640 ft left, par
  1000 ft, order 2 boxes".

## 8. Orders and shipments

- A draft PO collects lines from tickets ("Order" on a line) and from the
  low-stock list ("Reorder"). Vendor and order number are typed once the
  order is placed; **Mark ordered** stamps `orderedAt` and `orderedBy`.
- Line status moves independently: backordered (vendor says so), shipped
  (shipment created carrying it), delivered (carrier says so, set by hand or
  by the date field), received (checked in by scan or tap).
- A shipment needs carrier + tracking; carrier auto-detected, overridable.
  Tracking links use URL patterns in Settings.
- Order status rolls up: all lines received = received; some = partial.
- Everything shows on the pick ticket line as chips: "PO 7731 - UPS - shipped
  10/23". The ticket's **Copy for Portal** block reads from these.
- No carrier API polling in v1. If wanted later, a worker cron with the
  carriers' free tracking APIs fits the same pattern as clover-worker.

## 8b. Serialized items: check-out and check-in

- **What gets an item record.** On receive, any unit whose cost (from the
  PO line, or the product's last cost) is at or above the QR threshold in
  Settings (default $250). Also anything a warehouse user chooses to
  **Serialize** on a product, in any quantity. Item records are created at
  receive, so the QR label prints while the box is still on the bench.
- **The label.** QR payload `spool:item:{itemId}` plus a human line: product
  and the last 6 of the item id (or the serial when typed or scanned from the
  box). Printed on the 2x4 sheet for anything that will live in a rack, or
  the small sheet for handhelds.
- **Check out.** Scan the item QR, tap Check out, pick the job (or "van
  stock"), optional note. Writes a `checkout` movement with holder, job, and
  time; the item's status becomes `checked_out` and its location clears.
  A pick ticket line can also check out all its serialized items in one tap
  when the ticket is delivered to site, so a van load of five APs is five
  records in five seconds.
- **Check in.** Scan the item QR, tap Check in, confirm where it goes
  (default: the product's default location, or the bay of the ticket it was
  out for), pick a condition (good / damaged / missing-parts), optional note.
  Writes a `checkin` movement; status returns to `in_stock` (or `returned`
  when it came back from a client's home and needs inspection before it is
  stock again; a warehouse user moves it to in_stock after looking at it).
- **Installed.** Delivering a ticket line checks its items out to the tech
  who is delivering (one tap for the whole line). Closing the ticket marks
  every item still checked out on it `installed` with the job; anything
  checked back in before that stays stock. Installed items stop counting as
  stock but keep their history, so a service call two years later can scan
  the sticker on the rack and see when it went in and on which proposal.
- **Who can do what.** Techs check out and check in. Warehouse and admin can
  also move, retire, and change the holder (for "Dana took it, not me").
  Every one of these writes a movement with the signed-in name; there is no
  anonymous change.
- **Where it shows.** The Items view (section 4), the item card on scan, the
  product detail's Items tab, the ticket line's chips ("2 of 4 checked out
  by Tech"), and the Console's Items-out report.

## 9. Offline

- `sw.js` precaches the app shell; Firestore `persistentLocalCache` holds
  data; every write goes local first. Scanning and counting in a dead corner
  of the warehouse must work; the sync pill shows pending writes.
- The camera does not need the network. Lazy-loaded zxing is in the precache
  list so the iOS fallback also works offline.

## 10. Labels and QR

- Payloads: `spool:loc:{locationId}`, `spool:ctr:{containerId}`,
  `spool:prod:{productId}`, `spool:item:{itemId}`. The Scan view routes on
  the prefix; a plain UPC routes to the product lookup (and, in Receive mode,
  counts a unit against the open PO).
- Every label carries the payload as a QR and a human-readable line, so a
  torn or unreadable sticker can still be typed into the manual field.
- Label sheet: Avery 5160 (30 per sheet) and 2x4 (10 per sheet) layouts, QR
  plus a human-readable line. Inline QR encoder (a small vendored function, no
  CDN). Print via the browser's print dialog with `@page` margins set.

## 11. Playbook standards checklist

- Toasts top-center for passive confirmations; decisions use modals.
- Form modals close only via X / Cancel / confirm.
- No horizontal scrollbars anywhere; card-stack tables under 640px;
  `minmax(0,1fr)` grids.
- Tables sortable with reset, Columns manager, saved layout per user in
  `/users/{uid}` (the Watchtower per-user prefs doc).
- Unset decision dropdowns get the amber attention glow (vendor on a draft PO,
  client on an import).
- Money fields `$` + 2 decimals when costs are shown.
- Fields wide enough for their values; dates never truncate; tooltips on
  every non-obvious field explaining why.
- Favicon, OG card (house style, no version text), semver in the title, A2HS
  manifest, `noindex, nofollow`, no repo link in the UI.
- Version constant, HTML meta, visible UI, and README changelog bump together.
- Every text color meets WCAG AA on every surface it sits on: 4.5:1 for
  normal text, 3:1 for 18px+ and for control borders. Status text uses the
  `--m-*-text` variables, never the raw status hue. Check with
  `.claude/skills/antislop-human/contrast-check.py` before each release.
- Every control is a real `<button>` or `<a href>`, reachable by Tab in
  visual order, activatable with Enter or Space, with the browser focus ring
  or a replacement that meets 3:1. Modals close with Escape. Never
  `outline: none` without a replacement.
- Every data view ships its empty, loading, and error state with the wording
  in section 4 before the happy path is called done.
- On the phone (under 640px) every control is at least 44px tall with a gap
  between neighbors; desktop may use the smaller sizes.
- Design reasons, written down so the build does not drift:
  - Uppercase labels with .04em tracking (field labels, table headers, stat
    keys): they read as labels beside dense numbers. Never wider tracking;
    Manifest uses serif sentence-case headings instead.
  - Left stripe on a `.need` row: it marks a real state (needs ordering).
    Manifest's tan stripe and ruled lines on the ticket card: the clipboard
    motif, used on that one card only.
  - Palette per theme: one accent, three status hues (ok, warn, danger) plus
    info, and the two carrier colors only on shipment chips. Nothing else.
  - Amber attention glow on unset decision dropdowns: Playbook rule. It stays
    lit and pulses three times on load, then rests; no endless animation.
  - Mono face for anything printed on a box or a label (container names,
    tracking numbers, UPCs), and in Rack for every count; sans elsewhere.
  - Dials: ENERGY 1 / RHYTHM 1 / MOTION 1. A staff tool used while holding a
    box; nothing moves unless it reports a state change.

## 12. Build phases (Opus, after section 13 is answered)

| Version | Scope |
|---|---|
| 0.1.0 | Shell, sign-in, roles and rules, Stock view, product CRUD, locations, movements, Scan with UPC lookup and receive/count, wire boxes with the box sheet and cut log, serialized items with check-out / check-in, QR labels and label sheets. The warehouse can be counted, labeled, and signed out. |
| 0.2.0 | Clients, jobs, proposals, CSV import with header mapping, pick tickets with lines, pull-from-stock, stage, deliver (checks items out to the tech), close (marks them installed), print, Copy for Portal (T0), the warehouse wall board with Show on board. |
| 0.3.0 | Orders, lines, shipments, carrier detection, receive-by-shipment into bays with barcode counting, chips on ticket lines, low-stock reorder into draft POs, the Tracking dashboard. |
| 0.4.0 | Console: reports with CSV / XLSX export, People, Settings, About (data dictionary), Export everything (one CSV per collection, zipped); accounting role end to end. |
| 0.5.0 | Offline (sw.js + persistent cache + sync pill), PWA manifest, photos on products. |
| 0.6.0 | spool-worker: T1 Zapier intake (if Premium) or T2 API intake and note push (if Unlimited and approved); nightly CSV export to the company Drive; carrier tracking poll if wanted. Settings shows the tier and last sync. |

Each version is a release: bump the version everywhere, README changelog entry
with the why, small commits.

## 13. Still open (answer before the build)

- **D1 Portal plan.** Which plan is Umbrella on (Lite / Pro / Premium /
  Unlimited), and is the Integrations add-on active? Decides whether 0.5.0 is
  Zapier, API, or skipped.
- **D2 Who uses it.** Roles are now in the plan (admin, warehouse, tech,
  accounting). Who is in each? Names or emails per role, and whether techs
  may receive product or only warehouse staff.
- **D3 Sample CSV.** One real Portal proposal CSV (and a warehouse pick list
  export) so the import mapping is right the first time. Scrub prices if you
  like; brand/model/qty/area are what matter.
- **D4 Staging.** Do you stage by bay/pallet with a label, or by a shelf per
  client? Decides the default location kinds and whether bays are reserved
  per job.
- **D5 Vans.** Track van stock as locations now (recommended, it is just
  another location kind) or later?
- **D6 Receiving.** Scan every box on receive, or tap-to-receive by line with
  scanning optional? Plan assumes optional.
- **D7 Costs.** Show Portal cost per line to everyone, nobody, or behind the
  Settings toggle (default)?
- **D8 Name.** Spool, or one of Depot / Manifest / Crate, or something else.
- **D9 Design.** Pick A, B, or C from the switcher. Design Read: a staff
  warehouse app for two to five people on phones and one desktop, in the
  Backup Audits family, dial ENERGY 1 / RHYTHM 1 / MOTION 1. B is recommended
  for the same reason Sundial picked Ledger: it matches Backup Audits and
  reads as business software, and it now carries a mark of its own (ruled
  area headers, mono for anything printed on a box or label). A is the pick
  if the phone in the rack room matters more than the desktop next to the
  other tools; C if you want the paper feel and will print tickets often.
- **D10 Firebase.** OK to keep this in `watchtower-6fbe1` with `spool_`
  collections, or do you want a dedicated project for inventory data?
- **D11 QR threshold.** Serialize every unit received at or above what cost?
  The plan says $250. Say a number, or "everything with a serial number".
- **D12 Wire box direction.** Do your pull boxes print the footage counting
  down from 1000 (mark = feet left), or up from 0? The box sheet's math flips
  on this; the plan assumes counting down.
- **D13 Storyboard sign-off.** The owner reads `storyboard.html` (section
  15) and either approves it or marks up what the flow gets wrong. The build
  starts after that, not before.
- **D15 Database.** Firestore (recommended; section 16) or Postgres via
  Supabase. The owner raised readability; section 16 is the answer either
  way. Postgres moves offline support from "built in" to "we build it" in
  phase 0.5.0 and adds a second sign-in system.
- **D14 Wall board hardware and mode.** What drives the TV: a mini PC in
  kiosk mode (recommended), a Chromecast or Android stick browser, or a
  laptop? And one pinned ticket at a time, or rotate through every open
  ticket? The plan defaults to pinned, rotating every 20 seconds.

## 14. Files

- `work/spool/PLAN.md` - this file.
- `work/spool/design-preview.html` - switcher with three directions, four
  views each (Ticket detail, Stock/Consumables, Orders, Scan on phone).
- `work/spool/anti-slop/audit-001-2026-10-23.md` - antislop audit of the
  switcher and this plan, with the follow-up record of what was fixed.
- `work/spool/storyboard.html` - the storyboard and functional SOP for the
  owner (section 15). Self-contained, prints to PDF from the browser.
- `work/spool/samples/` - real test data (the owner's Excel sheet, a Portal
  CSV). Ignored by git because the repo is public; never commit anything in
  it. Sessions read it from disk to shape the import mapping and seed data.
- Later: `index.html`, `sw.js`, `manifest.json`, `og-image.png`, icons,
  `README.md`; rules block in `watchtower/firestore.rules`;
  `spool-worker/` for T1/T2. The design switcher gains Tracking, Items,
  Console, and Board views once D9 picks a direction.

## 15. Storyboard and functional SOP (for the owner, before the build)

The owner asked for a storyboard and a functional SOP before anything is
built. `storyboard.html` is that document: one page, printable, written for
someone who will never open this plan. It has three parts.

**Part 1, the day in the warehouse (storyboard).** Thirteen panels, each a
sketch of the phone or desktop screen with a caption of what the person does
and what the system records:

1. Approved proposal arrives: download the CSV from Portal, import it, the
   pick ticket appears with every part grouped by room.
2. Pull from stock: scan the shelf label, scan the product, confirm the
   count, the line turns green and the bay fills.
3. Order the rest: one tap builds a draft PO; vendor and order number typed
   when it is placed.
4. Track it: the Tracking dashboard shows each line on order with carrier,
   tracking link, and expected date; late ones rise.
5. Receive: scan each box's UPC against the open PO; counts tick down;
   anything over the threshold prints an item sticker on the spot.
6. Label: QR stickers for the bay, the wire box, the AP.
7. Wire box: scan the box QR, enter the mark where it stopped, Save; the cut
   and your name are logged against the ticket.
8. Load the van: deliver the ticket; the serialized items check out to the
   tech in one tap.
9. On site: an item sticker on the rack can be scanned years later to see
   when it went in and on which proposal.
10. Something comes back: the tech scans the item at the shop, Check in,
    condition, where it goes; the return is logged with the name.
11. End of day: wire boxes back on the rack get their mark entered; the
    sync pill shows everything reached the server.
12. Accounting: the Console shows delivered product per job with cost, spend
    by vendor, items out, and exports to a spreadsheet; nobody in accounting
    can change a count.
13. The wall board: the TV by the bays shows the pinned ticket, lines
    grouped by the shelf to pull from, picked lines greyed as the scans
    land, on-order lines in amber with their ETA.

**Part 2, the functional SOP.** Numbered procedures, each with who does it,
when, the steps, and what gets recorded:

- SOP-1 Receiving product (with and without a PO; the QR threshold).
- SOP-2 Labeling (bays, shelves, wire boxes, items; when to re-label).
- SOP-3 Building a pick ticket from an approved proposal.
- SOP-4 Picking and staging (pull from stock, the wall board as the pick
  path, bay discipline, partial picks).
- SOP-5 Ordering and tracking (draft PO, order number, shipments, the
  dashboard, delivered-but-not-received).
- SOP-6 Wire boxes (receive by UPC, the box sheet, end-of-day marks, empties).
- SOP-7 Check-out and check-in of serialized items (van stock, returns from
  a client's home, damaged or missing).
- SOP-8 Delivering a ticket and closing it (installed items, leftovers back
  to stock or written off).
- SOP-9 Counts and adjustments (who may adjust, the required reason).
- SOP-10 Roles and the Console (what each role sees, how accounting pulls
  a report, how an admin adds a person).
- SOP-11 Portal notes (Copy for Portal today; automatic later).

**Part 3, what it is not.** Half a page of boundaries so the owner's
expectations match: not a replacement for Portal's proposals or QuickBooks,
no carrier polling in v1, no barcode on things that never had one until it
is scanned once, no per-item tracking below the threshold unless chosen.

The page is a self-contained HTML file in the house style of the SOP library
(`work/sop`): print-ready, `?print=1` strips the chrome, noindex. Panels are
inline SVG wireframes, theme-neutral, so the storyboard does not pre-empt D9.

**Tabs (added 2026-10-27).** The page opens on an **Overview** tab: a
five-minute outline in the owner's language (the problem, how a job moves
through in eight steps, what is tracked, who uses it, the screens, Portal,
rollout, what we need from you, what it is not). The **Storyboard** tab is
Part 1 and the **SOP** tab is Parts 2 and 3. Contents links cross tabs.
Two print buttons: **Print this tab** (the Overview alone is a two-page PDF)
and **Print everything** (one PDF, each tab starting a new page).
`?tab=overview|story|sop|tech` opens a tab, `?all=1` shows all four, and
both combine with `?print=1`. The **Tech spec** tab (added 2026-10-27 after
the owner asked what the site runs on and whether a Firestore database stays
readable) is section 16 in the owner's words.

## 16. Tech spec and data readability

The stack is the work site's usual: static HTML on GitHub Pages, Firebase
Authentication with Google restricted to the domain, Cloud Firestore in
`watchtower-6fbe1`, Firebase Storage for photos, browser camera scanning,
browser-printed labels, SheetJS exports, and later a Cloudflare Worker for
Portal. Nothing new to run. D15 keeps Postgres (Supabase) open as the
alternative; the screens are the same either way, offline support is the
cost (section 9 becomes hand-built sync).

**Readability rules.** The owner does not want a database only the app can
read. These are build requirements, checked before each release:

1. Flat collections with plain names (section 3). One collection per kind of
   thing; at most one level of nesting (ticket lines). No encoded blobs, no
   maps-of-maps, no arrays of objects except short chip lists.
2. Field names are English words: `brand`, `model`, `qtyNeeded`, `ftLeft`,
   `holderName`. No abbreviations beyond `qty`, `ft`, and `id`.
3. **Names travel with the record.** Every document that references another
   carries the readable name beside the id, written at the moment of the
   change: `clientName` and `jobName` on tickets, items, and orders;
   `productName` (brand + model) and `locationName` on stock rows,
   containers, items, and every movement; `holderName` and `byName` on
   movements; `ticketNumber` beside `ticketId`. A row reads on its own in
   the console or a CSV. Names are snapshots; renaming a client does not
   rewrite history.
4. Readable document ids where the world has one: `spool_proposals/{Portal
   number}`, `spool_products/{brand-model slug}` (`ubiquiti-u6-pro`),
   `spool_locations/{rack-a3}`, `spool_tickets/{proposal number}` (or
   `{number}-co2` for a change order). Random ids only for movements,
   shipments, items, and containers, and those carry names (rule 3).
5. A data dictionary: section 3 of this plan is the source; the Console's
   **About** tab renders the same list (collection, field, meaning) from a
   constant in the code, so it cannot drift from the build.
6. **Export everything** in the Console: one CSV per collection, zipped,
   opening in Excel with the headers from rule 2. Phase 0.4.0.
7. Nightly export: spool-worker writes the same CSVs to a company Google
   Drive folder ("Spool backups", dated subfolders, 90-day retention) through
   a service account. Phase 0.6.0, with the worker. Until then, Export
   everything by hand on Fridays is SOP-10's last step.
8. Reports read the live collections, never a hidden copy.
9. One-for-one SQL mapping: every collection is a table, every field a
   column, every subcollection a table with a parent id. A move to Postgres
   is a copy script, not a rewrite.

**Firestore vs Postgres, for the record.** Firestore: shared sign-in, offline
persistence built in, listeners for the wall board, free tier covers a
five-person shop, console shows one document at a time. Supabase Postgres:
grid view per table, SQL joins for reports, its own auth, no built-in
offline, free tier pauses after a week idle so Pro is the realistic tier.
Recommendation stays Firestore with rules 1-9; D15 is the owner's call.
