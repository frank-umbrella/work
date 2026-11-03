// Google Cloud Storage JSON API calls for the nightly export (PLAN section
// 16 rule 7). The files go to the project's own Firebase Storage bucket
// (STORAGE_BUCKET, the app's storageBucket) under
// loadout/backups/YYYY-MM-DD/<collection>.csv, and days older than
// RETENTION_DAYS are deleted.
//
// Why Storage and not Google Drive (0.2.0): the shop's Workspace cannot
// create a Shared Drive, and a service account cannot upload into a folder
// in a person's My Drive (storageQuotaExceeded). The bucket is already in
// watchtower-6fbe1 for product photos, the same service account reaches it
// once it has the Storage Object Admin role, and the app lists the files
// under Console > Backups.

export const STORAGE_API = 'https://storage.googleapis.com/storage/v1';
export const STORAGE_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';
export const BACKUP_ROOT = 'loadout/backups/';
export const CSV_TYPE = 'text/csv; charset=UTF-8';
export const RETENTION_DAYS = 90;

const pad = n => String(n).padStart(2, '0');

// The day folder for a run, in UTC (the cron fires at 09:00 UTC).
export function dayStamp(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// loadout/backups/2026-11-02/ for a day stamp.
export function dayPrefix(day) {
  return BACKUP_ROOT + day + '/';
}

// loadout/backups/2026-11-02/loadout_products.csv
export function objectName(day, file) {
  return dayPrefix(day) + file;
}

// The day stamp from a listed prefix ("loadout/backups/2026-11-02/" gives
// "2026-11-02"). Anything that is not directly one level under the backup
// root gives null, so a stray folder is never read as a day.
export function dayFromPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith(BACKUP_ROOT)) return null;
  const rest = prefix.slice(BACKUP_ROOT.length).replace(/\/$/, '');
  return rest && !rest.includes('/') ? rest : null;
}

// Days named YYYY-MM-DD whose date is more than `days` days before the
// run's date are pruned. Exactly `days` days old is kept. The name is the
// source of truth, not the objects' timeCreated, so a day rewritten by a
// late rerun keeps its own date. Anything not named like a date is left
// alone. Each entry is { name } (a listed day), so the same function took
// Drive folders before 0.2.0.
export function foldersToPrune(folders, now, days = RETENTION_DAYS) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - days * 86400000;
  return folders.filter(f => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f.name || '');
    if (!m) return false;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return !isNaN(t) && t < cutoff;
  });
}

// The object part of a JSON API URL: the whole name, slashes included, is
// one path segment, so every slash is encoded (%2F).
export function encodeName(name) {
  return encodeURIComponent(name);
}

export function uploadUrl(bucket, name) {
  return STORAGE_UPLOAD + '/b/' + encodeURIComponent(bucket) + '/o?uploadType=media&name=' + encodeName(name);
}

export function objectUrl(bucket, name) {
  return STORAGE_API + '/b/' + encodeURIComponent(bucket) + '/o/' + encodeName(name);
}

export function listUrl(bucket, { prefix, delimiter, pageToken } = {}) {
  const params = [['fields', 'nextPageToken,prefixes,items(name)']];
  if (prefix) params.push(['prefix', prefix]);
  if (delimiter) params.push(['delimiter', delimiter]);
  if (pageToken) params.push(['pageToken', pageToken]);
  return STORAGE_API + '/b/' + encodeURIComponent(bucket) + '/o?' + params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

async function gcsFetch(token, url, init = {}) {
  const resp = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Authorization: 'Bearer ' + token }, init.headers || {}),
  }));
  if (!resp.ok) {
    const e = new Error('Storage ' + (init.method || 'GET') + ' ' + url.split('?')[0] + ' failed: ' + resp.status + ' ' + (await resp.text()));
    e.status = resp.status;
    throw e;
  }
  return resp.status === 204 || init.method === 'DELETE' ? null : resp.json();
}

// The day stamps under loadout/backups/, from the listing's prefixes.
// One subrequest per 1,000 days, so one in practice.
export async function listDays(token, bucket) {
  const days = [];
  let pageToken = '';
  do {
    const data = await gcsFetch(token, listUrl(bucket, { prefix: BACKUP_ROOT, delimiter: '/', pageToken }));
    for (const p of data.prefixes || []) {
      const d = dayFromPrefix(p);
      if (d) days.push(d);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return days;
}

// Every object name under a prefix (one day's files).
export async function listNames(token, bucket, prefix) {
  const names = [];
  let pageToken = '';
  do {
    const data = await gcsFetch(token, listUrl(bucket, { prefix, pageToken }));
    for (const it of data.items || []) names.push(it.name);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return names;
}

// A simple media upload. The same name on the same day replaces the
// object, so a rerun overwrites instead of adding copies.
export async function uploadCsv(token, bucket, name, text) {
  return gcsFetch(token, uploadUrl(bucket, name), {
    method: 'POST',
    headers: { 'Content-Type': CSV_TYPE },
    body: text,
  });
}

// ---------------------------------------------------------------------
// Deleting a day
// ---------------------------------------------------------------------
//
// One DELETE per file would cost 18 subrequests a day, and from day 91 on
// every run prunes a day, which takes a normal run past the 50 subrequests
// the Workers free plan allows (see the count in index.js). Storage's
// batch endpoint carries up to 100 DELETE calls in one request, so a day
// costs two subrequests: the list and one batch. Each part still answers
// on its own; 404 (already gone) counts as done.

export const STORAGE_BATCH = 'https://storage.googleapis.com/batch/storage/v1';
export const BATCH_MAX = 100;

export function batchDeleteBody(boundary, bucket, names) {
  return names.map((n, i) =>
    '--' + boundary + '\r\n' +
    'Content-Type: application/http\r\n' +
    'Content-ID: <' + (i + 1) + '>\r\n\r\n' +
    'DELETE /storage/v1/b/' + encodeURIComponent(bucket) + '/o/' + encodeName(n) + ' HTTP/1.1\r\n\r\n'
  ).join('') + '--' + boundary + '--\r\n';
}

// The HTTP status of each part of a multipart/mixed batch response, in
// order. `contentType` is the response's Content-Type header, which names
// the boundary.
export function batchStatuses(contentType, text) {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType || '');
  if (!m) throw new Error('Storage batch answered without a multipart boundary');
  return text.split('--' + m[2]).slice(1)
    .map(part => /HTTP\/1\.[01] (\d{3})/.exec(part))
    .filter(Boolean)
    .map(x => +x[1]);
}

export async function deleteNames(token, bucket, names) {
  for (let i = 0; i < names.length; i += BATCH_MAX) {
    const chunk = names.slice(i, i + BATCH_MAX);
    const boundary = 'loadout' + Math.random().toString(36).slice(2);
    const resp = await fetch(STORAGE_BATCH, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/mixed; boundary=' + boundary },
      body: batchDeleteBody(boundary, bucket, chunk),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const e = new Error('Storage batch delete failed: ' + resp.status + ' ' + text.slice(0, 300));
      e.status = resp.status;
      throw e;
    }
    const statuses = batchStatuses(resp.headers.get('Content-Type'), text);
    const bad = statuses.filter(s => !(s >= 200 && s < 300) && s !== 404);
    if (statuses.length !== chunk.length || bad.length) {
      const e = new Error('Storage batch delete: ' + chunk.length + ' asked, ' + statuses.length + ' answered, failures ' + (bad.join(', ') || 'none'));
      e.status = bad[0] || 500;
      throw e;
    }
  }
  return names.length;
}

// Deletes every object of a day (two subrequests for a normal day).
// Storage has no trash; the 90 days of copies after it are the safety net.
export async function deleteDay(token, bucket, day) {
  const names = await listNames(token, bucket, dayPrefix(day));
  return deleteNames(token, bucket, names);
}
