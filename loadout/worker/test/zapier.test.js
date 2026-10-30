import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseProposal, buildImport, unwrapPayload, chooseOptions, productIdFor, composeName, lineIdFor, slug,
  matchProduct, availableFor, secretsMatch, statusFrom,
} from '../src/zapier.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/zapier-proposal-accepted.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-29T15:00:00Z');

// A tiny stand-in for Firestore: applies the worker's write descriptors to a
// Map of path -> doc, enforcing the create/update preconditions.
function applyWrites(store, writes) {
  for (const w of writes) {
    const cur = store.get(w.path);
    if (w.op === 'create' && cur) throw new Error('ALREADY_EXISTS ' + w.path);
    if (w.op === 'update' && !cur) throw new Error('NOT_FOUND ' + w.path);
    if (w.op === 'set' || w.op === 'create') store.set(w.path, Object.assign({}, w.data));
    else store.set(w.path, Object.assign({}, cur || {}, w.data));
  }
}
function contextFrom(store, number) {
  const tid = slug(number);
  const ticket = store.get('loadout_tickets/' + tid);
  const lines = new Map();
  const products = new Map();
  for (const [path, doc] of store) {
    const seg = path.split('/');
    if (seg[0] === 'loadout_tickets' && seg[1] === tid && seg[2] === 'lines') lines.set(seg[3], Object.assign({ id: seg[3] }, doc));
    if (seg[0] === 'loadout_products' && seg.length === 2) products.set(seg[1], Object.assign({ id: seg[1] }, doc));
  }
  return { products, ticket: ticket ? Object.assign({ id: tid }, ticket) : null, lines, client: null, job: null, inventory: null, now: NOW };
}
const clone = o => JSON.parse(JSON.stringify(o));

test('zapier parser: fixture areas become lines grouped by area', () => {
  const p = parseProposal(fixture);
  assert.equal(p.number, '1077');
  assert.equal(p.status, 'Accepted');
  assert.equal(p.portalId, '55120');
  assert.equal(p.name, 'Harbor Street office refresh');
  assert.deepEqual(p.customer, { portalContactId: '7301', name: 'Example Dental Group', address: '100 Harbor Street Suite 2, Sampletown, EX 00000' });
  assert.deepEqual(p.lines.map(l => [l.id, l.qtyNeeded]), [
    ['front-office--ubiquiti-u6-pro', 3],
    ['front-office--ubiquiti-usw-pro-24-poe', 1],
    ['front-office--panduit-cj688tgbu', 24],
    ['conference-room--sonos-amp', 1],
    ['conference-room--sonance-vp62r', 4],
    ['network-closet--belden-1583a', 1000],
    ['network-closet--velcro-cable-ties', 3],
  ]);
  assert.deepEqual(p.areas.map(a => [a.name, a.lines]), [['Front Office', 3], ['Conference Room', 2], ['Network Closet', 2]]);
  // two Portal items for the same product in one area are one line
  assert.deepEqual(p.lines[0].portalItemIds, ['9001', '9003']);
});

test('zapier parser: Labor, Fee, CustomItem, and zero quantity are skipped and listed', () => {
  const p = parseProposal(fixture);
  assert.deepEqual(p.skipped.map(s => [s.itemId, s.itemType, s.why]), [
    ['9004', 'Labor', 'Labor rows are not product'],
    ['9022', 'CustomItem', 'CustomItem rows are not product'],
    ['9023', 'Fee', 'Fee rows are not product'],
    ['9024', 'Part', 'Quantity 0 is not a number above zero'],
  ]);
});

test('zapier parser: declined and not-chosen options are skipped and listed', () => {
  const p = parseProposal(fixture);
  assert.deepEqual(p.skippedOptions.map(o => [o.area, o.optionId, o.why]), [
    ['Front Office', '402', 'Option declined'],
    ['Network Closet', '405', 'Another option in this area was accepted'],
  ]);
  // an area whose only option is Draft is still imported (Conference Room)
  assert.equal(chooseOptions([{ id: 1, status: 'Draft' }]).use.length, 1);
});

test('zapier parser: nested items take the parent\'s area', () => {
  const p = parseProposal(fixture);
  const jack = p.lines.find(l => l.model === 'CJ688TGBU');
  assert.equal(jack.parentPortalItemId, '9002');
  assert.equal(jack.area, 'Front Office');
  const speaker = p.lines.find(l => l.model === 'VP62R');
  assert.equal(speaker.area, 'Conference Room');
  // a child listed under a different area still follows its parent
  const moved = clone(fixture);
  const child = moved.areas[0].options[0].items.splice(4, 1)[0];
  moved.areas[2].options[0].items.push(child);
  const p2 = parseProposal(moved);
  assert.equal(p2.lines.find(l => l.model === 'CJ688TGBU').id, 'front-office--panduit-cj688tgbu');
});

test('zapier parser: accepts a wrapped array, a proposal key, and areas sent as JSON text', () => {
  assert.equal(unwrapPayload([fixture]).number, 1077);
  assert.equal(unwrapPayload({ proposal: fixture }).number, 1077);
  const textAreas = Object.assign({}, fixture, { areas: JSON.stringify(fixture.areas) });
  assert.equal(parseProposal(textAreas).lines.length, 7);
  assert.equal(parseProposal(JSON.stringify(fixture)).lines.length, 7);
});

test('ids and names follow the app rules (PLAN section 17)', () => {
  assert.equal(productIdFor({ brand: 'Ubiquiti', model: 'U6-Pro' }), 'ubiquiti-u6-pro');
  assert.equal(productIdFor({ brand: 'ubiquiti', model: 'U6 Pro' }), 'ubiquiti-u6-pro');
  assert.equal(productIdFor({ brand: 'B&K', model: "6\" Mount/Arm" }), 'b-and-k-6-mountarm');
  assert.equal(productIdFor({ brand: 'Acme', model: '' }), 'acme');
  assert.equal(productIdFor({ kind: 'patch-cable', type: 'Cat6 UTP patch cable', connector1: 'RJ45/M', connector2: 'RJ45/M', color: 'Blue', length: 3, lengthUnit: 'ft' }), 'patch-cable-cat6-utp-patch-cable-rj45m-rj45m-blue-3ft');
  assert.equal(composeName({ brand: 'Ubiquiti', model: 'U6-Pro' }), 'Ubiquiti U6-Pro');
  assert.equal(composeName({ brand: 'Acme' }), 'Product, Acme');
  assert.equal(composeName({ kind: 'patch-cable', type: 'Cat6 UTP patch cable', connector1: 'RJ45- M', connector2: 'RJ45-M', color: 'blue', length: 3, lengthUnit: 'ft' }), 'Cat6 UTP patch cable, RJ45-M to RJ45-M, blue, 3 ft');
  assert.equal(lineIdFor('Living Room', 'Sonos', 'Amp', ''), 'living-room--sonos-amp');
  assert.equal(lineIdFor('', '', '', 'Velcro ties'), 'general--velcro-ties');
});

test('catalog match: brand + model ignores case and spacing, then falls back to the slug id', () => {
  const products = new Map([['ubiquiti-u6-pro', { id: 'ubiquiti-u6-pro', brand: 'Ubiquiti', model: 'U6-Pro' }], ['sonos-amp', { id: 'sonos-amp', brand: 'SONOS', model: 'Amp  ' }]]);
  assert.equal(matchProduct(products, 'sonos', 'amp').id, 'sonos-amp');
  assert.equal(matchProduct(products, 'Ubiquiti', 'U6 Pro').id, 'ubiquiti-u6-pro');
  assert.equal(matchProduct(products, 'Ubiquiti', 'U7-Pro'), null);
  assert.equal(matchProduct(products, '', ''), null);
});

test('import: a new proposal creates client, job, products, lines, ticket, proposal, and one movement', () => {
  const parsed = parseProposal(fixture);
  const products = new Map([['sonos-amp', { id: 'sonos-amp', brand: 'Sonos', model: 'Amp', name: 'Sonos Amp', unit: 'each' }]]);
  const inventory = {
    stock: [{ productId: 'sonos-amp', locationId: 'storage-room--a', qty: 1 }, { productId: 'sonos-amp', locationId: 'bay-1', qty: 5 }],
    containers: [], items: [],
    locations: new Map([['bay-1', { id: 'bay-1', kind: 'bay' }], ['storage-room--a', { id: 'storage-room--a', kind: 'shelf' }]]),
  };
  assert.equal(availableFor('sonos-amp', inventory), 1);
  const r = buildImport(parsed, { products, ticket: null, lines: new Map(), client: null, job: null, inventory, now: NOW });
  assert.equal(r.unchanged, false);
  assert.equal(r.ticketId, '1077');
  const byPath = new Map(r.writes.map(w => [w.path, w]));

  const client = byPath.get('loadout_clients/example-dental-group');
  assert.equal(client.data.name, 'Example Dental Group');
  assert.equal(client.data.portalContactId, '7301');
  const job = byPath.get('loadout_jobs/example-dental-group--harbor-street-office-refresh');
  assert.equal(job.data.name, 'Harbor Street office refresh');
  assert.equal(job.data.status, 'open');

  // unmatched brand + model rows create products with the app's slug ids
  const created = r.writes.filter(w => w.path.startsWith('loadout_products/')).map(w => w.path.split('/')[1]);
  assert.deepEqual(created, ['ubiquiti-u6-pro', 'ubiquiti-usw-pro-24-poe', 'panduit-cj688tgbu', 'sonance-vp62r', 'belden-1583a']);
  assert.equal(byPath.get('loadout_products/ubiquiti-u6-pro').data.name, 'Ubiquiti U6-Pro');
  assert.equal(byPath.get('loadout_products/ubiquiti-u6-pro').data.portalItemId, '70011');
  // products come before the lines that point at them
  assert.ok(r.writes.findIndex(w => w.path === 'loadout_products/ubiquiti-u6-pro') < r.writes.findIndex(w => w.path.endsWith('/lines/front-office--ubiquiti-u6-pro')));

  const amp = byPath.get('loadout_tickets/1077/lines/conference-room--sonos-amp').data;
  assert.equal(amp.matchState, 'matched');
  assert.equal(amp.qtyToOrder, 0); // one on a shelf; the bay does not count
  const ap = byPath.get('loadout_tickets/1077/lines/front-office--ubiquiti-u6-pro').data;
  assert.equal(ap.matchState, 'new');
  assert.equal(ap.qtyNeeded, 3);
  assert.equal(ap.qtyToOrder, 3);
  assert.equal(ap.productName, 'Ubiquiti U6-Pro');
  const ties = byPath.get('loadout_tickets/1077/lines/network-closet--velcro-cable-ties').data;
  assert.equal(ties.productId, null);
  assert.equal(ties.matchState, 'unmatched');

  const ticket = byPath.get('loadout_tickets/1077');
  assert.equal(ticket.op, 'create');
  assert.equal(ticket.data.status, 'open');
  assert.equal(ticket.data.needsReview, true);
  assert.equal(ticket.data.source, 'zapier');
  assert.deepEqual(ticket.data.summary, { lines: 7, needed: 7, fromStock: 0, toOrder: 6, staged: 0, delivered: 0 });

  const prop = byPath.get('loadout_proposals/1077');
  assert.equal(prop.op, 'merge');
  assert.equal(prop.data.importSource, 'zapier');
  assert.equal(prop.data.portalId, '55120');

  const moves = r.writes.filter(w => w.path.startsWith('loadout_movements/'));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].data.type, 'edit');
  assert.equal(moves[0].data.by, 'Zapier');
  assert.match(moves[0].data.note, /Ticket #1077 created from Portal by Zapier, 7 lines, 5 products created, 4 items skipped/);
});

test('import: replaying the same payload writes nothing', () => {
  const store = new Map();
  const parsed = parseProposal(fixture);
  applyWrites(store, buildImport(parsed, contextFrom(store, '1077')).writes);
  const sizeAfterFirst = store.size;
  const again = buildImport(parsed, contextFrom(store, '1077'));
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.writes, []);
  assert.equal(again.summary.unchangedLines, 7);
  assert.equal(store.size, sizeAfterFirst);
});

test('import: a changed quantity and a new item adjust the ticket without duplicating', () => {
  const store = new Map();
  applyWrites(store, buildImport(parseProposal(fixture), contextFrom(store, '1077')).writes);
  // someone staged one access point before the change order came through
  store.get('loadout_tickets/1077/lines/front-office--ubiquiti-u6-pro').qtyStaged = 1;

  const changed = clone(fixture);
  changed.areas[0].options[0].items[0].quantity = 4; // U6-Pro 2 -> 4, line total 3 -> 5
  changed.areas[2].options[0].items.push({ id: 9032, parentId: null, itemType: 'Part', referencedItemId: 70050, brand: 'Panduit', model: 'NK6PPG24Y', shortDescription: 'Patch panel', quantity: 1 });
  const before = store.size;
  const r = buildImport(parseProposal(changed), contextFrom(store, '1077'));
  assert.equal(r.summary.newLines, 1);
  assert.equal(r.summary.changedLines, 1);
  assert.equal(r.summary.unchangedLines, 6);
  const lineWrites = r.writes.filter(w => w.path.includes('/lines/'));
  assert.deepEqual(lineWrites.map(w => [w.op, w.path.split('/').pop()]), [
    ['update', 'front-office--ubiquiti-u6-pro'],
    ['set', 'network-closet--panduit-nk6ppg24y'],
  ]);
  assert.deepEqual(lineWrites[0].data.qtyNeeded, 5);
  assert.deepEqual(lineWrites[0].data.qtyToOrder, 4); // 5 needed, 1 staged, new product has no stock
  const t = r.writes.find(w => w.path === 'loadout_tickets/1077');
  assert.equal(t.op, 'update');
  assert.equal(t.data.status, 'picking');
  assert.equal(t.data.needsReview, true);
  assert.equal(t.data.summary.lines, 8);
  assert.equal(r.writes.filter(w => w.path.startsWith('loadout_clients/') || w.path.startsWith('loadout_jobs/')).length, 0);

  applyWrites(store, r.writes);
  // one new line, one new product, one more movement
  assert.equal(store.size, before + 3);
  // and replaying the change order is again a no-op
  assert.equal(buildImport(parseProposal(changed), contextFrom(store, '1077')).unchanged, true);
});

test('import: a racing duplicate cannot create the ticket twice', () => {
  const store = new Map();
  const parsed = parseProposal(fixture);
  const first = buildImport(parsed, contextFrom(store, '1077'));
  const second = buildImport(parsed, contextFrom(store, '1077'));
  applyWrites(store, first.writes);
  assert.throws(() => applyWrites(store, second.writes.filter(w => w.op === 'create')), /ALREADY_EXISTS/);
});

test('import: an existing client and job are reused, not recreated', () => {
  const parsed = parseProposal(fixture);
  const client = { id: 'example-dental', name: 'Example Dental', portalContactId: '7301' };
  const job = { id: 'example-dental--harbor-street-office-refresh', name: 'Harbor Street office refresh', stagingLocationId: 'bay-2', stagingLocationName: 'Bay 2' };
  const r = buildImport(parsed, { products: new Map(), ticket: null, lines: new Map(), client, job, inventory: null, now: NOW });
  assert.equal(r.writes.filter(w => w.path.startsWith('loadout_clients/') || w.path.startsWith('loadout_jobs/')).length, 0);
  const t = r.writes.find(w => w.path === 'loadout_tickets/1077').data;
  assert.equal(t.clientId, 'example-dental');
  assert.equal(t.stagingLocationId, 'bay-2');
  assert.equal(t.stagingLocationName, 'Bay 2');
});

test('status and secret helpers', () => {
  assert.equal(statusFrom([], 'open'), 'open');
  assert.equal(statusFrom([{ qtyNeeded: 1, qtyStaged: 1, qtyDelivered: 0 }], 'open'), 'staged');
  assert.equal(statusFrom([{ qtyNeeded: 1, qtyStaged: 1, qtyDelivered: 1 }], 'closed'), 'closed');
  assert.equal(secretsMatch('abc123', 'abc123'), true);
  assert.equal(secretsMatch('abc124', 'abc123'), false);
  assert.equal(secretsMatch('abc', 'abc123'), false);
  assert.equal(secretsMatch(null, 'abc123'), false);
  assert.equal(secretsMatch('', ''), false);
});
