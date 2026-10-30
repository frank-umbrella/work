// Firestore REST access through a Google service account.
// Same idea as watchtower-worker: the worker signs a JWT with the service
// account's private key, trades it for an OAuth access token, and calls the
// Firestore REST API with it. The service account bypasses security rules,
// so nothing in watchtower/firestore.rules changes for this worker.

import { SignJWT, importPKCS8 } from 'jose';

export const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';
export const SCOPE_DATASTORE = 'https://www.googleapis.com/auth/datastore';
export const SCOPE_DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
// Firestore commit allows 500 writes; 450 leaves headroom, same as the app.
export const BATCH_SIZE = 450;
// Rows per runQuery page. Bigger pages mean fewer subrequests, which matters
// on the Workers free plan (50 subrequests per invocation).
export const PAGE_SIZE = 1000;

// ---------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------

const tokenCache = new Map();

// One token can carry several scopes; the nightly export asks for Firestore
// and Drive together so it mints once.
export async function getAccessToken(env, scopes) {
  const scope = (Array.isArray(scopes) ? scopes : [scopes]).join(' ');
  const hit = tokenCache.get(scope);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not set');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const key = await importPKCS8(sa.private_key, 'RS256');
  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!resp.ok) throw new Error('Service account token exchange failed: ' + resp.status + ' ' + (await resp.text()));
  const data = await resp.json();
  tokenCache.set(scope, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 });
  return data.access_token;
}

// ---------------------------------------------------------------------
// Value codec: plain JS <-> Firestore REST typed values
// ---------------------------------------------------------------------

// Dates become timestamps; strings stay strings (no ISO guessing, so a
// part number that looks like a date is never turned into one).
export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

export function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    fields[k] = encodeValue(v);
  }
  return fields;
}

export function decodeValue(fv) {
  if (!fv || typeof fv !== 'object') return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) return Number(fv.integerValue);
  if ('doubleValue' in fv) return Number(fv.doubleValue);
  if ('stringValue' in fv) return fv.stringValue;
  if ('timestampValue' in fv) return new Date(fv.timestampValue);
  if ('referenceValue' in fv) return fv.referenceValue;
  if ('bytesValue' in fv) return fv.bytesValue;
  if ('geoPointValue' in fv) return { latitude: fv.geoPointValue.latitude ?? 0, longitude: fv.geoPointValue.longitude ?? 0 };
  // An empty array or map comes back with the inner key missing.
  if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in fv) return decodeFields(fv.mapValue.fields || {});
  return null;
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

// A REST document becomes { id, ...fields }; _path keeps the full path so
// subcollection rows know their parent.
export function decodeDoc(doc) {
  const rel = relPath(doc.name);
  return Object.assign({ id: rel.split('/').pop(), _path: rel }, decodeFields(doc.fields));
}

// "projects/p/databases/(default)/documents/a/b/c/d" -> "a/b/c/d"
export function relPath(name) {
  const i = name.indexOf('/documents/');
  return i < 0 ? name : name.slice(i + '/documents/'.length);
}

// Field names outside [A-Za-z_][A-Za-z0-9_]* must be backtick-quoted in masks.
export function quoteFieldPath(k) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '`' + k.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export function docsRoot(env) {
  return 'projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents';
}

export async function getDoc(env, token, path) {
  const resp = await fetch(FIRESTORE_BASE + '/' + docsRoot(env) + '/' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error('Firestore GET ' + path + ' failed: ' + resp.status + ' ' + (await resp.text()));
  return decodeDoc(await resp.json());
}

async function runQuery(env, token, parentPath, structuredQuery) {
  const parent = parentPath ? docsRoot(env) + '/' + parentPath : docsRoot(env);
  const resp = await fetch(FIRESTORE_BASE + '/' + parent + ':runQuery', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!resp.ok) throw new Error('Firestore runQuery failed: ' + resp.status + ' ' + (await resp.text()));
  const rows = await resp.json();
  // A zero-match query returns one row holding only readTime.
  return rows.filter(r => r && r.document).map(r => r.document);
}

// Every document in a collection, paged by document name.
// collectionId is the last segment ("loadout_products"); parentPath is ""
// for a root collection or "loadout_tickets/1077" for one ticket's lines.
// allDescendants: true reads a collection group ("lines" under every parent).
export async function queryAll(env, token, collectionId, { parentPath = '', allDescendants = false, pageSize = PAGE_SIZE } = {}) {
  const out = [];
  let after = null;
  for (;;) {
    const q = {
      from: [{ collectionId, allDescendants }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize,
    };
    if (after) q.startAt = { values: [{ referenceValue: after }], before: false };
    const docs = await runQuery(env, token, parentPath, q);
    for (const d of docs) out.push(decodeDoc(d));
    if (docs.length < pageSize) break;
    after = docs[docs.length - 1].name;
  }
  return out;
}

// Documents in one root collection where field == value (string).
export async function queryEq(env, token, collectionId, field, value, limit = 5) {
  const docs = await runQuery(env, token, '', {
    from: [{ collectionId }],
    where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encodeValue(value) } },
    limit,
  });
  return docs.map(decodeDoc);
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

// Write descriptors used across the worker:
//   { op: 'create', path, data }  fails if the doc exists (guards a racing replay)
//   { op: 'set',    path, data }  full replace
//   { op: 'merge',  path, data }  only the given top-level fields change
//   { op: 'update', path, data }  like merge, but the doc must exist
export function toRestWrite(env, w) {
  const name = docsRoot(env) + '/' + w.path;
  const out = { update: { name, fields: encodeFields(w.data) } };
  if (w.op === 'merge' || w.op === 'update') {
    out.updateMask = { fieldPaths: Object.keys(w.data).filter(k => w.data[k] !== undefined).map(quoteFieldPath) };
  }
  if (w.op === 'update') out.currentDocument = { exists: true };
  if (w.op === 'create') out.currentDocument = { exists: false };
  return out;
}

export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Each chunk commits atomically; chunks after the first are separate commits.
export async function commitWrites(env, token, writes) {
  for (const part of chunk(writes)) {
    const resp = await fetch(FIRESTORE_BASE + '/' + docsRoot(env) + ':commit', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: part.map(w => toRestWrite(env, w)) }),
    });
    if (!resp.ok) {
      const err = new Error('Firestore commit failed: ' + resp.status + ' ' + (await resp.text()));
      err.status = resp.status;
      throw err;
    }
  }
}
