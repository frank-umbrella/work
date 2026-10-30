# loadout-worker

Cloudflare Worker for Loadout (`work/loadout`). It does two jobs:

1. **Zapier intake (PLAN section 6, T1).** When a Portal proposal is
   accepted, a Zap posts the proposal to the worker. The worker writes the
   proposal, a pick ticket, and its lines into Firestore exactly as the app's
   **New ticket > Import a Portal CSV** would, so the ticket is waiting in
   Loadout before anyone opens Portal.
2. **Nightly export (PLAN section 16 rule 7).** Every day at 09:00 UTC it
   writes one CSV per collection to a Google Drive folder, in a dated
   subfolder (`2026-10-29`), and moves subfolders older than 90 days to the
   Drive trash.

The Portal API intake (T2) is a stub until PLAN D1 is answered; see
"T2 boundary" below.

Version: **0.1.0**. Worker URL once deployed:
`https://loadout-worker.umbrelladev.workers.dev`.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /health` | Version, which intakes are configured (`csv`, `zapier`, `portalApi`), and the last export time, folder, and error, read from `loadout_settings/worker`. |
| `POST /zapier/proposal` | Needs header `X-Loadout-Secret` equal to `ZAPIER_SHARED_SECRET`. Body is the Portal "Update Proposal Status" payload. Only status `Accepted` does anything; any other status answers 200 with `ignored: true` so the Zap does not show an error. |
| `POST /portal/webhook` | Always 501 for now: "Portal API intake is not configured (needs the Unlimited plan and PORTAL_* secrets)", or "not built yet" once the secrets exist. |
| cron `0 9 * * *` | The nightly export. Skips quietly while `DRIVE_FOLDER_ID` is empty. |

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
| `FIREBASE_SERVICE_ACCOUNT` | The JSON key of a service account on `watchtower-6fbe1` with the Cloud Datastore User role. The same key calls the Drive API for the export. |
| `ZAPIER_SHARED_SECRET` | A long random string. The Zap sends it in the `X-Loadout-Secret` header. |
| `PORTAL_APP_ID`, `PORTAL_USER_KEY`, `PORTAL_BASE_URL` | T2 only. Leave unset until the shop is on Portal's Unlimited plan with an approved API application. |

Vars in `wrangler.toml` (not secret): `FIREBASE_PROJECT_ID =
"watchtower-6fbe1"` and `DRIVE_FOLDER_ID` (empty until the owner fills it).
Optional: `DRIVE_SCOPE`, see Troubleshooting.

## Firestore rules

No change. The worker writes through the service account, which bypasses
security rules, the same as watchtower-worker. The Loadout block in
`watchtower/firestore.rules` stays as it is.

## Owner setup

Done once, by the owner, in this order.

1. **Service account.** In the Google Cloud console for project
   `watchtower-6fbe1`: IAM and Admin > Service Accounts > Create service
   account, name it `loadout-worker`, give it the role **Cloud Datastore
   User**. Open it > Keys > Add key > JSON. A JSON file downloads; keep it
   out of this folder (the `.gitignore` catches the usual names anyway).
2. **Drive API.** In the same project: APIs and Services > Library > Google
   Drive API > Enable.
3. **Backup folder.** Create a folder named **Loadout backups** on a
   **Shared Drive** and add the service account's email (it ends in
   `@watchtower-6fbe1.iam.gserviceaccount.com`) as **Content manager**, or as
   Editor if the folder sits in a Shared Drive that already allows it. A
   folder in someone's My Drive does not work: a service account has no Drive
   storage of its own, so uploads there fail with `storageQuotaExceeded`.
4. **Folder id.** Open the folder; the id is the part of the address after
   `/folders/`. Put it in `wrangler.toml` as `DRIVE_FOLDER_ID = "..."`.
5. **Shared secret.** Make one in PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
   ```

   Keep it for steps 6 and 8.
6. **Secrets and deploy**, from PowerShell (the `cf umbrella` helper loads
   the umbrella account's Cloudflare token; `account_id` in `wrangler.toml`
   also pins it):

   ```powershell
   cd T:\ClaudeCodeRepo\work\loadout\worker
   npm install
   cf umbrella
   wrangler secret put FIREBASE_SERVICE_ACCOUNT   # paste the whole JSON key
   wrangler secret put ZAPIER_SHARED_SECRET       # paste the string from step 5
   wrangler deploy
   ```

7. **Check it.** Open
   `https://loadout-worker.umbrelladev.workers.dev/health`. `intakes.zapier`
   should be `true` and `export.configured` `true`.
8. **The Zap.** In Zapier (Portal needs the Premium plan and the
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
     - Headers: `X-Loadout-Secret` = the string from step 5.
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

Files, one per collection, named as the app's Console export names them:
`loadout_products.csv`, `loadout_locations.csv`, `loadout_stock.csv`,
`loadout_containers.csv`, `loadout_items.csv`, `loadout_movements.csv`,
`loadout_users.csv`, `loadout_settings.csv`, `loadout_clients.csv`,
`loadout_jobs.csv`, `loadout_proposals.csv`, `loadout_tickets.csv`,
`loadout_ticket_lines.csv` (first column `ticketId`),
`loadout_orders.csv`, `loadout_order_lines.csv` (first column `orderId`),
`loadout_shipments.csv`.

Each has a UTF-8 byte-order mark so Excel reads it right, field names as
headers, maps as dotted columns (`summary.lines`), lists joined with `; `,
and times as `YYYY-MM-DD HH:MM` in UTC. A rerun on the same day replaces the
files in that day's folder instead of adding copies. Pruned folders go to
the Shared Drive's trash, which empties itself after 30 days.

After each run the worker writes `loadout_settings/worker`:
`lastExportAt`, `lastExportFolder`, `lastExportFolderId`,
`lastExportFiles`, `lastExportRows`, `lastExportPruned`, and
`lastExportError` (null on success). `/health` shows the time, folder, and
error.

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

- **Drive answers 404 for the backup folder.** The `drive.file` scope only
  reaches files the service account created or was given through an app,
  and some Workspace setups do not count a shared folder. Add
  `DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"` under `[vars]` in
  `wrangler.toml` and deploy again.
- **`storageQuotaExceeded`.** The folder is in a My Drive. Move it to a
  Shared Drive (setup step 3).
- **"Too many subrequests".** The Workers free plan allows 50 outbound calls
  per run. The export makes about 40 (one token, one read per collection
  per 1,000 documents, three folder calls, 16 uploads, one prune per old
  folder, one status write). When movements pass a few thousand, the umbrella
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

Tests cover the CSV writer, the Firestore value codec, the Zapier parser on
the fixture, id and name composition against the app's rules, replays and
change orders over existing lines, retention date math, and the routes that
answer before touching Firestore.

## Changelog

### 0.1.0 (2026-10-29)

First build. Accepted Portal proposals can now reach Loadout through Zapier
on their own, so the warehouse sees the pick ticket without waiting for
someone to download and import the CSV. The nightly export puts a dated copy
of every collection in Drive, which replaces the Friday hand export in
SOP-10 once it is running. Not deployed yet; the owner setup above comes
first.
