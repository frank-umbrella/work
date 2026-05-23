// watchtower-worker — Cloudflare Worker that receives check-ins from
// watchtower agents (Windows services running on client PCs), writes
// status + history to Firestore via service-account JWT, and fires
// Resend email + optional webhook POST when the external IP changes.
//
// Agent → Worker auth: Authorization: Bearer <install token>.
//   v0.2.0+ uses per-client tokens stored as SHA-256 hashes in
//   /install_tokens/{hash}; raw tokens are entered at install time in
//   the agent wizard (or passed via /TOKEN= for silent installs).
//   See validateToken() — the legacy env-var WATCHTOWER_INSTALL_TOKEN
//   is still honored as a single shared-secret fallback / emergency
//   backdoor.
//
// Worker → Firestore auth: service-account JSON (FIREBASE_SERVICE_ACCOUNT_JSON
//   secret) → OAuth2 access token via JWT-bearer grant → Firestore REST API.
//   Service-account writes bypass firestore.rules entirely.
//
// Worker → Resend: RESEND_API_KEY secret → POST https://api.resend.com/emails.
//
// No cron handler here — this worker is event-driven by agent POSTs.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const RESEND_BASE = 'https://api.resend.com';
const DELL_API_BASE = 'https://apigtwb2c.us.dell.com';
const FIREBASE_PROJECT_ID = 'watchtower-6fbe1';

// JWKS for verifying Firebase ID tokens. createRemoteJWKSet handles
// caching + key rotation across requests automatically; this lives at
// module scope so a single worker instance reuses one JWKS across many
// requests.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

// In-memory cache for the Dell OAuth access token. Tokens live ~1h; we
// refresh 5 min early. Module scope = shared across requests on the
// same worker isolate. The Cache API isn't used here because the token
// is a single global value, not per-request, and Cache API has
// stronger consistency guarantees than we need.
let _dellTokenCache = { token: null, expiresAt: 0 };

// ═════════════════════════════════════════════════════════════════════
// HTTP entrypoint
// ═════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — only allowed origins (set in wrangler.toml) get a 204.
    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }

    // Liveness probe — no auth.
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return jsonResponse({ ok: true, ts: Date.now(), service: 'watchtower-worker' }, 200);
    }

    if (url.pathname === '/checkin' && request.method === 'POST') {
      return handleCheckin(request, env, ctx);
    }

    if (url.pathname === '/validate' && request.method === 'GET') {
      return handleValidate(request, env, ctx);
    }

    if (url.pathname === '/warranty' && request.method === 'GET') {
      return withCors(await handleWarranty(request, env, ctx), env, request);
    }

    if (url.pathname === '/latest-version' && request.method === 'GET') {
      return withCors(await handleLatestVersion(request, env, ctx), env, request);
    }

    if (url.pathname === '/test-webhook' && request.method === 'POST') {
      return withCors(await handleTestWebhook(request, env, ctx), env, request);
    }

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
  },
};

// ═════════════════════════════════════════════════════════════════════
// POST /test-webhook — fire a sample payload at the master webhook URL
// ═════════════════════════════════════════════════════════════════════
//
// Operator clicks "Test webhook" in the dashboard's Settings tab. We
// resolve the URL from /settings/webhook (or the request body's `url`
// field if the operator wants to test before saving), POST a sample
// JSON event to it, and return the upstream status + a small slice of
// the response body so the operator can confirm their receiver took it.
//
// Routing the test through the worker (rather than directly from the
// browser) is deliberate: matches the real webhook code path exactly,
// and side-steps CORS — most webhook receivers don't allow arbitrary
// browser origins.
//
// Auth: Bearer <Firebase ID token>, same as /warranty + /notify-*.
//
// Optional request body: { url: "https://override-for-testing/..." }
// If omitted, reads /settings/webhook.
//
// Response:
//   200 { ok: true, status: 200, body: "first 500 chars of response" }
//   200 { ok: false, status: 502, body: "...", error: "upstream failed" }
//   400 { error: "no webhook URL configured" }
//   401 { error: "invalid sign-in token" }
async function handleTestWebhook(request, env, ctx) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) return jsonResponse({ error: 'Missing sign-in token' }, 401);
  let claims;
  try {
    claims = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    return jsonResponse({ error: 'Invalid or expired sign-in token' }, 401);
  }
  const email = (claims.email || '').toLowerCase();
  if (!claims.email_verified || !email.endsWith('@umbrellaautomation.com')) {
    return jsonResponse({ error: 'Not authorized — domain mismatch' }, 403);
  }

  // Where to POST. Body URL wins for "test before save" workflows.
  let overrideUrl = null;
  try {
    const body = await request.json();
    overrideUrl = body && body.url;
  } catch (e) {
    // Empty body is fine — fall back to saved URL.
  }

  let targetUrl = overrideUrl;
  if (!targetUrl) {
    const accessToken = await getServiceAccountToken(env);
    const settingsDoc = await firestoreGetDoc(env, accessToken, 'settings/webhook');
    targetUrl = settingsDoc?.fields?.url?.stringValue || null;
  }
  if (!targetUrl) {
    return jsonResponse({ error: 'No webhook URL configured. Save one in Settings or pass {url} in request body.' }, 400);
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    return jsonResponse({ error: 'webhook URL must start with http(s)://' }, 400);
  }

  const samplePayload = {
    event: 'test',
    pcId: '00000000-0000-0000-0000-000000000000',
    hostname: 'Watchtower-Test',
    client: 'Test Client',
    triggeredBy: email,
    when: new Date().toISOString(),
    note: 'This is a test event from the Watchtower dashboard. No real fleet event occurred.',
  };

  let upstreamStatus = 0;
  let upstreamBody = '';
  let networkError = null;
  try {
    const r = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Watchtower-Webhook-Test/1.0' },
      body: JSON.stringify(samplePayload),
    });
    upstreamStatus = r.status;
    try {
      upstreamBody = (await r.text()).slice(0, 500);
    } catch (e) {
      upstreamBody = '(could not read response body)';
    }
  } catch (e) {
    networkError = String(e).slice(0, 200);
  }

  if (networkError) {
    return jsonResponse({
      ok: false,
      url: targetUrl,
      error: `Network error: ${networkError}`,
    }, 502);
  }

  return jsonResponse({
    ok: upstreamStatus >= 200 && upstreamStatus < 300,
    url: targetUrl,
    status: upstreamStatus,
    body: upstreamBody,
  }, 200);
}

// ═════════════════════════════════════════════════════════════════════
// GET /latest-version — what's the newest agent build available?
// ═════════════════════════════════════════════════════════════════════
//
// Reads /settings/agentVersion from Firestore, which the dashboard's
// Settings tab writes after the operator publishes a new build to
// GitHub Releases via `build.ps1 -Publish`. Doc shape:
//   { version: "0.9.0", downloadUrl: "https://github.com/.../...exe",
//     sha256: "abc123...", notes: "what changed", updatedAt, updatedBy }
//
// No auth — version info is public (the EXE on GitHub Releases is too).
// Agents call this on every check-in to learn whether they're behind.
//
// Cached at the edge for 60s so a busy fleet doesn't hammer Firestore.
async function handleLatestVersion(request, env, ctx) {
  const cacheKey = new Request('https://internal-cache/latest-version', { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, { status: cached.status, headers: cached.headers });
  }

  let payload;
  try {
    const accessToken = await getServiceAccountToken(env);
    const doc = await firestoreGetDoc(env, accessToken, 'settings/agentVersion');
    if (!doc || !doc.fields) {
      payload = { ok: false, error: 'no version published yet' };
    } else {
      payload = {
        ok: true,
        version: doc.fields.version?.stringValue || null,
        downloadUrl: doc.fields.downloadUrl?.stringValue || null,
        sha256: doc.fields.sha256?.stringValue || null,
        notes: doc.fields.notes?.stringValue || null,
        updatedAt: doc.fields.updatedAt?.stringValue || null,
      };
    }
  } catch (e) {
    return jsonResponse({ error: 'lookup failed', detail: String(e).slice(0, 200) }, 502);
  }

  const resp = jsonResponse(payload, 200);
  // Cache 60s — agents check daily, dashboard polls on Settings page,
  // tray "Check for updates" is the only interactive caller.
  const cacheCopy = jsonResponse(payload, 200);
  cacheCopy.headers.set('Cache-Control', 'public, max-age=60');
  ctx.waitUntil(cache.put(cacheKey, cacheCopy));
  return resp;
}

// ═════════════════════════════════════════════════════════════════════
// CORS — only the dashboard origin(s) listed in ALLOWED_ORIGINS get
// cross-origin access. Agent endpoints (/checkin, /validate) are
// called from native code (no Origin header), so we don't bother with
// CORS for those — only /warranty needs it.
// ═════════════════════════════════════════════════════════════════════

function _allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!_allowedOrigins(env).includes(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

function withCors(response, env, request) {
  const origin = request.headers.get('Origin') || '';
  if (_allowedOrigins(env).includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

// ═════════════════════════════════════════════════════════════════════
// GET /validate — token pre-check for the installer
// ═════════════════════════════════════════════════════════════════════
//
// The Inno Setup wizard calls this before completing install so we can
// catch typos / revoked tokens / wrong-worker-URL before writing
// config.json and registering the service. No body — auth is the
// Bearer token. Returns the resolved client name + id so the wizard
// can show "Token is valid for: <Acme Corp>" as confirmation.
//
// Response:
//   200 { ok: true, client: "Acme Corp", clientId: "uuid", legacy: false }
//   401 { error: "Invalid install token" }
//
async function handleValidate(request, env, ctx) {
  const authHeader = request.headers.get('Authorization') || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!presented) {
    return jsonResponse({ error: 'Missing install token' }, 401);
  }
  const accessToken = await getServiceAccountToken(env);
  const auth = await validateToken(presented, env, accessToken);
  if (!auth.ok) {
    return jsonResponse({ error: 'Invalid install token' }, 401);
  }
  return jsonResponse({
    ok: true,
    client: auth.client || '',
    clientId: auth.clientId || '',
    legacy: auth.legacy === true,
  }, 200);
}

// ═════════════════════════════════════════════════════════════════════
// GET /warranty?serviceTag=XXX — Dell TechDirect warranty proxy
// ═════════════════════════════════════════════════════════════════════
//
// Called by the dashboard when a Dell host's drawer opens. Returns
// normalized warranty data for the given service tag.
//
// Auth: Bearer <Firebase ID token>. Same trust model as the dashboard's
//   Firestore rules — any verified @umbrellaautomation.com Google
//   account gets through.
//
// Caching: per-tag for 24h via the Cache API. Dell's own OAuth token
//   is cached at module scope and refreshed 5 min before expiry.
//
// Response shape:
//   200 { ok: true, tag, status: "active"|"expired"|"unknown",
//         endDate, daysRemaining, level, productLine, shipDate, vendor }
//   401 { error: "Invalid or expired sign-in token" }
//   503 { error: "Dell warranty integration not configured",
//         setup: "..." }  // when DELL_API_CLIENT_ID secret is missing
//   404 { error: "Service tag not found in Dell records" }
//
async function handleWarranty(request, env, ctx) {
  // ----- 1. Verify the caller is a signed-in admin -----
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return jsonResponse({ error: 'Missing sign-in token' }, 401);
  }
  let claims;
  try {
    claims = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    return jsonResponse({ error: 'Invalid or expired sign-in token' }, 401);
  }
  const email = (claims.email || '').toLowerCase();
  if (!claims.email_verified || !email.endsWith('@umbrellaautomation.com')) {
    return jsonResponse({ error: 'Not authorized — domain mismatch' }, 403);
  }

  // ----- 2. Parse + validate service tag -----
  const url = new URL(request.url);
  const tag = (url.searchParams.get('serviceTag') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,15}$/.test(tag)) {
    return jsonResponse({ error: 'Invalid serviceTag (expected 5-15 alphanumeric chars)' }, 400);
  }

  // ----- 3. Bail clean if Dell creds aren't configured -----
  if (!env.DELL_API_CLIENT_ID || !env.DELL_API_CLIENT_SECRET) {
    return jsonResponse({
      error: 'Dell warranty integration not configured',
      setup: 'Set DELL_API_CLIENT_ID and DELL_API_CLIENT_SECRET via wrangler secret put (see worker/README.md).',
    }, 503);
  }

  // ----- 4. Cache lookup (24h per tag) -----
  const cacheKey = new Request(`https://internal-cache/warranty/${tag}`, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return jsonResponse(body, 200);
  }

  // ----- 5. Hit Dell -----
  let dellRecords;
  try {
    dellRecords = await fetchDellWarranty(tag, env, ctx);
  } catch (e) {
    return jsonResponse({ error: 'Dell API request failed', detail: String(e).slice(0, 200) }, 502);
  }
  if (!dellRecords || dellRecords.length === 0) {
    return jsonResponse({ error: 'Service tag not found in Dell records', tag }, 404);
  }

  // ----- 6. Normalize + cache -----
  const normalized = normalizeDellWarranty(tag, dellRecords[0]);
  const response = jsonResponse(normalized, 200);
  // Cache the body for 24h. Note: cache.put expects a Response with a
  // body that can be consumed twice — we serialize fresh here so the
  // returned response and the cached one don't fight over the stream.
  const cacheCopy = jsonResponse(normalized, 200);
  cacheCopy.headers.set('Cache-Control', 'public, max-age=86400');
  ctx.waitUntil(cache.put(cacheKey, cacheCopy));
  return response;
}

// ─────────────────────────────────────────────────────────────────────
// Firebase ID token verification — used by /warranty to gate on the
// same "verified @umbrellaautomation.com Google account" rule that
// Firestore enforces. JWKS is fetched + cached automatically by jose.
// ─────────────────────────────────────────────────────────────────────

async function verifyFirebaseIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
    algorithms: ['RS256'],
  });
  return payload;
}

// ─────────────────────────────────────────────────────────────────────
// Dell TechDirect API client
// ─────────────────────────────────────────────────────────────────────
// OAuth2 client_credentials grant → bearer token → asset-entitlements.
// Docs: https://techdirect.dell.com  (Dell-published spec is behind a
// login but the endpoint shapes used here are stable and have been the
// same since v5 launched in 2018).

async function getDellApiToken(env) {
  // Use cached token if it has at least 5 minutes of life left.
  if (_dellTokenCache.token && _dellTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return _dellTokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.DELL_API_CLIENT_ID,
    client_secret: env.DELL_API_CLIENT_SECRET,
  });

  const r = await fetch(`${DELL_API_BASE}/auth/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Dell OAuth failed: ${r.status} ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.access_token) {
    throw new Error('Dell OAuth: no access_token in response');
  }
  const expiresInMs = (data.expires_in || 3600) * 1000;
  _dellTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresInMs,
  };
  return data.access_token;
}

async function fetchDellWarranty(tag, env, ctx) {
  const token = await getDellApiToken(env);
  const url = `${DELL_API_BASE}/PROD/sbil/eapi/v5/asset-entitlements?servicetags=${encodeURIComponent(tag)}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  if (r.status === 401) {
    // Token expired between cache check and use — invalidate + retry once.
    _dellTokenCache = { token: null, expiresAt: 0 };
    const fresh = await getDellApiToken(env);
    const retry = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${fresh}`,
        'Accept': 'application/json',
      },
    });
    if (!retry.ok) {
      throw new Error(`Dell API ${retry.status} after token refresh`);
    }
    return retry.json();
  }
  if (!r.ok) {
    throw new Error(`Dell API ${r.status}`);
  }
  return r.json();
}

function normalizeDellWarranty(tag, record) {
  // Dell returns an "entitlements" array — one per warranty/contract
  // tier (initial, extended, etc). We pick the one with the latest
  // endDate as the headline value, since that's what determines when
  // the host actually drops off support.
  const entitlements = Array.isArray(record.entitlements) ? record.entitlements : [];
  let latest = null;
  for (const e of entitlements) {
    if (!e.endDate) continue;
    if (!latest || new Date(e.endDate) > new Date(latest.endDate)) {
      latest = e;
    }
  }

  const endDate = latest?.endDate || null;
  const now = Date.now();
  let status = 'unknown';
  let daysRemaining = null;
  if (endDate) {
    const endMs = new Date(endDate).getTime();
    daysRemaining = Math.round((endMs - now) / (1000 * 60 * 60 * 24));
    status = endMs > now ? 'active' : 'expired';
  }

  return {
    ok: true,
    tag,
    status,
    endDate,
    daysRemaining,
    level: latest?.serviceLevelDescription || latest?.serviceLevelCode || null,
    productLine: record.productLineDescription || record.productFamily || null,
    machineDescription: record.machineDescription || null,
    shipDate: record.shipDate || null,
    vendor: record.vendor || 'Dell',
    entitlementCount: entitlements.length,
    fetchedAt: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════════
// POST /checkin — the only meaningful endpoint
// ═════════════════════════════════════════════════════════════════════
//
// Request:
//   Authorization: Bearer <WATCHTOWER_INSTALL_TOKEN>
//   Body: {
//     pcId: "uuid",          // stable per-install, generated by agent at install
//     agentVersion: "0.1.0",
//     hostname: "OPFD-SERVER",
//     client: "OPFD",        // worker overrides with token-bound name on validation
//     ts: "2026-05-22T...",  // agent's local clock
//     report: { ...Belarc-lite fields... }
//   }
//
// Response:
//   200 {
//     ok: true,
//     config: { enabled, emailEnabled, webhookEnabled, webhookUrl },
//     uninstall: false
//   }
//
// Errors:
//   401 invalid token
//   400 malformed payload
//   500 upstream failure (Firestore, Resend)
//

async function handleCheckin(request, env, ctx) {
  // ----- 1. Validate install token (legacy env var OR per-client Firestore doc) -----
  const authHeader = request.headers.get('Authorization') || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!presented) {
    return jsonResponse({ error: 'Missing install token' }, 401);
  }

  const accessToken = await getServiceAccountToken(env);
  const auth = await validateToken(presented, env, accessToken);
  if (!auth.ok) {
    return jsonResponse({ error: 'Invalid install token', reason: auth.reason }, 401);
  }

  // ----- 2. Parse + minimally validate payload -----
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const { pcId, hostname, client, agentVersion, report } = payload || {};
  if (!pcId || typeof pcId !== 'string' || pcId.length < 8 || pcId.length > 64) {
    return jsonResponse({ error: 'pcId required (8-64 chars)' }, 400);
  }
  if (!hostname || typeof hostname !== 'string') {
    return jsonResponse({ error: 'hostname required' }, 400);
  }
  if (!report || typeof report !== 'object') {
    return jsonResponse({ error: 'report required' }, 400);
  }

  // Trust the token-bound client name over the payload's claim. This way an
  // agent can't lie about which client it belongs to — the binding is set
  // at token-generation time in the dashboard. Legacy tokens (env var) fall
  // back to whatever the agent reports, since they have no binding.
  const resolvedClient = auth.client || client || 'unknown';
  const resolvedClientId = auth.clientId || null;

  // ----- 3. Fetch existing status doc to detect IP changes + backup-failure transitions -----
  const existing = await firestoreGetDoc(env, accessToken, `agents/${pcId}`);
  const previousExternalIp = existing?.fields?.externalIp?.stringValue || null;
  const newExternalIp = report?.network?.externalIp || null;
  const ipChanged = previousExternalIp !== null && newExternalIp !== null && previousExternalIp !== newExternalIp;
  const firstSeen = existing === null;
  const nowIso = new Date().toISOString();

  // ----- 3d. Pick a "primary" internal IP for the fleet table -----
  // Heuristic: first NIC with a default gateway AND a non-link-local IPv4.
  // That's almost always the one an admin would RDP to. Falls back to any
  // routable-looking IPv4 if no NIC has a gateway set (which can happen
  // on isolated subnets / point-to-point links).
  const newInternalIp = pickPrimaryInternalIp(report?.network?.nics);

  // ----- 3c. Track OMSA storage warning duration -----
  // omsaFirstWarnAt is the timestamp at which OMSA's healthRollup first
  // went non-OK. We set it on the OK→warn/bad transition, preserve it
  // while the warning persists across check-ins, and clear it on the
  // warn/bad→OK transition (or when OMSA is no longer installed). The
  // dashboard computes "Nd warn" from this field.
  //
  // "unknown" rollup is treated as OK for this purpose — we don't want
  // to flag a host just because the probe couldn't read its state on
  // one check-in.
  const omsaCurrent = report?.omsa;
  const omsaPrevWarnAt = existing?.fields?.omsaFirstWarnAt?.stringValue || null;
  const omsaInstalled = omsaCurrent?.installed === true;
  const omsaRollup = omsaCurrent?.healthRollup;
  const omsaIsNonOk = omsaInstalled && (omsaRollup === 'warn' || omsaRollup === 'bad');
  let omsaFirstWarnAt;
  if (omsaIsNonOk && !omsaPrevWarnAt) {
    omsaFirstWarnAt = nowIso;  // first detected this check-in
  } else if (!omsaIsNonOk) {
    omsaFirstWarnAt = null;  // back to OK / not installed → clear
  } else {
    omsaFirstWarnAt = omsaPrevWarnAt;  // still warning → preserve start
  }

  // ----- 3b. Detect new WSB backup failure -----
  // Dedupe on lastBackupTime: a host with a failing daily backup will
  // produce one alert per failed attempt (since each attempt advances
  // lastBackupTime), not one per check-in. Persistent same-state
  // failures across multiple check-ins of the same attempt = silent.
  const wsbCurrent = report?.wsb;
  const wsbPrev = existing?.fields?.report?.mapValue?.fields?.wsb?.mapValue?.fields;
  const wsbInstalled = wsbCurrent?.installed === true;
  const wsbCurrentResult = wsbCurrent?.lastBackupResult;
  const wsbCurrentTime = wsbCurrent?.lastBackupTime;
  const wsbPrevTime = wsbPrev?.lastBackupTime?.stringValue || null;
  const wsbNewFailure = (
    wsbInstalled
    && wsbCurrentResult
    && wsbCurrentResult !== 'Success'
    && wsbCurrentTime
    && wsbCurrentTime !== wsbPrevTime  // new attempt since last check-in (or never seen)
  );

  // ----- 4. Read per-PC config (kill switches) — but treat absence as defaults -----
  const configDoc = await firestoreGetDoc(env, accessToken, `agents/${pcId}/config/current`);
  const config = readConfig(configDoc);

  // ----- 4b. Read global webhook URL (single fleet-wide value) -----
  // Per-agent webhookUrl is legacy — we keep it as a fallback for hosts
  // that were configured before the global setting existed, but new
  // installs should be controlled via /settings/webhook in Firestore.
  // Resolution order: agent's own URL > global URL > none. (Agent-level
  // wins so a host can override the global for one-off testing.)
  const settingsDoc = await firestoreGetDoc(env, accessToken, 'settings/webhook');
  const globalWebhookUrl = settingsDoc?.fields?.url?.stringValue || null;
  const effectiveWebhookUrl = config.webhookUrl || globalWebhookUrl;

  // ----- 5. Write status doc (PATCH = upsert when doc id is in path) -----
  // We pass the entire report as nested fields. Firestore can take maps up
  // to 1 MB per doc — Belarc-lite reports are well under that even with
  // 200 installed apps and 90 days of hotfixes.
  const statusUpdate = {
    pcId,
    hostname,
    client: resolvedClient,
    clientId: resolvedClientId,
    tokenLegacy: auth.legacy === true,
    agentVersion: agentVersion || 'unknown',
    lastCheckin: nowIso,
    externalIp: newExternalIp,
    ...(firstSeen ? { installedAt: nowIso } : {}),
    ...(ipChanged || firstSeen ? { externalIpChangedAt: nowIso } : {}),
    internalIp: newInternalIp,
    omsaFirstWarnAt,
    report,
  };
  await firestoreSetDoc(env, accessToken, `agents/${pcId}`, statusUpdate);

  // ----- 6. Append history doc -----
  // Doc id is a sortable timestamp prefix + short random suffix to avoid
  // collisions if two check-ins land in the same millisecond.
  const histId = `${nowIso.replace(/[:.]/g, '-')}-${randomShortId()}`;
  await firestoreSetDoc(env, accessToken, `agents/${pcId}/history/${histId}`, {
    ts: nowIso,
    pcId,
    externalIp: newExternalIp,
    changed: ipChanged,
    firstSeen,
    agentVersion: agentVersion || 'unknown',
  });

  // ----- 6b. First-time intake email -----
  // When this is the host's first check-in (no previous /agents/{pcId}
  // doc), email a comprehensive summary of what the probes found.
  // The admin gets a one-time "welcome to the fleet, here's what's on
  // this box" report. Fires exactly once per pcId by construction —
  // firstSeen only happens before the first setDoc above.
  if (firstSeen && config.enabled && config.emailEnabled && env.RESEND_API_KEY) {
    ctx.waitUntil(
      sendIntakeEmail(env, {
        pcId,
        hostname,
        client: resolvedClient,
        agentVersion: agentVersion || 'unknown',
        when: nowIso,
        externalIp: newExternalIp,
        report,
      }).catch((e) => console.error('Intake email failed:', e))
    );
  }

  // ----- 7. Notify on IP change (unless silenced by per-PC config) -----
  // ctx.waitUntil lets the worker return to the agent quickly while
  // notifications fire in the background. If the agent's HTTP timeout is
  // short, this matters; we still observe failures via wrangler tail.
  if (ipChanged && config.enabled) {
    if (config.emailEnabled && env.RESEND_API_KEY) {
      ctx.waitUntil(
        sendIpChangeEmail(env, {
          pcId,
          hostname,
          client: client || 'unknown',
          previousIp: previousExternalIp,
          newIp: newExternalIp,
          when: nowIso,
        }).catch((e) => console.error('Resend email failed:', e))
      );
    }
    if (config.webhookEnabled && effectiveWebhookUrl) {
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'external_ip_changed',
          pcId,
          hostname,
          client: client || 'unknown',
          previousIp: previousExternalIp,
          newIp: newExternalIp,
          when: nowIso,
        }).catch((e) => console.error('Webhook POST failed:', e))
      );
    }
  }

  // ----- 7b. Notify on new WSB backup failure -----
  if (wsbNewFailure && config.enabled) {
    const lastSuccess = wsbCurrent?.lastSuccessfulBackup || null;
    const daysSinceSuccess = lastSuccess
      ? Math.floor((Date.now() - new Date(lastSuccess).getTime()) / 86400000)
      : null;

    if (config.emailEnabled && env.RESEND_API_KEY) {
      ctx.waitUntil(
        sendBackupFailureEmail(env, {
          pcId,
          hostname,
          client: resolvedClient,
          result: wsbCurrentResult,
          detail: wsbCurrent?.detail || null,
          attemptedAt: wsbCurrentTime,
          lastSuccess,
          daysSinceSuccess,
          when: nowIso,
        }).catch((e) => console.error('WSB failure email failed:', e))
      );
    }
    if (config.webhookEnabled && effectiveWebhookUrl) {
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'wsb_backup_failed',
          pcId,
          hostname,
          client: resolvedClient,
          result: wsbCurrentResult,
          detail: wsbCurrent?.detail || null,
          attemptedAt: wsbCurrentTime,
          lastSuccess,
          daysSinceSuccess,
          when: nowIso,
        }).catch((e) => console.error('Webhook POST failed:', e))
      );
    }
  }

  // ----- 8. Return config + uninstall flag to the agent -----
  return jsonResponse({
    ok: true,
    config: {
      enabled: config.enabled,
      emailEnabled: config.emailEnabled,
      webhookEnabled: config.webhookEnabled,
      webhookUrl: config.webhookUrl || null,
      autoUpdate: config.autoUpdate,
    },
    uninstall: config.uninstall,
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────
// Install-token validation
// ─────────────────────────────────────────────────────────────────────
// Two paths:
//
//   1. Legacy: env.WATCHTOWER_INSTALL_TOKEN (one shared secret across all
//      agents). Kept for backward compat with agents that were built before
//      per-client tokens existed — and as an emergency backdoor that an
//      admin can always set if Firestore is unreachable. Should be empty in
//      steady-state production.
//
//   2. Per-client: SHA-256 the presented token, look up the resulting hash
//      as a doc id in /install_tokens. The doc carries the bound clientId
//      + clientName + a revoked flag.
//
// Returns either { ok: true, client, clientId, legacy } on success
// or       { ok: false, reason } on failure.
//
// We don't differentiate "unknown" vs "revoked" in the response to the
// agent (security: don't give attackers signal about which tokens exist).
async function validateToken(presented, env, accessToken) {
  // Legacy path — short-circuit. Only enabled if the env var is actually set.
  if (env.WATCHTOWER_INSTALL_TOKEN && presented === env.WATCHTOWER_INSTALL_TOKEN) {
    return { ok: true, legacy: true, client: null, clientId: null };
  }

  // Per-client path: hash and look up. Hash uses the raw bytes of the token
  // so different presented strings (e.g. with stray whitespace) won't match
  // — the dashboard generates clean base64 tokens and Firestore preserves
  // them exactly, so as long as the agent's installer also got a clean copy
  // (the .iss bakes it in at build time), they'll match.
  let hash;
  try {
    hash = await sha256Hex(presented);
  } catch (e) {
    return { ok: false, reason: 'token-hash-failed' };
  }

  const doc = await firestoreGetDoc(env, accessToken, `install_tokens/${hash}`);
  if (!doc || !doc.fields) {
    return { ok: false, reason: 'unknown' };
  }
  if (doc.fields.revoked?.booleanValue === true) {
    return { ok: false, reason: 'unknown' }; // intentionally vague
  }
  return {
    ok: true,
    legacy: false,
    client: doc.fields.clientName?.stringValue || null,
    clientId: doc.fields.clientId?.stringValue || null,
  };
}

function pickPrimaryInternalIp(nics) {
  if (!Array.isArray(nics)) return null;
  const usable = (ip) => ip && ip !== '0.0.0.0' && ip !== '127.0.0.1' && !ip.startsWith('169.254.');
  // First pass: NICs with a default gateway (= internet-facing or LAN-routed)
  for (const nic of nics) {
    if (Array.isArray(nic.gateways) && nic.gateways.length && Array.isArray(nic.ipv4)) {
      const ip = nic.ipv4.find(usable);
      if (ip) return ip;
    }
  }
  // Fallback: any usable IPv4 anywhere
  for (const nic of nics) {
    if (Array.isArray(nic.ipv4)) {
      const ip = nic.ipv4.find(usable);
      if (ip) return ip;
    }
  }
  return null;
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ─────────────────────────────────────────────────────────────────────
// Config doc reader — translates Firestore typed values into plain JS
// with sensible defaults when the config doc doesn't exist yet.
// ─────────────────────────────────────────────────────────────────────
function readConfig(doc) {
  // Defaults: everything on, no webhook, no uninstall.
  const defaults = {
    enabled: true,
    emailEnabled: true,
    webhookEnabled: false,
    webhookUrl: null,
    uninstall: false,
    autoUpdate: false,  // safety default — opt-in per host
  };
  if (!doc || !doc.fields) return defaults;
  return {
    enabled: fieldBool(doc.fields.enabled, defaults.enabled),
    emailEnabled: fieldBool(doc.fields.emailEnabled, defaults.emailEnabled),
    webhookEnabled: fieldBool(doc.fields.webhookEnabled, defaults.webhookEnabled),
    webhookUrl: doc.fields.webhookUrl?.stringValue || null,
    uninstall: fieldBool(doc.fields.uninstall, defaults.uninstall),
    autoUpdate: fieldBool(doc.fields.autoUpdate, defaults.autoUpdate),
  };
}

function fieldBool(field, fallback) {
  if (!field) return fallback;
  if ('booleanValue' in field) return field.booleanValue;
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — IP change alert
// ─────────────────────────────────────────────────────────────────────
async function sendIpChangeEmail(env, { pcId, hostname, client, previousIp, newIp, when }) {
  const subject = `Watchtower: external IP changed — ${hostname} (${client})`;
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#222; max-width:600px;">
      <h2 style="color:#0a6; margin:0 0 12px;">External IP changed</h2>
      <table cellpadding="6" style="border-collapse:collapse; font-size:14px;">
        <tr><td style="color:#666;">Host</td><td><b>${escapeHtml(hostname)}</b></td></tr>
        <tr><td style="color:#666;">Client</td><td>${escapeHtml(client)}</td></tr>
        <tr><td style="color:#666;">Previous IP</td><td><code>${escapeHtml(previousIp)}</code></td></tr>
        <tr><td style="color:#666;">New IP</td><td><code style="color:#0a6;"><b>${escapeHtml(newIp)}</b></code></td></tr>
        <tr><td style="color:#666;">When</td><td>${escapeHtml(when)}</td></tr>
        <tr><td style="color:#666;">pcId</td><td><code>${escapeHtml(pcId)}</code></td></tr>
      </table>
      <p style="color:#888; font-size:12px; margin-top:24px;">
        Sent by watchtower-worker. To silence these emails, flip
        <code>emailEnabled</code> off in the agent's per-PC config from the
        Watchtower dashboard.
      </p>
    </div>
  `;
  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SENDER_FROM || 'Watchtower <onboarding@resend.dev>',
      to: [env.ALERT_TO],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend ${resp.status}: ${txt}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — first-time host intake (one per pcId, on firstSeen)
// ─────────────────────────────────────────────────────────────────────
async function sendIntakeEmail(env, { pcId, hostname, client, agentVersion, when, externalIp, report }) {
  const subject = `Watchtower: New host onboarded — ${hostname} (${client})`;
  const r = report || {};
  const sys = r.system || {};
  const os = sys.os || {};
  const net = r.network || {};
  const stor = r.storage || {};
  const sw = r.software || {};
  const hf = r.hotfixes || {};

  const isDell = /dell/i.test(sys.manufacturer || '');
  const tagHtml = sys.serviceTag
    ? (isDell
        ? `<a href="https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(sys.serviceTag)}" style="color:#0a6b6b;"><code>${escapeHtml(sys.serviceTag)}</code></a>`
        : `<code>${escapeHtml(sys.serviceTag)}</code>`)
    : '—';

  const row = (label, value) => value
    ? `<tr><td style="color:#666; padding:4px 10px 4px 0; vertical-align:top;">${escapeHtml(label)}</td><td style="padding:4px 0; vertical-align:top;">${value}</td></tr>`
    : '';

  const sectionHeader = (title) => `<div style="margin:18px 0 6px; font-size:11px; text-transform:uppercase; color:#8892a4; letter-spacing:0.06em; font-weight:700;">${escapeHtml(title)}</div>`;

  // Build optional product-detection sections only when present.
  const veeam = r.veeam;
  const wsb = r.wsb;
  const carbonite = r.carbonite;
  const lmi = r.logmein;
  const s1 = r.sentinelone;
  const def = r.defender;
  const omsa = r.omsa;
  const idrac = r.idrac;
  const usb = r.usb;

  const veeamHtml = veeam && veeam.installed
    ? (veeam.products || []).map(p => `<div>${p.edition === 'br' ? 'Veeam Backup & Replication' : 'Veeam Agent for Windows'} <b>${escapeHtml(p.version || '?')}</b>${p.lastJob && p.lastJob.result ? ` — last job: <b>${escapeHtml(p.lastJob.result)}</b>` : ''}</div>`).join('')
    : '';

  const wsbHtml = wsb && wsb.installed
    ? `<div>WSB <b>${escapeHtml(wsb.lastBackupResult || 'no runs yet')}</b>${wsb.lastSuccessfulBackup ? ` · last success ${escapeHtml(wsb.lastSuccessfulBackup)}` : ''} · ${wsb.numberOfVersions || 0} version(s) retained</div>`
    : '';

  const carboniteHtml = carbonite && carbonite.installed
    ? (carbonite.products || []).map(p => `<div>${escapeHtml(p.name)} <b>${escapeHtml(p.version || '?')}</b></div>`).join('')
    : '';

  const omsaHtml = omsa && omsa.installed
    ? `<div>Dell OMSA <b>${escapeHtml(omsa.version || '?')}</b> · rollup: <b>${escapeHtml(omsa.healthRollup || 'unknown')}</b> · ${(omsa.physicalDisks || []).length} disks, ${(omsa.virtualDisks || []).length} RAID arrays</div>`
    : '';

  const idracHtml = idrac && idrac.installed
    ? `<div>iDRAC Service Module <b>${escapeHtml(idrac.version || '?')}</b> · service ${escapeHtml(idrac.serviceState || '?')}</div>`
    : '';

  const lmiHtml = lmi && lmi.installed
    ? `<div>LogMeIn <b>${escapeHtml(lmi.version || '?')}</b> · service ${escapeHtml(lmi.serviceState || '?')}${lmi.description ? ` · "${escapeHtml(lmi.description)}"` : ''}</div>`
    : '';

  const s1Html = s1 && s1.installed
    ? `<div>SentinelOne <b>${escapeHtml(s1.version || '?')}</b> · service ${escapeHtml(s1.serviceState || '?')}</div>`
    : '';

  const defHtml = def
    ? `<div>Defender: enabled=<b>${def.enabled ? 'yes' : 'no'}</b>, realtime=<b>${def.realtimeOn ? 'on' : 'off'}</b>, definitions ${escapeHtml(def.definitionsVersion || '?')} (${escapeHtml(def.definitionsUpdated || '?')})</div>`
    : '';

  const backupsBlock = (veeamHtml || wsbHtml || carboniteHtml)
    ? sectionHeader('Backups') + `<div style="font-size:13px; line-height:1.6;">${veeamHtml}${wsbHtml}${carboniteHtml}</div>`
    : '';

  const securityBlock = (defHtml || s1Html)
    ? sectionHeader('Security') + `<div style="font-size:13px; line-height:1.6;">${defHtml}${s1Html}</div>`
    : '';

  const remoteBlock = (lmiHtml || idracHtml)
    ? sectionHeader('Remote access') + `<div style="font-size:13px; line-height:1.6;">${lmiHtml}${idracHtml}</div>`
    : '';

  const storageBlock = omsaHtml
    ? sectionHeader('Storage (Dell OMSA)') + `<div style="font-size:13px; line-height:1.6;">${omsaHtml}</div>`
    : '';

  const volumes = (stor.volumes || []).map(v => `<li>${escapeHtml(v.letter)} (${escapeHtml(v.filesystem || '?')}) — ${v.sizeGB || 0} GB total, ${v.freeGB || 0} GB free</li>`).join('');
  const nics = (net.nics || []).filter(n => (n.ipv4 || []).length).map(n => `<li>${escapeHtml(n.name || n.description || '?')} — ${escapeHtml((n.ipv4 || []).join(', '))}${n.speedMbps ? ` @ ${n.speedMbps} Mbps` : ''}</li>`).join('');

  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#1a1f2b; max-width:680px;">
      <h2 style="color:#0a6b6b; margin:0 0 4px; font-size:18px;">New host onboarded</h2>
      <p style="color:#475063; margin:0 0 18px; font-size:14px;"><b>${escapeHtml(hostname)}</b> joined the Watchtower fleet at ${escapeHtml(when)}. Below is the intake report from its first check-in — a one-time summary so you have a record of what was on this machine when it came in. Future check-ins won't send this email.</p>

      ${sectionHeader('Identity')}
      <table cellpadding="0" style="font-size:13.5px; line-height:1.5;">
        ${row('Hostname', `<b>${escapeHtml(hostname)}</b>`)}
        ${row('Client', escapeHtml(client))}
        ${row('External IP', `<code>${escapeHtml(externalIp || '?')}</code>`)}
        ${row('pcId', `<code style="font-size:11px;">${escapeHtml(pcId)}</code>`)}
        ${row('Agent version', escapeHtml(agentVersion))}
      </table>

      ${sectionHeader('Hardware')}
      <table cellpadding="0" style="font-size:13.5px; line-height:1.5;">
        ${row('Manufacturer', escapeHtml(sys.manufacturer))}
        ${row('Model', escapeHtml(sys.model))}
        ${row('Service Tag', tagHtml)}
        ${row('CPU', `${escapeHtml((sys.cpu && sys.cpu.name) || '?')}${sys.cpu && sys.cpu.cores ? ` (${sys.cpu.cores} cores)` : ''}`)}
        ${row('RAM', sys.memory && sys.memory.totalGB ? `${sys.memory.totalGB} GB` : null)}
        ${row('TPM', sys.tpm ? (sys.tpm.present ? `present, spec ${escapeHtml(sys.tpm.specVersion || '?')}` : 'absent') : null)}
        ${row('BIOS', `${escapeHtml(sys.biosVersion || '?')} (${escapeHtml(sys.biosDate || '?')})`)}
      </table>

      ${sectionHeader('Operating system')}
      <table cellpadding="0" style="font-size:13.5px; line-height:1.5;">
        ${row('OS', escapeHtml(os.name))}
        ${row('Build', escapeHtml(os.build))}
        ${row('Install date', escapeHtml(os.installDate))}
        ${row('Domain', sys.partOfDomain ? escapeHtml(sys.workgroup || 'unknown domain') : `workgroup: ${escapeHtml(sys.workgroup || 'WORKGROUP')}`)}
      </table>

      ${volumes ? sectionHeader('Volumes') + `<ul style="font-size:13.5px; line-height:1.6; margin:0; padding-left:22px;">${volumes}</ul>` : ''}
      ${nics ? sectionHeader('Network interfaces') + `<ul style="font-size:13.5px; line-height:1.6; margin:0; padding-left:22px;">${nics}</ul>` : ''}

      ${storageBlock}
      ${backupsBlock}
      ${securityBlock}
      ${remoteBlock}

      ${sectionHeader('Inventory')}
      <div style="font-size:13.5px; line-height:1.6;">
        ${sw.count ? `<div>${sw.count} installed applications</div>` : ''}
        ${hf.total ? `<div>${hf.total} hotfixes installed</div>` : ''}
        ${usb && usb.devices ? `<div>${usb.devices.length} USB device(s) in history</div>` : ''}
      </div>

      <p style="color:#8892a4; font-size:12px; margin-top:28px;">
        View full details at the <a href="https://frank-umbrella.github.io/work/watchtower/" style="color:#0a6b6b;">Watchtower dashboard</a> → click <b>${escapeHtml(hostname)}</b> in the Fleet tab.
        This is a one-time email per host. If you want to silence future alerts for this host, flip <code>emailEnabled</code> off in its per-PC config.
      </p>
    </div>
  `;

  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SENDER_FROM || 'Watchtower <onboarding@resend.dev>',
      to: [env.ALERT_TO],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend ${resp.status}: ${txt}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — Windows Server Backup failure alert
// ─────────────────────────────────────────────────────────────────────
async function sendBackupFailureEmail(env, { pcId, hostname, client, result, detail, attemptedAt, lastSuccess, daysSinceSuccess, when }) {
  const subject = `Watchtower: backup FAILED — ${hostname} (${client})`;
  const daysLine = daysSinceSuccess != null
    ? `<tr><td style="color:#666;">Days since success</td><td><b style="color:#b00;">${daysSinceSuccess}</b></td></tr>`
    : `<tr><td style="color:#666;">Last success</td><td><i>No successful backup on record</i></td></tr>`;
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#222; max-width:600px;">
      <h2 style="color:#b00; margin:0 0 12px;">Windows Server Backup failed</h2>
      <table cellpadding="6" style="border-collapse:collapse; font-size:14px;">
        <tr><td style="color:#666;">Host</td><td><b>${escapeHtml(hostname)}</b></td></tr>
        <tr><td style="color:#666;">Client</td><td>${escapeHtml(client)}</td></tr>
        <tr><td style="color:#666;">Result</td><td><code style="color:#b00;"><b>${escapeHtml(result)}</b></code></td></tr>
        <tr><td style="color:#666;">Attempted at</td><td>${escapeHtml(attemptedAt)}</td></tr>
        ${lastSuccess ? `<tr><td style="color:#666;">Last successful</td><td>${escapeHtml(lastSuccess)}</td></tr>` : ''}
        ${daysLine}
        <tr><td style="color:#666;">Detected</td><td>${escapeHtml(when)}</td></tr>
        <tr><td style="color:#666;">pcId</td><td><code>${escapeHtml(pcId)}</code></td></tr>
      </table>
      ${detail ? `<p style="color:#444; font-size:13px; margin-top:16px; padding:10px; background:#fafafa; border-left:3px solid #b00;"><b>WSB detail:</b><br>${escapeHtml(detail)}</p>` : ''}
      <p style="color:#888; font-size:12px; margin-top:24px;">
        Sent once per new failed attempt (deduped by lastBackupTime). To silence
        these emails for this host, flip <code>emailEnabled</code> off in the
        agent's per-PC config from the Watchtower dashboard.
      </p>
    </div>
  `;
  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SENDER_FROM || 'Watchtower <onboarding@resend.dev>',
      to: [env.ALERT_TO],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend ${resp.status}: ${txt}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Webhook POST — optional per-PC custom endpoint for IP changes
// ─────────────────────────────────────────────────────────────────────
async function postWebhook(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Webhook ${url} returned ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════
// FIRESTORE — service-account auth + REST helpers
// (lifted from stocks-worker / usage-worker)
// ═════════════════════════════════════════════════════════════════════

let _accessTokenCache = null;

async function getServiceAccountToken(env) {
  if (_accessTokenCache && _accessTokenCache.expiresAt > Date.now() + 60_000) {
    return _accessTokenCache.token;
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = b64url(btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimB64 = b64url(btoa(JSON.stringify(claim)));
  const unsigned = `${headerB64}.${claimB64}`;

  const privateKey = await pemToCryptoKey(sa.private_key);
  const enc = new TextEncoder();
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(unsigned));
  const sigB64 = b64url(arrayBufferToBase64(sigBuf));
  const jwt = `${unsigned}.${sigB64}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`Service account token exchange failed: ${resp.status} ${errTxt}`);
  }
  const data = await resp.json();
  _accessTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 120) * 1000,
  };
  return data.access_token;
}

async function firestoreGetDoc(env, accessToken, path) {
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`Firestore GET ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// PATCH with no field mask → upsert. We replace the doc wholesale; the
// status doc always reflects the latest check-in's complete report so
// stale fields don't linger.
async function firestoreSetDoc(env, accessToken, path, jsObject) {
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields = {};
  for (const [k, v] of Object.entries(jsObject)) {
    if (v === undefined) continue;
    fields[k] = jsToFsValue(v);
  }
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    throw new Error(`Firestore PATCH ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// JS-value → Firestore typed-value JSON. Handles null, bool, integer,
// double, string, array, object, ISO-string timestamps (heuristic).
function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') {
    // Heuristic: ISO-8601 timestamps become Firestore timestampValue so
    // they sort properly in the console and from query order-by. The
    // regex is strict enough that ordinary strings won't trigger.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      return { timestampValue: v };
    }
    return { stringValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(jsToFsValue) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      fields[k] = jsToFsValue(val);
    }
    return { mapValue: { fields } };
  }
  // Fallback — string-coerce anything weird so we don't drop data on the floor.
  return { stringValue: String(v) };
}

// ═════════════════════════════════════════════════════════════════════
// SMALL HELPERS
// ═════════════════════════════════════════════════════════════════════

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function b64url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function pemToCryptoKey(pem) {
  const stripped = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function randomShortId() {
  // 6 chars of base32-ish, good enough for in-millisecond uniqueness.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
