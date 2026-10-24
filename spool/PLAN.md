# Spool - office inventory, pick tickets, and product tracking

Plan v0.1 - 2026-10-23 by Fable 5.1 (design/plan pass). Nothing here is built
yet. Implementation is a later Opus job once the decisions in section 13 are
answered. Open the design switcher at
`file:///T:/ClaudeCodeRepo/work/spool/design-preview.html`.

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
warehouse is one warehouse.

Four things it tracks, in a fixed hierarchy:

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
  replenishment). Shipments carry carrier + tracking and can be partial.

Every change writes a **movement** (receive, pick, stage, deliver, adjust,
reading, return, transfer) so a count can always be explained.

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
| Labels | Printable QR labels for bins, staging bays, and containers | A spool with a QR sticker takes a feet-left reading in two taps. Inline QR generator, no CDN. |
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

/spool_locations/{locationId}
  name ("Rack A3", "Bay 2", "Van 1"), kind ("shelf"|"bay"|"van"|"other")
  jobId (string|null)                  set while a bay is reserved for a job
  qr              string               payload printed on the label

/spool_stock/{productId_locationId}    one doc per product per location
  productId, locationId, qty           qty in the product's unit

/spool_containers/{containerId}        only for unit == "ft" products
  productId, locationId
  label ("Cat6 blue box 3"), startLength (1000), ftLeft (640)
  status ("open"|"empty"|"assigned"), pickTicketId (string|null)
  qr, createdAt, lastReadingAt

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
  type        "receive"|"pick"|"stage"|"deliver"|"adjust"|"reading"|"return"|"transfer"
  productId, containerId (null), qty, fromLocationId, toLocationId
  ticketId, ticketLineId, orderId, shipmentId   whichever apply
  by (email), at (Timestamp), note

/spool_settings/{key}
  "general"   {showCosts, carriers: {UPS: urlPattern, ...}, labelSize}
  "portal"    {tier: "t0"|"t1"|"t2", lastPollAt}   no secrets here
  "importMap" {header -> field} saved CSV column mapping
```

Rules to add to `watchtower/firestore.rules` (shared file, deployed with
Watchtower's `firebase.json`, work account `frank@umbrellaautomation.com`):

```
match /spool_movements/{id} {
  allow read, create: if isMSPAdmin();
  allow update, delete: if false;          // audit trail is append-only
}
match /{coll}/{docId} {
  allow read, write: if isMSPAdmin() && coll.matches('spool_.*');
  match /{sub=**} { allow read, write: if isMSPAdmin() && coll.matches('spool_.*'); }
}
```

(Firestore evaluates the specific `spool_movements` match first; the wildcard
match must not grant anything to non-spool collections, hence the prefix check.
Verify in the rules playground before deploying.)

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

### Scan (phone)
- Full-screen camera with a scan box. Decoded UPC looks up the product.
  - Known product: shows name, on-hand by location, and three buttons:
    **Receive**, **Pick for ticket**, **Count**.
  - Unknown UPC: "New product" form with brand/model prefilled from the last
    import line that has no UPC yet (one-tap link) or blank.
  - Location or bay QR: switches the active location (shows as a chip).
  - Container QR (a wire box): opens the **Feet-left reading** sheet: big
    number field, quick buttons -50 / -100 / -250 / Empty, optional ticket.
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

### More
- Settings (show costs, carriers, label size, Portal tier and status).
- Clients and Jobs management (small tables; most clients arrive by import).
- Movements log (everything, filterable), export CSV.
- Labels: pick locations/containers, print a sheet.
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

## 7. Feet-left consumables

- A `ft` product has containers. **Receive** a box creates a container with
  `startLength` (1000 by default for Cat5e/Cat6 boxes, editable) and prints a
  label if you want one.
- **Reading** is a movement of type `reading` that sets `ftLeft` to what you
  typed; the delta is recorded. A reading replaces the estimate the picks
  built up.
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

## 9. Offline

- `sw.js` precaches the app shell; Firestore `persistentLocalCache` holds
  data; every write goes local first. Scanning and counting in a dead corner
  of the warehouse must work; the sync pill shows pending writes.
- The camera does not need the network. Lazy-loaded zxing is in the precache
  list so the iOS fallback also works offline.

## 10. Labels and QR

- Payloads: `spool:loc:{locationId}`, `spool:ctr:{containerId}`,
  `spool:prod:{productId}`. The Scan view routes on the prefix; a plain UPC
  routes to the product lookup.
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
| 0.1.0 | Shell, sign-in, Firestore rules, Stock view, product CRUD, locations, movements, Scan with UPC lookup and receive/count, feet-left containers. The warehouse can be counted. |
| 0.2.0 | Clients, jobs, proposals, CSV import with header mapping, pick tickets with lines, pull-from-stock, stage, deliver, close, print, Copy for Portal (T0). |
| 0.3.0 | Orders, lines, shipments, tracking detection, receive-by-shipment into bays, chips on ticket lines, low-stock reorder into draft POs. |
| 0.4.0 | Offline (sw.js + persistent cache + sync pill), PWA manifest, QR labels and label sheets, container QR routing. |
| 0.5.0 | spool-worker: T1 Zapier intake (if Premium) or T2 API intake and note push (if Unlimited and approved). Settings shows the tier and last sync. |
| 0.6.0 | Reports: stock value (costs on), movements export, per-client product delivered, aging open tickets. Photos on products. |

Each version is a release: bump the version everywhere, README changelog entry
with the why, small commits.

## 13. Still open (answer before the build)

- **D1 Portal plan.** Which plan is Umbrella on (Lite / Pro / Premium /
  Unlimited), and is the Integrations add-on active? Decides whether 0.5.0 is
  Zapier, API, or skipped.
- **D2 Who uses it.** How many people, and are any read-only? The default is
  everyone on the domain can do everything, with the movements log showing who
  did what.
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

## 14. Files

- `work/spool/PLAN.md` - this file.
- `work/spool/design-preview.html` - switcher with three directions, four
  views each (Ticket detail, Stock/Consumables, Orders, Scan on phone).
- `work/spool/anti-slop/audit-001-2026-10-23.md` - antislop audit of the
  switcher and this plan, with the follow-up record of what was fixed.
- Later: `index.html`, `sw.js`, `manifest.json`, `og-image.png`, icons,
  `README.md`; rules block in `watchtower/firestore.rules`;
  `spool-worker/` for T1/T2.
