import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_ROOT, dayPrefix, objectName, dayFromPrefix, foldersToPrune, encodeName,
  uploadUrl, objectUrl, listUrl, batchDeleteBody, batchStatuses,
} from '../src/storage.js';

const BUCKET = 'watchtower-6fbe1.firebasestorage.app';

test('storage: object names are loadout/backups/YYYY-MM-DD/<file>', () => {
  assert.equal(BACKUP_ROOT, 'loadout/backups/');
  assert.equal(dayPrefix('2026-11-02'), 'loadout/backups/2026-11-02/');
  assert.equal(objectName('2026-11-02', 'loadout_products.csv'), 'loadout/backups/2026-11-02/loadout_products.csv');
});

test('storage: a listed prefix gives its day, anything else gives null', () => {
  assert.equal(dayFromPrefix('loadout/backups/2026-11-02/'), '2026-11-02');
  assert.equal(dayFromPrefix('loadout/backups/2026-11-02'), '2026-11-02');
  assert.equal(dayFromPrefix('loadout/backups/notes/'), 'notes');
  assert.equal(dayFromPrefix('loadout/backups/'), null);
  assert.equal(dayFromPrefix('loadout/backups/2026-11-02/extra/'), null);
  assert.equal(dayFromPrefix('loadout/products/'), null);
  assert.equal(dayFromPrefix(null), null);
});

test('storage: prune picks the old days from listed prefixes and leaves non-dates alone', () => {
  const now = new Date('2026-10-29T09:00:00Z');
  const prefixes = [
    'loadout/backups/2026-10-29/', 'loadout/backups/2026-07-31/', 'loadout/backups/2026-07-30/',
    'loadout/backups/2025-12-31/', 'loadout/backups/notes/', 'loadout/backups/2026-7-1/',
  ];
  const days = prefixes.map(dayFromPrefix).filter(Boolean).map(name => ({ name }));
  assert.deepEqual(foldersToPrune(days, now).map(f => f.name), ['2026-07-30', '2025-12-31']);
});

test('storage: names with slashes are one encoded path segment', () => {
  const name = objectName('2026-11-02', 'loadout_ticket_lines.csv');
  assert.equal(encodeName(name), 'loadout%2Fbackups%2F2026-11-02%2Floadout_ticket_lines.csv');
  assert.equal(uploadUrl(BUCKET, name),
    'https://storage.googleapis.com/upload/storage/v1/b/watchtower-6fbe1.firebasestorage.app/o?uploadType=media&name=loadout%2Fbackups%2F2026-11-02%2Floadout_ticket_lines.csv');
  assert.equal(objectUrl(BUCKET, name),
    'https://storage.googleapis.com/storage/v1/b/watchtower-6fbe1.firebasestorage.app/o/loadout%2Fbackups%2F2026-11-02%2Floadout_ticket_lines.csv');
  assert.ok(!objectUrl(BUCKET, name).split('/o/')[1].includes('/'));
});

test('storage: the day listing asks for prefixes one level under the root', () => {
  const u = new URL(listUrl(BUCKET, { prefix: BACKUP_ROOT, delimiter: '/', pageToken: 'abc' }));
  assert.equal(u.pathname, '/storage/v1/b/watchtower-6fbe1.firebasestorage.app/o');
  assert.equal(u.searchParams.get('prefix'), 'loadout/backups/');
  assert.equal(u.searchParams.get('delimiter'), '/');
  assert.equal(u.searchParams.get('pageToken'), 'abc');
});

test('storage: a batch delete names every object, encoded, one part each', () => {
  const names = [objectName('2026-07-30', 'loadout_products.csv'), objectName('2026-07-30', 'loadout_stock.csv')];
  const body = batchDeleteBody('b1', BUCKET, names);
  assert.equal(body.split('--b1\r\n').length - 1, 2);
  assert.ok(body.includes('DELETE /storage/v1/b/watchtower-6fbe1.firebasestorage.app/o/loadout%2Fbackups%2F2026-07-30%2Floadout_products.csv HTTP/1.1'));
  assert.ok(body.includes('Content-ID: <2>'));
  assert.ok(body.endsWith('--b1--\r\n'));
});

test('storage: batch response statuses are read per part, in order', () => {
  const text = [
    '--batch_x', 'Content-Type: application/http', 'Content-ID: <response-1>', '', 'HTTP/1.1 204 No Content', '', '',
    '--batch_x', 'Content-Type: application/http', 'Content-ID: <response-2>', '', 'HTTP/1.1 404 Not Found', 'Content-Type: application/json', '', '{"error":{}}', '',
    '--batch_x--', '',
  ].join('\r\n');
  assert.deepEqual(batchStatuses('multipart/mixed; boundary=batch_x', text), [204, 404]);
  assert.deepEqual(batchStatuses('multipart/mixed; boundary="batch_x"', text), [204, 404]);
  assert.throws(() => batchStatuses('application/json', text));
});
