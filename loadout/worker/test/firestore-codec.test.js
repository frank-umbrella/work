import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeValue, decodeValue, encodeFields, decodeFields, decodeDoc, relPath, quoteFieldPath, toRestWrite, chunk } from '../src/firestore.js';

test('codec: scalar types encode to Firestore REST values', () => {
  assert.deepEqual(encodeValue(null), { nullValue: null });
  assert.deepEqual(encodeValue(undefined), { nullValue: null });
  assert.deepEqual(encodeValue(true), { booleanValue: true });
  assert.deepEqual(encodeValue(42), { integerValue: '42' });
  assert.deepEqual(encodeValue(5.5), { doubleValue: 5.5 });
  assert.deepEqual(encodeValue('U6-Pro'), { stringValue: 'U6-Pro' });
  assert.deepEqual(encodeValue(new Date('2026-10-29T09:00:00Z')), { timestampValue: '2026-10-29T09:00:00.000Z' });
});

test('codec: a date-shaped string stays a string', () => {
  assert.deepEqual(encodeValue('2026-10-29T09:00:00Z'), { stringValue: '2026-10-29T09:00:00Z' });
});

test('codec: nested maps and arrays round-trip', () => {
  const obj = { summary: { lines: 3, staged: 0 }, orderLineRefs: [], tags: ['a', 1, null], when: new Date('2026-01-02T03:04:05Z'), qty: 2.25 };
  const back = decodeFields(encodeFields(obj));
  assert.deepEqual(back, obj);
});

test('codec: decoder handles empty arrays and maps sent without inner keys', () => {
  assert.deepEqual(decodeValue({ arrayValue: {} }), []);
  assert.deepEqual(decodeValue({ mapValue: {} }), {});
  assert.equal(decodeValue({ integerValue: '7' }), 7);
  assert.equal(decodeValue({ referenceValue: 'projects/p/databases/(default)/documents/a/b' }), 'projects/p/databases/(default)/documents/a/b');
});

test('codec: decodeDoc keeps id and relative path', () => {
  const d = decodeDoc({ name: 'projects/p/databases/(default)/documents/loadout_tickets/1077/lines/abc', fields: { qtyNeeded: { integerValue: '4' } } });
  assert.deepEqual(d, { id: 'abc', _path: 'loadout_tickets/1077/lines/abc', qtyNeeded: 4 });
  assert.equal(relPath('projects/p/databases/(default)/documents/x/y'), 'x/y');
});

test('codec: field paths are quoted only when needed', () => {
  assert.equal(quoteFieldPath('qtyNeeded'), 'qtyNeeded');
  assert.equal(quoteFieldPath('summary.lines'), '`summary.lines`');
  assert.equal(quoteFieldPath('a-b'), '`a-b`');
});

test('codec: write descriptors map to REST writes with masks and preconditions', () => {
  const env = { FIREBASE_PROJECT_ID: 'demo' };
  const root = 'projects/demo/databases/(default)/documents/';
  const c = toRestWrite(env, { op: 'create', path: 'loadout_tickets/1', data: { a: 1 } });
  assert.equal(c.update.name, root + 'loadout_tickets/1');
  assert.deepEqual(c.currentDocument, { exists: false });
  assert.equal(c.updateMask, undefined);
  const m = toRestWrite(env, { op: 'merge', path: 'loadout_settings/worker', data: { a: 1, b: undefined, c: null } });
  assert.deepEqual(m.updateMask.fieldPaths, ['a', 'c']);
  assert.equal(m.currentDocument, undefined);
  const u = toRestWrite(env, { op: 'update', path: 'x/y', data: { q: 2 } });
  assert.deepEqual(u.currentDocument, { exists: true });
  const s = toRestWrite(env, { op: 'set', path: 'x/y', data: { q: 2 } });
  assert.equal(s.updateMask, undefined);
});

test('codec: writes are chunked at 450 per commit', () => {
  const parts = chunk(Array.from({ length: 1000 }, (_, i) => i));
  assert.deepEqual(parts.map(p => p.length), [450, 450, 100]);
});
