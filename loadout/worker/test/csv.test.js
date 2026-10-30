import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenDoc, csvCell, buildTable, toCsv, splitLines, parentOf, BOM } from '../src/csv.js';

test('csv: cells with commas, quotes, and line breaks are quoted', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(false), 'false');
});

test('csv: flatten turns maps into dotted columns, arrays into "; ", dates into UTC stamps', () => {
  const row = flattenDoc({
    id: 't1', _path: 'loadout_tickets/t1',
    summary: { lines: 3, toOrder: 1 },
    tags: ['a', 'b'],
    refs: [{ orderId: '7701', orderLineId: 'x' }],
    at: new Date('2026-10-29T09:05:00Z'),
    empty: null,
  });
  assert.deepEqual(row, {
    id: 't1', 'summary.lines': 3, 'summary.toOrder': 1, tags: 'a; b',
    refs: '{"orderId":"7701","orderLineId":"x"}', at: '2026-10-29 09:05', empty: null,
  });
  assert.equal('_path' in row, false);
});

test('csv: header is id first, then fields in first-seen order; file has BOM and CRLF', () => {
  const t = buildTable([{ id: 'a', name: 'One' }, { id: 'b', qty: 2, name: 'Two' }]);
  assert.deepEqual(t.keys, ['id', 'name', 'qty']);
  const text = toCsv(t);
  assert.ok(text.startsWith(BOM));
  assert.equal(text, BOM + 'id,name,qty\r\na,One,\r\nb,Two,2\r\n');
});

test('csv: an empty collection still writes its header', () => {
  assert.equal(toCsv(buildTable([])), BOM + 'id\r\n');
});

test('csv: lines split into ticket and order files with the parent id as the first column', () => {
  const docs = [
    { id: 'front-office--sonos-amp', _path: 'loadout_tickets/1077/lines/front-office--sonos-amp', qtyNeeded: 1 },
    { id: 'l1', _path: 'loadout_orders/7701/lines/l1', ticketId: '1077', qtyOrdered: 2 },
    { id: 'zz', _path: 'some_other_collection/x/lines/zz', qty: 9 },
  ];
  const out = splitLines(docs);
  assert.deepEqual(Object.keys(out).sort(), ['loadout_order_lines', 'loadout_ticket_lines']);
  assert.deepEqual(out.loadout_ticket_lines.keys, ['ticketId', 'id', 'qtyNeeded']);
  assert.equal(out.loadout_ticket_lines.rows[0].ticketId, '1077');
  assert.deepEqual(out.loadout_order_lines.keys, ['orderId', 'id', 'ticketId', 'qtyOrdered']);
  assert.equal(out.loadout_order_lines.rows[0].orderId, '7701');
  assert.equal(out.loadout_order_lines.rows[0].ticketId, '1077');
  assert.deepEqual(parentOf('loadout_tickets/1077/lines/x'), { coll: 'loadout_tickets', id: '1077' });
  assert.equal(parentOf('loadout_tickets/1077'), null);
});
