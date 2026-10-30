# Loadout - office inventory, pick tickets, and product tracking

Plan v0.4 - 2026-10-29 by Fable 5.1 (design/plan pass; v0.1 was 2026-10-23,
v0.2 was 2026-10-26; v0.3 (2026-10-27) adds the warehouse wall board,
section 4; v0.4 renames the tool Loadout and adds section 17).
Nothing here is built yet. Implementation is a later Opus job once the
decisions in section 13 are answered and the owner has read the storyboard.
Open the design switcher at
`file:///T:/ClaudeCodeRepo/work/loadout/design-preview.html` and the storyboard
and functional SOP for the owner at
`file:///T:/ClaudeCodeRepo/work/loadout/storyboard.html` (section 15).

v0.2 adds, from the 2026-10-26 notes: serialized items with their own QR and
a check-out / check-in log (section 8b), a cut log on wire boxes (section 7),
roles with an accounting console (sections 3, 4), a tracking dashboard for
product on order (section 4), and the storyboard (section 15).

**Loadout** is the name (settled 2026-10-29), folder `work/loadout/`. A
loadout is the gear you take on a job, which is what this tool assembles and
tracks. It is still deliberately not "inventory" or "warehouse" in the URL:
internal tools on the work site get a neutral name, no hub tile, no links from
other pages, `noindex, nofollow`, and the shared Watchtower sign-in wall
(`@umbrellaautomation.com` Google accounts only).

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
  are tracked as **containers** (one record per box or reel) with a
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
- **Wire box.** A box or reel of a by-the-foot product. Received by the UPC
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
| Home | `frank-umbrella/work`, folder `loadout/` | Same repo and Pages site as Watchtower, Backup Audits, Sundial. Deploys on push. |
| Sign-in | Google, `@umbrellaautomation.com` only, Firebase project `watchtower-6fbe1` | Zero new setup. Copy `firebaseConfig`, `ALLOWED_DOMAIN`, the `hd` parameter, and the post-sign-in domain check from `backups/index.html`. |
| Storage | Firestore, collections prefixed `loadout_`, shared by everyone on the domain | Same trade-off as Watchtower's rules: every employee has full read/write. Movements are the audit trail, so mistakes are visible, not prevented. |
| Portal integration | **Tiered** (section 6): T0 manual import works on any plan today; T1 Zapier push needs Premium; T2 full API needs Unlimited plus an approved application | We do not know the current Portal plan. The pick ticket must not depend on an API we may not have. |
| Notes back to Portal | Append to the proposal's internal notes via API when allowed; otherwise a **Copy for Portal** button | Portal has no comment thread object. Internal notes is a single text field that the update call replaces, and accepted proposals may return 409. Copy-paste is the guaranteed path. |
| Units | `each` or `ft` per product; `ft` products are tracked per container with a feet-left reading | "Feet left" is a reading you take, not a calculation. Picking 150 ft from a 1000 ft box is a movement against that box. |
| Barcodes | UPC scanned with the phone camera; falls back to typing | Portal's item model has no SKU or UPC, so the catalog learns barcodes on first receive. Chrome on Android has `BarcodeDetector`; a lazy-loaded zxing fallback covers iOS Safari. |
| Mobile | Phone first | Scan, pick, and count happen in the warehouse. Bottom tab bar under 640px, thumb-sized buttons, 16px inputs, PWA manifest, offline shell cache plus Firestore persistent cache. |
| Costs and prices | Off by default; a Settings toggle shows Portal cost per line | The warehouse does not need prices. Salespeople might. Playbook money fields when shown. |
| Labels | Printable QR labels for bins, staging bays, wire boxes, and serialized items | A wire box with a QR sticker takes a feet-left reading in two taps; an item with one answers "who has it" in one scan. Inline QR generator, no CDN. |
| Roles | `admin`, `warehouse`, `tech`, `accounting`, stored per user; the first admin is seeded by hand | Accounting needs to read everything and write nothing. Techs need scan, check out, check in, and readings, not product edits. The rules enforce it, so the UI is not the only guard. |
| Serialized items | Automatic at or above the QR threshold (Settings, default $250); manual for anything else | Cheap stock is counted; expensive stock is followed. One scan answers where an AP, a camera, or a processor is and who signed it out. |
| Wire cuts | Every box entry records the mark now and the length cut, by whom, for which ticket | "Feet left" alone does not say who used 360 ft on Tuesday. The cut log does, and the job gets charged the right footage. |
| Tracking dashboard | Its own view: every line on order, grouped by job, with carrier status and ETA | The office asks "where is the UDM for Acme" more than anything else. One page answers it without opening the PO. |
| Wall board | A read-only full-screen view for the warehouse TV: the active pick tickets, lines grouped by the shelf to pull from, picked lines greyed, live from Firestore | A 50-inch screen by the bays answers "what is left and where is it" without anyone picking up a phone. Nothing on it can be tapped, so a stray hand cannot change a count. |
| Analytics | None | Client names and job addresses live in it. |

## 3. Data model (Firestore, project `watchtower-6fbe1`)

```
/loadout_clients/{clientId}
  name, portalContactId (string|null), notes, archived
  createdAt, updatedAt

/loadout_jobs/{jobId}
  clientId, name ("Main office buildout"), address, status ("open"|"closed")
  stagingLocationId (string|null)      the bay/pallet reserved for this job
  createdAt, updatedAt

/loadout_proposals/{proposalId}          doc id = Portal proposal number as string
  jobId, clientId
  portalId (string|null)               Portal's internal id, when known
  number, name, status                 Accepted | Completed | ...
  acceptedAt, importedAt, importSource ("csv"|"zapier"|"api"|"manual")
  lastNoteSyncAt, lastNoteStatus       for the Portal note push (section 6)

/loadout_products/{productId}
  kind            "device" | "patch-cable" | "splitter" | "connector" |
                  "wire" | "other"            from the sheet tab it came from
  type            "CAT6 UTP patch cable", "2 way coaxial splitter", "XLR",
                  "Network"...                the sheet's Type column, kept
  brand, model, description                   blank on most cables and
                                              connectors (section 17)
  name            display name: brand + model when present, otherwise
                  composed from type and attributes ("Cat6 UTP patch
                  cable, RJ45/M to RJ45/M, blue, 3 ft")
  connector1, connector2, color, length, lengthUnit ("ft"|"m"|"in"),
  gauge, gaugeUnit ("awg"|"mm"), inputs, outputs, sex, band, pins,
  wireType ("23/4", "RG6"), grade ("GP"|"Riser"|"Plenum"|"Shielded")
                                              flat optional attributes;
                                              only the ones the kind uses
  unit            "each" | "ft"
  upc             string|null          learned on first scan
  category        string               "Wire", "Network", "Camera", "Mount"...
  consumable      bool                 shows in the Consumables view, has a par level
  parLevel        number|null          reorder point in the product's unit
  defaultLocationId (string|null)
  imageUrl        string|null          photo download link, optional (0.5.0)
  imagePath       string|null          its Storage path, loadout/products/{id}.jpg
  imageAt         Timestamp|null       when the photo was last set
  onHand          number               denormalized sum; recomputed on each movement
  portalItemId    string|null          Portal referencedItemId, when imported
  lastCountAt     Timestamp|null       from the sheet's Last Date / Count Date
  createdAt, updatedAt

  Document id: brand-model slug when both exist ("ubiquiti-u6-pro");
  otherwise kind + type + attributes slug
  ("patch-cable-cat6-utp-rj45m-rj45m-blue-3ft"). Same product, same id,
  so a re-import updates instead of duplicating.

/loadout_users/{uid}
  email, name, role ("admin"|"warehouse"|"tech"|"accounting"|"board"), active
                  "board" is the TV's own account: reads everything, writes
                  nothing, and is sent straight to the Board view on sign-in
  addedBy, addedAt, lastSeen
  First admin seeded in the Firebase console; admins manage the rest from
  the console's People tab. A signed-in domain account with no doc gets
  role "tech" and is listed for an admin to confirm.

/loadout_items/{itemId}                  one physical unit, serialized
  productId, serial (string|null), cost (number|null)
  qr              "loadout:item:{itemId}"
  status          "on_order" | "in_stock" | "staged" | "checked_out" |
                  "installed" | "returned" | "retired"
  locationId      where it sits when in stock or staged
  holderUid, holderName                who has it while checked out
  jobId, ticketId, ticketLineId        what it is out for
  checkedOutAt, checkedInAt, condition ("good"|"damaged"|"missing")
  orderId, shipmentId                  where it came from
  createdAt, updatedAt

/loadout_locations/{locationId}
  area ("Storage room", "Computer Room Shelving Rack", "Warehouse")
  shelf ("RCA A/V Video", "Power cables", "C", "")   blank for a bare area
  name            "Storage room, RCA A/V Video"   composed; what labels print
  kind ("shelf"|"bay"|"van"|"other")
  jobId (string|null)                  set while a bay is reserved for a job
  qr              string               payload printed on the label
  Document id: area-shelf slug ("storage-room--rca-av-video").

/loadout_stock/{productId_locationId}    one doc per product per location
  productId, locationId, qty           qty in the product's unit

/loadout_containers/{containerId}        only for unit == "ft" products
  productId, locationId
  upc             the barcode printed on the box, scanned at receive
  label           the shop's existing box code ("A826", "BB"), kept as the
                  id and printed on the QR sticker; new boxes continue the
                  scheme (section 17)
  startLength (1000), ftLeft (640), purchasedAt
  lastMark        the footage mark the box is stopped at (boxes count down
                  from startLength; ftLeft = lastMark on a count-down box)
  status ("open"|"empty"|"assigned"), pickTicketId (string|null)
  qr, createdAt, lastReadingAt, lastReadingBy

/loadout_tickets/{ticketId}              pick ticket
  proposalId, jobId, clientId
  status      "open" | "picking" | "staged" | "delivered" | "closed"
  stagingLocationId
  createdAt, createdBy, updatedAt
  summary     {lines, needed, fromStock, toOrder, staged, delivered}  denormalized

/loadout_tickets/{ticketId}/lines/{lineId}
  area ("Living Room"), option, sort
  productId (string|null)              null until matched to the catalog
  brand, model, description            copied from the proposal so the line reads
                                       even before the product exists
  qtyNeeded, qtyFromStock, qtyToOrder, qtyStaged, qtyDelivered
  portalItemId, orderLineRefs [{orderId, orderLineId}]
  notes

/loadout_orders/{orderId}                purchase order
  vendor, orderNumber, orderedAt, orderedBy
  status      "draft" | "ordered" | "partial" | "received" | "cancelled"
  jobId, clientId, proposalId          null for stock replenishment
  notes

/loadout_orders/{orderId}/lines/{lineId}
  productId, brand, model, qtyOrdered, qtyReceived
  ticketId, ticketLineId               what this line serves; null = stock
  status      "ordered" | "backordered" | "shipped" | "delivered" | "received"

/loadout_shipments/{shipmentId}
  orderId, carrier ("UPS"|"FedEx"|"USPS"|"Other"), tracking, trackingUrl
  status ("shipped"|"out_for_delivery"|"delivered"|"received")
  shippedAt, deliveredAt, receivedAt
  lines [{orderLineId, qty}]           partial shipments carry only their lines

/loadout_movements/{movementId}          append-only audit trail
  type        "receive"|"pick"|"stage"|"deliver"|"adjust"|"reading"|"cut"|
              "checkout"|"checkin"|"return"|"transfer"
  productId, containerId (null), itemId (null), qty
  fromLocationId, toLocationId
  ticketId, ticketLineId, orderId, shipmentId   whichever apply
  cut         {fromMark, toMark, length}        type == "cut" only
  holderUid, holderName, condition             checkout / checkin only
  by (email), byName, at (Timestamp), note

/loadout_settings/{key}
  "general"   {showCosts, carriers: {UPS: urlPattern, ...}, labelSize,
               qrThreshold: 250}            cost at or above which a received
                                            unit becomes a serialized item
               (as built: also vendors, weekStart, boxStart by cable type,
               and workWeek, the Week view default added in 0.4.0; the
               Console's About tab lists every field from the code)
  "portal"    {tier: "t0"|"t1"|"t2", lastPollAt}   no secrets here
  "importMap" {header -> field} saved CSV column mapping
  "board"     {mode: "pinned"|"all_open", ticketIds: [], rotateSec: 20,
               groupBy: "location"|"area", showStaged: true,
               theme: "dark"|"light"}   set from the ticket's "Show on board"
                                        button and the Console's Board tab
```

Rules to add to `watchtower/firestore.rules` (shared file, deployed with
Watchtower's `firebase.json`, work account `frank@umbrellaautomation.com`):

The deployed source of truth is the `// -------- Loadout (work/loadout) --------`
block in `watchtower/firestore.rules` (copied into `loadout/README.md` under
"Rules"). It differs from the first draft of this section in two ways the
0.1.0 build proved in the Firestore emulator: the `loadout_.*` wildcard no
longer covers collections that have their own rules (Firestore allows a write
if ANY matching rule allows it, so the wildcard was letting warehouse users
edit movements and settings and admins delete movements), and
`loadout_users` lets a signed-in domain account create its own doc as tech,
with the owner account (the existing `backupsOwner()` check) creating its own
as admin, since otherwise the first admin could never exist. Techs may also
write `onHand`, `updatedAt`, `locationName`, `jobName`, and `confirmLocation`
on products and containers so names and totals stay right after a cut or a
check-out, and every movement must carry `by` equal to the signed-in email.
Subcollections use `/{subcoll}/{rest=**}` because a bare `{sub=**}` also
matches the parent document.

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
- **Idle.** No open tickets: the Loadout mark, "Nothing to pick", the three
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
- Product detail opens **in place under the row** (section 12b item 5), not
  in a modal: edit fields, UPC (scan to set), photo, movements history,
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

### Week (added 2026-10-29, laid out by the user)
- The staging schedule shown like a timesheet. Seven day blocks across the
  top, Sunday to Saturday (week start from Settings), with **Previous week /
  This week / Next week** arrows and the date range above them. Each day is
  its own bordered block with the weekday and date as its header. Days that
  have passed are faded (the whole block at reduced opacity; any text that
  still needs reading stays at 4.5:1, since the cards are a record, not a
  to-do); today's block carries a soft highlighted border (the accent at
  low opacity, 2px, with a faint matching glow) and a "Today" tag; future
  days are full strength.
- Inside a day block, one card per pick ticket due that day: the **client
  name** and the **pick ticket number** as the card header (job name under
  it in small text), then the ticket's **items listed below**, one line
  each, product name on the left and its **status on the right** as a pill:
  Pull, Picked, Staged, On order (with ETA), Short, Delivered. A ticket with
  more than eight lines shows the first eight and "and 14 more" that opens
  the ticket. A small progress figure on the card ("18 of 24 staged").
- A day with nothing: the block stays, with "Nothing due." in muted text.
  Tickets with no install date sit in an **Unscheduled** strip under the
  grid so they are not lost; dragging is not in v1, set the date from the
  ticket or the strip's date field.
- Clicking a card opens the ticket. Clicking a line opens that line's row
  on the ticket.
- Tickets gain an **install date** (`installAt`), set on the ticket header
  and on the import sheet; the Tickets list sorts and filters by it. The
  wall board's pinned mode can also follow "today's tickets" from this
  view (Board setting `mode: "today"`).
- **Layout settled 2026-10-29: B, the timesheet grid** (`week-preview.html`
  compared it with a stacked-lists layout; the user picked B as more visual
  and straight to the point).
- Desktop: the view takes the full window width (no side rail), seven
  columns with `repeat(auto-fit, minmax(180px, 1fr))` so a day block is
  never narrower than 180px; when seven do not fit, the grid wraps to
  four then three per row rather than squeezing. A **Work week** toggle
  in the week strip (remembered per user) hides Saturday and Sunday, so
  five days share the width; a weekend with a ticket on it shows a small
  "1 ticket on Sat" chip that turns the toggle off. Card type is 15px,
  product names wrap to two lines then truncate with a tooltip. Under
  640px: day blocks stack vertically, today first, and the week arrows
  stay fixed at the top.
- Movements under More gains the same Previous / This / Next week arrows
  beside its date fields, so "what moved this week" is one tap.
- **States.** A week with no tickets at all: "Nothing scheduled the week of
  Nov 2. Set an install date on a ticket to see it here." Loading: the seven
  blocks with grey bars. Error: the Tickets wording.

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
- **People** (admin only): the roster from `loadout_users`, role per person,
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
2. In Loadout, **New ticket > Import CSV**: drop the file or paste its text.
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
saved in `loadout_settings/importMap`. The first real CSV decides the final
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
[Loadout 2026-10-23 14:05] Pick ticket #1042 - Acme Dental, Main office
Staged 18/24 lines in Bay 2. To order: 4 lines (PO 7731 to ADI, ordered 10/22,
UPS 1Z999AA10123456784 shipped 10/23). Backordered: Ubiquiti U6-Pro x2.
```

**T1 - Zapier push (Premium).** A Zap on "Update Proposal Status" filtered to
Accepted posts the payload to `loadout-worker` (Cloudflare Worker on the
umbrella account, `cf umbrella`). The worker verifies a shared secret, parses
areas/items, writes `loadout_proposals/{number}` and a draft pick ticket through
the Firestore service account, same pattern as watchtower-worker. The ticket
appears in Loadout with "Imported from Portal, review" before anyone touches it.
Order-status triggers can also update order lines to Received when Portal's
own PO is marked received. Still no write-back.

Built 2026-10-29 in `loadout/worker/`; T2 stub only until D1 is answered.

**T2 - API (Unlimited + approved application).** The worker holds the Portal
app id and user key as secrets (`wrangler secret put`, never in chat). It
subscribes to `proposal.status_changed`, pulls the proposal on Accepted, and
on every Loadout status change appends to the proposal's internal notes by
reading the current text, appending the status block, and writing it back.
If accepted proposals return 409 for notes, T2 falls back to T0's copy button
and the plan notes it. Also lets Loadout show Portal's `linkedOrders` beside our
own PO lines.

Build T0 first. T1 and T2 are worker work and need the plan tier known.

## 7. Wire boxes: feet left and the cut log

- A `ft` product has containers (boxes or reels). **Receive** scans the UPC
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
  `loadout_stock` rows (for a `ft` product those should stay at zero; the UI
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
- **The label.** QR payload `loadout:item:{itemId}` plus a human line: product
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

- Payloads: `loadout:loc:{locationId}`, `loadout:ctr:{containerId}`,
  `loadout:prod:{productId}`, `loadout:item:{itemId}`. The Scan view routes on
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
- Version constant, HTML meta, visible UI, README changelog, and the `sw.js`
  `VERSION` (its cache name) bump together; a stale sw.js serves the old shell.
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
| 0.1.0 | Shell, sign-in, roles and rules, Stock view, product CRUD, locations, movements, Scan with UPC lookup and receive/count, wire boxes with the box sheet and cut log, serialized items with check-out / check-in, QR labels and label sheets, and the **inventory sheet importer** (section 17) so day one starts from the current spreadsheet, not from zero. The warehouse can be counted, labeled, and signed out. |
| 0.2.0 | Clients, jobs, proposals, CSV import with header mapping, pick tickets with lines, pull-from-stock, stage, deliver (checks items out to the tech), close (marks them installed), print, Copy for Portal (T0), the warehouse wall board with Show on board. |
| 0.3.0 | Orders, lines, shipments, carrier detection, receive-by-shipment into bays with barcode counting, chips on ticket lines, low-stock reorder into draft POs, the Tracking dashboard, the Week view with ticket install dates and week arrows on Movements. |
| 0.4.0 | Console: reports with CSV / XLSX export, People, Settings, About (data dictionary), Export everything (one CSV per collection, zipped); accounting role end to end. |
| 0.5.0 | Offline (sw.js + persistent cache + sync pill), PWA manifest, photos on products. |
| 0.6.0 | loadout-worker: T1 Zapier intake (if Premium) or T2 API intake and note push (if Unlimited and approved); nightly CSV export to the company Drive; carrier tracking poll if wanted. Settings shows the tier and last sync. |

Each version is a release: bump the version everywhere, README changelog entry
with the why, small commits.

## 12b. Fix list from the first live run (2026-10-29)

Status: all five items are done in 0.3.0 (README changelog). Item 4 also
closes the space in a connector's hyphen ("Edison- M" reads "Edison-M"),
since a comma there would split one connector in two.

The user deployed the rules, signed in, and imported the workbook on the live
site. Confirmed working: 262 products, 216 consumables, 17 locations, 13
serialized units, 300 import movements naming the workbook tab and row, wire
boxes with feet left and "Confirm location" flags. To fix in the next phase:

1. **Title-casing mangles slash words.** "A/V" became "A/v" in composed names
   ("1 Pin A/v Cable- Black Band"). Keep letters after a slash upper-case
   when the source had them so, and do not title-case a token that is all
   caps and 3 letters or fewer on either side of a slash. Re-import must
   rename the affected products (same ids, new `name`).
2. **Serialized unit labels are ugly.** Units imported as "Unit C-IW-1" and
   "Unit -WHT-1" (the tail of the model slug). The label should be the
   product name plus a number: "Unifi UAP-AC-IW #1". The QR payload and id
   stay as they are.
3. **Import movements carry the import time, not the count date.** Every
   import row shows 10/29/2026 4:42 PM. Section 17 asked for the sheet's
   Last Date / Count Date / As of Date as the movement time (keep the
   import time in a `importedAt` field) so the history reads as the real
   count dates. Movements already written stay; a re-import may not
   duplicate them.
4. **Type spacing from the sheet.** "Audio- Outdoor" and "Cable- Black Band"
   carry the sheet's stray hyphen spacing; normalize " - " / "- " / " -" to
   ", " in composed names only, leaving `type` as typed.

5. **Stock rows expand in place instead of opening a modal.** (User, after
   the first live run.) Clicking a product row opens a panel directly under
   that row, pushing the rows below down: the editable fields in a tidy
   two-column grid (name, brand, model, category, unit, par, default
   location, UPC with Set by scan, consumable toggle, cost when costs are
   on), then the on-hand-by-location list, the containers list for `ft`
   products, and one row of buttons (Save, Receive, Adjust, Serialize, New
   box, Print label, History). One row open at a time; clicking another
   row closes the first; Escape or the chevron closes it; the URL hash
   carries the open product (`#stock/p/<id>`) so a link lands on it open.
   On the phone the card itself expands the same way. Modals stay for the
   decisions (Receive, Adjust, Serialize, New box) because they need a
   confirm; the detail view itself is no longer a modal. Apply the same
   pattern to Items rows and Locations rows so the three tables behave
   alike. Keep the row's height stable while it is closed so sorting and
   scanning the list does not jump.

6. **Tracking-number links are under 44px on the phone** (Tracking and
   Order detail, inline text links from 0.3.0). Give them 44px tap height
   with padding, or wrap them in the carrier chip.

7. **Worker-imported tickets are not marked in the app.** The worker sets
   `needsReview: true` and `importSource: "zapier"`, but 0.5.0 shows neither:
   ticket detail labels every non-manual ticket "Imported from CSV". Show an
   "Imported from Portal, review" chip on the Tickets list and the ticket
   header while `needsReview` is set, with a Reviewed button that clears it
   (warehouse/admin), and label the source by `importSource`.
8. **Order lines should carry a unit cost** (`unitCost` at Mark ordered,
   defaulting from the product's last cost) so the Spend and Delivered
   reports stay fixed when a product's cost later changes.

Decisions recorded from the 0.5.0 build (2026-10-29): the service worker
registers in demo mode too (needed for the offline test; harmless); product
`imageUrl` stores the Firebase download link, so anyone holding the link can
open the image without the read rule, accepted for product photos because it
lets photos show offline; `sw.js` carries its own `VERSION` that must be
bumped with every release (added to section 11); Storage must be enabled on
`watchtower-6fbe1` (may need Blaze) before the storage rules deploy.

## 13. Still open (answer before the build)

**Assumed for the first build (2026-10-29).** The user asked for the build to
start so the shop can feel it out before the owner's decisions are in. The
build proceeds on these defaults; each is a one-line change later and the
decision text below stays until the real answer lands.

| Decision | Assumed |
|---|---|
| D1 Portal plan | Unknown; T0 only (CSV import + Copy for Portal). No worker. |
| D2 Roles | `frank@umbrellaautomation.com` seeded as admin; every other domain sign-in lands as tech until an admin confirms a role. Warehouse and admin receive; techs do not. |
| D3 Sample CSV | None yet; the importer maps by header name with a preview, prefilled for Area, Item Type, Brand, Model, Description, Quantity, Unit. |
| D4 Staging | Labeled bays: Bay 1 to Bay 4 seeded as locations of kind `bay`. |
| D5 Vans | Location kind `van` exists; Van 1 and Van 2 seeded. |
| D6 Receiving | Tap-to-receive by line, scanning optional. |
| D7 Costs | Behind the Settings toggle, off by default. |
| D8 Name | Loadout (settled). |
| D9 Design | B Ledger. |
| D10 Firebase | `watchtower-6fbe1`, collections `loadout_*`, rules appended to `watchtower/firestore.rules`. |
| D11 QR threshold | $250. |
| D12 Wire boxes | Count down from the start length; mark now = feet left. |
| D13 Sign-off | Build is a prototype for feel; the owner's mark-ups land as changes, not as a blocker. |
| D14 Wall board | Any full-screen browser; pinned mode, 20 s rotation. |
| D15 Database | Firestore (settled). |
| D16 Box start lengths | Default by cable type at import: Cat5e / Cat6 / coax 1,000 ft; audio, speaker, and stranded 500 ft; anything else 1,000; every box editable afterwards. Boxes whose feet left exceed the default take their feet left as the start. |
| D17 Assigned inventory | Unassigned only; jobs start from new pick tickets. |

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
- **D8 Name.** Settled 2026-10-29: **Loadout**. (Spool, Depot, Quartermaster,
  Keep, Hold, Manifest, Stow, Dock, Crate, Kit, Packout, Pull and others were
  considered; Pull stays as the fallback.)
- **D9 Design.** Pick A, B, or C from the switcher. Design Read: a staff
  warehouse app for two to five people on phones and one desktop, in the
  Backup Audits family, dial ENERGY 1 / RHYTHM 1 / MOTION 1. B is recommended
  for the same reason Sundial picked Ledger: it matches Backup Audits and
  reads as business software, and it now carries a mark of its own (ruled
  area headers, mono for anything printed on a box or label). A is the pick
  if the phone in the rack room matters more than the desktop next to the
  other tools; C if you want the paper feel and will print tickets often.
- **D10 Firebase.** OK to keep this in `watchtower-6fbe1` with `loadout_`
  collections, or do you want a dedicated project for inventory data?
- **D11 QR threshold.** Serialize every unit received at or above what cost?
  The plan says $250. Say a number, or "everything with a serial number".
- **D12 Wire box direction.** Do your pull boxes print the footage counting
  down from 1000 (mark = feet left), or up from 0? The box sheet's math flips
  on this; the plan assumes counting down.
- **D13 Storyboard sign-off.** The owner reads `storyboard.html` (section
  15) and either approves it or marks up what the flow gets wrong. The build
  starts after that, not before.
- **D15 Database.** Settled 2026-10-29: **Firestore**, as recommended in
  section 16. Postgres is off the table for v1; the one-for-one SQL mapping
  rule stays so the door is not locked.
- **D16 Box start lengths.** The current sheet has feet left per box but
  not what each box started at, and the maximums show they are not all
  1,000 (one box type reads 1,954, coax 1,000, several under 800 and
  already partly used). At import, each open box needs its start length
  typed once, or a default per cable type (Cat6 1,000; RG6 1,000; audio and
  speaker 500?). Which?
- **D17 Assigned inventory.** The sheet is "Unassigned Inventory", so there
  is presumably a per-job or assigned list somewhere. Is there, and should
  it be imported as staged stock against jobs, or does Loadout start with the
  unassigned stock only and build the rest from new pick tickets?
- **D14 Wall board hardware and mode.** What drives the TV: a mini PC in
  kiosk mode (recommended), a Chromecast or Android stick browser, or a
  laptop? And one pinned ticket at a time, or rotate through every open
  ticket? The plan defaults to pinned, rotating every 20 seconds.

## 14. Files

- `work/loadout/PLAN.md` - this file.
- `work/loadout/design-preview.html` - switcher with three directions, four
  views each (Ticket detail, Stock/Consumables, Orders, Scan on phone).
- `work/loadout/anti-slop/audit-001-2026-10-23.md` - antislop audit of the
  switcher and this plan, with the follow-up record of what was fixed.
- `work/loadout/storyboard.html` - the storyboard and functional SOP for the
  owner (section 15). Self-contained, prints to PDF from the browser.
- `work/loadout/samples/` - real test data (the owner's Excel sheet, a Portal
  CSV). Ignored by git because the repo is public; never commit anything in
  it. Sessions read it from disk to shape the import mapping and seed data.
- Later: `index.html`, `sw.js`, `manifest.json`, `og-image.png`, icons,
  `README.md`; rules block in `watchtower/firestore.rules`;
  `loadout-worker/` for T1/T2. The design switcher gains Tracking, Items,
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
4. Readable document ids where the world has one: `loadout_proposals/{Portal
   number}`, `loadout_products/{brand-model slug}` (`ubiquiti-u6-pro`),
   `loadout_locations/{rack-a3}`, `loadout_tickets/{proposal number}` (or
   `{number}-co2` for a change order). Random ids only for movements,
   shipments, items, and containers, and those carry names (rule 3).
5. A data dictionary: section 3 of this plan is the source; the Console's
   **About** tab renders the same list (collection, field, meaning) from a
   constant in the code, so it cannot drift from the build.
6. **Export everything** in the Console: one CSV per collection, zipped,
   opening in Excel with the headers from rule 2. Phase 0.4.0.
7. Nightly export: loadout-worker writes the same CSVs to a company Google
   Drive folder ("Loadout backups", dated subfolders, 90-day retention) through
   a service account. Phase 0.6.0, with the worker. Until then, Export
   everything by hand on Fridays is SOP-10's last step.
8. Reports read the live collections, never a hidden copy.
9. One-for-one SQL mapping: every collection is a table, every field a
   column, every subcollection a table with a parent id. A move to Postgres
   is a copy script, not a rewrite.

**Fixture.** `samples/Unassigned Inventory.xlsx` (ignored, section 17) is
the readability test: the import of it must produce documents a person can
read in the console and a CSV export that round-trips to the same sheet.

**Firestore vs Postgres, for the record.** Firestore: shared sign-in, offline
persistence built in, listeners for the wall board, free tier covers a
five-person shop, console shows one document at a time. Supabase Postgres:
grid view per table, SQL joins for reports, its own auth, no built-in
offline, free tier pauses after a week idle so Pro is the realistic tier.
Settled 2026-10-29 (D15): Firestore with rules 1-9.

## 17. Importing the current inventory sheet

The shop already keeps inventory in a workbook, `Unassigned Inventory.xlsx`
(in `samples/`, never committed). It is the day-one seed and the first real
test of the import mapping. Read on 2026-10-29; what it holds:

| Tab | Rows | What it is | Columns |
|---|---|---|---|
| Patch Cables | 171 | Made-up cables by type and attributes; 31 types (power, stereo audio, Cat6 patch, HDMI, fiber, USB, A/V...) | Type, Make, Part Number, Connector 1, Connector 2, Color, Diameter + Unit of Measure (gauge), Amps, Length + Unit of Measure 2, QTY, Area, Shelf, Last Date |
| Splitters | 15 | Coax, RCA, and 3.5 mm splitters | Type, Make, Part Number, Connector 1, Number of Inputs, Connector 2, Number of outputs, QTY, Area, Shelf, Last Date |
| Devices | 47 | Network, surveillance, speakers, control, racks | Type, Make, Part Number, Description, Color, Condition, QTY, Area, Shelf, Count Date |
| Connectors | 9 | XLR and banana | Type, Make, Part Number, Sex, Band, Pin, QTY, Area, Shelf, Last Date |
| Boxed Cable | 53 | Wire boxes by box code | Box, Type, Wire Type, Color, Purchase Date, QTY (feet left), As of Date, Location |
| Carrier OnhandPricing | 33 | Cable type x color grid with three vendor price columns, almost empty | Type, Grade, Color, Length, and one column per vendor |
| Cable Guide | 5 | Cable type and grade list | Type, Grade |

What the sheet taught the plan (changes already made above):

1. **Most cables and connectors have no make or part number** (143 of 171
   patch cables, 6 of 15 splitters, 6 of 9 connectors). A catalog keyed on
   brand + model cannot hold them. Products now have a `kind`, the sheet's
   `type`, and flat attribute fields; the id and display name compose from
   those when brand and model are blank (section 3).
2. **Locations are two-level**: an Area (Storage room, Computer Room
   Shelving Rack, Computer Room Cabinet, Warehouse, Garage) and a Shelf
   (RCA A/V Video, Power cables, HDMI, USB cables, Patch cables, A, B, C).
   Locations now carry `area` and `shelf` with a composed name.
3. **Wire boxes already have codes** (A826, B626, AA, BB: a letter plus, on
   newer boxes, month and year of purchase). The code becomes the
   container's id and label and goes on the QR sticker; new boxes continue
   the scheme. Feet left is the sheet's QTY; the last reading date is As of
   Date; Purchase Date is kept. Fifteen boxes read zero and two say
   "completed": those import as empty. Thirteen boxes have feet left but no
   location: they import with a "confirm location" flag that the Stock view
   shows until someone scans them onto a shelf.
4. **Every row has a count date** (Last Date, Count Date, As of Date). The
   import writes one `adjust` movement per row, dated from that column, by
   "Import", note "Unassigned Inventory.xlsx, tab X row N", and sets
   `lastCountAt`. The audit trail starts from the sheet, not from nothing.
5. **Condition exists on devices** (new, new in box, used) and maps to the
   item condition field; devices with a condition or a cost above the
   threshold become serialized items at import, one per unit of QTY.
6. **The vendor columns** on the pricing tab seed the vendor list in
   Settings. The prices themselves are empty and are not imported.
7. **Zero-quantity rows stay** as products with on-hand 0, so the catalog
   remembers what the shop stocks.

Normalization the importer applies, shown in the preview before anything is
written:

- Trim, collapse spaces, and fold case on Area, Shelf, Type, Color, units
  ("Storage room" and "storage Room" are one shelf; "grey" and "gray" are
  one color; "foot", "Foot", "feet" are `ft`).
- Make aliases from a small table the user confirms in the preview
  ("Ubiquity" and "Unifi" to "Ubiquiti"); unknown makes pass through as
  typed.
- Part numbers that Excel stored as numbers (13 devices, 5 cables) become
  text without the trailing ".0".
- "N/A" and blanks become empty fields, never the string "N/A".
- Length + unit become `length` and `lengthUnit`; Diameter + Unit of Measure
  become `gauge` and `gaugeUnit`.
- Boxed Cable: Type + Wire Type + Color + grade (from the Cable Guide tab
  when the type names one) compose the wire product; one container per row.

The importer lives at More > Import inventory sheet (admin only), built in
0.1.0: drop the .xlsx (SheetJS reads it in the browser), pick the tab-to-kind
mapping (prefilled for these seven tabs), review a dry-run report (products
to create, shelves to create, boxes, items, rows skipped and why, the alias
table), then Import. Re-running it on a newer copy of the sheet updates
counts and adds new rows; it never duplicates, because the ids are
deterministic (section 3). The same screen takes a plain CSV with the same
columns for later bulk edits.

Open: D16 (start length per box) and D17 (assigned inventory).
