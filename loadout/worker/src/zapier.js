// Zapier intake (PLAN section 6, T1): parse the Portal "Update Proposal
// Status" payload and build the Firestore writes the app's CSV import would
// make (PLAN section 5). Pure functions only, so the tests run without a
// network or a database.
//
// The helpers below copy the app's own (index.html: slug, clean, prodKey,
// lineIdFor, productIdFor, composeName, summarize, statusFrom, toOrderFor,
// availableFor) on purpose. The ids they produce are what makes a ticket
// created here and a ticket created from the CSV the same document. Change
// them in both places or not at all.

// ---------------------------------------------------------------------
// The app's id and name rules
// ---------------------------------------------------------------------

export const SKIP_TYPES = /^(labor|labour|fee|fees|custom ?item)$/i;
const KIND_LABEL = { device: 'Device', 'patch-cable': 'Patch cable', splitter: 'Splitter', connector: 'Connector', wire: 'Wire', other: 'Other' };

export function slug(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/["'\/]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

export function clean(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  const s = String(v).replace(/\s+/g, ' ').trim();
  return /^(n\/?a|none|-+)$/i.test(s) ? '' : s;
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const prodKey = (b, m) => (String(b || '') + ' ' + String(m || '')).toLowerCase().replace(/\s+/g, ' ').trim();

export function lineIdFor(area, brand, model, desc) {
  const prod = brand || model ? slug((brand || '') + '-' + (model || '')) : slug(desc || 'line');
  return ((slug(area) || 'general') + '--' + (prod || 'line')).slice(0, 140);
}

function fixSlashCase(s) {
  return String(s == null ? '' : s).replace(/\b[A-Za-z]{1,3}(?:\/[A-Za-z]{1,3})+\b/g, w => {
    const parts = w.split('/');
    if (!parts.some(x => /^[A-Z]+$/.test(x))) return w;
    return parts.map(x => (/^[a-z]+$/.test(x) ? x.toUpperCase() : x)).join('/');
  });
}
function typeLabel(t) {
  return fixSlashCase(t).replace(/\s*-\s+|\s+-\s*/g, ', ').replace(/,\s*,/g, ',').replace(/^,\s*|,\s*$/g, '').trim();
}

export function composeName(d) {
  if (d.brand && d.model) return d.brand + ' ' + d.model;
  const bits = [d.type ? typeLabel(d.type) : KIND_LABEL[d.kind] || 'Product'];
  if (d.brand) bits.push(d.brand);
  if (d.model) bits.push(d.model);
  if (d.connector1 || d.connector2) bits.push([d.connector1, d.connector2].filter(Boolean).map(c => String(c).replace(/\s*-\s*/g, '-')).join(' to '));
  if (d.sex) bits.push(String(d.sex).toLowerCase());
  if (d.pins) bits.push(d.pins + ' pin');
  if (d.wireType) bits.push(d.wireType);
  if (d.color) bits.push(d.color);
  if (d.length) bits.push(d.length + ' ' + (d.lengthUnit || 'ft'));
  return bits.join(', ');
}

export function productIdFor(d) {
  if (d.brand && d.model) return slug(d.brand + '-' + d.model);
  return slug([d.kind, d.type, d.brand, d.model, d.connector1, d.connector2, d.inputs, d.outputs, d.sex, d.band, d.pins, d.wireType, d.color, d.length ? d.length + (d.lengthUnit || '') : '', d.gauge ? d.gauge + (d.gaugeUnit || '') : '', d.amps ? d.amps + 'a' : ''].filter(x => x !== '' && x != null).join('-'));
}

export function productName(p) {
  if (!p) return '';
  if (p.name) return p.name;
  return [p.brand, p.model].filter(Boolean).join(' ') || p.type || 'Unnamed product';
}

// Catalog match: brand + model case-insensitive and whitespace-collapsed,
// then the slug id, same order as the app's matchProduct().
export function matchProduct(products, brand, model) {
  if (!brand && !model) return null;
  const k = prodKey(brand, model);
  for (const p of products.values()) if ((p.brand || p.model) && prodKey(p.brand, p.model) === k) return p;
  return products.get(productIdFor({ brand, model })) || null;
}

const lineDone = (l, f) => num(l[f]) >= num(l.qtyNeeded);

export function summarize(lines) {
  return {
    lines: lines.length, needed: lines.filter(l => num(l.qtyNeeded) > 0).length,
    fromStock: lines.filter(l => num(l.qtyFromStock) > 0).length, toOrder: lines.filter(l => num(l.qtyToOrder) > 0).length,
    staged: lines.filter(l => lineDone(l, 'qtyStaged')).length, delivered: lines.filter(l => lineDone(l, 'qtyDelivered')).length,
  };
}

export function statusFrom(lines, cur) {
  if (cur === 'closed') return 'closed';
  if (!lines.length) return 'open';
  if (lines.every(l => lineDone(l, 'qtyDelivered'))) return 'delivered';
  if (lines.every(l => lineDone(l, 'qtyStaged'))) return 'staged';
  if (lines.some(l => num(l.qtyStaged) > 0)) return 'picking';
  return 'open';
}

export function toOrderFor(l, p, staged, avail) {
  return Math.max(0, num(l.qtyNeeded) - staged - (p ? Math.max(0, avail) : 0));
}

// Stock a line can be pulled from: shelves and areas, never a bay or a van.
// inv = { stock: [], containers: [], items: [], locations: Map }
export function availableFor(productId, inv) {
  if (!productId || !inv) return 0;
  const pullable = id => { const L = inv.locations && inv.locations.get(id); return !L || (L.kind !== 'bay' && L.kind !== 'van'); };
  let n = 0;
  for (const r of inv.stock || []) if (r.productId === productId && pullable(r.locationId) && num(r.qty) > 0) n += num(r.qty);
  for (const c of inv.containers || []) if (c.productId === productId && c.status !== 'empty' && pullable(c.locationId)) n += num(c.ftLeft);
  for (const i of inv.items || []) if (i.productId === productId && i.status === 'in_stock' && pullable(i.locationId)) n += 1;
  return n;
}

// Compares the X-Loadout-Secret header with the secret without stopping at
// the first differing character, so response timing does not leak a prefix.
export function secretsMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] || 0) ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------

// Reads camelCase first, then PascalCase, since Zapier steps sometimes
// re-key fields.
function pick(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  if (key in o) return o[key];
  const pascal = key[0].toUpperCase() + key.slice(1);
  return o[pascal];
}

function asJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return v;
  try { return JSON.parse(s); } catch { return v; }
}

// Accepts the proposal itself, a Zapier "wrap in array" body, or an object
// with the proposal under "proposal". Nested fields that arrive as JSON text
// are parsed.
export function unwrapPayload(body) {
  let p = asJson(body);
  if (Array.isArray(p)) p = p[0];
  if (p && typeof p === 'object' && !pick(p, 'areas') && pick(p, 'proposal') && typeof pick(p, 'proposal') === 'object') p = pick(p, 'proposal');
  if (!p || typeof p !== 'object') return null;
  const out = Object.assign({}, p);
  for (const k of ['areas', 'customer']) {
    if (k in out) out[k] = asJson(out[k]);
    const P = k[0].toUpperCase() + k.slice(1);
    if (P in out) out[P] = asJson(out[P]);
  }
  return out;
}

export function customerName(c) {
  if (!c) return '';
  const company = clean(pick(c, 'companyName'));
  const person = clean([clean(pick(c, 'firstName')), clean(pick(c, 'lastName'))].filter(Boolean).join(' '));
  if (pick(c, 'partyType') === 'Person') return person || company;
  return company || person;
}

export function customerAddress(c) {
  const L = c && pick(c, 'location');
  if (!L) return '';
  const street = [clean(pick(L, 'street')), clean(pick(L, 'suite'))].filter(Boolean).join(' ');
  const cityLine = [clean(pick(L, 'city')), [clean(pick(L, 'stateAbbrev')) || clean(pick(L, 'state')), clean(pick(L, 'postalCode'))].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, cityLine].filter(Boolean).join(', ');
}

// Which options of an area become ticket lines. Declined options never do.
// When the area has an Accepted option, only Accepted options count (the
// others were alternatives the client did not take). With none Accepted,
// every remaining option counts, since Portal leaves a single default
// option in Draft on many accepted proposals.
export function chooseOptions(options) {
  const live = options.filter(o => clean(pick(o, 'status')).toLowerCase() !== 'declined');
  const accepted = live.filter(o => clean(pick(o, 'status')).toLowerCase() === 'accepted');
  const use = accepted.length ? accepted : live;
  const skip = options.filter(o => !use.includes(o)).map(o => ({
    optionId: pick(o, 'id') == null ? null : String(pick(o, 'id')),
    status: clean(pick(o, 'status')) || 'Unknown',
    why: clean(pick(o, 'status')).toLowerCase() === 'declined' ? 'Option declined' : 'Another option in this area was accepted',
  }));
  return { use, skip };
}

// Returns { number, name, status, portalId, customer: {...}, lines: [...],
// skipped: [...], skippedOptions: [...], areas: [...] }. Lines are aggregated
// by the app's line id, so the same product twice in one area is one line.
export function parseProposal(raw) {
  const p = unwrapPayload(raw);
  if (!p) throw new Error('Payload is not a JSON object');
  const number = clean(pick(p, 'number'));
  const c = pick(p, 'customer') || null;
  const out = {
    number,
    name: clean(pick(p, 'name')),
    status: clean(pick(p, 'status')),
    portalId: pick(p, 'id') == null ? null : String(pick(p, 'id')),
    proposalCsv: clean(pick(p, 'proposalCsv')) || null,
    proposalPdf: clean(pick(p, 'proposalPdf')) || null,
    customer: {
      portalContactId: c && pick(c, 'id') != null ? String(pick(c, 'id')) : null,
      name: customerName(c),
      address: customerAddress(c),
    },
    lines: [], skipped: [], skippedOptions: [], areas: [],
  };

  const lines = new Map();
  const areas = Array.isArray(pick(p, 'areas')) ? pick(p, 'areas') : [];
  // Every item's area, so a nested accessory can take its parent's area
  // even when Zapier has moved it out of the parent's option.
  const areaOfItem = new Map();
  for (const a of areas) for (const o of pick(a, 'options') || []) for (const it of pick(o, 'items') || []) {
    if (pick(it, 'id') != null) areaOfItem.set(String(pick(it, 'id')), clean(pick(a, 'name')));
  }

  for (const a of areas) {
    const areaName = clean(pick(a, 'name'));
    const opts = Array.isArray(pick(a, 'options')) ? pick(a, 'options') : [];
    const { use, skip } = chooseOptions(opts);
    for (const s of skip) out.skippedOptions.push(Object.assign({ area: areaName }, s));
    let areaLines = 0;
    for (const o of use) {
      const optionLabel = clean(pick(o, 'clientDescription'));
      for (const it of pick(o, 'items') || []) {
        const itemId = pick(it, 'id') == null ? null : String(pick(it, 'id'));
        const parentId = pick(it, 'parentId') == null ? null : String(pick(it, 'parentId'));
        const area = (parentId && areaOfItem.get(parentId)) || areaName;
        const brand = clean(pick(it, 'brand'));
        const model = clean(pick(it, 'model'));
        const desc = clean(pick(it, 'shortDescription')) || clean(pick(it, 'name'));
        const type = clean(pick(it, 'itemType'));
        const label = [brand, model].filter(Boolean).join(' ') || desc || 'Item ' + itemId;
        const skipRow = why => out.skipped.push({ itemId, area, label, itemType: type, why });
        if (SKIP_TYPES.test(type)) { skipRow(type + ' rows are not product'); continue; }
        if (!brand && !model && !desc) { skipRow('No brand, model, or description'); continue; }
        const qv = pick(it, 'quantity');
        if (qv == null || qv === '') { skipRow('Quantity is blank'); continue; }
        const q = Number(String(qv).replace(/,/g, ''));
        if (!Number.isFinite(q) || q <= 0) { skipRow('Quantity ' + qv + ' is not a number above zero'); continue; }
        const id = lineIdFor(area, brand, model, desc);
        const refId = pick(it, 'referencedItemId');
        if (lines.has(id)) {
          const e = lines.get(id);
          e.qtyNeeded += q;
          e.portalItemIds.push(itemId);
          continue;
        }
        lines.set(id, {
          id, area, option: optionLabel, itemType: type, brand, model, description: desc,
          unit: 'each', qtyNeeded: q,
          portalItemId: refId == null ? null : String(refId),
          portalItemIds: [itemId], parentPortalItemId: parentId,
          supplier: clean(pick(it, 'supplier')) || null,
        });
        areaLines++;
      }
    }
    out.areas.push({ name: areaName, optionsUsed: use.length, optionsSkipped: skip.length, lines: areaLines });
  }
  out.lines = Array.from(lines.values());
  return out;
}

// ---------------------------------------------------------------------
// The import itself
// ---------------------------------------------------------------------

// FNV-1a, enough to give a replayed change the same movement id.
export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// ctx = {
//   products: Map(id -> product), ticket: doc|null, lines: Map(id -> line),
//   client: doc|null, job: doc|null, inventory: {stock, containers, items, locations},
//   now: Date
// }
// Returns { writes, unchanged, ticketId, summary }. writes use the
// descriptors in firestore.js (create, set, merge, update). Nothing is
// written when every line already matches the ticket, so a replayed Zap is
// a no-op.
export function buildImport(parsed, ctx) {
  const now = ctx.now || new Date();
  const products = ctx.products || new Map();
  const ex = ctx.ticket || null;
  const have = ctx.lines || new Map();
  const number = parsed.number;
  const tid = ex ? ex.id : slug(number);
  if (!tid) throw new Error('The proposal number needs letters or numbers');

  const writes = [];
  let clientId, clientName, jobId, jobName, clientCreated = false, jobCreated = false;
  if (ex) {
    // An existing ticket keeps its client and job, as the app does.
    clientId = ex.clientId; clientName = ex.clientName; jobId = ex.jobId; jobName = ex.jobName;
  } else {
    if (ctx.client) { clientId = ctx.client.id; clientName = ctx.client.name || parsed.customer.name; }
    else {
      clientName = parsed.customer.name || 'Portal customer ' + (parsed.customer.portalContactId || number);
      clientId = slug(clientName);
      if (!clientId) throw new Error('The customer name has no letters or numbers');
      writes.push({ op: 'set', path: 'loadout_clients/' + clientId, data: { name: clientName, notes: '', archived: false, portalContactId: parsed.customer.portalContactId, createdAt: now, updatedAt: now } });
      clientCreated = true;
    }
    jobName = ctx.job ? ctx.job.name : (parsed.name || 'Proposal ' + number);
    jobId = ctx.job ? ctx.job.id : clientId + '--' + slug(jobName);
    if (!ctx.job) {
      writes.push({ op: 'set', path: 'loadout_jobs/' + jobId, data: { clientId, clientName, name: jobName, address: parsed.customer.address || '', status: 'open', stagingLocationId: null, stagingLocationName: null, createdAt: now, updatedAt: now } });
      jobCreated = true;
    }
  }

  const base = have.size ? Math.max(...Array.from(have.values()).map(l => num(l.sort))) : 0;
  const after = new Map(Array.from(have.values()).map(l => [l.id, Object.assign({}, l)]));
  const created = new Map();
  const changes = [];
  let nNew = 0, nChg = 0, nSame = 0, sortN = base;

  for (const l of parsed.lines) {
    const matched = matchProduct(products, l.brand, l.model);
    let pid = matched ? matched.id : null;
    let p = matched;
    let state = pid ? 'matched' : 'unmatched';
    if (!pid && (l.brand || l.model)) {
      pid = productIdFor({ brand: l.brand, model: l.model });
      if (pid && !products.has(pid) && !created.has(pid)) {
        const name = composeName({ brand: l.brand, model: l.model });
        const data = { brand: l.brand, model: l.model, name, kind: 'device', unit: 'each', type: l.itemType || '', category: '', description: l.description || '',
          upc: null, consumable: false, parLevel: null, defaultLocationId: null, portalItemId: l.portalItemId || null, imageUrl: null, onHand: 0, lastCountAt: null, createdAt: now, updatedAt: now };
        created.set(pid, data);
      }
      p = products.get(pid) || null;
      state = 'new';
    }
    const avail = p ? availableFor(p.id, ctx.inventory) : 0;
    const old = have.get(l.id);
    if (old) {
      if (num(old.qtyNeeded) === num(l.qtyNeeded)) { nSame++; continue; }
      const y = Object.assign({}, old, { qtyNeeded: l.qtyNeeded });
      y.qtyToOrder = state === 'new' ? Math.max(0, l.qtyNeeded - num(old.qtyStaged)) : toOrderFor(y, p, num(old.qtyStaged), avail);
      after.set(l.id, y); nChg++;
      changes.push(l.id + '=' + l.qtyNeeded);
      writes.push({ op: 'update', path: 'loadout_tickets/' + tid + '/lines/' + l.id, data: { qtyNeeded: l.qtyNeeded, qtyToOrder: y.qtyToOrder, updatedAt: now } });
      continue;
    }
    const doc = {
      area: l.area || '', option: l.option || '', sort: ++sortN, productId: pid || null,
      productName: p ? productName(p) : (pid ? composeName({ brand: l.brand, model: l.model }) : null),
      brand: l.brand || '', model: l.model || '', description: l.description || '',
      unit: p ? (p.unit || 'each') : 'each', matchState: state,
      qtyNeeded: l.qtyNeeded, qtyFromStock: 0, qtyToOrder: p ? toOrderFor(l, p, 0, avail) : l.qtyNeeded, qtyStaged: 0, qtyDelivered: 0,
      portalItemId: l.portalItemId || null, orderLineRefs: [], notes: null, createdAt: now, updatedAt: now,
    };
    after.set(l.id, Object.assign({ id: l.id }, doc)); nNew++;
    changes.push(l.id + '+' + l.qtyNeeded);
    writes.push({ op: 'set', path: 'loadout_tickets/' + tid + '/lines/' + l.id, data: doc });
  }

  const summaryOut = {
    ticketId: tid, number, lines: parsed.lines.length, newLines: nNew, changedLines: nChg, unchangedLines: nSame,
    productsCreated: created.size, clientCreated, jobCreated, ticketCreated: !ex,
    skipped: parsed.skipped.length, skippedOptions: parsed.skippedOptions.length,
  };

  if (ex && !nNew && !nChg) return { writes: [], unchanged: true, ticketId: tid, summary: summaryOut };

  // Products go first so a line never points at a product that is not there.
  const productWrites = Array.from(created.entries()).map(([id, data]) => ({ op: 'set', path: 'loadout_products/' + id, data }));
  const allLines = Array.from(after.values());

  writes.push({ op: 'merge', path: 'loadout_proposals/' + slug(number), data: {
    number, name: parsed.name || jobName || null, status: 'Accepted', jobId, jobName, clientId, clientName,
    portalId: parsed.portalId, acceptedAt: now, importedAt: now, importSource: 'zapier',
  } });

  if (ex) {
    writes.push({ op: 'update', path: 'loadout_tickets/' + tid, data: { status: statusFrom(allLines, ex.status), summary: summarize(allLines), needsReview: true, updatedAt: now } });
  } else {
    const bay = ctx.job && ctx.job.stagingLocationId ? ctx.job.stagingLocationId : null;
    // create, not set: if two deliveries of the same Zap race, the second
    // commit fails whole instead of writing a second movement.
    writes.push({ op: 'create', path: 'loadout_tickets/' + tid, data: {
      number, proposalId: number, jobId, jobName, clientId, clientName, status: 'open',
      stagingLocationId: bay, stagingLocationName: bay ? (ctx.job.stagingLocationName || null) : null,
      source: 'zapier', installAt: null, needsReview: true,
      createdAt: now, createdBy: 'Zapier', createdByName: 'Zapier', updatedAt: now, summary: summarize(allLines),
    } });
  }

  const skippedNote = parsed.skipped.length ? ', ' + parsed.skipped.length + ' items skipped (' + parsed.skipped.map(s => s.label + ': ' + s.why).join('; ') + ')' : '';
  const what = ex
    ? 'Portal proposal ' + number + ' re-sent by Zapier: ' + nNew + ' new lines, ' + nChg + ' changed'
    : 'Ticket #' + number + ' created from Portal by Zapier, ' + parsed.lines.length + ' lines';
  const note = what + (created.size ? ', ' + created.size + ' products created' : '') + skippedNote + '. Imported from Portal, review.';
  const mvId = 'zapier-' + tid + '-' + shortHash(changes.sort().join('|'));
  writes.push({ op: 'set', path: 'loadout_movements/' + mvId, data: {
    type: 'edit', productId: null, productName: null, containerId: null, containerLabel: null, itemId: null, itemLabel: null,
    qty: null, unit: null, fromLocationId: null, fromLocationName: null, toLocationId: null, toLocationName: null, cut: null,
    holderUid: null, holderName: null, condition: null, jobName: jobName || null,
    ticketId: tid, ticketNumber: number, ticketLineId: null, orderId: null, orderNumber: null, shipmentId: null,
    note, by: 'Zapier', byName: 'Zapier', at: now,
  } });

  return { writes: productWrites.concat(writes), unchanged: false, ticketId: tid, summary: summaryOut };
}
