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

Worker URL: `https://watchtower-worker.sevendwarfs.workers.dev`

## Generating the install token

The install token is the shared secret that the installer bakes into
every deployed agent. Generate it once and reuse it across all
installations (until you decide to rotate):

```powershell
# In PowerShell:
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Set it as both `WATCHTOWER_INSTALL_TOKEN` (here in Cloudflare) and
`-InstallToken <value>` when building the installer (see
`work/watchtower/installer/build.ps1`).
