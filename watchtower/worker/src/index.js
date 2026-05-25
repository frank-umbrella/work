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

    if (url.pathname === '/rename-client' && request.method === 'POST') {
      return withCors(await handleRenameClient(request, env, ctx), env, request);
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

    // POST /force-update — admin pushes "install latest version on next
    // check-in" to a single host without flipping the per-host autoUpdate
    // toggle on permanently. Writes a one-shot flag to the agent's config
    // doc; agent applies it next time it checks in (within 24h max) and
    // the flag self-clears once the new version is reported.
    if (url.pathname === '/force-update' && request.method === 'POST') {
      return withCors(await handleForceUpdate(request, env, ctx), env, request);
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
// POST /rename-client — rename a client + cascade through agents / tokens
// ═════════════════════════════════════════════════════════════════════
//
// Admin-only. Auth via Firebase ID token with verified
// @umbrellaautomation.com email (same gate as /reassign-client).
//
// Why a worker endpoint rather than dashboard-direct writes:
//   * /agents/{pcId} is service-account-only per firestore.rules
//     (allow create/update/delete: if false). Admins read it directly
//     but can't mutate, so the cascade has to happen here.
//   * Atomicity matters -- if we rename /clients/{id}.name but leave
//     /agents/* and /install_tokens/* showing the stale name, the UI
//     looks inconsistent until each agent's next check-in eventually
//     overwrites it. Doing all writes in one server-side call closes
//     that window.
//
// Request body:  { clientId, newName }
// Response:      { ok, clientId, oldName, newName, cascadedAgents, cascadedTokens }
async function handleRenameClient(request, env, ctx) {
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
  const { clientId, newName } = body || {};
  if (!clientId || typeof clientId !== 'string') {
    return jsonResponse({ error: 'clientId required' }, 400);
  }
  const trimmed = (newName || '').trim();
  if (!trimmed) {
    return jsonResponse({ error: 'newName required (non-empty)' }, 400);
  }
  if (trimmed.length > 80) {
    return jsonResponse({ error: 'newName too long (max 80 chars)' }, 400);
  }

  const accessToken = await getServiceAccountToken(env);

  // Confirm the client doc exists + capture the old name for the activity log.
  const clientDoc = await firestoreGetDoc(env, accessToken, `clients/${clientId}`);
  if (!clientDoc || !clientDoc.fields) {
    return jsonResponse({ error: 'Client not found' }, 404);
  }
  const oldName = clientDoc.fields.name?.stringValue || '(unnamed)';
  if (oldName === trimmed) {
    // No-op -- short-circuit so we don't pollute the activity log with
    // identity renames (fat-fingered Save after the modal opens).
    return jsonResponse({ ok: true, clientId, oldName, newName: trimmed, cascadedAgents: 0, cascadedTokens: 0, noop: true }, 200);
  }

  // Write 1: the canonical client name. PARTIAL so we don't wipe
  // createdAt / notes / etc.
  await firestoreSetDoc(env, accessToken, `clients/${clientId}`, {
    name: trimmed,
    renamedAt: new Date().toISOString(),
    renamedBy: email,
  }, /* partial */ true);

  // Write 2: cascade to every /agents doc carrying the old denorm name.
  // Match on clientId (the stable identifier), not the name, in case
  // some agent doc has a stale name we want to fix at the same time.
  const agentPcIds = await firestoreQueryDocIds(env, accessToken, 'agents', 'clientId', clientId);
  for (const pcId of agentPcIds) {
    try {
      await firestoreSetDoc(env, accessToken, `agents/${pcId}`, {
        client: trimmed,
      }, /* partial */ true);
    } catch (e) {
      // Don't abort the whole rename if one agent doc is wedged --
      // log and continue; the next check-in from that host will fix
      // its own client field from the resolved token-bound value.
      console.error(`Rename cascade: agent ${pcId} update failed (non-fatal):`, e);
    }
  }

  // Write 3: cascade to every /install_tokens doc bound to this client.
  // Same denorm: tokens carry a `client` string for UI display.
  const tokenHashes = await firestoreQueryDocIds(env, accessToken, 'install_tokens', 'clientId', clientId);
  for (const hash of tokenHashes) {
    try {
      await firestoreSetDoc(env, accessToken, `install_tokens/${hash}`, {
        client: trimmed,
      }, /* partial */ true);
    } catch (e) {
      console.error(`Rename cascade: token ${hash.slice(0, 8)} update failed (non-fatal):`, e);
    }
  }

  ctx.waitUntil(logActivity(env, accessToken, {
    type: 'client_renamed',
    actor: { type: 'admin', id: email },
    target: { type: 'client', id: clientId, label: trimmed },
    client: trimmed,
    details: {
      oldName,
      newName: trimmed,
      cascadedAgents: agentPcIds.length,
      cascadedTokens: tokenHashes.length,
    },
  }));

  return jsonResponse({
    ok: true,
    clientId,
    oldName,
    newName: trimmed,
    cascadedAgents: agentPcIds.length,
    cascadedTokens: tokenHashes.length,
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
// POST /force-update — admin pushes "install latest now" for one host
// ═════════════════════════════════════════════════════════════════════
//
// One-shot opt-in: writes `forceUpdate: true` to /agents/{pcId}/config
// /current. The agent's checkin.py reads the config returned by
// /checkin and runs the updater whenever EITHER forceUpdate OR
// autoUpdate is true -- so flipping forceUpdate on without touching the
// permanent autoUpdate toggle works as a one-time push.
//
// Self-clearing: handleCheckin clears the flag once the agent's
// reported agentVersion matches the worker's latest available version
// (i.e. the update landed). If the operator clicks Force Update on a
// host already at latest, the flag clears on the next check-in without
// the agent doing anything -- safe no-op.
//
// Latency: the agent's check-in cadence is 24h by default. The toast
// in the dashboard tells the operator this so they don't expect
// instant. For instant, the operator can right-click the tray icon
// on the host itself and pick "Check for updates."
//
// Auth: Bearer Firebase ID token, verified + @umbrellaautomation.com.
// Body: { pcId }
async function handleForceUpdate(request, env, ctx) {
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
  const { pcId } = body || {};
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
  const currentVersion = agentDoc.fields.agentVersion?.stringValue || 'unknown';

  const nowIso = new Date().toISOString();
  await firestoreSetDoc(env, accessToken, `agents/${pcId}/config/current`, {
    forceUpdate: true,
    forceUpdateRequestedAt: nowIso,
    forceUpdateRequestedBy: email,
    updatedAt: nowIso,
    updatedBy: email,
  }, /* partial */ true);

  ctx.waitUntil(logActivity(env, accessToken, {
    type: 'force_update_requested',
    actor: { type: 'admin', id: email },
    target: { type: 'host', id: pcId, label: resolvedHost },
    client: resolvedClient,
    details: { currentVersion, when: nowIso },
  }));

  return jsonResponse({ ok: true, pcId, currentVersion }, 200);
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

  // Slim variant = Watchtower-Setup.exe (no LogMeIn, smaller download).
  // Bundled variant = Watchtower-Setup-LogMeIn.exe (includes LMI MSI).
  // The build workflow publishes both when bundles/LogMeIn.msi is
  // committed; only the slim variant when it isn't.
  const slimAsset = (latest.assets || []).find(a => /^watchtower-setup\.exe$/i.test(a.name || ''));
  const lmiAsset  = (latest.assets || []).find(a => /^watchtower-setup-logmein\.exe$/i.test(a.name || ''));

  // build.ps1 -Publish writes "Watchtower agent X.Y.Z. SHA256: <hex>"
  // into the release body for EACH asset. Body now has TWO SHA lines
  // (one per variant) so we parse them by filename context. If only
  // one variant exists the body has just one SHA line.
  const body = latest.body || '';
  const slimShaMatch = body.match(/Watchtower-Setup\.exe[^]*?SHA256:\s*([a-f0-9]{64})/i)
                    || body.match(/SHA256:\s*([a-f0-9]{64})/i);  // single-line legacy fallback
  const lmiShaMatch  = body.match(/Watchtower-Setup-LogMeIn\.exe[^]*?SHA256:\s*([a-f0-9]{64})/i);

  return {
    ok: true,
    version: (latest.tag_name || '').replace(/^watchtower-v/i, ''),
    // Primary download = slim. Dashboard's chooser modal uses this
    // when the operator picks "Without LogMeIn". Agent auto-updater
    // also uses this URL (auto-update never wants LogMeIn -- it
    // would surprise-install something the host might have opted
    // out of originally).
    downloadUrl: slimAsset ? slimAsset.browser_download_url : null,
    sha256: slimShaMatch ? slimShaMatch[1].toLowerCase() : null,
    // Bundled variant fields. Null when the release didn't include
    // a LogMeIn-bundled asset (bundles/LogMeIn.msi not committed
    // when this version was built). Dashboard chooser hides the
    // "With LogMeIn" option in that case.
    downloadUrlWithLogmein: lmiAsset ? lmiAsset.browser_download_url : null,
    sha256WithLogmein: lmiShaMatch ? lmiShaMatch[1].toLowerCase() : null,
    notes: body || latest.name || null,
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
      // Was `GET, OPTIONS` -- which silently blocked the dashboard's
      // POST calls to /reassign-client, /decommission, /force-update,
      // /test-webhook. The browser's preflight check requires the
      // method to be in this list; POST not present -> browser aborts
      // with "Failed to fetch" before the request leaves the page.
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  // ----- 3e. Track low C: drive capacity -----
  // Walks report.storage.volumes looking for the system drive (C:) and
  // emits cDriveFreeGB / cDriveFreePct as top-level fields so the
  // dashboard can render them without descending into the report tree.
  // Warning thresholds: <10% free OR <10 GB free (whichever fires
  // first). Critical thresholds: <5% free OR <5 GB free. Same first-
  // warn-timestamp pattern as OMSA so we don't email/webhook the
  // operator every 24h while the warning persists -- one notification
  // per OK->low transition, no notifications for continued-low.
  let cDriveFreeGB = null;
  let cDriveFreePct = null;
  let cDriveSizeGB = null;
  const volumes = report?.storage?.volumes;
  if (Array.isArray(volumes)) {
    const cVol = volumes.find(v => (v?.letter || '').toUpperCase() === 'C:');
    if (cVol && typeof cVol.sizeGB === 'number' && typeof cVol.freeGB === 'number' && cVol.sizeGB > 0) {
      cDriveSizeGB = cVol.sizeGB;
      cDriveFreeGB = cVol.freeGB;
      cDriveFreePct = Math.round((cVol.freeGB / cVol.sizeGB) * 1000) / 10;
    }
  }
  const cDriveIsLow = (
    (cDriveFreePct !== null && cDriveFreePct < 10) ||
    (cDriveFreeGB !== null && cDriveFreeGB < 10)
  );
  const cDriveIsCritical = (
    (cDriveFreePct !== null && cDriveFreePct < 5) ||
    (cDriveFreeGB !== null && cDriveFreeGB < 5)
  );
  const cDrivePrevWarnAt = existing?.fields?.cDriveLowFirstWarnAt?.stringValue || null;
  let cDriveLowFirstWarnAt;
  if (cDriveIsLow && !cDrivePrevWarnAt) {
    cDriveLowFirstWarnAt = nowIso;   // OK -> low transition this checkin
  } else if (!cDriveIsLow) {
    cDriveLowFirstWarnAt = null;     // recovered (or no measurement)
  } else {
    cDriveLowFirstWarnAt = cDrivePrevWarnAt;  // still low, preserve start
  }
  // "New warning" = the same OK->low transition we use for emails.
  const cDriveNewWarning = cDriveIsLow && !cDrivePrevWarnAt;

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

  // ----- 3f. Detect aged primary backup disk (warn-level advisory) -----
  // Picks the target whose newestBackup is the latest -- that's the disk
  // currently being written to. Computes age as (now - that target's
  // oldestBackup). Mirrors the dashboard's backupDiskAgeFinding() so the
  // server-side trigger and the UI agree on which target is "primary."
  //
  // Threshold comes from /settings/backupDiskAge.thresholdDays (admin-
  // configurable from the dashboard's Settings tab); falls back to 913
  // days (~2.5y) when the setting is absent or unparseable. Same default
  // as the dashboard's BACKUP_DISK_AGE_DEFAULT_DAYS constant.
  const backupAgeSettingDoc = await firestoreGetDoc(env, accessToken, 'settings/backupDiskAge');
  const backupAgeThresholdRaw = backupAgeSettingDoc?.fields?.thresholdDays?.integerValue
    ?? backupAgeSettingDoc?.fields?.thresholdDays?.doubleValue
    ?? null;
  const backupAgeThresholdDays = (backupAgeThresholdRaw && Number(backupAgeThresholdRaw) > 0)
    ? Number(backupAgeThresholdRaw)
    : 913;
  const backupAgedFinding = pickPrimaryAgedBackupDisk(wsbCurrent, backupAgeThresholdDays);
  const backupDiskAged = backupAgedFinding !== null && backupAgedFinding.exceeds;
  const backupDiskAgePrevWarnAt = existing?.fields?.backupDiskAgeFirstWarnAt?.stringValue || null;
  let backupDiskAgeFirstWarnAt;
  if (backupDiskAged && !backupDiskAgePrevWarnAt) {
    backupDiskAgeFirstWarnAt = nowIso;
  } else if (!backupDiskAged) {
    backupDiskAgeFirstWarnAt = null;
  } else {
    backupDiskAgeFirstWarnAt = backupDiskAgePrevWarnAt;
  }
  const backupDiskAgedNewWarning = backupDiskAged && !backupDiskAgePrevWarnAt;

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
  // Promote the Hyper-V parent host name (if any) to a top-level field
  // so the dashboard can do a cheap match against state.agents[].hostname
  // without descending into report.system.physicalHost on every row.
  // Always null on physical hosts and on non-Hyper-V guests; set to the
  // bare NetBIOS name for matching when the guest's Integration Services
  // exposed it (see system.py _hyperv_parent_host).
  const newPhysicalHost = report?.system?.physicalHost?.name || null;

  // ----- 4d. Connectivity history (v0.14.27+ agents) -----
  // The agent now tracks offline periods locally and ships the closed
  // periods up on each successful check-in. We merge them into a
  // rolling window on the agent doc (last 30 days), deduped by
  // startedAt. consecutiveFailures is 0 when the check-in itself
  // succeeded (we wouldn't be here otherwise) but the previous
  // check-in's count is captured indirectly via the offlinePeriods
  // entries the agent just sent up.
  const reportedPeriods = Array.isArray(payload.offlinePeriods) ? payload.offlinePeriods : [];
  const previousPeriods = (() => {
    const arr = existing?.fields?.offlinePeriods?.arrayValue?.values || [];
    return arr.map((v) => {
      const m = v.mapValue?.fields || {};
      const out = {};
      if (m.startedAt?.stringValue)    out.startedAt    = m.startedAt.stringValue;
      if (m.endedAt?.stringValue)      out.endedAt      = m.endedAt.stringValue;
      if (m.reason?.stringValue)       out.reason       = m.reason.stringValue;
      if (m.durationSec?.integerValue !== undefined) out.durationSec = parseInt(m.durationSec.integerValue, 10);
      if (m.durationSec?.doubleValue !== undefined)  out.durationSec = m.durationSec.doubleValue;
      if (m.attempts?.integerValue !== undefined)    out.attempts    = parseInt(m.attempts.integerValue, 10);
      return out;
    });
  })();
  const periodKey = (p) => `${p.startedAt}|${p.endedAt || ''}`;
  const mergedMap = new Map();
  for (const p of previousPeriods) mergedMap.set(periodKey(p), p);
  for (const p of reportedPeriods) mergedMap.set(periodKey(p), p);
  // Prune anything ended >30 days ago. Keep periods with no endedAt
  // (shouldn't happen on a successful check-in but defensive).
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const mergedPeriods = Array.from(mergedMap.values()).filter((p) => {
    if (!p.endedAt) return true;
    const t = Date.parse(p.endedAt);
    return isNaN(t) ? true : t >= cutoff;
  }).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));

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
    physicalHost: newPhysicalHost,
    omsaFirstWarnAt,
    // C: drive free space promoted to top-level so the Endpoints table
    // can render a "Disk low" badge without inflating renderFleet by
    // descending into report.storage.volumes for every row. Null when
    // the storage probe didn't return a usable C: volume.
    cDriveSizeGB,
    cDriveFreeGB,
    cDriveFreePct,
    cDriveLowFirstWarnAt,
    // First-detection timestamp for an aged primary WSB target. Tracked
    // for the same reason as omsaFirstWarnAt -- so we email/webhook once
    // on the OK→aged transition rather than every check-in. Auto-clears
    // when the operator swaps the disk (oldestBackup drops, ageDays
    // falls under threshold) or bumps the threshold past current age.
    backupDiskAgeFirstWarnAt,
    // Connectivity history. Read by the dashboard drawer to render the
    // 30-day powered-vs-online chart. Each entry:
    //   { startedAt, endedAt, durationSec, reason, attempts }
    //   reason in {'internet_down','worker_down','http_error'}
    offlinePeriods: mergedPeriods,
    // Last-known failure kind from the agent. Tracks across check-ins
    // so the tray/dashboard can show "last failure was internet down
    // 12 min ago" even after the host is online again. Older agents
    // (<0.14.27) won't send this -- we still preserve any existing
    // value rather than nuking it.
    ...(payload.lastFailureKind ? { lastFailureKind: payload.lastFailureKind } : {}),
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

  // ----- 7a2. Notify on new C: drive low capacity -----
  // Same OK->low transition pattern as OMSA: fires once when free%
  // drops below 10 (or free GB below 10), stays silent while still
  // low, can re-fire after a recovery + new drop. Critical (under 5%
  // or 5 GB) gets a different subject line + severity but uses the
  // same transition trigger -- we don't want to double-fire if a
  // host drops from 8% -> 4% in a single check-in.
  if (cDriveNewWarning && config.enabled) {
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'disk_low',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: {
        drive: 'C:',
        freeGB: cDriveFreeGB,
        freePct: cDriveFreePct,
        sizeGB: cDriveSizeGB,
        severity: cDriveIsCritical ? 'critical' : 'warning',
      },
    }));
    if (config.emailEnabled && env.RESEND_API_KEY) {
      ctx.waitUntil(
        sendDiskLowEmail(env, {
          pcId,
          hostname,
          client: resolvedClient,
          drive: 'C:',
          freeGB: cDriveFreeGB,
          freePct: cDriveFreePct,
          sizeGB: cDriveSizeGB,
          severity: cDriveIsCritical ? 'critical' : 'warning',
          when: nowIso,
        }).catch((e) => console.error('Disk-low email failed:', e))
      );
    }
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'disk_low',
          pcId,
          hostname,
          client: resolvedClient,
          drive: 'C:',
          freeGB: cDriveFreeGB,
          freePct: cDriveFreePct,
          sizeGB: cDriveSizeGB,
          severity: cDriveIsCritical ? 'critical' : 'warning',
          when: nowIso,
        }).catch((e) => console.error('Webhook POST failed:', e))
      );
    }
  }

  // ----- 7a3. Notify on new aged primary backup disk -----
  // Same OK→aged transition pattern as OMSA. Fires once when the
  // primary target's first-backup age first crosses the configured
  // threshold (default 913 days / 2.5y, /settings/backupDiskAge). Stays
  // silent on subsequent check-ins while still aged. Auto-clears when
  // the operator swaps the disk (oldestBackup drops) or bumps the
  // threshold past current age, then re-arms.
  if (backupDiskAgedNewWarning && config.enabled) {
    const ageLabel = _fmtAgeDays(backupAgedFinding.ageDays);
    const thresholdLabel = _fmtAgeDays(backupAgedFinding.thresholdDays);
    ctx.waitUntil(logActivity(env, accessToken, {
      type: 'backup_disk_aged',
      actor: { type: 'agent', id: pcId },
      target: { type: 'host', id: pcId, label: hostname },
      client: resolvedClient,
      details: {
        target: backupAgedFinding.target,
        ageDays: Math.floor(backupAgedFinding.ageDays),
        thresholdDays: backupAgedFinding.thresholdDays,
        oldestBackup: backupAgedFinding.oldestBackup,
        newestBackup: backupAgedFinding.newestBackup,
      },
    }));
    if (config.emailEnabled && env.RESEND_API_KEY) {
      ctx.waitUntil(
        sendBackupDiskAgedEmail(env, {
          pcId,
          hostname,
          client: resolvedClient,
          target: backupAgedFinding.target,
          ageDays: backupAgedFinding.ageDays,
          ageLabel,
          thresholdDays: backupAgedFinding.thresholdDays,
          thresholdLabel,
          oldestBackup: backupAgedFinding.oldestBackup,
          newestBackup: backupAgedFinding.newestBackup,
          when: nowIso,
        }).catch((e) => console.error('Backup-disk-aged email failed:', e))
      );
    }
    if (config.webhookEnabled !== false && effectiveWebhookUrl) {
      ctx.waitUntil(
        postWebhook(effectiveWebhookUrl, {
          event: 'backup_disk_aged',
          pcId,
          hostname,
          client: resolvedClient,
          target: backupAgedFinding.target,
          ageDays: Math.floor(backupAgedFinding.ageDays),
          ageLabel,
          thresholdDays: backupAgedFinding.thresholdDays,
          thresholdLabel,
          oldestBackup: backupAgedFinding.oldestBackup,
          newestBackup: backupAgedFinding.newestBackup,
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

  // ----- 8. Self-clear forceUpdate once the agent has caught up -----
  // The /force-update admin endpoint writes config.forceUpdate=true.
  // Agent's checkin.py then runs the updater regardless of autoUpdate.
  // Once the agent's reported agentVersion matches the latest available
  // (i.e. the update landed), the flag is no longer needed -- clear it
  // so a subsequent toggle of autoUpdate doesn't accidentally re-trigger
  // on every check-in. Best-effort: failure here doesn't break the
  // check-in path.
  if (config.forceUpdate) {
    try {
      // Fetch latest-version quickly to compare. If we can't determine
      // latest, leave the flag (will retry next time).
      const latest = await fetchLatestFromGitHub().catch(() => null);
      if (latest && latest.version && (agentVersion || '').trim() === latest.version) {
        await firestoreSetDoc(env, accessToken, `agents/${pcId}/config/current`, {
          forceUpdate: false,
          forceUpdateClearedAt: nowIso,
        }, /* partial */ true);
        ctx.waitUntil(logActivity(env, accessToken, {
          type: 'force_update_applied',
          actor: { type: 'agent', id: pcId },
          target: { type: 'host', id: pcId, label: hostname },
          client: resolvedClient,
          details: { version: latest.version },
        }));
      }
    } catch (e) {
      console.error('forceUpdate self-clear failed (non-fatal):', e);
    }
  }

  // ----- 9. Return config + uninstall flag to the agent -----
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
      // Forwarded to the agent. checkin.py treats this as "run the
      // updater right now even if autoUpdate is off" -- one-shot push.
      forceUpdate: config.forceUpdate,
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
  // "usable" = a routable IP we'd trust to show as the host's internal
  // address. Skips 0.0.0.0 (uninitialized), 127.0.0.1 (loopback), and
  // 169.254.* (link-local; DHCP failed). The last-resort 5th pass
  // below DROPS the link-local exclusion so we surface something
  // rather than showing "-" -- a 169.254 address is at least a sign
  // the NIC is up + has DHCP enabled, useful for triage.
  const usable = (ip) => ip && ip !== '0.0.0.0' && ip !== '127.0.0.1' && !ip.startsWith('169.254.');
  const anyIp = (ip) => ip && ip !== '0.0.0.0' && ip !== '127.0.0.1';
  // Hyper-V Default Switch + Internal Switches sit in 172.16.0.0/12.
  // They have IPs + DHCP but no useful default gateway, and the operator
  // doesn't RDP to them. De-prioritize so we don't surface 172.x.x.x
  // when a real LAN IP exists on another NIC.
  const isHyperVInternal = (ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // Hyper-V vEthernet interface descriptions Windows assigns by default.
  const isVEthernetName = (n) => /vEthernet|Hyper-V Virtual/i.test(n || '');

  // Pass 1: NIC with a default gateway AND a non-Hyper-V-Internal IP.
  // This is the strongest signal -- the LAN-routed interface.
  for (const nic of nics) {
    if (!Array.isArray(nic.gateways) || !nic.gateways.length) continue;
    if (!Array.isArray(nic.ipv4)) continue;
    const ip = nic.ipv4.find(addr => usable(addr) && !isHyperVInternal(addr));
    if (ip) return ip;
  }
  // Pass 2: any NIC with a default gateway (even if 172.x.x.x).
  // A real LAN configured in the 172.16/12 range is rare but possible.
  for (const nic of nics) {
    if (!Array.isArray(nic.gateways) || !nic.gateways.length) continue;
    if (!Array.isArray(nic.ipv4)) continue;
    const ip = nic.ipv4.find(usable);
    if (ip) return ip;
  }
  // Pass 3: any non-Hyper-V-internal, non-vEthernet IPv4 on any NIC.
  for (const nic of nics) {
    if (isVEthernetName(nic.name) || isVEthernetName(nic.description)) continue;
    if (!Array.isArray(nic.ipv4)) continue;
    const ip = nic.ipv4.find(addr => usable(addr) && !isHyperVInternal(addr));
    if (ip) return ip;
  }
  // Pass 4: any usable IPv4 anywhere. Better to show a 172.x.x.x
  // management IP than a dash.
  for (const nic of nics) {
    if (!Array.isArray(nic.ipv4)) continue;
    const ip = nic.ipv4.find(usable);
    if (ip) return ip;
  }
  // Pass 5: last resort -- accept link-local (169.254.*) too.
  // A host whose DHCP failed still has an internal "address" we can
  // surface for triage, and operators looking at the table can
  // immediately tell what's wrong.
  for (const nic of nics) {
    if (!Array.isArray(nic.ipv4)) continue;
    const ip = nic.ipv4.find(anyIp);
    if (ip) return ip;
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
    forceUpdate: false, // one-shot push, self-clears after success
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
    forceUpdate: fieldBool(doc.fields.forceUpdate, defaults.forceUpdate),
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
// Branded email template helpers (Variant B "Hero Card" design)
// ─────────────────────────────────────────────────────────────────────
//
// All six Resend emails share the same chrome -- teal-gradient hero
// with the Watchtower mark + Umbrella Automation eyebrow + a WHITE
// pill chip with the client name, then a colored severity band, then
// the per-email body, then a CTA button linking back to the dashboard.
// Centralising the shell means a typography/color tweak lands in one
// place, not six. See watchtower/notification-previews.html for the
// reference renderings.
//
// Helpers are intentionally inline-styled and table-heavy so Outlook /
// Gmail / Apple Mail render them consistently without external CSS.

const DASHBOARD_BASE = 'https://frank-umbrella.github.io/work/watchtower/';

// Watchtower mark used in every email hero. Inline SVG works in browser
// previews but Outlook / Gmail / Apple Mail strip or ignore it. Switched
// to a hosted PNG <img> -- the same icon-192.png served from GitHub
// Pages that the dashboard + Google Chat card already use. Width/height
// attributes are required for Outlook (which otherwise renders the img
// at natural 192x192). Alt text shows when remote images are blocked
// before the user clicks "show images".
const TOWER_ICON_PNG = 'https://frank-umbrella.github.io/work/watchtower/icon-192.png';
const TOWER_ICON_IMG = `<img src="${TOWER_ICON_PNG}" width="42" height="42" alt="Watchtower" style="display:block;border-radius:8px;">`;

const SEVERITY_PALETTE = {
  info:     { bg: '#e6f4f4', text: '#074a4a', border: '#d0e8e8', dot: '#0a6b6b' },
  // warn = advisory amber. Reads as "plan a response," not "outage in
  // progress." Currently used by backup_disk_aged. The dashboard's
  // alert chip + favicon also map this tier to amber.
  warn:     { bg: '#fef3c7', text: '#78350f', border: '#fcd34d', dot: '#d97706' },
  critical: { bg: '#fee2e2', text: '#7f1d1d', border: '#fca5a5', dot: '#b91c1c' },
  neutral:  { bg: '#f3f4f6', text: '#475063', border: '#e3e6ec', dot: '#6b7280' },
};

function dashboardUrl(pcId) {
  return pcId ? `${DASHBOARD_BASE}?pc=${encodeURIComponent(pcId)}` : DASHBOARD_BASE;
}

// Wrap an email's body content with the standard branded chrome.
//   client       -- client name (renders in the white pill chip)
//   hostname     -- host display name (renders in the hero subtitle)
//   headline     -- main H1, e.g. "Backup Failed"
//   subtitleHtml -- pre-rendered HTML for the subtitle line; if omitted
//                   defaults to "on <b>HOSTNAME</b>". Lets callers add
//                   severity-tinted context like "5 days since last success".
//   severity     -- "info" | "critical" | "neutral" (drives the band color)
//   bandText     -- short label in the severity band
//   bodyHtml     -- per-email body content (rendered before the CTA)
//   pcId         -- used to deep-link the "Open host in dashboard" CTA
function renderEmailShell({ client, hostname, headline, subtitleHtml, severity, bandText, bodyHtml, pcId }) {
  const pal = SEVERITY_PALETTE[severity] || SEVERITY_PALETTE.info;
  const dashUrl = dashboardUrl(pcId);
  const clientLabel = client && client.trim() ? client : 'Unassigned';
  const subtitle = subtitleHtml || `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b>`;
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(20,25,40,0.06);">
      <!-- Hero -->
      <div style="background:linear-gradient(135deg,#0a6b6b 0%,#074a4a 100%);padding:24px 30px;color:#ffffff;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td width="50" style="vertical-align:middle;">${TOWER_ICON_IMG}</td>
          <td style="vertical-align:middle;padding-left:14px;">
            <div style="font-size:11px;color:#5af4e3;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;">Umbrella Automation &middot; Watchtower</div>
          </td>
          <td align="right" style="vertical-align:middle;">
            <span style="display:inline-block;padding:7px 16px;background:#ffffff;color:#0a6b6b;border-radius:999px;font-size:12.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.18);">${escapeHtml(clientLabel)}</span>
          </td>
        </tr></table>
        <div style="font-size:26px;color:#ffffff;font-weight:700;line-height:1.2;margin-top:18px;letter-spacing:-0.01em;">${escapeHtml(headline)}</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.78);margin-top:5px;">${subtitle}</div>
      </div>
      <!-- Severity band -->
      <div style="background:${pal.bg};color:${pal.text};padding:9px 30px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid ${pal.border};">
        <span style="display:inline-block;width:8px;height:8px;background:${pal.dot};border-radius:50%;margin-right:8px;vertical-align:middle;"></span>${escapeHtml(bandText || '')}
      </div>
      <!-- Body -->
      <div style="padding:24px 30px;">
        ${bodyHtml}
        <a href="${dashUrl}" style="display:block;text-align:center;background:#0a6b6b;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:700;font-size:14.5px;box-shadow:0 2px 4px rgba(10,107,107,0.25);margin-top:20px;">Open host in dashboard &rarr;</a>
      </div>
      <!-- Footer -->
      <div style="background:#fafbfc;padding:16px 30px;border-top:1px solid #e3e6ec;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="font-size:11.5px;color:#8892a4;"><b style="color:#475063;">Watchtower</b> &middot; Umbrella Automation</td>
          <td align="right" style="font-size:11.5px;"><a href="${dashUrl}" style="color:#8892a4;text-decoration:none;">Silence this host</a></td>
        </tr></table>
      </div>
    </div>
  `;
}

// POST the rendered email to Resend. Shared across all six send*Email
// functions so the auth + endpoint + error handling lives in one place.
async function postResendEmail(env, { subject, html }) {
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
// Resend email — IP change alert
// ─────────────────────────────────────────────────────────────────────
async function sendIpChangeEmail(env, { pcId, hostname, client, previousIp, newIp, when }) {
  const subject = `[Watchtower] ${hostname} · External IP Changed to ${newIp}`;
  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 22px;">
      This host is now reaching the internet from a new public address. If this isn't expected, check the WAN equipment or ISP.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:0;"><tr>
      <td style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">Previous IP</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;color:#475063;">${escapeHtml(previousIp || '?')}</div>
      </td>
      <td width="4%"></td>
      <td style="background:#e6f4f4;border:1px solid #b8dbdb;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top;">
        <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">New IP</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;color:#0a6b6b;font-weight:700;">${escapeHtml(newIp || '?')}</div>
      </td>
    </tr></table>
    <p style="font-size:11.5px;color:#8892a4;margin:14px 0 0;">Detected ${escapeHtml(when)}</p>
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: 'External IP Changed',
    severity: 'info',
    bandText: 'Network event · informational',
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — first-time host intake (one per pcId, on firstSeen)
// ─────────────────────────────────────────────────────────────────────
async function sendIntakeEmail(env, { pcId, hostname, client, agentVersion, when, externalIp, report }) {
  const subject = `[Watchtower] New Host Onboarded — ${hostname} (${client})`;
  const r = report || {};
  const sys = r.system || {};
  const os = sys.os || {};
  const stor = r.storage || {};
  const sw = r.software || {};
  const hf = r.hotfixes || {};

  const isDell = /dell/i.test(sys.manufacturer || '');
  const tagHtml = sys.serviceTag
    ? (isDell
        ? `<a href="https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(sys.serviceTag)}" style="color:#0a6b6b;text-decoration:none;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;">${escapeHtml(sys.serviceTag)}</a>`
        : `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(sys.serviceTag)}</span>`)
    : '<span style="color:#8892a4;">none</span>';

  // Product-detection -- collect short chip labels + a few details for the
  // body. Same data the dashboard's drawer renders, just flattened.
  const productChips = [];
  const productDetails = [];
  if (r.veeam && r.veeam.installed) {
    for (const p of (r.veeam.products || [])) {
      const label = p.edition === 'br' ? `Veeam B&R ${escapeHtml(p.version || '?')}` : `Veeam Agent ${escapeHtml(p.version || '?')}`;
      productChips.push(label);
      if (p.lastJob && p.lastJob.result) productDetails.push(`${label} &mdash; last job <b style="color:${p.lastJob.result === 'Success' ? '#16a34a' : '#b91c1c'};">${escapeHtml(p.lastJob.result)}</b>`);
    }
  }
  if (r.wsb && r.wsb.installed) {
    productChips.push('WSB');
    if (r.wsb.lastBackupResult) productDetails.push(`WSB <b style="color:${r.wsb.lastBackupResult === 'Success' ? '#16a34a' : '#b91c1c'};">${escapeHtml(r.wsb.lastBackupResult)}</b>${r.wsb.lastSuccessfulBackup ? ` &middot; last success ${escapeHtml(r.wsb.lastSuccessfulBackup)}` : ''}`);
  }
  if (r.carbonite && r.carbonite.installed) {
    for (const p of (r.carbonite.products || [])) productChips.push(`${escapeHtml(p.name)} ${escapeHtml(p.version || '')}`.trim());
  }
  if (r.ibackup && r.ibackup.installed) {
    for (const p of (r.ibackup.products || [])) productChips.push(`${escapeHtml(p.name)} ${escapeHtml(p.version || '')}`.trim());
    if (r.ibackup.lastBackupResult || r.ibackup.lastBackupAt) {
      productDetails.push(`IBackup &middot; last run <b style="color:${r.ibackup.lastBackupResult === 'Success' ? '#16a34a' : '#b91c1c'};">${escapeHtml(r.ibackup.lastBackupResult || 'unknown')}</b>${r.ibackup.lastBackupAt ? ` &middot; ${escapeHtml(String(r.ibackup.lastBackupAt).replace('T', ' ').replace('Z', ''))}` : ''}`);
    }
  }
  if (r.omsa && r.omsa.installed) {
    productChips.push(`OMSA ${escapeHtml(r.omsa.version || '?')}`);
    productDetails.push(`Dell OMSA <b>${escapeHtml(r.omsa.version || '?')}</b> &middot; rollup <b style="color:${r.omsa.healthRollup === 'ok' ? '#16a34a' : '#b91c1c'};">${escapeHtml(r.omsa.healthRollup || 'unknown')}</b> &middot; ${(r.omsa.physicalDisks || []).length} disks, ${(r.omsa.virtualDisks || []).length} arrays`);
  }
  if (r.idrac && r.idrac.installed) productChips.push(`iDRAC iSM ${escapeHtml(r.idrac.version || '?')}`);
  if (r.logmein && r.logmein.installed) productChips.push('LogMeIn');
  if (r.sentinelone && r.sentinelone.installed) productChips.push('SentinelOne');
  if (r.defender) {
    productChips.push('Defender');
    productDetails.push(`Defender realtime <b style="color:${r.defender.realtimeOn ? '#16a34a' : '#b91c1c'};">${r.defender.realtimeOn ? 'on' : 'off'}</b>${r.defender.definitionsVersion ? ` &middot; defs ${escapeHtml(r.defender.definitionsVersion)}` : ''}`);
  }

  const chipPills = productChips.map(c => `<span style="display:inline-block;padding:3px 10px;background:#e6f4f4;color:#074a4a;border-radius:999px;font-size:11.5px;font-weight:600;margin:2px 4px 2px 0;">${c}</span>`).join('');

  const volumes = (stor.volumes || []).slice(0, 6).map(v => `<li>${escapeHtml(v.letter)} (${escapeHtml(v.filesystem || '?')}) &mdash; ${v.sizeGB || 0} GB total, ${v.freeGB || 0} GB free</li>`).join('');

  const subtitleHtml = `<b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; joined ${escapeHtml(when)}`;

  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 18px;">
      This is the one-time intake summary captured at the host's first check-in. Future check-ins won't send this email &mdash; they flow into the dashboard quietly.
    </p>

    <!-- Identity card -->
    <div style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:10px;">Identity</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13.5px;"><tr>
        <td style="padding:3px 0;width:50%;vertical-align:top;"><span style="color:#8892a4;">Host</span> <b style="color:#1a1f2b;">${escapeHtml(hostname || '?')}</b></td>
        <td style="padding:3px 0;width:50%;vertical-align:top;"><span style="color:#8892a4;">Client</span> ${escapeHtml(client || 'unassigned')}</td>
      </tr><tr>
        <td style="padding:3px 0;vertical-align:top;"><span style="color:#8892a4;">External IP</span> <span style="font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(externalIp || '?')}</span></td>
        <td style="padding:3px 0;vertical-align:top;"><span style="color:#8892a4;">Agent</span> ${escapeHtml(agentVersion || '?')}</td>
      </tr></table>
    </div>

    <!-- Hardware card -->
    ${sys.manufacturer || sys.model ? `
    <div style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:10px;">Hardware</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13.5px;"><tr>
        <td style="padding:3px 0;width:50%;vertical-align:top;"><span style="color:#8892a4;">Manufacturer</span> ${escapeHtml(sys.manufacturer || '?')}</td>
        <td style="padding:3px 0;width:50%;vertical-align:top;"><span style="color:#8892a4;">Model</span> ${escapeHtml(sys.model || '?')}</td>
      </tr><tr>
        <td style="padding:3px 0;vertical-align:top;"><span style="color:#8892a4;">Service tag</span> ${tagHtml}</td>
        <td style="padding:3px 0;vertical-align:top;"><span style="color:#8892a4;">RAM</span> ${sys.memory && sys.memory.totalGB ? `${sys.memory.totalGB} GB` : '?'}</td>
      </tr>${sys.cpu && sys.cpu.name ? `<tr>
        <td colspan="2" style="padding:3px 0;vertical-align:top;"><span style="color:#8892a4;">CPU</span> ${escapeHtml(sys.cpu.name)}${sys.cpu.cores ? ` (${sys.cpu.cores} cores)` : ''}</td>
      </tr>` : ''}</table>
    </div>` : ''}

    <!-- Operating system card -->
    ${os.name ? `
    <div style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:10px;">Operating System</div>
      <div style="font-size:13.5px;color:#1a1f2b;">${escapeHtml(os.name)}${os.build ? ` &middot; build ${escapeHtml(os.build)}` : ''}${sys.partOfDomain ? ` &middot; domain ${escapeHtml(sys.workgroup || '?')}` : ` &middot; workgroup ${escapeHtml(sys.workgroup || 'WORKGROUP')}`}</div>
    </div>` : ''}

    <!-- Detected products card -->
    ${productChips.length ? `
    <div style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:10px;">Detected Products</div>
      <div style="margin-bottom:10px;">${chipPills}</div>
      ${productDetails.length ? `<div style="font-size:12.5px;color:#475063;line-height:1.7;">${productDetails.map(d => `&middot; ${d}`).join('<br>')}</div>` : ''}
    </div>` : ''}

    <!-- Volumes (compact) -->
    ${volumes ? `
    <div style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:16px 18px;margin-bottom:0;">
      <div style="font-size:10.5px;color:#0a6b6b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:6px;">Volumes</div>
      <ul style="font-size:13px;line-height:1.7;margin:0;padding-left:20px;color:#475063;">${volumes}</ul>
    </div>` : ''}

    <!-- Inventory totals -->
    ${sw.count || hf.total ? `<p style="font-size:12.5px;color:#8892a4;margin:14px 0 0;">${sw.count ? `${sw.count} installed applications` : ''}${sw.count && hf.total ? ' &middot; ' : ''}${hf.total ? `${hf.total} hotfixes installed` : ''}</p>` : ''}
  `;

  const html = renderEmailShell({
    client, hostname, pcId,
    headline: 'New Host Onboarded',
    subtitleHtml,
    severity: 'info',
    bandText: 'First check-in · one-time intake report',
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
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
// Mirror of the dashboard's backupDiskAgeFinding(). Walks the WSB
// probe's backupsByTarget list, picks the target whose newestBackup
// is the latest (= currently active disk), computes age as (now -
// that target's oldestBackup), compares to threshold. Returns null
// when WSB isn't installed / no per-target history / no dates we can
// parse. Returns { target, ageDays, thresholdDays, exceeds,
// oldestBackup, newestBackup } otherwise. The trigger only fires when
// exceeds === true.
function pickPrimaryAgedBackupDisk(wsb, thresholdDays) {
  if (!wsb || !wsb.installed) return null;
  const targets = Array.isArray(wsb.backupsByTarget) ? wsb.backupsByTarget : [];
  if (!targets.length) return null;
  let primary = null;
  let latestMs = -Infinity;
  for (const t of targets) {
    const newestIso = t && t.newestBackup;
    if (!newestIso) continue;
    const ms = Date.parse(newestIso);
    if (!isFinite(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      primary = t;
    }
  }
  if (!primary) return null;
  const oldestIso = primary.oldestBackup;
  if (!oldestIso) return null;
  const oldestMs = Date.parse(oldestIso);
  if (!isFinite(oldestMs)) return null;
  const ageDays = (Date.now() - oldestMs) / 86_400_000;
  return {
    target: primary.target || '?',
    ageDays,
    thresholdDays,
    exceeds: ageDays > thresholdDays,
    oldestBackup: oldestIso,
    newestBackup: primary.newestBackup || null,
  };
}

// Convert a fractional day count into the "Xd" / "Xy Yd" / "Xy" labels
// the dashboard's _fmtAgeDays produces. Used in both the email subject
// + webhook payloads so the operator sees consistent phrasing everywhere.
function _fmtAgeDays(days) {
  if (!isFinite(days) || days < 0) return '?';
  const d = Math.floor(days);
  if (d < 365) return `${d}d`;
  const y = Math.floor(d / 365);
  const remD = d - y * 365;
  if (remD === 0) return `${y}y`;
  return `${y}y ${remD}d`;
}

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
  const subject = `[Watchtower] ${hostname} · OMSA ${sevLabel} · ${issues.length} Issue${issues.length === 1 ? '' : 's'}`;
  const subtitleHtml = `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; <span style="color:#fca5a5;">rollup ${escapeHtml((rollup || '?').toUpperCase())}${issues.length ? ` &middot; ${issues.length} issue${issues.length === 1 ? '' : 's'}` : ''}</span>`;
  const issuesListHtml = issues.length
    ? `<ul style="margin:0;padding-left:18px;font-size:13.5px;color:#7f1d1d;line-height:1.7;">${issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : `<div style="font-size:13.5px;color:#7f1d1d;font-style:italic;">No per-disk detail in this check-in.</div>`;
  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 22px;">
      This host's Dell OpenManage Server Administrator is reporting a non-OK storage rollup. The issues flagged in the latest check-in:
    </p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:18px;">
      <div style="font-size:10.5px;color:#b91c1c;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">What needs attention</div>
      ${issuesListHtml}
    </div>
    <p style="font-size:12px;color:#8892a4;margin:0;">OMSA ${escapeHtml(version || '?')} &middot; detected ${escapeHtml(when)}</p>
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: `Storage Health: ${sevLabel}`,
    subtitleHtml,
    severity: 'critical',
    bandText: `Dell OMSA · ${sevLabel.toLowerCase()}`,
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — C: drive low capacity alert
// ─────────────────────────────────────────────────────────────────────
async function sendDiskLowEmail(env, { pcId, hostname, client, drive, freeGB, freePct, sizeGB, severity, when }) {
  const sevLabel = severity === 'critical' ? 'CRITICAL' : 'WARNING';
  const subject = `[Watchtower] ${hostname} · ${drive} ${sevLabel} (${freePct}% / ${freeGB} GB Free)`;
  const subtitleHtml = `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; <span style="color:#fca5a5;">${freeGB} GB / ${freePct}% free</span>`;
  const usedPct = Math.max(0, Math.min(100, 100 - (freePct || 0)));
  const bodyHtml = `
    <div style="margin-bottom:22px;">
      <div style="display:block;font-size:11.5px;color:#475063;margin-bottom:6px;">
        <b style="color:#b91c1c;">${freeGB} GB free</b> &middot; of ${sizeGB} GB total
      </div>
      <div style="height:10px;background:#fee2e2;border-radius:5px;overflow:hidden;">
        <div style="height:10px;width:${usedPct}%;background:#b91c1c;"></div>
      </div>
    </div>
    <p style="font-size:14px;color:#475063;line-height:1.55;margin:0 0 18px;">
      This host is below the 5% / 5 GB threshold on <b>${escapeHtml(drive)}</b>. Common culprits:
    </p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:0;">
      <ul style="margin:0;padding-left:18px;font-size:13.5px;color:#7f1d1d;line-height:1.7;">
        <li>Storage Sense / Disk Cleanup for temp + Windows Update cache</li>
        <li><code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#fff5f5;padding:1px 5px;border-radius:3px;">SoftwareDistribution\\Download</code> + CBS logs</li>
        <li>Veeam / WSB destination accidentally landing on C: (common on Hyper-V)</li>
        <li>Page-file growth on heavy-load servers</li>
      </ul>
    </div>
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: `${drive} Drive Critically Low`,
    subtitleHtml,
    severity: 'critical',
    bandText: `Disk capacity · ${sevLabel.toLowerCase()}`,
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — Windows Server Backup failure alert
// ─────────────────────────────────────────────────────────────────────
async function sendBackupFailureEmail(env, { pcId, hostname, client, result, detail, attemptedAt, lastSuccess, daysSinceSuccess, when }) {
  const daysLabel = daysSinceSuccess != null ? `${daysSinceSuccess} day${daysSinceSuccess === 1 ? '' : 's'} since last success` : 'no successful backup on record';
  const subject = `[Watchtower] ${hostname} · Backup FAILED · ${daysLabel}`;
  const subtitleHtml = `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; <span style="color:#fca5a5;">${escapeHtml(daysLabel)}</span>`;
  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 22px;">
      The last scheduled WSB run did not complete. ${detail ? 'See the failure detail below.' : 'See the dashboard for the full job history.'}
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:18px;"><tr>
      <td style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;width:32%;vertical-align:top;text-align:center;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">${daysSinceSuccess != null ? 'Days w/o' : 'Last success'}</div>
        <div style="font-size:${daysSinceSuccess != null ? '28px' : '14px'};color:#b91c1c;font-weight:${daysSinceSuccess != null ? '800' : '700'};line-height:1;">${daysSinceSuccess != null ? daysSinceSuccess : 'never'}</div>
      </td>
      <td width="4%"></td>
      <td style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:14px 18px;vertical-align:top;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">Failure result</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#b91c1c;font-weight:700;line-height:1.3;word-break:break-all;">${escapeHtml(result || 'unknown')}</div>
        <div style="font-size:11.5px;color:#475063;margin-top:6px;">attempted ${escapeHtml(attemptedAt || when)}${lastSuccess ? ` &middot; last success ${escapeHtml(lastSuccess)}` : ''}</div>
      </td>
    </tr></table>
    ${detail ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 16px;margin-bottom:0;">
      <div style="font-size:10.5px;color:#b91c1c;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">WSB detail</div>
      <div style="font-size:13.5px;color:#7f1d1d;line-height:1.55;">${escapeHtml(detail)}</div>
    </div>` : ''}
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: 'Backup Failed',
    subtitleHtml,
    severity: 'critical',
    bandText: 'Windows Server Backup · critical',
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — primary backup disk aged out alert
// ─────────────────────────────────────────────────────────────────────
//
// Fires once per OK -> aged transition. Warn-level (amber), not
// critical -- the host's backups still ran successfully on this disk,
// it's just been in continuous rotation longer than the admin's
// configured threshold (default 913 days / 2.5y). Body emphasizes
// "plan a swap" rather than "outage now."
async function sendBackupDiskAgedEmail(env, { pcId, hostname, client, target, ageDays, ageLabel, thresholdDays, thresholdLabel, oldestBackup, newestBackup, when }) {
  const subject = `[Watchtower] ${hostname} · Backup disk aged · ${ageLabel} in rotation`;
  const subtitleHtml = `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; <span style="color:#fcd34d;">${escapeHtml(ageLabel || '?')} in rotation${thresholdLabel ? ` (threshold ${escapeHtml(thresholdLabel)})` : ''}</span>`;
  const targetShort = target ? escapeHtml(String(target).slice(0, 64)) : '?';
  const oldestShort = oldestBackup ? escapeHtml(String(oldestBackup).slice(0, 10)) : '?';
  const newestShort = newestBackup ? escapeHtml(String(newestBackup).slice(0, 10)) : '?';
  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 22px;">
      The primary backup target on this host has been in continuous rotation for longer than the configured threshold. Backup disks are a wear item &mdash; rotating to a fresh unit now keeps you ahead of the failure curve rather than scrambling after one.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:18px;"><tr>
      <td style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:14px 18px;width:32%;vertical-align:top;text-align:center;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">In rotation</div>
        <div style="font-size:28px;color:#78350f;font-weight:800;line-height:1;">${escapeHtml(ageLabel || '?')}</div>
        <div style="font-size:11px;color:#a16207;margin-top:4px;">since first backup</div>
      </td>
      <td width="4%"></td>
      <td style="background:#fafbfc;border:1px solid #e3e6ec;border-radius:10px;padding:14px 18px;vertical-align:top;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">Backup target</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#475063;font-weight:700;line-height:1.3;word-break:break-all;margin-bottom:10px;">${targetShort}</div>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:11.5px;color:#475063;"><tr>
          <td style="padding-right:14px;border-right:1px solid #e3e6ec;">
            <div style="font-size:9.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:2px;">First backup</div>
            <div style="color:#1a1f2b;font-weight:600;">${oldestShort}</div>
          </td>
          <td style="padding-left:14px;">
            <div style="font-size:9.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:2px;">Latest backup</div>
            <div style="color:#1a1f2b;font-weight:600;">${newestShort}</div>
          </td>
        </tr></table>
      </td>
    </tr></table>
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px 18px;margin-bottom:0;">
      <div style="font-size:10.5px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Suggested next steps</div>
      <ul style="margin:0;padding-left:18px;font-size:13.5px;color:#78350f;line-height:1.7;">
        <li>Pull SMART data &mdash; if reallocated sectors or pending sectors are non-zero, swap immediately.</li>
        <li>Order a replacement disk in the same capacity tier and confirm WSB picks it up via <code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#fffbeb;padding:1px 5px;border-radius:3px;">wbadmin enable backup -addtarget</code>.</li>
        <li>Adjust the threshold under <b>Settings &middot; Backup disk age alert</b> if ${escapeHtml(thresholdLabel || 'the default')} is too aggressive for this customer.</li>
      </ul>
    </div>
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: 'Backup Disk Aging Out',
    subtitleHtml,
    severity: 'warn',
    bandText: 'Windows Server Backup · advisory',
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
}

// ─────────────────────────────────────────────────────────────────────
// Resend email — agent uninstalled at the host side
// ─────────────────────────────────────────────────────────────────────
// Fires once from the /uninstall endpoint. Distinct from the admin's
// own click of "Decommission" in the dashboard, which doesn't email
// (the admin's already aware they did it). This email is the heads-up
// that someone (or something) removed the agent on the box itself.
async function sendUninstallEmail(env, { pcId, hostname, client, source, reason, when }) {
  const subject = `[Watchtower] ${hostname} · Agent Decommissioned`;
  const sourceShort = source === 'agent-uninstall' ? 'uninstalled at host'
    : source === 'admin' ? 'decommissioned by admin'
    : (source || 'unknown source');
  const sourceLong = source === 'agent-uninstall'
    ? 'The uninstaller ran on the host (Control Panel or operator-initiated).'
    : source === 'admin'
      ? 'An admin marked this host decommissioned from the dashboard.'
      : `Source: ${escapeHtml(source || 'unknown')}.`;
  const subtitleHtml = `on <b style="color:#ffffff;">${escapeHtml(hostname || '?')}</b> &middot; ${escapeHtml(sourceShort)}`;
  const bodyHtml = `
    <p style="font-size:15px;color:#1a1f2b;line-height:1.55;margin:0 0 22px;">
      This host has been removed from Watchtower. ${sourceLong} The row stays in the dashboard with a Decommissioned badge until you delete it. If the agent is reinstalled with the same pcId, it'll automatically reactivate on next check-in.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:0;"><tr>
      <td style="background:#f4f6f9;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">Source</div>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;color:#475063;">${escapeHtml(source || 'unknown')}</div>
      </td>
      <td width="4%"></td>
      <td style="background:#f4f6f9;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top;">
        <div style="font-size:10.5px;color:#8892a4;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px;">When</div>
        <div style="font-size:14px;color:#1a1f2b;">${escapeHtml(when)}</div>
      </td>
    </tr></table>
    ${reason ? `<p style="font-size:13px;color:#475063;margin:16px 0 0;"><b style="color:#1a1f2b;">Reason:</b> ${escapeHtml(reason)}</p>` : ''}
  `;
  const html = renderEmailShell({
    client, hostname, pcId,
    headline: 'Agent Decommissioned',
    subtitleHtml,
    severity: 'neutral',
    bandText: 'Agent lifecycle',
    bodyHtml,
  });
  await postResendEmail(env, { subject, html });
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
// Detection by URL host. Every receiver-specific shape carries the
// client name prominently (matching the email Hero Card design) plus
// a severity indicator wired into whatever the platform supports for
// color (Slack attachment color, Teams themeColor, Discord embed
// color). Generic / unknown receivers get the full structured
// payload so n8n / Zapier / custom HTTP endpoints can do anything.
//
//   Google Chat (chat.googleapis.com)       → Cards v2, client in subtitle
//   Discord (discord.com|discordapp.com)    → rich embed w/ color bar
//   Teams classic (outlook.office.com,
//                  webhook.office.com)      → MessageCard w/ activityTitle
//   Slack (hooks.slack.com)                 → blocks + attachment color bar
//   Generic / unknown                       → { text, ...payload }

// Map event type to display attributes shared across webhook surfaces.
// Headline + severity match the email templates so an alert reads the
// same whether it lands in Gmail or a chat room. `context` is the
// short urgency string (e.g. "5 days since success") that follows the
// headline -- not all events have one.
function eventMeta(p) {
  switch (p.event) {
    case 'test':
      return { headline: 'Test Event', severity: 'info', context: 'webhook test from dashboard' };
    case 'host_onboarded':
      return { headline: 'New Host Onboarded', severity: 'info', context: 'first check-in' };
    case 'external_ip_changed':
      return { headline: 'External IP Changed', severity: 'info', context: p.newIp ? `now ${p.newIp}` : null };
    case 'omsa_warning': {
      const rollup = String(p.rollup || 'warning').toUpperCase();
      const ctx = (p.issues && p.issues.length) ? `${p.issues.length} issue${p.issues.length === 1 ? '' : 's'}` : `rollup ${rollup}`;
      return { headline: `Storage Health: ${rollup}`, severity: 'critical', context: ctx };
    }
    case 'wsb_backup_failed':
      return { headline: 'Backup Failed', severity: 'critical', context: p.daysSinceSuccess != null ? `${p.daysSinceSuccess} day${p.daysSinceSuccess === 1 ? '' : 's'} since last success` : 'no successful backup on record' };
    case 'backup_disk_aged':
      // ageDays is float; we already humanize it (e.g. "2y 285d") on
      // the agent side as p.ageLabel. Fall back to "?" if a downstream
      // payload omitted it.
      return { headline: 'Backup Disk Aging Out', severity: 'warn', context: p.ageLabel ? `${p.ageLabel} in rotation${p.thresholdLabel ? ` (threshold ${p.thresholdLabel})` : ''}` : 'past configured threshold' };
    case 'disk_low': {
      const sev = p.severity === 'critical' ? 'critical' : 'critical';   // any disk_low is critical-flavored
      return { headline: `${p.drive || 'C:'} Drive Critically Low`, severity: sev, context: p.freeGB != null ? `${p.freeGB} GB / ${p.freePct}% free` : null };
    }
    case 'agent_uninstalled':
    case 'agent_decommissioned':
      return { headline: 'Agent Decommissioned', severity: 'neutral', context: p.source === 'agent-uninstall' ? 'uninstalled at host' : (p.source ? `source: ${p.source}` : null) };
    default:
      return { headline: p.event || 'Event', severity: 'info', context: null };
  }
}

// Per-platform color encodings of {info, critical, neutral}. Same
// brand teal / red / gray as the emails; just the format the
// platform expects.
const _WH_HEX_HASH    = { info: '#0a6b6b', warn: '#d97706', critical: '#b91c1c', neutral: '#6b7280' };  // Slack attachment
const _WH_HEX_NOHASH  = { info: '0a6b6b',  warn: 'd97706',  critical: 'b91c1c',  neutral: '6b7280'  };  // Teams MessageCard
const _WH_DECIMAL_RGB = { info: 0x0a6b6b,  warn: 0xd97706,  critical: 0xb91c1c,  neutral: 0x6b7280  };  // Discord embed

function buildWebhookBody(url, payload) {
  const summary = humanSummary(payload);
  const u = (url || '').toLowerCase();
  const meta = eventMeta(payload);

  if (u.includes('chat.googleapis.com')) {
    return buildGoogleChatCard(payload, summary, meta);
  }
  if (u.includes('discord.com/api/webhooks') || u.includes('discordapp.com/api/webhooks')) {
    return buildDiscordEmbed(payload, summary, meta);
  }
  if (u.includes('outlook.office.com') || u.includes('webhook.office.com') || u.includes('.office.com/webhook')) {
    return buildTeamsMessageCard(payload, summary, meta);
  }
  if (u.includes('hooks.slack.com')) {
    return buildSlackMessage(payload, summary, meta);
  }
  // Generic / unknown receivers (n8n, Zapier, Make, custom HTTP endpoints).
  // Send everything so receivers that want structured data can pull it.
  return { text: summary, ...payload };
}

// Slack — Block Kit blocks inside an attachment so the left border
// gets a severity color. Header block carries Watchtower + client
// chip (rendered as a context line with bold client name). Section
// block carries the headline + hostname. Facts come next when the
// event has them. Final actions block has a button to the host.
function buildSlackMessage(p, summary, meta) {
  const client = p.client || 'Unassigned';
  const hostname = p.hostname || '?';
  const cardUrl = dashboardUrl(p.pcId);
  const sevLabel = meta.severity === 'critical' ? 'CRITICAL' : meta.severity === 'warn' ? 'ADVISORY' : meta.severity === 'neutral' ? 'INFO' : 'INFO';

  // Lead context: bold client + severity label so the FIRST line of
  // the message in the Slack channel screams "WHO + HOW URGENT".
  const blocks = [
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:satellite_antenna: *Watchtower*  ·  \`${client}\`  ·  ${sevLabel}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${meta.headline}*\non \`${hostname}\`${meta.context ? `  ·  ${meta.context}` : ''}`,
      },
    },
  ];

  // Event-specific fact rows (2-column grid via Block Kit `fields`).
  const facts = _slackFacts(p);
  if (facts.length) {
    blocks.push({ type: 'section', fields: facts });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open host in dashboard' },
        url: cardUrl,
      },
    ],
  });

  return {
    text: summary,    // notification fallback (push, channel list)
    attachments: [
      {
        color: _WH_HEX_HASH[meta.severity],
        blocks,
      },
    ],
  };
}

// Slack block-kit fields come in pairs (label + value, 2-column).
function _slackFacts(p) {
  const facts = [];
  const add = (label, val) => {
    if (val == null || val === '') return;
    facts.push({ type: 'mrkdwn', text: `*${label}*\n${val}` });
  };
  switch (p.event) {
    case 'external_ip_changed':
      add('Previous IP', `\`${p.previousIp || '?'}\``);
      add('New IP',      `\`${p.newIp || '?'}\``);
      break;
    case 'wsb_backup_failed':
      add('Result',      `\`${p.result || '?'}\``);
      if (p.daysSinceSuccess != null) add('Days w/o success', String(p.daysSinceSuccess));
      break;
    case 'omsa_warning':
      add('Rollup', String(p.rollup || '?').toUpperCase());
      if (p.omsaVersion) add('OMSA version', p.omsaVersion);
      break;
    case 'disk_low':
      add('Drive', p.drive || 'C:');
      add('Free',  `${p.freeGB} GB (${p.freePct}%)`);
      break;
    case 'backup_disk_aged':
      if (p.ageLabel) add('In rotation', p.ageLabel);
      if (p.thresholdLabel) add('Threshold', p.thresholdLabel);
      if (p.oldestBackup) add('First backup', p.oldestBackup.slice(0, 10));
      if (p.newestBackup) add('Latest backup', p.newestBackup.slice(0, 10));
      if (p.target) add('Target', `\`${String(p.target).slice(0, 60)}\``);
      break;
    case 'agent_uninstalled':
    case 'agent_decommissioned':
      if (p.source) add('Source', `\`${p.source}\``);
      if (p.reason) add('Reason', p.reason);
      break;
    case 'host_onboarded':
      if (p.externalIp) add('External IP', `\`${p.externalIp}\``);
      if (p.serviceTag) add('Service tag', `\`${p.serviceTag}\``);
      break;
  }
  if (p.when) add('When', p.when);
  // Slack caps `fields` at 10; truncate if we got carried away.
  return facts.slice(0, 10);
}

// Teams classic MessageCard. activityTitle/activitySubtitle/activityImage
// get rendered prominently at the top of the card -- using them to
// put the client name and headline front-and-center (instead of
// burying them in the `facts` list like the old version did).
function buildTeamsMessageCard(p, summary, meta) {
  const client = p.client || 'Unassigned';
  const hostname = p.hostname || '?';
  const cardUrl = dashboardUrl(p.pcId);
  const sevLabel = meta.severity === 'critical' ? 'CRITICAL' : meta.severity === 'warn' ? 'ADVISORY' : meta.severity === 'neutral' ? 'INFO' : 'INFO';

  // Watchtower icon as activityImage. Teams expects an HTTPS URL.
  const iconUrl = 'https://frank-umbrella.github.io/work/watchtower/icon-192.png';

  // Per-event fact list -- runs after the activity title/subtitle.
  const facts = [];
  if (hostname) facts.push({ name: 'Host', value: hostname });
  if (p.when) facts.push({ name: 'When', value: p.when });
  switch (p.event) {
    case 'external_ip_changed':
      if (p.previousIp) facts.push({ name: 'Previous IP', value: p.previousIp });
      if (p.newIp) facts.push({ name: 'New IP', value: p.newIp });
      break;
    case 'wsb_backup_failed':
      if (p.result) facts.push({ name: 'Result', value: p.result });
      if (p.daysSinceSuccess != null) facts.push({ name: 'Days since success', value: String(p.daysSinceSuccess) });
      break;
    case 'omsa_warning':
      if (p.rollup) facts.push({ name: 'OMSA rollup', value: String(p.rollup).toUpperCase() });
      if (p.omsaVersion) facts.push({ name: 'OMSA version', value: p.omsaVersion });
      break;
    case 'disk_low':
      if (p.drive) facts.push({ name: 'Drive', value: p.drive });
      if (p.freeGB != null) facts.push({ name: 'Free', value: `${p.freeGB} GB (${p.freePct}%)` });
      break;
    case 'backup_disk_aged':
      if (p.ageLabel) facts.push({ name: 'In rotation', value: p.ageLabel });
      if (p.thresholdLabel) facts.push({ name: 'Threshold', value: p.thresholdLabel });
      if (p.oldestBackup) facts.push({ name: 'First backup', value: p.oldestBackup.slice(0, 10) });
      if (p.newestBackup) facts.push({ name: 'Latest backup', value: p.newestBackup.slice(0, 10) });
      if (p.target) facts.push({ name: 'Target', value: String(p.target).slice(0, 80) });
      break;
    case 'agent_uninstalled':
    case 'agent_decommissioned':
      if (p.source) facts.push({ name: 'Source', value: p.source });
      if (p.reason) facts.push({ name: 'Reason', value: p.reason });
      break;
    case 'host_onboarded':
      if (p.externalIp) facts.push({ name: 'External IP', value: p.externalIp });
      if (p.serviceTag) facts.push({ name: 'Service tag', value: p.serviceTag });
      break;
  }

  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: summary.slice(0, 250),
    themeColor: _WH_HEX_NOHASH[meta.severity],
    title: `Watchtower · ${client}`,                                // top line carries the client
    text: `**${meta.headline}**${meta.context ? ` &middot; ${meta.context}` : ''}`,
    sections: [
      {
        activityTitle: `**${meta.headline}**`,
        activitySubtitle: `${client}  ·  ${sevLabel}  ·  on \`${hostname}\``,
        activityImage: iconUrl,
        facts,
      },
    ],
    potentialAction: [
      {
        '@type': 'OpenUri',
        name: 'Open host in dashboard',
        targets: [{ os: 'default', uri: cardUrl }],
      },
    ],
  };
}

// Discord rich embed. Embeds get a colored vertical left bar (severity),
// support a title + description + structured fields, plus an author row
// for the Watchtower branding. `content` (the older plain-text format)
// drops to a single-line fallback for notification previews.
function buildDiscordEmbed(p, summary, meta) {
  const client = p.client || 'Unassigned';
  const hostname = p.hostname || '?';
  const cardUrl = dashboardUrl(p.pcId);

  const fields = [];
  switch (p.event) {
    case 'external_ip_changed':
      if (p.previousIp) fields.push({ name: 'Previous IP', value: `\`${p.previousIp}\``, inline: true });
      if (p.newIp) fields.push({ name: 'New IP', value: `\`${p.newIp}\``, inline: true });
      break;
    case 'wsb_backup_failed':
      if (p.result) fields.push({ name: 'Result', value: `\`${p.result}\``, inline: true });
      if (p.daysSinceSuccess != null) fields.push({ name: 'Days w/o success', value: String(p.daysSinceSuccess), inline: true });
      if (p.detail) fields.push({ name: 'Detail', value: String(p.detail).slice(0, 1024), inline: false });
      break;
    case 'omsa_warning':
      if (p.rollup) fields.push({ name: 'Rollup', value: String(p.rollup).toUpperCase(), inline: true });
      if (p.omsaVersion) fields.push({ name: 'OMSA version', value: p.omsaVersion, inline: true });
      if (p.issues && p.issues.length) fields.push({ name: `Issues (${p.issues.length})`, value: p.issues.slice(0, 5).map(i => `· ${i}`).join('\n').slice(0, 1024), inline: false });
      break;
    case 'disk_low':
      if (p.drive) fields.push({ name: 'Drive', value: p.drive, inline: true });
      if (p.freeGB != null) fields.push({ name: 'Free', value: `${p.freeGB} GB (${p.freePct}%)`, inline: true });
      break;
    case 'backup_disk_aged':
      if (p.ageLabel) fields.push({ name: 'In rotation', value: p.ageLabel, inline: true });
      if (p.thresholdLabel) fields.push({ name: 'Threshold', value: p.thresholdLabel, inline: true });
      if (p.oldestBackup) fields.push({ name: 'First backup', value: p.oldestBackup.slice(0, 10), inline: true });
      if (p.newestBackup) fields.push({ name: 'Latest backup', value: p.newestBackup.slice(0, 10), inline: true });
      if (p.target) fields.push({ name: 'Target', value: `\`${String(p.target).slice(0, 80)}\``, inline: false });
      break;
    case 'agent_uninstalled':
    case 'agent_decommissioned':
      if (p.source) fields.push({ name: 'Source', value: `\`${p.source}\``, inline: true });
      if (p.reason) fields.push({ name: 'Reason', value: p.reason, inline: false });
      break;
    case 'host_onboarded':
      if (p.externalIp) fields.push({ name: 'External IP', value: `\`${p.externalIp}\``, inline: true });
      if (p.serviceTag) fields.push({ name: 'Service tag', value: `\`${p.serviceTag}\``, inline: true });
      break;
  }
  if (p.when) fields.push({ name: 'When', value: p.when, inline: true });

  return {
    embeds: [
      {
        author: { name: `Watchtower · ${client}` },
        title: meta.headline,
        description: `on \`${hostname}\`${meta.context ? `  ·  ${meta.context}` : ''}\n[Open host in dashboard](${cardUrl})`,
        color: _WH_DECIMAL_RGB[meta.severity],
        fields,
        footer: { text: 'Umbrella Automation' },
      },
    ],
  };
}

// Google Chat Cards v2 builder. Returns the {text, cardsV2:[...]} envelope.
//
// Design notes:
//   * `text` is the notification preview (room list + mobile push). Cards
//     don't generate notifications on their own -- text does.
//   * Card header has an `imageUrl` -- Google Chat needs a public HTTPS
//     image. Pointing at the dashboard's icon-192.png (rasterized from
//     favicon.svg, served by GitHub Pages).
//   * Header subtitle now leads with the CLIENT NAME so the most useful
//     identifier reads from the room list / mobile push without expanding
//     the card. The event label still appears in a leading decoratedText
//     widget at the top of the card body.
//   * Sections use decoratedText widgets so each fact pair (Host: x,
//     Client: y) gets a label + value rather than running text.
//   * Footer button opens the dashboard to the relevant host.
function buildGoogleChatCard(p, summary, meta) {
  const host = p.hostname || '?';
  const client = p.client || 'Unassigned';
  meta = meta || eventMeta(p);
  const headerIcon = 'https://frank-umbrella.github.io/work/watchtower/icon-192.png';
  // Reuse the same dashboard URL helper the email templates use so deep
  // links stay consistent across surfaces.
  const cardUrl = dashboardUrl(p.pcId);
  const sevLabel = meta.severity === 'critical' ? 'CRITICAL' : meta.severity === 'warn' ? 'ADVISORY' : meta.severity === 'neutral' ? 'INFO' : 'INFO';

  const widgets = [];

  // Leading banner widget: event headline + severity label + context.
  // This is the first thing rendered inside the card body, sitting under
  // the header (which already shows the client). Bold + uppercase severity
  // makes the urgency unmissable on a small phone screen. wrapText:true
  // ensures the context string (e.g. "5 days since last success") flows
  // to a second line on mobile instead of getting truncated.
  widgets.push({
    decoratedText: {
      topLabel: sevLabel,
      text: `<b>${meta.headline}</b>${meta.context ? ` &middot; ${meta.context}` : ''}`,
      wrapText: true,
      startIcon: { knownIcon: 'STAR' },
    },
  });

  // Identity row: hostname (client is already in the card header subtitle).
  widgets.push(_gchatFact('Host', host, 'DESCRIPTION'));

  // Event-specific facts.
  switch (p.event) {
    case 'test':
      widgets.push(_gchatFact('Triggered by', p.triggeredBy || 'dashboard', 'PERSON'));
      break;
    case 'host_onboarded':
      if (p.manufacturer || p.model) {
        widgets.push(_gchatFact('Hardware', [p.manufacturer, p.model].filter(Boolean).join(' '), 'TICKET'));
      }
      if (p.os) widgets.push(_gchatFact('OS', p.os, 'STAR'));
      if (p.serviceTag) widgets.push(_gchatFact('Service tag', p.serviceTag, 'BOOKMARK'));
      if (p.externalIp) widgets.push(_gchatFact('External IP', p.externalIp, 'MAP_PIN'));
      break;
    case 'external_ip_changed':
      widgets.push(_gchatFact('Previous IP', p.previousIp || '?', 'MAP_PIN'));
      widgets.push(_gchatFact('New IP', p.newIp || '?', 'MAP_PIN'));
      break;
    case 'omsa_warning':
      widgets.push(_gchatFact('Rollup', String(p.rollup || 'warn').toUpperCase(), 'STAR'));
      if (p.omsaVersion) widgets.push(_gchatFact('OMSA version', p.omsaVersion, 'BOOKMARK'));
      if (p.issues && p.issues.length) {
        // Issues can be multi-line; render as a single decoratedText with
        // wrapText so long lists don't get truncated.
        widgets.push({
          decoratedText: {
            topLabel: `Issues (${p.issues.length})`,
            text: p.issues.slice(0, 5).join('\n'),
            wrapText: true,
            startIcon: { knownIcon: 'DESCRIPTION' },
          },
        });
      }
      break;
    case 'disk_low':
      widgets.push(_gchatFact('Drive', p.drive || 'C:', 'DESCRIPTION'));
      widgets.push(_gchatFact('Severity', String(p.severity || 'warning').toUpperCase(), 'STAR'));
      widgets.push(_gchatFact('Free', `${p.freeGB} GB (${p.freePct}%)`, 'STAR'));
      if (p.sizeGB) widgets.push(_gchatFact('Total', `${p.sizeGB} GB`, 'BOOKMARK'));
      break;
    case 'backup_disk_aged':
      if (p.ageLabel) widgets.push(_gchatFact('In rotation', p.ageLabel, 'CLOCK'));
      if (p.thresholdLabel) widgets.push(_gchatFact('Threshold', p.thresholdLabel, 'BOOKMARK'));
      if (p.oldestBackup) widgets.push(_gchatFact('First backup', p.oldestBackup.slice(0, 10), 'CLOCK'));
      if (p.newestBackup) widgets.push(_gchatFact('Latest backup', p.newestBackup.slice(0, 10), 'CLOCK'));
      if (p.target) widgets.push(_gchatFact('Target', String(p.target).slice(0, 80), 'DESCRIPTION'));
      break;
    case 'wsb_backup_failed':
      widgets.push(_gchatFact('Result', p.result || '?', 'STAR'));
      if (p.daysSinceSuccess != null) {
        widgets.push(_gchatFact('Days since last success', String(p.daysSinceSuccess), 'CLOCK'));
      }
      if (p.lastSuccess) widgets.push(_gchatFact('Last success', p.lastSuccess, 'CLOCK'));
      if (p.detail) {
        widgets.push({
          decoratedText: {
            topLabel: 'Detail',
            text: String(p.detail),
            wrapText: true,
            startIcon: { knownIcon: 'DESCRIPTION' },
          },
        });
      }
      break;
    case 'agent_uninstalled':
    case 'agent_decommissioned':
      if (p.reason) widgets.push(_gchatFact('Reason', p.reason, 'DESCRIPTION'));
      if (p.by) widgets.push(_gchatFact('By', p.by, 'PERSON'));
      break;
  }

  if (p.when) widgets.push(_gchatFact('When', p.when, 'CLOCK'));

  // Footer: link button to the dashboard. Doesn't render on mobile push
  // notifications but works in the in-room card. Per-host deep-link via
  // ?pc=<pcId> opens the host's drawer directly.
  widgets.push({
    buttonList: {
      buttons: [
        {
          text: p.pcId ? 'Open host in dashboard' : 'Open Watchtower',
          onClick: { openLink: { url: cardUrl } },
        },
      ],
    },
  });

  return {
    text: summary,
    cardsV2: [
      {
        cardId: `watchtower-${p.event || 'event'}-${Date.now()}`,
        card: {
          header: {
            title: 'Watchtower',
            // Client name in the subtitle = visible in room/push without
            // expanding the card. Falls back to "Unassigned" so the
            // subtitle is never blank.
            subtitle: client,
            imageUrl: headerIcon,
            imageType: 'SQUARE',
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

// Helper: emit a decoratedText fact widget for the Google Chat card.
// knownIcon is one of Google Chat's built-in icons -- the COMPUTER /
// PERSON / MAP_PIN / CLOCK set is small but covers the relevant cases.
// wrapText:true is critical -- without it Google Chat truncates the
// value with ellipsis on mobile (e.g. "Triggered by: frank@umbrellaa..."
// gets clipped on phone-sized screens). With wrapText the cell flows
// onto a second line and stays readable.
function _gchatFact(label, value, iconName) {
  return {
    decoratedText: {
      topLabel: label,
      text: String(value),
      wrapText: true,
      startIcon: { knownIcon: iconName || 'DESCRIPTION' },
    },
  };
}

// Short notification-preview text shown above the card in chat clients
// (Google Chat room list, mobile push notifications) and used as the
// Slack/Discord text fallback. Kept under ~80 chars per line so it
// wraps cleanly on phone-sized screens. Format: "Watchtower · CLIENT ·
// HEADLINE on HOST" -- three space-padded segments so the chat client
// can wrap at the middle dots.
function humanSummary(p) {
  if (!p || typeof p !== 'object') return 'Watchtower event';
  const host = p.hostname || '?';
  const client = p.client || 'Unassigned';
  const prefix = `Watchtower · ${client}`;
  switch (p.event) {
    case 'test':
      return `${prefix} · Test event from ${p.triggeredBy || 'dashboard'}`;
    case 'host_onboarded':
      return `${prefix} · New host onboarded: ${host}`;
    case 'external_ip_changed':
      return `${prefix} · External IP changed on ${host} (now ${p.newIp || '?'})`;
    case 'omsa_warning':
      return `${prefix} · OMSA ${String(p.rollup || 'WARN').toUpperCase()} on ${host}`;
    case 'wsb_backup_failed':
      return `${prefix} · Backup FAILED on ${host}${p.daysSinceSuccess != null ? ` (${p.daysSinceSuccess}d w/o success)` : ''}`;
    case 'backup_disk_aged':
      return `${prefix} · Backup disk aged on ${host}${p.ageLabel ? ` (${p.ageLabel} in rotation)` : ''}`;
    case 'disk_low':
      return `${prefix} · ${p.drive || 'C:'} ${(p.severity || 'warning').toUpperCase()} on ${host} (${p.freePct}% free)`;
    case 'agent_uninstalled':
      return `${prefix} · Agent uninstalled on ${host}`;
    case 'agent_decommissioned':
      return `${prefix} · ${host} decommissioned by admin`;
    default:
      return `${prefix} · ${p.event || 'event'} on ${host}`;
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

// Structured query helper: returns the document IDs (last path segment)
// of every doc in `collection` where `field == value`. Used by the
// rename-client cascade -- "give me every agent whose clientId is X".
// Reads in pages of 300 (well under the 10MB response cap). Caller
// can do per-id PATCHes from the result.
async function firestoreQueryDocIds(env, accessToken, collection, field, value) {
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: 'EQUAL',
          value: { stringValue: value },
        },
      },
      // Return only the doc name (path) -- we don't need any field data
      // here, just IDs to issue PATCHes against.
      select: { fields: [{ fieldPath: '__name__' }] },
      limit: 300,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Firestore runQuery ${collection} failed: ${resp.status} ${await resp.text()}`);
  }
  const arr = await resp.json();
  // runQuery returns an array of { document?: {name: 'projects/.../documents/agents/PCID'} }
  // entries, plus possibly a leading entry with just readTime when zero matches.
  const ids = [];
  for (const row of arr) {
    if (!row || !row.document || !row.document.name) continue;
    const name = row.document.name;
    const lastSlash = name.lastIndexOf('/');
    if (lastSlash > -1) ids.push(name.slice(lastSlash + 1));
  }
  return ids;
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
