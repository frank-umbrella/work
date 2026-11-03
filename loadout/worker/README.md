# loadout-worker

Cloudflare Worker for Loadout (`work/loadout`). It does two jobs:

1. **Zapier intake (PLAN section 6, T1).** When a Portal proposal is
   accepted, a Zap posts the proposal to the worker. The worker writes the
   proposal, a pick ticket, and its lines into Firestore exactly as the app's
   **New ticket > Import a Portal CSV** would, so the ticket is waiting in
   Loadout before anyone opens Portal.
2. **Nightly export (PLAN section 16 rule 7).** Every day at 09:00 UTC it
   writes one CSV per collection to the project's Firebase Storage bucket,
   under `loadout/backups/2026-11-02/`, and deletes days older than 90. The
   app lists them under Console > Backups.

The Portal API intake (T2) is a stub until PLAN D1 is answered; see
"T2 boundary" below.

Version: **0.2.0**. Worker URL once deployed:
`https://loadout-worker.umbrelladev.workers.dev`.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /health` | Version, which intakes are configured (`csv`, `zapier`, `portalApi`), and under `export`: `configured` (the service account secret exists), `bucket` (`STORAGE_BUCKET`), and the last export time, day folder, and error, read from `loadout_settings/worker`. |
| `POST /zapier/proposal` | Needs header `X-Loadout-Secret` equal to `ZAPIER_SHARED_SECRET`. Body is the Portal "Update Proposal Status" payload. Only status `Accepted` does anything; any other status answers 200 with `ignored: true` so the Zap does not show an error. |
| `POST /portal/webhook` | Always 501 for now: "Portal API intake is not configured (needs the Unlimited plan and PORTAL_* secrets)", or "not built yet" once the secrets exist. |
| cron `0 9 * * *` | The nightly export to `loadout/backups/YYYY-MM-DD/` in `STORAGE_BUCKET`. Skips quietly while `FIREBASE_SERVICE_ACCOUNT` is not set. |

## What an accepted proposal writes

All ids are the app's own (PLAN sections 3, 5, and 17), so a ticket from
Zapier and a ticket from the CSV for the same proposal are the same
document. A later CSV import of that proposal, or a replayed Zap, adds or
adjusts lines; it never makes a second ticket.

| Document | Id | Notes |
| --- | --- | --- |
| `loadout_proposals` | Portal proposal number (`1077`) | `importSource: "zapier"`, `status: "Accepted"`, `portalId` (Portal's internal id), names of the client and job. Merged, so fields the app wrote stay. |
| `loadout_tickets` | Portal proposal number | New: `status: "open"`, `needsReview: true` (the "Imported from Portal, review" flag), `source: "zapier"`, `createdBy: "Zapier"`, the summary counts. Existing: status and summary recomputed from the lines, `needsReview: true`. |
| `loadout_tickets/{n}/lines` | `{area slug}--{brand-model slug}` (`front-office--ubiquiti-u6-pro`) | One line per product per area; two Portal items for the same product in one area add together. New lines are added, a changed quantity updates `qtyNeeded` and `qtyToOrder`, unchanged lines are left alone, lines no longer on the proposal stay as they are (same as the app). |
| `loadout_products` | Brand-model slug (`ubiquiti-u6-pro`) | Only for a brand and model the catalog does not have. Matching is brand + model, case and spacing ignored, then the slug id. Created as kind `device`, unit `each`, on hand 0. |
| `loadout_clients` | Slug of the company name, or the person's name | Only when no client has this Portal customer id (`portalContactId`) and none has that slug. |
| `loadout_jobs` | `{client id}--{slug of the proposal name}` | Only when it does not exist. Address from the Portal customer's location. |
| `loadout_movements` | `zapier-{ticket}-{hash of the change}` | One `edit` movement, by "Zapier", noting what was created or changed and which items were skipped. |

What is skipped, and listed in the response and the movement note:

- Items typed `Labor`, `Fee`, or `CustomItem`.
- Items with no brand, model, or description, and items with a quantity of
  zero or blank.
- Declined options. When an area has an Accepted option, its other options
  (alternatives the client did not take) are skipped too. An area whose only
  option is still Draft is imported, since Portal leaves the default option
  in Draft on many accepted proposals.

Nested items (a `parentId`) take their parent's area. Portal sends no unit
of measure, so every line is `each` until it matches a catalog product sold
by the foot.

Replays are safe: when every line already matches, nothing is written and
the response says `unchanged: true`. A new ticket is written with a
"must not exist" precondition, so two copies of the same Zap arriving at
once cannot both create it; the loser re-reads and finds nothing to change.

## Secrets

Set with `wrangler secret put <NAME>`. Never put them in `wrangler.toml`,
in this repo, or in a chat.

| Name | What it is |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | The JSON key of the `loadout-worker` service account on `watchtower-6fbe1`, with the roles Cloud Datastore User and Storage Object Admin. The same key writes the export to Storage. |
| `ZAPIER_SHARED_SECRET` | A long random string. The Zap sends it in the `X-Loadout-Secret` header. |
| `PORTAL_APP_ID`, `PORTAL_USER_KEY`, `PORTAL_BASE_URL` | T2 only. Leave unset until the shop is on Portal's Unlimited plan with an approved API application. |

Vars in `wrangler.toml` (not secret): `FIREBASE_PROJECT_ID =
"watchtower-6fbe1"` and `STORAGE_BUCKET =
"watchtower-6fbe1.firebasestorage.app"` (the app's `storageBucket`).

## Firestore and Storage rules

Firestore: no change. The worker writes through the service account, which
bypasses security rules, the same as watchtower-worker. The Loadout block in
`watchtower/firestore.rules` stays as it is.

Storage: the service account skips the rules too, so the worker needs none.
The app's Backups tab reads the files as the signed-in person, so
`watchtower/storage.rules` gained `loadoutReader()` (admin and accounting)
and `match /loadout/backups/{day}/{file}` with read for those two and write
for nobody, plus a list-only match on the day level (Loadout 0.6.1; the
block is copied in `../README.md`).

## Owner setup

Done once, by the owner, in this order.

1. **Service account.** In the Google Cloud console for project
   `watchtower-6fbe1`: IAM and Admin > Service Accounts > Create service
   account, name it `loadout-worker`, give it the role **Cloud Datastore
   User**. Open it > Keys > Add key > JSON. A JSON file downloads; keep it
   out of this folder (the `.gitignore` catches the usual names anyway).
2. **Storage role.** IAM and Admin > IAM > edit the principal
   `loadout-worker@watchtower-6fbe1.iam.gserviceaccount.com` > Add another
   role > **Storage Object Admin** > Save, so it sits beside Cloud Datastore
   User. It lets the worker write, list, and delete the backup files.
   Storage itself must be on for the project (Firebase console > Storage),
   which it already is once product photos work.
3. **Shared secret.** Make one in PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

   Keep it for steps 4 and 6.
4. **Secrets and deploy**, from PowerShell (the `cf umbrella` helper loads
   the umbrella account's Cloudflare token; `account_id` in `wrangler.toml`
   also pins it):

   ```powershell
   cd T:\ClaudeCodeRepo\work\loadout\worker
   npm install
   cf umbrella
   wrangler secret put FIREBASE_SERVICE_ACCOUNT   # paste the whole JSON key
   wrangler secret put ZAPIER_SHARED_SECRET       # paste the string from step 3
   wrangler deploy
   ```

5. **Check it.** Open
   `https://loadout-worker.umbrelladev.workers.dev/health`. `intakes.zapier`
   should be `true`, `export.configured` `true`, and `export.bucket`
   `watchtower-6fbe1.firebasestorage.app`. Deploy the Storage rules as well
   (`../README.md`, Storage rules), so the Console's Backups tab can list
   the files.
6. **The Zap.** In Zapier (Portal needs the Premium plan and the
   Integrations add-on for its Zapier triggers):
   - Trigger: **Portal > Update Proposal Status**.
   - Filter: only continue if Status exactly matches `Accepted`.
   - Action: **Webhooks by Zapier > POST**.
     - URL: `https://loadout-worker.umbrelladev.workers.dev/zapier/proposal`
     - Payload Type: `json`
     - Data: leave empty, so Zapier sends the raw trigger payload with its
       areas, options, and items intact. Filling in fields one by one
       flattens the item lists.
     - Wrap Request In Array: No (the worker accepts either).
     - Headers: `X-Loadout-Secret` = the string from step 3.
   - Test the action on an accepted proposal. The response lists the ticket
     id, how many lines were new or changed, and every skipped item.

## Trying it with the fixture

`test/fixtures/zapier-proposal-accepted.json` is a made-up proposal in the
documented payload shape (proposal 1077, three areas, seven lines, four
items and two options skipped). Posting it to the deployed worker writes
real documents, so do it only when you mean to, and delete ticket 1077, its
lines, proposal 1077, client `example-dental-group`, and its job afterwards:

```powershell
curl.exe -X POST https://loadout-worker.umbrelladev.workers.dev/zapier/proposal `
  -H "Content-Type: application/json" `
  -H "X-Loadout-Secret: <the shared secret>" `
  --data-binary "@test/fixtures/zapier-proposal-accepted.json"
```

A second identical post answers `unchanged: true` and writes nothing.

## Nightly export

Where the files live: the project's Firebase Storage bucket
(`STORAGE_BUCKET`, `watchtower-6fbe1.firebasestorage.app`, the same bucket
as the product photos), one folder per night,
`loadout/backups/2026-11-02/loadout_products.csv` and so on, content type
`text/csv; charset=UTF-8`. The day is the UTC date of the run. In the app,
Console > Backups lists the days newest first; a day opens in place to its
files with their sizes and Download links. The Storage rule lets admin and
accounting read and list them and nobody write them from the app; only the
worker, through its service account, writes and deletes.

Files, one per collection, named as the app's Console export names them:
`loadout_products.csv`, `loadout_locations.csv`, `loadout_stock.csv`,
`loadout_containers.csv`, `loadout_items.csv`, `loadout_movements.csv`,
`loadout_users.csv`, `loadout_settings.csv`, `loadout_clients.csv`,
`loadout_jobs.csv`, `loadout_proposals.csv`, `loadout_tickets.csv`,
`loadout_ticket_lines.csv` (columns `id`, then `ticketId`),
`loadout_orders.csv`, `loadout_order_lines.csv` (columns `id`, then
`orderId`),
`loadout_shipments.csv`, `loadout_shipments_status.csv`,
`loadout_shipments_lines.csv`.

A shipment's two lists get their own files, the same as the app's Export
everything since 0.5.2, so no file holds JSON text:

- `loadout_shipments_status.csv`: one row per entry in `statusLog`, oldest
  first. Columns `shipmentId`, `orderNumber`, `tracking`, `seq`, `status`,
  `statusLabel` (the app's words, "Delivered to site" for a client-site
  package), `at`, `by`, `byName`, `note`.
- `loadout_shipments_lines.csv`: one row per entry in `lines`. Columns
  `shipmentId`, `orderId`, `orderNumber`, `tracking`, `orderLineId`,
  `productName`, `qty`, `qtyReceived`.
- `loadout_shipments.csv` leaves out `statusLog` and `lines`.

Each has a UTF-8 byte-order mark so Excel reads it right, field names as
headers, maps as dotted columns (`summary.lines`), lists joined with `; `,
and times as `YYYY-MM-DD HH:MM` in UTC. Any other list of objects prints
each object's plain values joined with `/`, the same rule as the app, so a
ticket line's `orderLineRefs` reads `7701/l1; 7702/l3` (orderId/orderLineId). A rerun on the same day writes the
same object names, so it replaces that day's files instead of adding
copies. Days older than 90 (by the folder's date, not the files' times) are
deleted for good: Storage has no trash, and the 90 newer days are the
safety net. The delete goes through Storage's batch endpoint, one request
for a whole day's files, to stay inside the subrequest budget (see
Troubleshooting).

After each run the worker writes `loadout_settings/worker`:
`lastExportAt`, `lastExportFolder` (the day, `2026-11-02`),
`lastExportBucket`, `lastExportPrefix` (`loadout/backups/2026-11-02/`),
`lastExportFiles`, `lastExportRows`, `lastExportPruned` (the days deleted),
and `lastExportError` (null on success). A failed run writes only
`lastExportError` and `lastExportErrorAt`. `/health` shows the time, day,
and error; Console > Backups shows the same as its status line.

## T2 boundary

Everything for the Portal API lives in `src/portal.js` and is not built.
`POST /portal/webhook` answers 501 whatever is configured. The file lists
what T2 needs: the three `PORTAL_*` secrets, the request signing headers
`X-MSS-API-APPID`, `X-MSS-API-USERKEY`, `X-MSS-CUSTOM-DATE`, and
`X-MSS-SIGNATURE`, the `proposal.status_changed` event, and the internal
notes write-back. When it is built it reuses `parseProposal()` and
`buildImport()` from `src/zapier.js`, so the ids stay the same on every
path. Build it only after D1 confirms the Unlimited plan and Portal has
approved the API application.

## Troubleshooting

- **403 on upload** (`does not have storage.objects.create access`). The
  service account is missing the Storage Object Admin role (setup step 2).
- **404 on the bucket** (`The specified bucket does not exist`).
  `STORAGE_BUCKET` in `wrangler.toml` does not match the bucket name in the
  Firebase console (Storage, the `gs://` name at the top of the Files tab).
- **The Backups tab says the rules do not allow your role.** The Storage
  rules with `loadoutReader()` are not deployed yet (`../README.md`).
- **"Too many subrequests".** The Workers free plan allows 50 outbound calls
  per run. A normal night makes 36: one token, 15 Firestore reads (one per
  collection per 1,000 documents), 18 uploads, one list of the days, and one
  status write. A night that prunes a day adds two (its file list and one
  batch delete), so 38. When movements pass a few thousand, the umbrella
  account needs the Workers Paid plan.
- **Firestore asks for an index on `lines`.** The export reads ticket and
  order lines with one collection-group query ordered by document name. If
  Firestore answers with an index link, open it and create the index.
- **A Zap run shows 422.** The proposal had no product lines after skipping
  Labor, Fee, and CustomItem items; the response lists what was skipped.

## Development

```powershell
npm install
npm test                                  # node --test, no network
npx wrangler deploy --dry-run --outdir dist   # builds without deploying
```

Tests cover the CSV writer (including the two shipment files and the
`orderLineRefs` column), the Firestore value codec, the Zapier parser on
the fixture, id and name composition against the app's rules, replays and
change orders over existing lines, retention date math, the Storage object
names, day parsing, prune selection, name encoding, and the batch delete
request and response (`test/storage.test.js`), and the routes that answer
before touching Firestore.

## Changelog

### 0.2.0 (2026-11-03)

The nightly export now writes to the project's own Firebase Storage bucket
instead of Google Drive. The shop's Workspace cannot create a Shared Drive,
and a service account cannot upload into a folder in a person's My Drive
(`storageQuotaExceeded`), so the Drive plan had no folder that would work.
The bucket already holds the product photos, the same service account
reaches it with one more IAM role (Storage Object Admin), and the app lists
the files under Console > Backups (Loadout 0.6.1), so nobody needs a Drive
folder or a shared link to find last night's copy. Same 18 files, same 90
days; a rerun overwrites that day's files. Old days are deleted with one
batch request each, so a night that prunes still fits the free plan's 50
subrequests. `DRIVE_FOLDER_ID` and `DRIVE_SCOPE` are gone and
`STORAGE_BUCKET` replaces them; the export runs as soon as the service
account secret is set. Still not deployed.

### 0.1.1 (2026-11-02)

The nightly files now match the app's Export everything (Loadout 0.5.2)
column for column, so a nightly copy and a hand export open the same way in
Excel and can be compared or swapped. A shipment's status history and its
lines come as their own files (`loadout_shipments_status.csv`,
`loadout_shipments_lines.csv`), one row each with the shipment id first,
instead of JSON text in one cell. Other lists of objects, like a ticket
line's `orderLineRefs`, read as `orderId/orderLineId`. Ticket and order
line files start with `id`, then the ticket or order id, as the app's do.
Still not deployed.

### 0.1.0 (2026-10-29)

First build. Accepted Portal proposals can now reach Loadout through Zapier
on their own, so the warehouse sees the pick ticket without waiting for
someone to download and import the CSV. The nightly export puts a dated copy
of every collection in Drive, which replaces the Friday hand export in
SOP-10 once it is running. The Portal API route is a stub that answers 501,
so the T2 path has a fixed place to land once the Unlimited plan is
confirmed. Not deployed yet; the owner setup above comes first.
