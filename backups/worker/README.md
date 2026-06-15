# backups-worker

Cloudflare Worker that emails an **end-of-day digest** of Backup Audit changes.

Once a day (cron `0 23 * * *`, ~6pm US Eastern) it reads every change
logged to `/backup_activity` in the last 24 hours from Firestore and sends a
single rollup email to `DIGEST_TO` (default `frank@umbrellaautomation.com`).

It shares everything with **watchtower-worker**:

- the **same Firebase project** (`watchtower-6fbe1`) — so it reads the audit
  activity the dashboard writes,
- the **same service-account** credentials (Firestore admin reads bypass
  security rules),
- the **same Resend** account and verified sending domain
  (`alerts.umbrellaautomation.com`).

## Deploy

This worker lives on the **Umbrella MSP** Cloudflare account
(`account_id` is pinned in `wrangler.toml`, same as watchtower-worker).

```sh
cd work/backups/worker
npm install

# Secrets — reuse the SAME values already set on watchtower-worker:
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # service-account JSON for watchtower-6fbe1
wrangler secret put RESEND_API_KEY                  # Resend API key
wrangler secret put DIGEST_TRIGGER_KEY              # optional: any random string, enables manual POST /run

wrangler deploy
```

> The repo's PowerShell `wrangler` wrapper auto-loads the umbrella Cloudflare
> token from `T:\.cloudflare-tokens\umbrella.token` based on the pinned
> `account_id`. Type bare `wrangler deploy` (not `npx wrangler`).

## Manual test

With `DIGEST_TRIGGER_KEY` set, fire the digest on demand:

```sh
curl -X POST "https://backups-worker.umbrelladev.workers.dev/run?key=YOUR_KEY"
```

Returns `{ sent: true, count: N }`, or `{ sent: false, reason: "no activity" }`
when nothing changed in the last 24 hours (no email is sent in that case).

## Endpoints

| Method | Path           | Purpose                                            |
|--------|----------------|----------------------------------------------------|
| GET    | `/` `/health`  | Health check.                                      |
| POST   | `/run?key=...` | Run the digest now (requires `DIGEST_TRIGGER_KEY`).|
