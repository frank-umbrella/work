# watchtower-worker

Cloudflare Worker that receives daily check-ins from watchtower agents
running on client PCs. Validates the shared install token, writes status
+ history to Firestore via a service account, and fires Resend email +
optional webhook POST when an agent's external IP changes.

Single endpoint:

```
POST /checkin
Authorization: Bearer <WATCHTOWER_INSTALL_TOKEN>
{
  "pcId": "<stable uuid generated at install>",
  "agentVersion": "0.1.0",
  "hostname": "OPFD-SERVER",
  "client": "OPFD",
  "ts": "2026-05-22T07:33:21Z",
  "report": { ...Belarc-lite fields... }
}
```

Plus `GET /healthz` for liveness.

## Deploy

```powershell
# One-time setup
npm install
wrangler login

# Set secrets (each prompts for the value)
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste the full service-account JSON
wrangler secret put RESEND_API_KEY                  # paste your Resend API key
wrangler secret put WATCHTOWER_INSTALL_TOKEN        # paste a 32-byte random base64 string

# Deploy
wrangler deploy
```

Worker URL: `https://watchtower-worker.umbrelladev.workers.dev`

## Install tokens

Per-client tokens are generated in the dashboard's Clients tab and
stored as `/install_tokens/{sha256(rawToken)}` documents in Firestore.
The agent presents its token on every `/checkin`; the worker SHA-256s
the presented value and looks up the doc to confirm validity + binding.
See `src/index.js` `validateToken()`.

The legacy `WATCHTOWER_INSTALL_TOKEN` env var is still honored as a
single shared-secret fallback &mdash; useful as an emergency backdoor
if Firestore is unreachable, or for one-off testing. Leave it unset in
steady-state production once all installs are on per-client tokens.
