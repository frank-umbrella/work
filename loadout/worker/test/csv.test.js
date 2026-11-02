import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenDoc, csvCell, buildTable, toCsv, splitLines, parentOf, shipmentTables, shipStatusLabel, BOM } from '../src/csv.js';

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
    refs: '7701/x', at: '2026-10-29 09:05', empty: null,
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

test('csv: lines split into ticket and order files with id first, then the parent id (the app order)', () => {
  const docs = [
    { id: 'front-office--sonos-amp', _path: 'loadout_tickets/1077/lines/front-office--sonos-amp', qtyNeeded: 1 },
    { id: 'l1', _path: 'loadout_orders/7701/lines/l1', ticketId: '1077', qtyOrdered: 2 },
    { id: 'zz', _path: 'some_other_collection/x/lines/zz', qty: 9 },
  ];
  const out = splitLines(docs);
  assert.deepEqual(Object.keys(out).sort(), ['loadout_order_lines', 'loadout_ticket_lines']);
  assert.deepEqual(out.loadout_ticket_lines.keys, ['id', 'ticketId', 'qtyNeeded']);
  assert.equal(toCsv(out.loadout_ticket_lines), BOM + 'id,ticketId,qtyNeeded\r\nfront-office--sonos-amp,1077,1\r\n');
  assert.equal(out.loadout_ticket_lines.rows[0].ticketId, '1077');
  assert.deepEqual(out.loadout_order_lines.keys, ['id', 'orderId', 'ticketId', 'qtyOrdered']);
  assert.equal(out.loadout_order_lines.rows[0].orderId, '7701');
  assert.equal(out.loadout_order_lines.rows[0].ticketId, '1077');
  assert.deepEqual(parentOf('loadout_tickets/1077/lines/x'), { coll: 'loadout_tickets', id: '1077' });
  assert.equal(parentOf('loadout_tickets/1077'), null);
});

test('csv: orderLineRefs on a ticket line flattens to "orderId/orderLineId; ..." and never JSON', () => {
  const out = splitLines([{
    id: 'front-office--u6', _path: 'loadout_tickets/1077/lines/front-office--u6', qtyNeeded: 4,
    orderLineRefs: [{ orderId: '7701', orderLineId: 'l1' }, { orderId: '7702', orderLineId: 'l3', note: null, extra: { deep: 1 } }],
  }, {
    id: 'lobby--tv', _path: 'loadout_tickets/1077/lines/lobby--tv', qtyNeeded: 1, orderLineRefs: [],
  }]);
  const t = out.loadout_ticket_lines;
  assert.equal(t.rows[0].orderLineRefs, '7701/l1; 7702/l3');
  assert.equal(t.rows[1].orderLineRefs, '');
  const text = toCsv(t);
  assert.ok(!text.includes('{'), 'no JSON text in the file');
  assert.ok(text.includes(',7701/l1; 7702/l3'));
});

const SHIPMENTS = [{
  id: 's1', _path: 'loadout_shipments/s1', orderId: '7701', orderNumber: 'PO-7701', tracking: '1Z999', shipTo: 'client',
  status: 'delivered',
  statusLog: [
    { status: 'shipped', at: new Date('2026-10-30T14:00:00Z'), by: 'a@x.com', byName: 'Ann' },
    { status: 'delivered', at: new Date('2026-10-31T16:30:00Z'), by: 'b@x.com', byName: 'Bo', note: 'left at, "front" desk' },
  ],
  lines: [
    { orderLineId: 'l1', productName: 'U6 Pro', qty: 4, qtyReceived: 4 },
    { orderLineId: 'l2', qty: 2 },
  ],
}, {
  id: 's2', _path: 'loadout_shipments/s2', orderId: '7702', shipTo: 'warehouse', status: 'shipped',
}];

test('csv: shipment statusLog goes to loadout_shipments_status with the app columns, shipment id first', () => {
  const { loadout_shipments_status: t } = shipmentTables(SHIPMENTS);
  assert.deepEqual(t.keys, ['shipmentId', 'orderNumber', 'tracking', 'seq', 'status', 'statusLabel', 'at', 'by', 'byName', 'note']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].statusLabel, 'Shipped');
  assert.equal(t.rows[1].statusLabel, 'Delivered to site');
  assert.equal(toCsv(t), BOM
    + 'shipmentId,orderNumber,tracking,seq,status,statusLabel,at,by,byName,note\r\n'
    + 's1,PO-7701,1Z999,1,shipped,Shipped,2026-10-30 14:00,a@x.com,Ann,\r\n'
    + 's1,PO-7701,1Z999,2,delivered,Delivered to site,2026-10-31 16:30,b@x.com,Bo,"left at, ""front"" desk"\r\n');
  assert.equal(shipStatusLabel('delivered', 'warehouse'), 'Delivered, not received');
  assert.equal(shipStatusLabel('mystery', 'warehouse'), 'mystery');
});

test('csv: shipment lines go to loadout_shipments_lines with the app columns, shipment id first', () => {
  const { loadout_shipments_lines: t } = shipmentTables(SHIPMENTS);
  assert.deepEqual(t.keys, ['shipmentId', 'orderId', 'orderNumber', 'tracking', 'orderLineId', 'productName', 'qty', 'qtyReceived']);
  assert.equal(toCsv(t), BOM
    + 'shipmentId,orderId,orderNumber,tracking,orderLineId,productName,qty,qtyReceived\r\n'
    + 's1,7701,PO-7701,1Z999,l1,U6 Pro,4,4\r\n'
    + 's1,7701,PO-7701,1Z999,l2,,2,\r\n');
});

test('csv: the shipment table drops statusLog and lines; empty shipments still write both headers', () => {
  const out = shipmentTables(SHIPMENTS);
  assert.deepEqual(Object.keys(out), ['loadout_shipments', 'loadout_shipments_status', 'loadout_shipments_lines']);
  assert.deepEqual(out.loadout_shipments.keys, ['id', 'orderId', 'orderNumber', 'tracking', 'shipTo', 'status']);
  assert.ok(!toCsv(out.loadout_shipments).includes('{'));
  const none = shipmentTables([]);
  assert.equal(toCsv(none.loadout_shipments_status), BOM + 'shipmentId\r\n');
  assert.equal(toCsv(none.loadout_shipments_lines), BOM + 'shipmentId\r\n');
});
