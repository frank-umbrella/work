import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

// Routing only: none of these paths reach Firestore or Drive, so no network.
const fixture = readFileSync(new URL('./fixtures/zapier-proposal-accepted.json', import.meta.url), 'utf8');
const base = { FIREBASE_PROJECT_ID: 'demo', DRIVE_FOLDER_ID: '' };
const call = (env, path, init) => worker.fetch(new Request('https://loadout-worker.test' + path, init), env, {});

test('routes: /health reports version and which intakes are configured', async () => {
  const r = await call(Object.assign({ ZAPIER_SHARED_SECRET: 's' }, base), '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.version, '0.1.0');
  assert.deepEqual(j.intakes, { csv: true, zapier: false, portalApi: false });
  assert.equal(j.export.configured, false);
  assert.equal(j.export.lastExportAt, null);
});

test('routes: /portal/webhook is a 501 stub with the right message', async () => {
  let r = await call(base, '/portal/webhook', { method: 'POST', body: '{}' });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).error, 'Portal API intake is not configured (needs the Unlimited plan and PORTAL_* secrets)');
  r = await call(Object.assign({ PORTAL_APP_ID: 'a', PORTAL_USER_KEY: 'b', PORTAL_BASE_URL: 'https://sandbox.api.portal.io/' }, base), '/portal/webhook', { method: 'POST', body: '{}' });
  assert.equal(r.status, 501);
  assert.equal((await r.json()).error, 'Portal API intake is not built yet');
});

test('routes: /zapier/proposal needs the secret configured and sent', async () => {
  let r = await call(base, '/zapier/proposal', { method: 'POST', body: fixture });
  assert.equal(r.status, 503);
  const env = Object.assign({ ZAPIER_SHARED_SECRET: 'right' }, base);
  r = await call(env, '/zapier/proposal', { method: 'POST', body: fixture });
  assert.equal(r.status, 401);
  r = await call(env, '/zapier/proposal', { method: 'POST', body: fixture, headers: { 'X-Loadout-Secret': 'wrong' } });
  assert.equal(r.status, 401);
  r = await call(env, '/zapier/proposal', { method: 'POST', body: 'not json', headers: { 'X-Loadout-Secret': 'right' } });
  assert.equal(r.status, 400);
});

test('routes: a status other than Accepted is acknowledged and ignored', async () => {
  const env = Object.assign({ ZAPIER_SHARED_SECRET: 'right' }, base);
  const body = JSON.stringify(Object.assign(JSON.parse(fixture), { status: 'Submitted' }));
  const r = await call(env, '/zapier/proposal', { method: 'POST', body, headers: { 'X-Loadout-Secret': 'right' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ignored, true);
});

test('routes: wrong method and unknown path', async () => {
  assert.equal((await call(base, '/zapier/proposal')).status, 405);
  assert.equal((await call(base, '/nope')).status, 404);
});
