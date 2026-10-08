import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { startAbaTestServer } from './abaHarness.js';
import { csvFixture, brandFixture, firstFile, secondFile } from './abaFixture.js';

test('ABA authenticated import, privacy, persistence, sorting, paging and transaction recovery', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());
  async function call(route, cookie = '', body) {
    const response = await fetch(server.url + '/api' + route, { method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (username) => (await call('/auth/login', '', { username, password: 'local-test-password' })).cookie;
  const a = await login('aba-test');
  const b = await login('aba-other');
  const de = await login('aba-de');
  const route = '/aba?marketplace=ES';
  const upload = (cookie, files, extra = {}) => call('/aba/import', cookie, { marketplace: 'ES', files, ...extra });
  await t.test('authentication and market authorization', async () => {
    assert.equal((await call(route)).status, 401);
    assert.equal((await call(route, de)).status, 403);
    assert.equal((await upload(de, [firstFile])).status, 403);
  });
  await t.test('multi-week import and exact report values', async () => {
    assert.equal((await upload(a, [firstFile, secondFile])).status, 200);
    const result = (await call(route + '&weeks=2026-08-29,2026-09-05', a)).data;
    assert.equal(result.total, 6);
    assert.equal(result.recordCount, 12);
    assert.equal(result.merged, true);
    assert.equal(result.items.find((r) => r.query === 'cartuchos hp 305').clicks, 90);
    assert.equal(result.items.find((r) => r.query === 'cartuchos hp 305').click_price, null);
    assert.equal((await call(route + '&weeks=2026-08-29,2026-09-05&merge=0', a)).data.total, 12);
    assert.equal(result.reports.length, 2);
    assert.deepEqual(result.trend.map((r) => r.query_volume), [138, 138]);
    assert.equal(result.items.find((r) => r.query === 'canon TS305').click_rate, 150);
    assert.equal(result.trend[0].click_rate, 66 / 138 * 100);
  });
  await t.test('owner cannot see or change another account, user_id/scope parameters are ignored', async () => {
    assert.equal((await call(route + '&user_id=1&scope=all', b)).data.total, 0);
    assert.equal((await upload(b, [firstFile], { user_id: 1 })).status, 200);
    assert.equal((await call(route, b)).data.reports.length, 1);
    assert.equal((await call(route, a)).data.reports.length, 2);
    assert.equal((await call('/aba?marketplace=DE', b)).data.total, 0);
  });
  await t.test('idempotent repeat and atomic rejection preserve earlier records', async () => {
    assert.equal((await upload(a, [firstFile])).data.reports[0].status, 'unchanged');
    assert.equal((await upload(a, [firstFile, firstFile])).status, 400);
    const changed = { ...firstFile, text: firstFile.text.replace('"100"', '"222"') };
    assert.equal((await upload(a, [changed, { ...secondFile, text: 'broken' }])).status, 400);
    assert.equal((await call(route + '&weeks=2026-08-29', a)).data.items[0].query_volume, 100);
    assert.equal((await upload(a, [changed])).data.reports[0].status, 'updated');
    assert.equal((await call(route + '&weeks=2026-08-29', a)).data.items[0].query_volume, 222);
    assert.equal((await call(route + '&weeks=2026-08-29', b)).data.items[0].query_volume, 100);
    assert.equal((await call(route + '&weeks=2026-09-05', a)).data.items[0].query_volume, 100);
  });
  await t.test('server search includes related candidates, supports exact week and empty selections', async () => {
    const result = (await call(route + '&q=305', a)).data;
    assert.equal(result.total, 5);
    assert.equal(result.linkedCount, 2);
    assert.equal(result.items.find((r) => r.query === 'hp 4310').candidates.length, 2);
    assert.equal((await call(route + '&q=305&models=0', a)).data.total, 3);
    assert.equal((await call(route + '&weeks=', a)).data.total, 0);
    assert.equal((await call(route + '&q=missing', a)).data.total, 0);
    assert.equal((await call(route + '&brand=Another', a)).data.total, 0);
    assert.equal((await call(route + '&sort=click_price&direction=asc', a)).data.items.at(-1).click_price, null);
  });
  await t.test('printer-only scope, cartridge exclusion, exclusive group totals and paged group children', async () => {
    const scope = route + '&q=305&weeks=2026-08-29,2026-09-05';
    assert.equal((await call(scope + '&wordType=printer', a)).data.total, 2);
    assert.equal((await call(scope + '&wordType=cartridge', a)).data.total, 1);
    const grouped = (await call(scope + '&wordType=printer&view=printers&sort=clicks', a)).data;
    assert.equal(grouped.total, 2);
    assert.equal(grouped.items.reduce((sum, r) => sum + r.clicks, 0), 24);
    assert.equal(grouped.items.reduce((sum, r) => sum + r.purchases, 0), 10);
    assert.equal(grouped.items.filter((r) => r.group.kind === 'review').length, 1);
    const groupKey = grouped.items.find((r) => r.group.kind === 'printer').key;
    const detailRoute = scope + '&wordType=printer&group=' + encodeURIComponent(groupKey);
    const detail = (await call(detailRoute, a)).data;
    assert.equal(detail.total, 1);
    assert.equal(detail.items[0].query, 'tinta hp deskjet 2700');
    assert.equal(detail.items[0].clicks, 20);
    assert.equal((await call(detailRoute + '&merge=0', a)).data.total, 2);
    assert.equal((await call(detailRoute + '&scope=all&user_id=1', b)).data.items[0].clicks, 10);
    assert.equal((await call(scope + '&group=nonexistent', a)).data.total, 0);
    assert.equal((await call(scope + '&sort=click_price', a)).data.sort, 'query_volume');
    assert.equal((await call(scope + '&pageSize=500', a)).data.pageSize, 500);
    const groupedAll = (await call(scope + '&view=printers', a)).data;
    assert.equal(groupedAll.items.reduce((sum, r) => sum + r.clicks, 0), groupedAll.trend.reduce((sum, w) => sum + w.clicks, 0));
  });
  await t.test('pagination clamps safely and sort is global, not within a page', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => [`tinta ${i}`, i + 1, (i + 1) * 10, i, 20, 10, i]);
    await upload(a, [{ ...secondFile, text: csvFixture({ week: 36, start: '2026-08-30', end: '2026-09-05', rows }) }]);
    let result = (await call(route + '&sort=purchases&pageSize=25&page=2', a)).data;
    assert.equal(result.items.length, 25);
    assert.equal(result.items[0].purchases, 39);
    result = (await call(route + '&pageSize=25&page=999', a)).data;
    assert.equal(result.page, 3);
    assert.equal(result.items.length, 15);
    assert.equal((await call(route + '&q=missing&page=999', a)).data.page, 1);
  });
  await t.test('committed reports are readable from a newly opened SQLite connection', () => {
    const reopened = new Database(path.join(server.directory, 'adtool.db'), { readonly: true });
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM aba_reports WHERE user_id=1').get().n, 2);
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM aba_queries q JOIN aba_reports r ON r.id=q.report_id WHERE r.user_id=1').get().n, 71);
    reopened.close();
  });
  await t.test('brand fields remain unknown for old reports, reimport fills them and recalculates weighted rates', async () => {
    assert.equal((await call(route + '&weeks=2026-08-29', a)).data.missingBrandData, true);
    const files = [{ ...firstFile, text: brandFixture({}, [100, 10, 2]) }, { ...secondFile, text: brandFixture({ week: 36, start: '2026-08-30', end: '2026-09-05' }, [120, 5, 3]) }];
    assert.equal((await upload(a, files)).status, 200);
    const result = (await call(route + '&weeks=2026-08-29,2026-09-05&q=cartuchos&sort=brand_share', a)).data;
    assert.equal(result.missingBrandData, false);
    const row = result.items[0];
    assert.equal(row.brand_impressions, 220);
    assert.equal(row.brand_clicks, 15);
    assert.equal(row.brand_purchases, 5);
    assert.equal(row.brand_cvr, 5 / 15 * 100);
    assert.equal(row.brand_share, 5 / 30 * 100);
    assert.equal(row.market_cvr, 30 / 90 * 100);
    assert.equal((await upload(a, files)).data.reports[0].status, 'unchanged');
    assert.equal((await call(route, b)).data.items[0].brand_purchases, null);
    const group = (await call(route + '&weeks=2026-08-29,2026-09-05&q=2700&view=printers', a)).data.items[0];
    assert.equal(group.brand_purchases, 5);
    assert.equal(group.brand_cvr, 5 / 15 * 100);
  });
  if (process.env.ABA_FIXTURE_DIR) await t.test('both supplied real reports reconcile to 2,000 rows and known source totals', async () => {
    const files = ['08_29', '09_05'].map((end) => { const name = `ES_Week_2026_${end}.csv`; return { name, text: fs.readFileSync(path.join(process.env.ABA_FIXTURE_DIR, name), 'utf8') }; });
    assert.equal((await upload(a, files)).status, 200);
    const result = (await call(route + '&weeks=2026-08-29,2026-09-05', a)).data;
    assert.equal(result.recordCount, 2000);
    assert.ok(result.total < 2000);
    assert.deepEqual(result.trend.map((w) => [w.query_volume, w.impressions, w.clicks, w.purchases]), [[83046, 2308371, 17371, 3285], [88231, 2416536, 21959, 4417]]);
  });
});
