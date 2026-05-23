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

    if (url.pathname === '/reassign-client' && request.method === 'POST') {
      return withCors(await handleReassignClient(request, env, ctx), env, request);
    }

    // POST /uninstall — agent phones home from Inno Setup's uninstall step.
    // Auth is the install token (same as /checkin), NOT a Firebase ID token.
    // No CORS — called from native WinHttp, not the browser.
    if (url.pathname === '/uninstall' && request.method === 'POST') {
      return handleUninstall(request, env, ctx);
    }

    // POST /decommission — admin marks a host decommissioned from the
    // dashboard. Used for offline / dead hosts that can't phone home on
    // their own, or to schedule a live host's uninstall + immediately
    // hide it from the active fleet view.
    if (url.pathname === '/decommission' && request.method === 'POST') {
      return withCors(await handleAdminDecommission(request, env, ctx), env, request);
    }

    return jsonResponse({ error: 'Not found', path: url.pathname }, 404);
  },
};

// ═════════════════════════════════════════════════════════════════════
// POST /reassign-client — change a host's client assignment
// ═════════════════════════════════════════════════════════════════════
//
// Operator picks a different client in the drawer's "Client" dropdown.
// The agent's check-in normally trusts the token-bound client name
// (commit acb34ac, the per-client install token model), so without this
// endpoint the only way to re-label a host would be to revoke its
// token + reinstall with a new one — overkill for a typo.
//
// Two writes, atomic from the operator's perspective:
//   1. /agents/{pcId} client + clientId fields — so the fleet table
//      reflects the change immediately without waiting for the next
//      check-in to refresh
//   2. /agents/{pcId}/config/current clientIdOverride — so subsequent
//      check-ins preserve the change instead of reverting to the
//      token's binding (handleCheckin reads this; see resolveClient)
//
// Pass clientId=null in the body to clear the override and let the
// token-bound default take effect on the next check-in.
//
// Auth: Bearer <Firebase ID token>, same as other admin endpoints.
async function handleReassignClient(request, env, ctx) {
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const { pcId, clientId } = body || {};
  if (!pcId || typeof pcId !== 'string') {
    return jsonResponse({ error: 'pcId required' }, 400);
  }

  const accessToken = await getServiceAccountToken(env);

  // Confirm the agent exists. Avoids creating stub /agents docs by
  // mistyping pcId in the dashboard.
  const agentDoc = await firestoreGetDoc(env, accessToken, `agents/${pcId}`);
  if (!agentDoc || !agentDoc.fields) {
    return jsonResponse({ error: 'Agent not found' }, 404);
  }
  const previousClient = agentDoc.fields.client?.stringValue || null;
  const previousClientId = agentDoc.fields.clientId?.stringValue || null;
  const hostname = agentDoc.fields.hostname?.stringValue || pcId;

  // Resolve the new client name. clientId=null/empty means reset to
  // the token-bound default; in that case we fall back to whatever the
  // most recent check-in's `client` field was (best approximation —
  // we don't know which token was used at install time).
  let newClient = null;
  let newClientId = null;
  if (clientId) {
    const clientDoc = await firestoreGetDoc(env, accessToken, `clients/${clientId}`);
    if (!clientDoc || !clientDoc.fields) {
      return jsonResponse({ error: 'Client not found' }, 404);
    }
    newClient = clientDoc.fields.name?.stringValue || '(unnamed)';
    newClientId = clientId;
  } else {
    // Reset — preserve existing client name from the agent doc since
    // it's our best guess at what the token would have said. The next
    // check-in will overwrite from the actual token-bound value.
    newClient = agentDoc.fields.client?.stringValue || 'unknown';
    newClientId = agentDoc.fields.clientId?.stringValue || null;
  }

  // Write 1: agent doc fields. PARTIAL via updateMask so we touch only
  // client + clientId and leave lastCheckin / hostname / report / etc
  // intact. Without partial=true, Firestore PATCH would REPLACE the
  // entire doc with just these two fields -- the bug that made
  // reassigned hosts vanish from the Endpoints table (the dashboard's
  // orderBy('lastCheckin', 'desc') query then excludes the doc).
  await firestoreSetDoc(env, accessToken, `agents/${pcId}`, {
    client: newClient,
    clientId: newClientId,
  }, /* partial */ true);

  // Write 2: config doc. PARTIAL same reason.
  await firestoreSetDoc(env, accessToken, `agents/${pcId}/config/current`, {
    clientIdOverride: clientId || null,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  }, /* partial */ true);

  // Activity log
  ctx.waitUntil(logActivity(env, accessToken, {
    type: 'host_reassigned',
    actor: { type: 'admin', id: email },
    target: { type: 'host', id: pcId, label: hostname },
    client: newClient,
    details: {
      previousClient,
      previousClientId,
      newClient,
      newClientId,
      cleared: !clientId,
    },
  }));

  return jsonResponse({
    ok: true,
    pcId,
    client: newClient,
    clientId: newClientId,
    cleared: !clientId,
  }, 200);
}

// ═════════════════════════════════════════════════════════════════════
// POST /uninstall — agent phones home as it's being uninstalled
// ═════════════════════════════════════════════════════════════════════
//
// Called by the Inno Setup uninstaller from CurUninstallStepChanged
// (best-effort, fire-and-forget) before files are removed. Same Bearer
// install-token auth as /checkin so a random script can't spoof a
// decommission; the token is read out of config.json on the host.
//
// Marks the host decommissioned with source='agent-uninstall' so the
// dashboard can show "this agent was uninstalled at the host side" vs
// "an admin clicked Decommission in the dashboard".
//
// Idempotent: re-uninstalling (or a retry) just rewrites the same fields
// and re-stamps decommissionedAt. We don't error on already-decommissioned.
//
// Request body:
//   { pcId, hostname?, reason? }   reason is an optional free-text note
//
// Response:
//   200 { ok: true }            — even if Firestore is unhappy under the
//                                  hood, we never want to block the
//                                  uninstaller. Worker logs the failure.
//   401 { error }               — invalid/missing token (do nothing)
//   400 { error }               — missing pcId
async function handleUninstall(request, env, ctx) {
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const { pcId, hostname, reason } = body || {};
  if (!pcId || typeof pcId !== 'string') {
    return jsonResponse({ error: 'pcId required' }, 400);
  }

  // Confirm the agent doc exists before we PATCH — avoids creating a
  // stub /agents/{pcId} from a typo'd pcId.
  const agentDoc = await firestoreGetDoc(env, accessToken, `agents/${pcId}`);
  if (!agentDoc || !agentDoc.fields) {
    // The host was never registered (or already deleted). Treat as OK so
    // the uninstaller doesn't hang on a 404.
    return jsonResponse({ ok: true, noop: true }, 200);
  }

  const nowIso = new Date().toISOString();
  const resolvedHost = hostname
    || agentDoc.fields.hostname?.stringValue
    || pcId;
  const resolvedClient = agentDoc.fields.client?.stringValue || 'unknown';

  await firestoreSetDoc(env, accessToken, `agents/${pcId}`, {
    decommissioned: true,
    decommissionedAt: nowIso,
    decommissionedBy: 'agent-uninstall',
    decommissionedByEmail: null,
    decommissionedReason: reason || null,
  }, /* partial */ true);

  // Activity log: type matches the dashboard's icon mapping.
  ctx.waitUntil(logActivity(env, accessToken, {
    type: 'agent_uninstalled',
    actor: { type: 'agent', id: pcId },
    target: { type: 'host', id: pcId, label: resolvedHost },
    client: resolvedClient,
    details: { reason: reason || null, when: nowIso },
  }));

  // Optional email — same channel as IP-change / WSB failure alerts so
  // admins get a heads-up that an agent left the fleet on its own.
  if (env.RESEND_API_KEY) {
    ctx.waitUntil(
      sendUninstallEmail(env, {
        pcId,
        hostname: resolvedHost,
        client: resolvedClient,
        source: 'agent-uninstall',
        reason: reason || null,
        when: nowIso,
      }).catch((e) => console.error('Uninstall email failed:', e))
    );
  }

  return jsonResponse({ ok: true }, 200);
}

// ═════════════════════════════════════════════════════════════════════
// POST /decommission — admin marks a host decommissioned
// ═════════════════════════════════════════════════════════════════════
//
// Used for two scenarios:
//   1. Live host: admin wants to retire it. Sets decommissioned=true AND
//      schedules config.uninstall=true so the agent self-removes on its
//      next check-in. When the uninstaller phones /uninstall, this
//      decommissioned record will be overwritten with source='agent-
//      uninstall' to reflect that the agent actually left the box.
//   2. Dead host: agent is offline / hardware is gone / Windows was
//      wiped. Admin just wants to clean up the dashboard. Sets
//      decommissioned=true; the config.uninstall flag is set anyway but
//      will never be picked up (host won't check in again).
//
// Auth: Bearer Firebase ID token, verified + @umbrellaautomation.com.
//
// Body: { pcId, reason? }
async function handleAdminDecommission(request, env, ctx) {
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

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Body must be JSON' }, 400);
  }
  const { pcId, reason } = body || {};
  if (!pcId || typeof pcId !== 'string') {
    return jsonResponse({ error: 'pcId required' }, 400);
  }

  const accessToken = await getServiceAccountToken(env);
  const agentDoc = await firestoreGetDoc(env, accessToken, `agents/${pcId}`);
  if (!agentDoc || !agentDoc.fields) {
    return jsonResponse({ error: 'Agent not found' }, 404);
  }
  const resolvedHost = agentDoc.fields.hostname?.stringValue || pcId;
  const resolvedClient = agentDoc.fields.client?.stringValue || 'unknown';

  const nowIso = new Date().toISOString();

  // Mark decommissioned + schedule uninstall in parallel-ish (one PATCH
  // each). If the host is alive it'll pick up uninstall=true on next
  // check-in and the /uninstall ping will overwrite decommissionedBy.
  await firestoreSetDoc(env, accessToken, `agents/${pcId}`, {
    decommissioned: true,
    decommissionedAt: nowIso,
    decommissionedBy: 'admin',
    decommissionedByEmail: email,
    decommissionedReason: reason || null,
  }, /* partial */ true);
  await firestoreSetDoc(env, accessToken, `agents/${pcId}/config/current`, {
    uninstall: true,
    updatedAt: nowIso,
    updatedBy: email,
  }, /* partial */ true);

  ctx.waitUntil(logActivity(env, accessToken, {
    type: 'agent_decommissioned',
    actor: { type: 'admin', id: email },
    target: { type: 'host', id: pcId, label: resolvedHost },
    client: resolvedClient,
    details: { reason: reason || null, when: nowIso },
  }));

  return jsonResponse({ ok: true }, 200);
}

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
    note: 'This is a test event from the Watchtower dashboard. No real endpoint event occurred.',
  };

  // Adapt the sample payload to the receiver's expected shape (Google Chat,
  // Teams, Slack, Discord, generic). Without this, Google Chat returns
  // HTTP 400 "Unknown name 'event'", Teams classic silently drops the
  // message, etc.
  const adaptedBody = buildWebhookBody(targetUrl, samplePayload);

  let upstreamStatus = 0;
  let upstreamBody = '';
  let networkError = null;
  try {
    const r = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Watchtower-Webhook-Test/1.0' },
      body: JSON.stringify(adaptedBody),
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
    // Expose what we actually sent so the operator can debug payload-
    // shape issues without needing wrangler tail.
    sent: adaptedBody,
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

  let payload = null;

  // ----- 1. Try Firestore /settings/agentVersion (explicit override) -----
  // Operator-set; used to pin a specific version, or to point at a
  // staging build that isn't the most recent GitHub release yet. If set,
  // wins over the GitHub fallback below.
  try {
    const accessToken = await getServiceAccountToken(env);
    const doc = await firestoreGetDoc(env, accessToken, 'settings/agentVersion');
    const v = doc?.fields?.version?.stringValue;
    const u = doc?.fields?.downloadUrl?.stringValue;
    if (v && u) {
      payload = {
        ok: true,
        version: v,
        downloadUrl: u,
        sha256: doc.fields.sha256?.stringValue || null,
        notes: doc.fields.notes?.stringValue || null,
        updatedAt: doc.fields.updatedAt?.stringValue || null,
        source: 'settings',
      };
    }
  } catch (e) {
    // Non-fatal — fall through to GitHub
  }

  // ----- 2. Fall back to GitHub Releases API -----
  // When /settings/agentVersion isn't set, query the public Releases API
  // for the latest watchtower-v* tag. build.ps1 -Publish puts the EXE
  // there + writes "SHA256: <hex>" into the release notes which we parse.
  // This is the "zero-paste-required" path — after a Publish the Download
  // Installer button + auto-update awareness both work without the operator
  // touching Settings.
  if (!payload) {
    try {
      payload = await fetchLatestFromGitHub();
    } catch (e) {
      payload = { ok: false, error: 'no version published yet', detail: String(e).slice(0, 200) };
    }
  }

  const resp = jsonResponse(payload, 200);
  // Cache 5 min — agents check daily, dashboard polls on Settings page,
  // tray "Check for updates" is the only interactive caller. GitHub API
  // has a 60/hr unauthenticated rate limit so caching keeps us well clear.
  const cacheCopy = jsonResponse(payload, 200);
  cacheCopy.headers.set('Cache-Control', 'public, max-age=300');
  ctx.waitUntil(cache.put(cacheKey, cacheCopy));
  return resp;
}

async function fetchLatestFromGitHub() {
  // Pull the 10 most recent releases (not just /releases/latest, which
  // can return drafts or non-watchtower tags if the work repo grows other
  // products). Filter ourselves so we only ever match watchtower-v* tags.
  const r = await fetch('https://api.github.com/repos/frank-umbrella/work/releases?per_page=10', {
    headers: {
      'User-Agent': 'watchtower-worker',
      'Accept': 'application/vnd.github+json',
    },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const releases = await r.json();
  if (!Array.isArray(releases)) throw new Error('unexpected GitHub API response');

  // GitHub returns releases in an order that LOOKS like newest-first but
  // isn't reliable -- in practice we've seen v0.9.0 (oldest by date) come
  // back at index 0 ahead of v0.13.1 (newest). Probably ordered by some
  // internal release-id rather than created_at. So we filter to
  // watchtower-v* + non-draft + has the asset, then explicitly semver-sort
  // and take the highest. "Latest" = highest version number, which is what
  // an MSP operator means even if it happens to be older calendar-wise
  // than some weird out-of-band release.
  const candidates = releases
    .filter(rel => !rel.draft && /^watchtower-v/i.test(rel.tag_name || ''))
    .filter(rel => (rel.assets || []).some(a => /watchtower-setup\.exe$/i.test(a.name || '')));
  if (!candidates.length) throw new Error('no watchtower-v* release with Watchtower-Setup.exe asset found');

  const semverParts = (tag) => {
    return String(tag).replace(/^watchtower-v/i, '').split('.').map(p => parseInt(p, 10) || 0);
  };
  candidates.sort((a, b) => {
    const pa = semverParts(a.tag_name);
    const pb = semverParts(b.tag_name);
    while (pa.length < 3) pa.push(0);
    while (pb.length < 3) pb.push(0);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];   // descending
    }
    return 0;
  });
  const latest = candidates[0];

  const asset = (latest.assets || []).find(a => /watchtower-setup\.exe$/i.test(a.name || ''));
  // build.ps1 -Publish writes "Watchtower agent X.Y.Z. SHA256: <hex>" into
  // the release body. Parse out the hex; if missing, return null and let
  // the dashboard / agent decide how to handle (manual download = fine
  // without SHA, auto-update path refuses without SHA — see updater.py).
  const shaMatch = (latest.body || '').match(/SHA256:\s*([a-f0-9]{64})/i);
  return {
    ok: true,
    version: (latest.tag_name || '').replace(/^watchtower-v/i, ''),
    downloadUrl: asset.browser_download_url,
    sha256: shaMatch ? shaMatch[1].toLowerCase() : null,
    notes: latest.body || latest.name || null,
    updatedAt: latest.published_at || latest.created_at || null,
    source: 'github',
  };
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
  //
  // The per-PC config can override this with clientIdOverride — set via
  // POST /reassign-client when the admin needs to fix a mislabeled host.
  // The override is applied below after we've read the config doc.
  let resolvedClient = auth.client || client || 'unknown';
  let resolvedClientId = auth.clientId || null;

  // ----- 3. Fetch existing status doc to detect IP changes + backup-failure transitions -----
  const existing = await firestoreGetDoc(env, accessToken, `agents/${pcId}`);
  const previousExternalIp = existing?.fields?.externalIp?.stringValue || null;
  const newExternalIp = report?.network?.externalIp || null;
  const ipChanged = previousExternalIp !== null && newExternalIp !== null && previousExternalIp !== newExternalIp;
  const firstSeen = existing === null;
  const nowIso = new Date().toISOString();

  // ----- 3z. Reactivation: a check-in from a previously decommissioned host -----
  // Could happen for a few reasons:
  //   - admin clicked Decommission, then changed mind before the agent
  //     received uninstall=true
  //   - host was offline at decommission time, came back online before
  //     the uninstall flag could be applied
  //   - somebody reinstalled with the same pcId (config.json preserved
  //     across re-install — see ExtractExistingPcId in the .iss)
  // In every case the right move is to clear the decommissioned fields
  // and log a reactivation event. The uninstall config flag stays where
  // it is — the agent will see it on this same response and act if it's
  // set; if it's not (e.g. admin cleared it), nothing happens.
  const wasDecommissioned = existing?.fields?.decommissioned?.booleanValue === true;

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

  // ----- 4a. Apply clientIdOverride if the admin reassigned the host -----
  if (config.clientIdOverride) {
    const overrideDoc = await firestoreGetDoc(env, accessToken, `clients/${config.clientIdOverride}`);
    if (overrideDoc && overrideDoc.fields) {
      resolvedClientId = config.clientIdOverride;
      resolvedClient = overrideDoc.fields.name?.stringValue || resolvedClient;
    }
    // If the client doc was deleted out from under the override, fall
    // back silently to the token-bound value rather than crashing the
    // check-in. Operator can clean up by clearing the override in the UI.
  }

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
    // Clear decommissioned flags on any successful check-in — a live
    // agent reporting in is the definition of "not decommissioned." If
    // the host was flagged, we log a reactivation activity entry below.
    ...(wasDecommissioned ? {
      decommissioned: false,
      decommissionedAt: null,
      decommissionedBy: null,
      decommissionedByEmail: null,
      decommissionedReason: null,
    } : {}),
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

  // ----- 6a. Activity log entries for significant events -----
  // first_seen + ip_change get explicit activity entries here. OMSA + WSB
  // events are logged inside their notification blocks below alongside
  // the email/webhook fires (they share the same transition detection).
  if (firstSeen) {
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'host_first_seen',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: { agentVersion: agentVersion || 'unknown', externalIp: newExternalIp },
    }));
  }
  if (ipChanged) {
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'ip_change',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: { previousIp: previousExternalIp, newIp: newExternalIp },
    }));
  }
  if (wasDecommissioned) {
    // Pull the original decommission metadata off the previous doc so
    // the activity entry says "reactivated after admin decommission on
    // <date>" rather than just "reactivated."
    const prevBy = existing?.fields?.decommissionedBy?.stringValue || null;
    const prevAt = existing?.fields?.decommissionedAt?.timestampValue
      || existing?.fields?.decommissionedAt?.stringValue
      || null;
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'agent_reactivated',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: { previousDecommissionedBy: prevBy, previousDecommissionedAt: prevAt },
    }));
  }

  // ----- 6b. First-time intake email + webhook -----
  // When this is the host's first check-in (no previous /agents/{pcId}
  // doc), notify the admin via whichever channels are configured. The
  // email is the comprehensive HTML report; the webhook gets a compact
  // structured payload so chat channels (Teams / Slack / Google Chat)
  // get the "new endpoint joined" ping at the same time the email lands.
  // Both fire exactly once per pcId — firstSeen only triggers before the
  // first setDoc above.
  if (firstSeen && config.enabled) {
    if (config.emailEnabled && env.RESEND_API_KEY) {
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
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
      // Match the shape of the other event webhooks (event + pcId + hostname
      // + client + when + relevant extras). humanSummary() in postWebhook
      // turns event='host_onboarded' into a readable line for chat receivers.
      const sys = report?.system || {};
      const os = sys.os || {};
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'host_onboarded',
          pcId,
          hostname,
          client: resolvedClient,
          agentVersion: agentVersion || 'unknown',
          when: nowIso,
          externalIp: newExternalIp,
          manufacturer: sys.manufacturer || null,
          model: sys.model || null,
          serviceTag: sys.serviceTag || null,
          os: os.name || null,
        }).catch((e) => console.error('Intake webhook failed:', e))
      );
    }
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
    // Default-on when a URL exists: webhookEnabled === false is the only
    // way to silence webhooks on a host that has an effective URL. null
    // (never explicitly set) reads as "on" so a new master URL starts
    // firing across the fleet immediately.
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
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

  // ----- 7a. Notify on new OMSA storage warning -----
  // Fires once on the OK -> warn/bad transition. The omsaFirstWarnAt
  // computation above gives us transition detection for free:
  //   omsaIsNonOk && !omsaPrevWarnAt  =  fresh warning
  // Persistent warnings (omsaIsNonOk && omsaPrevWarnAt) don't re-fire.
  // Re-fires only after the warning clears (back to OK) and reappears.
  const omsaNewWarning = omsaIsNonOk && !omsaPrevWarnAt;
  const omsaCleared = !omsaIsNonOk && omsaPrevWarnAt;
  if (omsaNewWarning && config.enabled) {
    const issues = extractOmsaIssues(omsaCurrent);
    // Activity entry for the warning start
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'omsa_warning',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: { rollup: omsaRollup, issues, omsaVersion: omsaCurrent?.version || null },
    }));
    if (config.emailEnabled && env.RESEND_API_KEY) {
      ctx.waitUntil(
        sendOmsaWarningEmail(env, {
          pcId,
          hostname,
          client: resolvedClient,
          rollup: omsaRollup,
          version: omsaCurrent?.version || null,
          issues,
          when: nowIso,
        }).catch((e) => console.error('OMSA email failed:', e))
      );
    }
    // Default-on when a URL exists: webhookEnabled === false is the only
    // way to silence webhooks on a host that has an effective URL. null
    // (never explicitly set) reads as "on" so a new master URL starts
    // firing across the fleet immediately.
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'omsa_warning',
          pcId,
          hostname,
          client: resolvedClient,
          rollup: omsaRollup,
          omsaVersion: omsaCurrent?.version || null,
          issues,
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

    // Activity entry for the new failed attempt
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'wsb_failure',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: {
        result: wsbCurrentResult,
        attemptedAt: wsbCurrentTime,
        lastSuccess,
        daysSinceSuccess,
        detail: wsbCurrent?.detail || null,
      },
    }));

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
    // Default-on when a URL exists: webhookEnabled === false is the only
    // way to silence webhooks on a host that has an effective URL. null
    // (never explicitly set) reads as "on" so a new master URL starts
    // firing across the fleet immediately.
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
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
  // Resolve webhookEnabled tristate to the effective boolean the agent
  // would see, so state.json / tray reflect runtime behavior rather
  // than the stored opt-in state. null → effective from URL presence.
  const effectiveWebhookEnabled = config.webhookEnabled === false
    ? false
    : Boolean(effectiveWebhookUrl);
  return jsonResponse({
    ok: true,
    config: {
      enabled: config.enabled,
      emailEnabled: config.emailEnabled,
      webhookEnabled: effectiveWebhookEnabled,
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
  // webhookEnabled is *tristate* (true / false / null) -- null means
  // "never explicitly set by the admin." The firing site interprets null
  // as "on iff an effective webhook URL exists" (master or per-host),
  // so a brand-new client that gets the master URL added under Settings
  // starts firing webhooks across every existing host without anyone
  // having to flip a switch. Explicit `false` is still the way to
  // silence webhooks on a single host.
  const defaults = {
    enabled: true,
    emailEnabled: true,
    webhookEnabled: null,
    webhookUrl: null,
    uninstall: false,
    autoUpdate: false,  // safety default — opt-in per host
    clientIdOverride: null,
  };
  if (!doc || !doc.fields) return defaults;
  return {
    enabled: fieldBool(doc.fields.enabled, defaults.enabled),
    emailEnabled: fieldBool(doc.fields.emailEnabled, defaults.emailEnabled),
    webhookEnabled: fieldBoolTristate(doc.fields.webhookEnabled),
    webhookUrl: doc.fields.webhookUrl?.stringValue || null,
    uninstall: fieldBool(doc.fields.uninstall, defaults.uninstall),
    autoUpdate: fieldBool(doc.fields.autoUpdate, defaults.autoUpdate),
    clientIdOverride: doc.fields.clientIdOverride?.stringValue || null,
  };
}

// Like fieldBool but returns null when the field doesn't exist at all.
// Used by webhookEnabled so the firing site can distinguish "admin
// explicitly opted out" (false) from "admin never touched it" (null).
function fieldBoolTristate(field) {
  if (!field) return null;
  if ('booleanValue' in field) return field.booleanValue;
  return null;
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
      <p style="color:#475063; margin:0 0 18px; font-size:14px;"><b>${escapeHtml(hostname)}</b> joined Watchtower at ${escapeHtml(when)}. Below is the intake report from its first check-in — a one-time summary so you have a record of what was on this machine when it came in. Future check-ins won't send this email.</p>

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
        View full details at the <a href="https://frank-umbrella.github.io/work/watchtower/" style="color:#0a6b6b;">Watchtower dashboard</a> → click <b>${escapeHtml(hostname)}</b> in the Endpoints tab.
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
// Activity log writer — both worker (agent events) and dashboard
// (admin actions) append to /activity. Doc id is a sortable timestamp
// prefix + short random suffix, matching the /history convention so a
// burst of events from one check-in is naturally ordered.
//
// Fire-and-forget (no await) when called from handleCheckin — activity
// logging shouldn't block the agent's response on Firestore latency.
// ─────────────────────────────────────────────────────────────────────
async function logActivity(env, accessToken, event) {
  const nowIso = new Date().toISOString();
  const id = `${nowIso.replace(/[:.]/g, '-')}-${randomShortId()}`;
  try {
    await firestoreSetDoc(env, accessToken, `activity/${id}`, {
      ts: nowIso,
      ...event,
    });
  } catch (e) {
    console.error('Activity log write failed:', e, event);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Extract OMSA issue list — strings describing each non-OK disk / array
// for the email + webhook payloads. Same view the dashboard's red
// callout shows, but flattened for non-HTML consumers.
// ─────────────────────────────────────────────────────────────────────
function extractOmsaIssues(omsa) {
  if (!omsa) return [];
  const issues = [];
  for (const vd of (omsa.virtualDisks || [])) {
    if (vd.status && vd.status.toLowerCase() !== 'ok') {
      issues.push(`Virtual disk ${vd.name || vd.id}: ${vd.status}${vd.state ? ` / ${vd.state}` : ''}${vd.layout ? ` (${vd.layout})` : ''}`);
    }
  }
  for (const pd of (omsa.physicalDisks || [])) {
    if (pd.status && pd.status.toLowerCase() !== 'ok') {
      issues.push(`Physical disk ${pd.id || pd.name} on controller ${pd.controllerId}: ${pd.status}${pd.product ? ` (${pd.product})` : ''}`);
    }
    if ((pd.predictiveFailure || '').toLowerCase() === 'yes') {
      issues.push(`Physical disk ${pd.id || pd.name}: SMART predictive failure flagged`);
    }
  }
  return issues;
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — OMSA storage warning
// ─────────────────────────────────────────────────────────────────────
async function sendOmsaWarningEmail(env, { pcId, hostname, client, rollup, version, issues, when }) {
  const sevLabel = rollup === 'bad' ? 'CRITICAL' : 'WARNING';
  const sevColor = rollup === 'bad' ? '#b00' : '#b4632b';
  const subject = `Watchtower: OMSA ${sevLabel} — ${hostname} (${client})`;
  const issuesHtml = issues.length
    ? `<ul style="margin:6px 0 0 16px; padding:0;">${issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : `<i>No per-disk detail in this check-in.</i>`;
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#222; max-width:640px;">
      <h2 style="color:${sevColor}; margin:0 0 12px;">Dell OMSA storage health: ${sevLabel}</h2>
      <p style="color:#475063; margin:0 0 16px; font-size:14px;">
        ${escapeHtml(hostname)} (${escapeHtml(client)}) is reporting OMSA rollup <b style="color:${sevColor};">${escapeHtml(rollup)}</b>.
      </p>
      <table cellpadding="6" style="border-collapse:collapse; font-size:14px; margin-bottom:16px;">
        <tr><td style="color:#666; width:120px;">Host</td><td><b>${escapeHtml(hostname)}</b></td></tr>
        <tr><td style="color:#666;">Client</td><td>${escapeHtml(client)}</td></tr>
        <tr><td style="color:#666;">OMSA version</td><td>${escapeHtml(version || '?')}</td></tr>
        <tr><td style="color:#666;">Detected at</td><td>${escapeHtml(when)}</td></tr>
        <tr><td style="color:#666;">pcId</td><td><code style="font-size:12px;">${escapeHtml(pcId)}</code></td></tr>
      </table>
      <div style="background:#fef3c7; border:1px solid #fde68a; color:#78350f; padding:10px 14px; border-radius:8px; font-size:13.5px;">
        <b>What needs attention:</b>
        ${issuesHtml}
      </div>
      <p style="color:#888; font-size:12px; margin-top:24px;">
        Sent once per OMSA warning episode (dedupe by omsaFirstWarnAt). You won't get a second email for the same incident; if it clears and reappears, the cycle restarts.
        Silence per-host: flip <code>emailEnabled</code> off in the host's drawer.
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
// Resend email — agent uninstalled at the host side
// ─────────────────────────────────────────────────────────────────────
// Fires once from the /uninstall endpoint. Distinct from the admin's
// own click of "Decommission" in the dashboard, which doesn't email
// (the admin's already aware they did it). This email is the heads-up
// that someone (or something) removed the agent on the box itself.
async function sendUninstallEmail(env, { pcId, hostname, client, source, reason, when }) {
  const subject = `Watchtower: agent uninstalled — ${hostname} (${client})`;
  const sourceLabel = source === 'agent-uninstall'
    ? 'Uninstalled at the host (Control Panel or operator-initiated)'
    : source === 'admin'
      ? 'Marked decommissioned by an admin from the dashboard'
      : `source: ${source || 'unknown'}`;
  const html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#222; max-width:600px;">
      <h2 style="color:#475063; margin:0 0 12px;">Agent decommissioned</h2>
      <p style="color:#475063; margin:0 0 16px; font-size:14px;">
        <b>${escapeHtml(hostname)}</b> (${escapeHtml(client)}) has been removed from Watchtower.
        ${escapeHtml(sourceLabel)}.
      </p>
      <table cellpadding="6" style="border-collapse:collapse; font-size:14px;">
        <tr><td style="color:#666; width:120px;">Host</td><td><b>${escapeHtml(hostname)}</b></td></tr>
        <tr><td style="color:#666;">Client</td><td>${escapeHtml(client)}</td></tr>
        <tr><td style="color:#666;">Source</td><td><code>${escapeHtml(source || 'unknown')}</code></td></tr>
        <tr><td style="color:#666;">When</td><td>${escapeHtml(when)}</td></tr>
        ${reason ? `<tr><td style="color:#666;">Reason</td><td>${escapeHtml(reason)}</td></tr>` : ''}
        <tr><td style="color:#666;">pcId</td><td><code style="font-size:12px;">${escapeHtml(pcId)}</code></td></tr>
      </table>
      <p style="color:#888; font-size:12px; margin-top:24px;">
        The host's row stays in the dashboard with a Decommissioned badge until you delete it.
        If the same machine is re-installed with the Watchtower agent (preserving its pcId),
        it'll automatically reactivate on next check-in.
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
//
// Routes through buildWebhookBody so the JSON shape matches the receiver
// the operator pointed us at. Google Chat / Discord / Teams / Slack each
// want different shapes; without adaptation a Google Chat URL returns
// HTTP 400 "Unknown name 'event'", a Teams classic connector silently
// drops the message, etc.
async function postWebhook(url, payload) {
  const body = buildWebhookBody(url, payload);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Watchtower-Worker/1.0' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Webhook ${url} returned ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Webhook payload adapter — match the receiver's required shape
// ─────────────────────────────────────────────────────────────────────
//
// Detection by URL host. We always include the raw structured payload
// (under the `watchtower` key for generic receivers, or alongside the
// receiver-specific fields for ones that ignore extra keys) so n8n /
// Zapier / custom HTTP receivers can pull the structured data, while
// chat receivers render the human-readable summary.
//
// Adds:
//   Google Chat (chat.googleapis.com)       → { text }
//   Discord (discord.com|discordapp.com)    → { content }
//   Teams classic (outlook.office.com,
//                  webhook.office.com)      → MessageCard
//   Slack (hooks.slack.com)                 → { text, attachments }
//   Generic / unknown                       → { text, ...payload }
function buildWebhookBody(url, payload) {
  const summary = humanSummary(payload);
  const u = (url || '').toLowerCase();

  // Google Chat — strict schema, drops the connection if extra fields exist
  if (u.includes('chat.googleapis.com')) {
    return { text: summary };
  }
  // Discord — uses `content` not `text`
  if (u.includes('discord.com/api/webhooks') || u.includes('discordapp.com/api/webhooks')) {
    return { content: summary };
  }
  // Microsoft Teams classic connectors. Workflows-based Teams webhooks
  // accept Adaptive Cards; sending MessageCard to a Workflows endpoint
  // still renders, just without the card styling — acceptable fallback.
  if (u.includes('outlook.office.com') || u.includes('webhook.office.com') || u.includes('.office.com/webhook')) {
    const facts = [];
    if (payload.hostname) facts.push({ name: 'Host', value: String(payload.hostname) });
    if (payload.client) facts.push({ name: 'Client', value: String(payload.client) });
    if (payload.event) facts.push({ name: 'Event', value: String(payload.event) });
    if (payload.when) facts.push({ name: 'When', value: String(payload.when) });
    if (payload.previousIp && payload.newIp) {
      facts.push({ name: 'Previous IP', value: String(payload.previousIp) });
      facts.push({ name: 'New IP', value: String(payload.newIp) });
    }
    if (payload.result) facts.push({ name: 'Result', value: String(payload.result) });
    if (payload.rollup) facts.push({ name: 'OMSA rollup', value: String(payload.rollup) });
    const color = (payload.event === 'wsb_backup_failed' || payload.event === 'omsa_warning')
      ? 'd04646'
      : payload.event === 'agent_uninstalled' || payload.event === 'agent_decommissioned'
        ? '6b7280'
        : '0a6b6b';
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: summary.slice(0, 250),
      themeColor: color,
      title: 'Watchtower',
      text: summary,
      sections: facts.length ? [{ facts }] : undefined,
    };
  }
  // Slack — `text` is mandatory; extra fields beyond text/attachments/blocks
  // are silently ignored by Slack itself, which is fine.
  if (u.includes('hooks.slack.com')) {
    return { text: summary, watchtower: payload };
  }
  // Generic / unknown receivers (n8n, Zapier, Make, custom HTTP endpoints).
  // Send everything: a `text` summary that chat-style receivers will pick
  // up, plus all the original structured fields for receivers that want
  // structured data.
  return { text: summary, ...payload };
}

function humanSummary(p) {
  if (!p || typeof p !== 'object') return 'Watchtower event';
  const host = p.hostname || '?';
  const client = p.client || 'unknown';
  switch (p.event) {
    case 'test':
      return `Watchtower test event from ${p.triggeredBy || 'dashboard'} at ${p.when || new Date().toISOString()}`;
    case 'host_onboarded':
      return `Watchtower: new endpoint joined — ${host} (${client})${p.manufacturer || p.model ? ` · ${[p.manufacturer, p.model].filter(Boolean).join(' ')}` : ''}${p.os ? ` · ${p.os}` : ''}${p.externalIp ? ` · IP ${p.externalIp}` : ''}`;
    case 'external_ip_changed':
      return `Watchtower: external IP changed on ${host} (${client}): ${p.previousIp || '?'} → ${p.newIp || '?'}`;
    case 'omsa_warning':
      return `Watchtower: OMSA ${p.rollup || 'warn'} on ${host} (${client})${(p.issues && p.issues.length) ? ` — ${p.issues.slice(0, 3).join('; ')}` : ''}`;
    case 'wsb_backup_failed':
      return `Watchtower: backup failed on ${host} (${client}). Result: ${p.result || '?'}${p.daysSinceSuccess != null ? `, ${p.daysSinceSuccess}d since last success` : ''}`;
    case 'agent_uninstalled':
      return `Watchtower: agent uninstalled on ${host} (${client})${p.reason ? ` — ${p.reason}` : ''}`;
    case 'agent_decommissioned':
      return `Watchtower: ${host} (${client}) marked decommissioned by admin`;
    default:
      return `Watchtower event: ${p.event || 'unknown'} on ${host} (${client})`;
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

// Firestore PATCH. CRITICAL: Firestore's REST API PATCH with no
// updateMask REPLACES the entire document with just the fields in the
// request body -- it does NOT merge. So a caller writing only
// { client, clientId } would wipe hostname, lastCheckin, externalIp,
// report, and everything else. That bug bit handleReassignClient and
// silently broke decommission / uninstall too: the next agent check-in
// repopulated everything, masking the issue, but a host that hadn't
// checked in yet became invisible to the dashboard (which queries
// orderBy('lastCheckin', 'desc'), and orderBy excludes docs missing
// the ordered field).
//
// Signature now takes an OPTIONAL `partial` flag (default false ->
// full-replace behavior, matching the original handleCheckin call
// site which DOES write the entire doc shape on every check-in).
// Partial-update callers pass `partial: true` -- we build an
// updateMask from the field keys so only those fields change.
//
// Usage:
//   firestoreSetDoc(env, t, path, obj)             // full replace (default)
//   firestoreSetDoc(env, t, path, obj, true)       // partial update via mask
async function firestoreSetDoc(env, accessToken, path, jsObject, partial = false) {
  const fields = {};
  const fieldKeys = [];
  for (const [k, v] of Object.entries(jsObject)) {
    if (v === undefined) continue;
    fields[k] = jsToFsValue(v);
    fieldKeys.push(k);
  }
  let url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  if (partial && fieldKeys.length) {
    // updateMask.fieldPaths must be repeated per field. URL-encode each.
    const maskParams = fieldKeys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    url += `?${maskParams}`;
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
