// loadout-worker: the server side of Loadout (work/loadout).
//
//   GET  /health            version, which intakes are configured, last export
//   POST /zapier/proposal   T1: Portal proposal accepted, pushed by a Zap
//   POST /portal/webhook    T2: Portal API webhook, a 501 stub (src/portal.js)
//   cron 09:00 UTC          nightly CSV export to Google Drive
//
// All Firestore writes go through the FIREBASE_SERVICE_ACCOUNT service
// account, which bypasses security rules (same as watchtower-worker).

import { getAccessToken, getDoc, queryAll, queryEq, commitWrites, SCOPE_DATASTORE, SCOPE_DRIVE_FILE } from './firestore.js';
import { buildTable, toCsv, splitLines } from './csv.js';
import { dayStamp, foldersToPrune, listChildren, createFolder, uploadCsv, trashFile, RETENTION_DAYS } from './drive.js';
import { parseProposal, buildImport, matchProduct, secretsMatch, slug } from './zapier.js';
import { portalConfigured, handlePortalWebhook } from './portal.js';

const VERSION = '0.1.0';

// Root collections in the same order as the app's Console export
// (index.html EXPORT_COLLS); ticket and order lines are added after.
const ROOT_COLLS = [
  'loadout_products', 'loadout_locations', 'loadout_stock', 'loadout_containers', 'loadout_items',
  'loadout_movements', 'loadout_users', 'loadout_settings', 'loadout_clients', 'loadout_jobs',
  'loadout_proposals', 'loadout_tickets', 'loadout_orders', 'loadout_shipments',
];
const FILE_ORDER = [
  'loadout_products', 'loadout_locations', 'loadout_stock', 'loadout_containers', 'loadout_items',
  'loadout_movements', 'loadout_users', 'loadout_settings', 'loadout_clients', 'loadout_jobs',
  'loadout_proposals', 'loadout_tickets', 'loadout_ticket_lines', 'loadout_orders', 'loadout_order_lines', 'loadout_shipments',
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function driveScope(env) {
  // drive.file is the narrow default. If Drive answers 404 for the backup
  // folder, the folder was not created by this service account and the
  // owner can set DRIVE_SCOPE to https://www.googleapis.com/auth/drive.
  return env.DRIVE_SCOPE || SCOPE_DRIVE_FILE;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return json({ ok: false, error: 'Use GET' }, 405);
        return await handleHealth(env);
      }
      if (url.pathname === '/zapier/proposal') {
        if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
        return await handleZapierProposal(request, env);
      }
      if (url.pathname === '/portal/webhook') {
        if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
        return handlePortalWebhook(request, env);
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      console.error('loadout-worker error:', e && e.stack ? e.stack : e);
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyExport(env, new Date(event.scheduledTime || Date.now())).then(
      r => console.log('nightly export:', JSON.stringify(r)),
      e => console.error('nightly export failed:', e && e.stack ? e.stack : e),
    ));
  },
};

// ---------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------

async function handleHealth(env) {
  const out = {
    ok: true,
    name: 'loadout-worker',
    version: VERSION,
    intakes: {
      csv: true,
      zapier: Boolean(env.ZAPIER_SHARED_SECRET && env.FIREBASE_SERVICE_ACCOUNT),
      portalApi: portalConfigured(env),
    },
    export: { configured: Boolean(env.DRIVE_FOLDER_ID && env.FIREBASE_SERVICE_ACCOUNT), lastExportAt: null, lastExportFolder: null, lastExportError: null },
  };
  if (env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const token = await getAccessToken(env, SCOPE_DATASTORE);
      const w = await getDoc(env, token, 'loadout_settings/worker');
      if (w) {
        out.export.lastExportAt = w.lastExportAt ? new Date(w.lastExportAt).toISOString() : null;
        out.export.lastExportFolder = w.lastExportFolder || null;
        out.export.lastExportError = w.lastExportError || null;
      }
    } catch (e) {
      out.export.readError = String(e.message || e);
    }
  }
  return json(out);
}

// ---------------------------------------------------------------------
// POST /zapier/proposal
// ---------------------------------------------------------------------

async function handleZapierProposal(request, env) {
  if (!env.ZAPIER_SHARED_SECRET) return json({ ok: false, error: 'Zapier intake is not configured (ZAPIER_SHARED_SECRET is not set)' }, 503);
  if (!secretsMatch(request.headers.get('X-Loadout-Secret'), env.ZAPIER_SHARED_SECRET)) return json({ ok: false, error: 'Wrong or missing X-Loadout-Secret' }, 401);

  let body;
  try { body = JSON.parse(await request.text()); } catch { return json({ ok: false, error: 'Body is not JSON' }, 400); }
  let parsed;
  try { parsed = parseProposal(body); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }

  // Zapier answers 2xx so a filtered-out status is not shown as a failed Zap.
  if (parsed.status.toLowerCase() !== 'accepted') return json({ ok: true, ignored: true, reason: 'Status is ' + (parsed.status || 'blank') + ', only Accepted is imported' });
  if (!parsed.number) return json({ ok: false, error: 'The payload has no proposal number' }, 400);
  if (!parsed.lines.length) return json({ ok: false, error: 'No product lines in this proposal', skippedItems: parsed.skipped, skippedOptions: parsed.skippedOptions }, 422);

  const token = await getAccessToken(env, SCOPE_DATASTORE);
  // Two tries: if a parallel delivery of the same Zap created the ticket
  // between our read and our commit, the second try sees it and updates.
  for (let attempt = 1; ; attempt++) {
    const ctx = await loadContext(env, token, parsed);
    const result = buildImport(parsed, ctx);
    if (result.unchanged) {
      return json({ ok: true, unchanged: true, ticketId: result.ticketId, summary: result.summary, skippedItems: parsed.skipped, skippedOptions: parsed.skippedOptions });
    }
    try {
      await commitWrites(env, token, result.writes);
    } catch (e) {
      if (attempt < 2 && (e.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message))) continue;
      throw e;
    }
    console.log('zapier import', JSON.stringify(result.summary));
    return json({ ok: true, ticketId: result.ticketId, writes: result.writes.length, summary: result.summary, skippedItems: parsed.skipped, skippedOptions: parsed.skippedOptions });
  }
}

async function loadContext(env, token, parsed) {
  const tid = slug(parsed.number);
  const [ticket, productDocs] = await Promise.all([
    getDoc(env, token, 'loadout_tickets/' + tid),
    queryAll(env, token, 'loadout_products'),
  ]);
  const products = new Map(productDocs.map(p => [p.id, p]));
  const lines = new Map();
  if (ticket) {
    for (const l of await queryAll(env, token, 'lines', { parentPath: 'loadout_tickets/' + tid })) lines.set(l.id, l);
  }

  let client = null, job = null;
  if (!ticket) {
    if (parsed.customer.portalContactId) {
      const hits = await queryEq(env, token, 'loadout_clients', 'portalContactId', parsed.customer.portalContactId, 1);
      client = hits[0] || null;
    }
    if (!client && parsed.customer.name) client = await getDoc(env, token, 'loadout_clients/' + slug(parsed.customer.name));
    if (client) {
      const jobName = parsed.name || 'Proposal ' + parsed.number;
      job = await getDoc(env, token, 'loadout_jobs/' + client.id + '--' + slug(jobName));
    }
  }

  // Stock is only read when a line matches a catalog product, since only
  // then does qtyToOrder depend on what is on the shelves.
  let inventory = null;
  if (parsed.lines.some(l => matchProduct(products, l.brand, l.model))) {
    const [stock, containers, items, locations] = await Promise.all([
      queryAll(env, token, 'loadout_stock'),
      queryAll(env, token, 'loadout_containers'),
      queryAll(env, token, 'loadout_items'),
      queryAll(env, token, 'loadout_locations'),
    ]);
    inventory = { stock, containers, items, locations: new Map(locations.map(l => [l.id, l])) };
  }
  return { products, ticket, lines, client, job, inventory, now: new Date() };
}

// ---------------------------------------------------------------------
// Nightly export (PLAN section 16 rule 7)
// ---------------------------------------------------------------------

async function runNightlyExport(env, now = new Date()) {
  if (!env.DRIVE_FOLDER_ID) return { skipped: true, reason: 'DRIVE_FOLDER_ID is empty in wrangler.toml' };
  const token = await getAccessToken(env, [SCOPE_DATASTORE, driveScope(env)]);
  const folderName = dayStamp(now);
  try {
    const tables = {};
    for (const coll of ROOT_COLLS) tables[coll] = buildTable(await queryAll(env, token, coll));
    Object.assign(tables, splitLines(await queryAll(env, token, 'lines', { allDescendants: true })));

    const dayFolders = await listChildren(token, env.DRIVE_FOLDER_ID, { foldersOnly: true });
    const folder = dayFolders.find(f => f.name === folderName) || (await createFolder(token, folderName, env.DRIVE_FOLDER_ID));
    const already = new Map((await listChildren(token, folder.id)).map(f => [f.name, f.id]));

    let rows = 0;
    for (const coll of FILE_ORDER) {
      const t = tables[coll] || { keys: ['id'], rows: [] };
      const name = coll + '.csv';
      await uploadCsv(token, folder.id, name, toCsv(t), already.get(name) || null);
      rows += t.rows.length;
    }

    const prune = foldersToPrune(dayFolders, now, RETENTION_DAYS);
    for (const f of prune) await trashFile(token, f.id);

    const result = { folder: folderName, folderId: folder.id, files: FILE_ORDER.length, rows, pruned: prune.map(f => f.name) };
    await commitWrites(env, token, [{ op: 'merge', path: 'loadout_settings/worker', data: {
      lastExportAt: now, lastExportFolder: folderName, lastExportFolderId: folder.id, lastExportFiles: FILE_ORDER.length,
      lastExportRows: rows, lastExportPruned: result.pruned, lastExportError: null, updatedAt: new Date(),
    } }]);
    return result;
  } catch (e) {
    // Keep the failure visible on /health; the export itself stays failed.
    try {
      await commitWrites(env, token, [{ op: 'merge', path: 'loadout_settings/worker', data: { lastExportError: String(e.message || e).slice(0, 500), lastExportErrorAt: now, updatedAt: new Date() } }]);
    } catch (inner) {
      console.error('could not record the export error:', inner);
    }
    throw e;
  }
}
