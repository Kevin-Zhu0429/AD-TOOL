import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { reportWeeks, nextTuesday, asinBatches, parsePublicReport, savePublicReports } from '../src/services/publicAsinData.js';
import { createPublicSync, downloadPublicDocument } from '../src/services/publicAsinSync.js';
import { AMAZON_MARKETPLACES, spApiRequest, spApiTiming } from '../src/spApi.js';
import { publicFixture, publicTask } from './abaPublicFixture.js';
import { startAbaTestServer } from './abaHarness.js';
import { asinFirst } from './abaAsinFixture.js';
import { gzipSync } from 'node:zlib';

function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  return db;
}

test('Beijing schedule and complete Amazon weeks work across local timezone and year boundaries', () => {
  assert.deepEqual(reportWeeks(Date.parse('2026-10-06T04:00:00Z')), [
    { week_start: '2026-09-27', week_end: '2026-10-03' },
    { week_start: '2026-09-20', week_end: '2026-09-26' },
    { week_start: '2026-09-13', week_end: '2026-09-19' },
    { week_start: '2026-09-06', week_end: '2026-09-12' },
  ]);
  assert.equal(new Date(nextTuesday(Date.parse('2026-10-06T03:59:59Z'))).toISOString(), '2026-10-06T04:00:00.000Z');
  assert.equal(new Date(nextTuesday(Date.parse('2026-10-06T04:00:00Z'))).toISOString(), '2026-10-13T04:00:00.000Z');
  assert.deepEqual(reportWeeks(Date.parse('2026-01-04T00:00:00Z'), 1), [{ week_start: '2025-12-28', week_end: '2026-01-03' }]);
  assert.deepEqual(reportWeeks(Date.parse('2026-10-03T16:01:00Z'), 1), [{ week_start: '2026-09-27', week_end: '2026-10-03' }]);
  const batches = asinBatches(Array.from({ length: 40 }, (_, i) => 'B' + String(i).padStart(9, '0')));
  assert.deepEqual(batches.map((b) => b.length), [18, 18, 4]);
  assert.ok(batches.every((b) => b.join(' ').length <= 200));
  assert.throws(() => asinBatches(['BAD']), /格式/);
});

test('API data validation, all-or-nothing writes, empty weeks and idempotent replacement', () => {
  const db = memoryDb();
  try {
    const payload = publicFixture(publicTask);
    assert.deepEqual(savePublicReports(db, { payload, task: publicTask, marketplaceId: AMAZON_MARKETPLACES.ES.id }), { rows: 4, reports: 2 });
    savePublicReports(db, { payload, task: publicTask, marketplaceId: AMAZON_MARKETPLACES.ES.id });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM aba_public_queries').get().n, 4);
    const bad = structuredClone(payload);
    bad.dataByAsin.at(-1).clickData.asinClickCount = null;
    assert.throws(() => savePublicReports(db, { payload: bad, task: publicTask, marketplaceId: AMAZON_MARKETPLACES.ES.id }), /缺失/);
    assert.equal(db.prepare('SELECT SUM(asin_clicks) n FROM aba_public_queries').get().n, 40);
    for (const mutate of [
      (p) => { p.reportSpecification.marketplaceIds = [AMAZON_MARKETPLACES.DE.id]; },
      (p) => { p.reportSpecification.dataStartTime = '2026-09-20'; },
      (p) => { p.dataByAsin[0].asin = 'B000000999'; },
      (p) => { p.dataByAsin.push(p.dataByAsin[0]); },
      (p) => { p.dataByAsin[0].clickData.asinClickCount = -1; },
    ]) {
      const value = structuredClone(payload); mutate(value);
      assert.throws(() => parsePublicReport(value, publicTask, AMAZON_MARKETPLACES.ES.id));
    }
    savePublicReports(db, { payload: publicFixture(publicTask, AMAZON_MARKETPLACES.ES.id, { empty: true }), task: publicTask, marketplaceId: AMAZON_MARKETPLACES.ES.id });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM aba_public_reports').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM aba_public_queries').get().n, 0);
  } finally { db.close(); }
});

test('persistent queue: four-week backfill, resume report IDs, partial failure, retry and scheduled deduplication', async () => {
  const db = memoryDb();
  let clock = Date.parse('2026-10-06T03:59:00Z');
  const accounts = () => ['CE', 'CC'].map((brand) => ({ brand, sellerId: brand, region: 'eu', markets: ['ES'] }));
  const targets = ['CE', 'CC'].map((brand, i) => ({ marketplace: 'ES', brand, asins: ['B' + String(305 + i).padStart(9, '0')] }));
  const requests = new Map();
  let creates = 0, denyCC = true;
  const options = { db, targets, accounts, now: () => clock, createInterval: 0, pollInterval: 0,
    save: (payload) => savePublicReports(db, payload),
    request: async (account, _region, path, request) => {
      if (denyCC && account.brand === 'CC') throw Object.assign(new Error('Brand Analytics 权限不足'), { upstreamStatus: 403 });
      if (request.method === 'POST') {
        const id = 'report-' + (++creates); requests.set(id, request.body); return { reportId: id };
      }
      if (path.includes('/documents/')) return { url: 'https://example.invalid/' + path.split('/').at(-1) };
      return { processingStatus: 'DONE', reportDocumentId: path.split('/').at(-1) };
    },
    download: async (document) => {
      const body = requests.get(document.url.split('/').at(-1));
      const task = { ...publicTask, week_start: body.dataStartTime.slice(0, 10), week_end: body.dataEndTime.slice(0, 10), asins_json: JSON.stringify(body.reportOptions.asin.split(' ')) };
      return publicFixture(task);
    },
  };
  try {
    let sync = createPublicSync(options);
    const first = sync.start();
    assert.equal(sync.start().jobId, first.jobId);
    assert.equal(sync.status().summary.total, 8);
    await sync.tick();
    assert.equal(creates, 1);
    sync = createPublicSync(options); // restart using the same persisted queue
    await sync.tick();
    assert.equal(creates, 1);
    for (let i = 0; i < 20 && sync.status().job.state === 'running'; i++) await sync.tick();
    assert.equal(sync.status().job.state, 'partial');
    assert.equal(sync.status().summary.failed, 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM aba_public_reports').get().n, 4);
    assert.ok(!JSON.stringify(sync.status()).includes('report-1'));
    denyCC = false;
    sync.start();
    assert.equal(sync.status().summary.total, 5); // latest CE refreshed, 4 missing CC weeks backfilled
    for (let i = 0; i < 20 && sync.status().job.state === 'running'; i++) await sync.tick();
    assert.equal(sync.status().job.state, 'done');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM aba_public_reports').get().n, 8);
    clock = Date.parse('2026-10-06T04:00:00Z');
    await sync.tick();
    const scheduled = sync.status().job.id;
    assert.equal(sync.status().job.trigger_kind, 'scheduled');
    await createPublicSync(options).tick();
    assert.equal(sync.status().job.id, scheduled);
    assert.equal(sync.status().nextDue, Date.parse('2026-10-13T04:00:00Z'));
  } finally { db.close(); }
});

test('download handles gzip and rejects unsafe documents without exposing signed URLs', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response(gzipSync(Buffer.from('{"dataByAsin":[]}')));
    assert.deepEqual(await downloadPublicDocument({ url: 'https://example.invalid/signed', compressionAlgorithm: 'GZIP' }), { dataByAsin: [] });
    await assert.rejects(downloadPublicDocument({ url: 'http://example.invalid/signed' }), /HTTPS/);
    await assert.rejects(downloadPublicDocument({ url: 'https://example.invalid/signed', compressionAlgorithm: 'ZIP' }), /压缩/);
  } finally { global.fetch = original; }
});

test('Reports API POST and Brand Analytics denial use existing LWA client without credential leakage', async () => {
  const original = global.fetch;
  const timing = { ...spApiTiming };
  try {
    spApiTiming.minIntervalMs = 0; spApiTiming.retryBaseMs = 0;
    const account = { sellerId: 'TEST-REPORTS', refreshToken: 'report-test-token', clientId: 'test', clientSecret: 'secret' };
    global.fetch = async (url, options) => {
      if (String(url).includes('auth/o2/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['x-amz-access-token'], 'access');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(JSON.parse(options.body).reportType, 'test');
      return Response.json({ reportId: 'new-id' });
    };
    assert.deepEqual(await spApiRequest(account, 'eu', '/reports/2021-06-30/reports', { method: 'POST', body: { reportType: 'test' }, role: 'Brand Analytics' }), { reportId: 'new-id' });
    global.fetch = async (url) => String(url).includes('auth/o2/token') ? Response.json({ access_token: 'access', expires_in: 3600 }) : Response.json({ errors: [{ message: 'Denied' }] }, { status: 403 });
    await assert.rejects(spApiRequest(account, 'eu', '/reports/2021-06-30/reports', { role: 'Brand Analytics' }), /Brand Analytics/);
  } finally { global.fetch = original; Object.assign(spApiTiming, timing); }
});

test('public API authorization, shared all-account SKU filters, private isolation and export', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());
  const call = async (route, cookie = '', body, method) => {
    const response = await fetch(server.url + '/api' + route, { method: method ?? (body ? 'POST' : 'GET'),
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json().catch(() => null) };
  };
  const login = async (username) => (await call('/auth/login', '', { username, password: 'local-test-password' })).cookie;
  const operator = await login('aba-test'), owner = await login('aba-other'), german = await login('aba-de');
  for (const [market, id] of [['ES', AMAZON_MARKETPLACES.ES.id], ['DE', AMAZON_MARKETPLACES.DE.id]]) {
    const task = { ...publicTask, marketplace: market };
    savePublicReports(server.db, { task, payload: publicFixture(task, id), marketplaceId: id });
  }
  const get = async (query = '', cookie = operator) => (await call('/aba-public/asin?marketplace=ES' + query, cookie)).data;
  assert.equal((await call('/aba-public/status')).status, 401);
  assert.equal((await call('/aba-public/sync', operator, {})).status, 403);
  assert.equal((await call('/aba-public/asin?marketplace=DE', operator)).status, 200);
  assert.equal((await call('/aba/asin?marketplace=DE', operator)).status, 403);
  assert.equal((await call('/aba-public/asin?marketplace=BAD', owner)).status, 400);
  assert.equal((await get('&brand=ce')).total, 4); // catalog brand works with no SKU linkage
  await call('/aba/asin/import', operator, { marketplace: 'ES', files: [asinFirst] });
  assert.equal((await get()).reports.length, 2);
  const sku = { country: 'ES', brand: 'CE', model: '305', setGroup: 'BK', asin: 'B000000305', sku: 'OWNER-SKU' };
  await call('/sku/rows', owner, { rows: [sku, { ...sku, asin: 'B000000306', sku: 'OWNER-COLOR' }] });
  await call('/sku/rows', operator, { rows: [sku, { ...sku, sku: 'OPERATOR-SKU' }] });
  const data = await get('&model=305&brand=ce');
  assert.equal(data.modelOptions.length, 1);
  assert.equal(data.skuItems.length, 3); // same logical SKU across accounts deduplicates
  assert.equal(data.items[0].asin_clicks, 20); // duplicate linkage cannot multiply counts
  const selected = await get('&skuId=' + data.skuItems.find((s) => s.sku === 'OWNER-SKU').id);
  assert.equal(selected.total, 2);
  assert.equal((await get('', german)).reports.length, 2);
  assert.equal((await call('/aba/asin?marketplace=ES', owner)).data.reports.length, 0);
  const exported = await get('&model=305&view=printers&export=1&pageSize=25');
  assert.equal(exported.items[0].query_rows.length, 2);
  assert.ok(exported.items.every((g) => g.query_rows.length > 0));
  assert.equal((await call('/auth/audit/events', german, { module: 'abaPublic', action: 'export', marketplace: 'ES' })).status, 200);
  const started = await call('/aba-public/sync', owner, {});
  assert.equal(started.status, 202);
  assert.equal((await call('/aba-public/sync', owner, {})).data.jobId, started.data.jobId);
  server.db.prepare("UPDATE users SET role='operator',marketplace='DE' WHERE username='aba-other'").run();
  assert.equal((await call('/aba-public/sync', owner, {})).status, 403); // latest DB role, not stale session
  assert.equal(server.db.prepare('SELECT COUNT(*) n FROM aba_public_reports').get().n, 4);
});

test('document rate budget persists across restarts and expired task leases recover', async () => {
  const db = memoryDb();
  let clock = Date.parse('2026-10-05T04:00:00Z');
  let documents = 0;
  const asins = Array.from({ length: 19 }, (_, i) => 'B' + String(i).padStart(9, '0'));
  const options = { db, targets: [{ marketplace: 'ES', brand: 'CE', asins }],
    accounts: () => [{ brand: 'CE', sellerId: 'CE', region: 'eu', markets: ['ES'] }],
    now: () => clock, createInterval: 60500, pollInterval: 0,
    save: (payload) => savePublicReports(db, payload),
    request: async (_account, _region, path) => {
      if (path.includes('/documents/')) { documents++; return { url: 'https://example.invalid/' + path.split('/').at(-1) }; }
      return { processingStatus: 'DONE', reportDocumentId: path.split('/').at(-1) };
    },
    download: async (document) => {
      const id = Number(document.url.split('/').at(-1));
      const task = db.prepare('SELECT * FROM aba_public_tasks WHERE id=?').get(id);
      return publicFixture(task);
    },
  };
  try {
    let sync = createPublicSync(options);
    sync.start();
    db.prepare("UPDATE aba_public_tasks SET report_id=CAST(id AS TEXT),stage='waiting'").run();
    await sync.tick();
    assert.equal(documents, 1);
    await sync.tick();
    assert.equal(documents, 1);
    assert.equal(sync.status().tasks[1].stage, 'waiting_download');
    sync = createPublicSync(options);
    await sync.tick();
    assert.equal(documents, 1);
    db.prepare("UPDATE aba_public_tasks SET locked_until=? WHERE stage NOT IN ('done','failed')").run(clock + 300000);
    clock += 60500;
    await sync.tick();
    assert.equal(documents, 1);
    clock += 300000;
    for (let i = 0; i < 10 && sync.status().job.state === 'running'; i++) { await sync.tick(); clock += 60500; }
    assert.equal(sync.status().job.state, 'done');
    assert.equal(sync.status().summary.completed, 8);
  } finally { db.close(); }
});
