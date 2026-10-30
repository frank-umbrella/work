import test from 'node:test';
import assert from 'node:assert/strict';
import { dayStamp, foldersToPrune, multipartBody, RETENTION_DAYS } from '../src/drive.js';

test('retention: folder name is the UTC date of the run', () => {
  assert.equal(dayStamp(new Date('2026-10-29T09:00:00Z')), '2026-10-29');
  assert.equal(dayStamp(new Date('2026-01-05T23:59:59Z')), '2026-01-05');
});

test('retention: exactly 90 days old is kept, 91 is pruned, non-date names are left alone', () => {
  assert.equal(RETENTION_DAYS, 90);
  const now = new Date('2026-10-29T09:00:00Z');
  const folders = [
    { id: 'a', name: '2026-10-29' },
    { id: 'b', name: '2026-07-31' },
    { id: 'c', name: '2026-07-30' },
    { id: 'd', name: '2025-12-31' },
    { id: 'e', name: 'notes' },
    { id: 'f', name: '2026-7-1' },
  ];
  assert.deepEqual(foldersToPrune(folders, now).map(f => f.id), ['c', 'd']);
});

test('retention: the cutoff crosses a year boundary and a leap day correctly', () => {
  const now = new Date('2028-03-01T09:00:00Z');
  // 2028 is a leap year: 90 days before 2028-03-01 is 2027-12-02.
  const out = foldersToPrune([{ id: 'k', name: '2027-12-02' }, { id: 'p', name: '2027-12-01' }], now).map(f => f.id);
  assert.deepEqual(out, ['p']);
});

test('drive: multipart body carries the metadata, then the CSV', () => {
  const body = multipartBody('xyz', { name: 'a.csv', parents: ['F'] }, 'id\r\n1\r\n');
  assert.ok(body.startsWith('--xyz\r\nContent-Type: application/json'));
  assert.ok(body.includes('{"name":"a.csv","parents":["F"]}'));
  assert.ok(body.includes('Content-Type: text/csv; charset=UTF-8\r\n\r\nid\r\n1\r\n'));
  assert.ok(body.endsWith('--xyz--'));
});
