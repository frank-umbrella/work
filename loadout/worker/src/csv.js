// CSV writer for the nightly export. It mirrors the app's Console export
// (index.html flatten(), exportTables() and csvOf()) so a nightly file and a
// hand export read the same in Excel: maps flatten to dotted columns
// ("summary.lines"), arrays join with "; ", an object in an array prints its
// plain values joined with "/" (orderLineRefs reads "7701/l1"), timestamps
// print as "YYYY-MM-DD HH:MM", the first column is id, and the rest follow in
// first-seen order. No cell holds JSON text. A shipment's statusLog and lines
// get their own files (shipmentTables). One difference: the worker runs in
// UTC, so its times are UTC where the app's are the browser's clock.

export const BOM = '\uFEFF';

const pad = n => String(n).padStart(2, '0');

export function fmtStamp(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

// Keys starting with "_" are worker bookkeeping (_path), not data.
export function flattenDoc(o, pre = '', out = {}) {
  for (const k of Object.keys(o)) {
    if (k[0] === '_') continue;
    const v = o[k];
    const key = pre ? pre + '.' + k : k;
    if (v instanceof Date) out[key] = isNaN(v) ? '' : fmtStamp(v);
    // Same rule as the app: an object in a list keeps only its plain values,
    // in key order, joined with "/"; nested objects and dates inside it drop.
    else if (Array.isArray(v)) out[key] = v.map(x => (x && typeof x === 'object' ? Object.values(x).filter(y => y != null && typeof y !== 'object').join('/') : x)).join('; ');
    else if (v && typeof v === 'object') flattenDoc(v, key, out);
    else out[key] = v;
  }
  return out;
}

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// docs: decoded documents ({ id, _path, ...fields }).
// lead: columns that go first, in order (["id"], or ["ticketId", "id"]).
export function buildTable(docs, lead = ['id']) {
  const rows = docs.map(d => flattenDoc(d));
  const keys = lead.slice();
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return { keys, rows };
}

// CRLF line ends and a UTF-8 byte-order mark, so Excel opens it as UTF-8.
export function toCsv({ keys, rows }) {
  const lines = [keys.map(csvCell).join(',')];
  for (const r of rows) lines.push(keys.map(k => csvCell(r[k])).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

// "loadout_tickets/1077/lines/front-office--sonos-amp" -> { coll: "loadout_tickets", id: "1077" }
export function parentOf(path) {
  const seg = String(path || '').split('/');
  return seg.length >= 4 ? { coll: seg[seg.length - 4], id: seg[seg.length - 3] } : null;
}

// The subcollection files, named as the app names them. Columns start with
// the line's id, then the parent id named for the parent (ticketId, orderId),
// the same order as the app's DB.getAll("loadout_ticket_lines").
export const SUBCOLLECTION_FILES = {
  loadout_tickets: { file: 'loadout_ticket_lines', parentKey: 'ticketId' },
  loadout_orders: { file: 'loadout_order_lines', parentKey: 'orderId' },
};

// Splits a collection-group read of "lines" into one table per parent
// collection. The parent id wins over any same-named field on the line.
export function splitLines(lineDocs) {
  const groups = {};
  for (const [coll, spec] of Object.entries(SUBCOLLECTION_FILES)) groups[spec.file] = { spec, docs: [] };
  for (const d of lineDocs) {
    const p = parentOf(d._path);
    const spec = p && SUBCOLLECTION_FILES[p.coll];
    if (!spec) continue;
    const row = Object.assign({ id: d.id, [spec.parentKey]: p.id }, d);
    row[spec.parentKey] = p.id;
    groups[spec.file].docs.push(row);
  }
  const out = {};
  for (const [file, g] of Object.entries(groups)) out[file] = buildTable(g.docs, ['id', g.spec.parentKey]);
  return out;
}

// The app's shipment status words (index.html PILL.ship), for statusLabel.
export const SHIP_LABEL = {
  shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered, not received',
  received: 'Received', site: 'Delivered to site',
};

// Same as the app's pillLabel("ship", ...): a delivered entry on a package
// shipped to the client's site reads "Delivered to site".
export function shipStatusLabel(status, shipTo) {
  const k = status === 'delivered' && shipTo === 'client' ? 'site' : status;
  return SHIP_LABEL[k] || String(k || '');
}

// A shipment's statusLog and lines become their own tables, one row per
// entry with the shipment id first, and leave the shipment table. Columns
// and their order are the app's (index.html exportTables()).
export function shipmentTables(docs) {
  const st = [], ln = [], ships = [];
  for (const s of docs) {
    (Array.isArray(s.statusLog) ? s.statusLog : []).forEach((e, i) => st.push({
      shipmentId: s.id, orderNumber: s.orderNumber || null, tracking: s.tracking || null, seq: i + 1,
      status: e.status, statusLabel: shipStatusLabel(e.status, s.shipTo), at: e.at,
      by: e.by || null, byName: e.byName || null, note: e.note || null,
    }));
    (Array.isArray(s.lines) ? s.lines : []).forEach(e => ln.push({
      shipmentId: s.id, orderId: s.orderId || null, orderNumber: s.orderNumber || null, tracking: s.tracking || null,
      orderLineId: e.orderLineId, productName: e.productName || null, qty: e.qty, qtyReceived: e.qtyReceived,
    }));
    const x = Object.assign({}, s);
    delete x.statusLog;
    delete x.lines;
    ships.push(x);
  }
  return {
    loadout_shipments: buildTable(ships),
    loadout_shipments_status: buildTable(st, ['shipmentId']),
    loadout_shipments_lines: buildTable(ln, ['shipmentId']),
  };
}
