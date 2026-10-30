// Google Drive API v3 calls for the nightly export (PLAN section 16 rule 7):
// a dated subfolder YYYY-MM-DD under DRIVE_FOLDER_ID, one CSV per
// collection inside it, and subfolders older than RETENTION_DAYS moved to
// the trash.
//
// supportsAllDrives is on every call because the backup folder should live
// on a Shared Drive: a service account has no storage quota of its own, so
// uploads into a folder in a person's My Drive fail with storageQuotaExceeded.

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const RETENTION_DAYS = 90;

const pad = n => String(n).padStart(2, '0');

// The folder name for a run, in UTC (the cron fires at 09:00 UTC).
export function dayStamp(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// Folders named YYYY-MM-DD whose date is more than `days` days before the
// run's date are pruned. Exactly `days` days old is kept. The name is the
// source of truth, not Drive's createdTime, so a folder re-created by a
// late rerun keeps its own date. Anything not named like a date is left alone.
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

async function driveFetch(token, url, init = {}) {
  const resp = await fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Authorization: 'Bearer ' + token }, init.headers || {}),
  }));
  if (!resp.ok) throw new Error('Drive ' + (init.method || 'GET') + ' ' + url.split('?')[0] + ' failed: ' + resp.status + ' ' + (await resp.text()));
  return resp.status === 204 ? null : resp.json();
}

function qs(params) {
  return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

// Every non-trashed child of a folder, optionally only folders.
export async function listChildren(token, parentId, { foldersOnly = false } = {}) {
  const out = [];
  let pageToken = '';
  const q = "'" + parentId.replace(/'/g, "\\'") + "' in parents and trashed = false" + (foldersOnly ? " and mimeType = '" + FOLDER_MIME + "'" : '');
  do {
    const params = { q, fields: 'nextPageToken, files(id, name, mimeType, createdTime)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };
    if (pageToken) params.pageToken = pageToken;
    const data = await driveFetch(token, DRIVE_API + '/files?' + qs(params));
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function createFolder(token, name, parentId) {
  return driveFetch(token, DRIVE_API + '/files?' + qs({ supportsAllDrives: 'true', fields: 'id, name' }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

// Multipart upload: metadata and the CSV in one request.
export function multipartBody(boundary, metadata, text, contentType = 'text/csv; charset=UTF-8') {
  return '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + contentType + '\r\n\r\n' +
    text + '\r\n' +
    '--' + boundary + '--';
}

export async function uploadCsv(token, folderId, name, text, existingId = null) {
  if (existingId) {
    // Same file name already in today's folder (a rerun): replace its content.
    return driveFetch(token, DRIVE_UPLOAD + '/files/' + encodeURIComponent(existingId) + '?' + qs({ uploadType: 'media', supportsAllDrives: 'true', fields: 'id, name' }), {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/csv; charset=UTF-8' },
      body: text,
    });
  }
  const boundary = 'loadout' + Math.random().toString(36).slice(2);
  return driveFetch(token, DRIVE_UPLOAD + '/files?' + qs({ uploadType: 'multipart', supportsAllDrives: 'true', fields: 'id, name' }), {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: multipartBody(boundary, { name, mimeType: 'text/csv', parents: [folderId] }, text),
  });
}

// Trash rather than delete: a Shared Drive empties its trash after 30 days,
// which leaves a window to pull back a folder pruned by mistake.
export async function trashFile(token, fileId) {
  return driveFetch(token, DRIVE_API + '/files/' + encodeURIComponent(fileId) + '?' + qs({ supportsAllDrives: 'true', fields: 'id' }), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}
