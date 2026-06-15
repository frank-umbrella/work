// ═══════════════════════════════════════════════════════════════════
// backups-worker — end-of-day digest for the Backup Audits tool
// ───────────────────────────────────────────────────────────────────
// Once a day (cron) this reads every change logged to /backup_activity
// in the last 24 hours from Firestore (project watchtower-6fbe1, the
// SAME project the Backup Audits dashboard and Watchtower share) and
// emails a single rollup to DIGEST_TO via Resend.
//
// Auth model — identical to watchtower-worker / usage-worker / stocks-worker:
//   * Firestore reads use a Google service-account JWT (RS256, signed
//     with crypto.subtle) exchanged for an OAuth access token. Service-
//     account reads bypass Firestore security rules.
//   * Email goes out through Resend (RESEND_API_KEY) from the verified
//     alerts.umbrellaautomation.com sending domain.
//
// Endpoints (fetch):
//   GET  /            -> health text
//   GET  /health      -> { ok: true }
//   POST /run?key=... -> run the digest immediately (key must equal
//                        DIGEST_TRIGGER_KEY). For manual testing.
// ═══════════════════════════════════════════════════════════════════

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
const RESEND_BASE = 'https://api.resend.com';
const WINDOW_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, worker: 'backups-worker' });
    }

    if (request.method === 'POST' && url.pathname === '/run') {
      // Trim both sides: secrets piped in via `wrangler secret put` on
      // PowerShell pick up a trailing newline, so a raw === would never match.
      const key = (url.searchParams.get('key') || '').trim();
      const expected = (env.DIGEST_TRIGGER_KEY || '').trim();
      if (!expected || key !== expected) {
        return json({ error: 'forbidden' }, 403);
      }
      try {
        const result = await runDigest(env);
        return json(result);
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runDigest(env).catch(err => console.error('digest run failed:', err))
    );
  },
};

// ───────────────────────────────────────────────────────────────────
// Core: gather the day's activity and email a digest.
// ───────────────────────────────────────────────────────────────────
async function runDigest(env) {
  const sinceMs = Date.now() - WINDOW_MS;
  const sinceIso = new Date(sinceMs).toISOString();

  const token = await getServiceAccountToken(env);
  const events = await queryActivitySince(env, token, sinceIso);

  if (!events.length) {
    console.log('No backup-audit activity in the last 24h — skipping digest.');
    return { sent: false, count: 0, reason: 'no activity' };
  }

  const { subject, html } = buildDigest(env, events, sinceMs);
  await postResendEmail(env, { subject, html });
  console.log(`Digest sent: ${events.length} change(s).`);
  return { sent: true, count: events.length };
}

// runQuery /backup_activity where at >= sinceIso, ordered ascending.
// Range filter + orderBy on the SAME field needs no composite index.
async function queryActivitySince(env, accessToken, sinceIso) {
  const url = `${FIRESTORE_BASE}/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'backup_activity' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'at' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: sinceIso },
        },
      },
      orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
      limit: 500,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Firestore runQuery failed: ${resp.status} ${await resp.text()}`);
  }
  const arr = await resp.json();
  const out = [];
  for (const row of arr) {
    if (!row || !row.document || !row.document.fields) continue;
    out.push(decodeDoc(row.document.fields));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────
// Digest HTML
// ───────────────────────────────────────────────────────────────────
function buildDigest(env, events, sinceMs) {
  const creates = events.filter(e => e.action === 'create').length;
  const updates = events.filter(e => e.action === 'update').length;
  const deletes = events.filter(e => e.action === 'delete').length;
  const dashUrl = env.DASHBOARD_URL || 'https://frank-umbrella.github.io/work/backups/';

  const parts = [];
  parts.push(`${creates} new`);
  if (updates) parts.push(`${updates} edited`);
  if (deletes) parts.push(`${deletes} deleted`);
  const summaryLine = parts.join(' · ');
  const subject = `Backup Audits — ${events.length} change${events.length === 1 ? '' : 's'} today (${summaryLine})`;

  const rows = events.map(ev => {
    const verb = ev.action === 'create' ? 'Created' : ev.action === 'delete' ? 'Deleted' : 'Edited';
    const color = ev.action === 'create' ? '#3ecf8e' : ev.action === 'delete' ? '#f0655d' : '#f0b955';
    const when = ev.at ? new Date(ev.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';
    const who = esc(ev.byName || ev.byEmail || '');
    const target = esc([ev.client, ev.server].filter(Boolean).join(' — '));

    let changesHtml = '';
    if (ev.action === 'update' && Array.isArray(ev.changes) && ev.changes.length) {
      const items = ev.changes.slice(0, 25).map(c =>
        `<li style="margin:2px 0;"><b style="color:#cfd6df;">${esc(c.field)}</b>: <span style="color:#8892a4;">${esc(c.from || '—')}</span> &rarr; <span style="color:#cfd6df;">${esc(c.to || '—')}</span></li>`
      ).join('');
      changesHtml = `<ul style="margin:6px 0 0 0; padding-left:18px; font-size:12.5px;">${items}</ul>`;
    }

    return `
      <tr>
        <td style="padding:12px 14px; border-bottom:1px solid #2a3340; vertical-align:top;">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${color}; margin-right:7px;"></span>
          <b style="color:#e6ebf2;">${verb}</b>
          <span style="color:#e6ebf2;"> ${target}</span>
          <div style="color:#6b7787; font-size:12px; margin-top:2px;">${when ? when + ' ET · ' : ''}${who}</div>
          ${changesHtml}
        </td>
      </tr>`;
  }).join('');

  const html = `
  <div style="background:#0e1116; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:640px; margin:0 auto; background:#181e27; border:1px solid #2a3340; border-radius:14px; overflow:hidden;">
      <div style="padding:20px 22px; border-bottom:1px solid #2a3340;">
        <div style="font-size:11px; letter-spacing:.8px; text-transform:uppercase; color:#1f9d8f; font-weight:700;">Umbrella Automation</div>
        <div style="font-size:19px; color:#e6ebf2; font-weight:700; margin-top:4px;">Backup Audits — daily digest</div>
        <div style="font-size:13px; color:#9aa6b5; margin-top:4px;">${events.length} change${events.length === 1 ? '' : 's'} in the last 24 hours · ${esc(summaryLine)}</div>
      </div>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
      <div style="padding:18px 22px;">
        <a href="${esc(dashUrl)}" style="display:inline-block; background:#1f9d8f; color:#04221e; text-decoration:none; font-weight:700; font-size:13.5px; padding:10px 18px; border-radius:9px;">Open the dashboard &rarr;</a>
      </div>
      <div style="padding:0 22px 20px; color:#6b7787; font-size:11.5px;">
        Sent automatically by backups-worker. Activity is also viewable on the Activity tab in the dashboard.
      </div>
    </div>
  </div>`;

  return { subject, html };
}

async function postResendEmail(env, { subject, html }) {
  const resp = await fetch(`${RESEND_BASE}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(env.RESEND_API_KEY || '').trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SENDER_FROM || 'Backup Audits <onboarding@resend.dev>',
      to: [env.DIGEST_TO],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Firestore typed-value decoding (read side)
// ───────────────────────────────────────────────────────────────────
function decodeDoc(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}
function decodeValue(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeDoc(v.mapValue.fields || {});
  return null;
}

// ───────────────────────────────────────────────────────────────────
// Service-account → OAuth access token (RS256 JWT via crypto.subtle).
// Lifted verbatim from watchtower-worker / stocks-worker.
// ───────────────────────────────────────────────────────────────────
let _accessTokenCache = null;

async function getServiceAccountToken(env) {
  if (_accessTokenCache && _accessTokenCache.expiresAt > Date.now() + 60_000) {
    return _accessTokenCache.token;
  }
  // Strip a leading UTF-8 BOM — service-account JSON files saved on Windows
  // (and piped in via `wrangler secret put`) often carry one, which breaks JSON.parse.
  const sa = JSON.parse((env.FIREBASE_SERVICE_ACCOUNT_JSON || '').replace(/^﻿/, ''));
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
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(arrayBufferToBase64(sigBuf))}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    throw new Error(`Service account token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  _accessTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
  return data.access_token;
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
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(stripped), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
