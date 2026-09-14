import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startAbaTestServer } from './abaHarness.js';
import { asinFixture, asinFirst, asinSecond, mergedFixture } from './abaAsinFixture.js';

test('ASIN reports: authenticated storage, raw metrics, SKU linkage and filter boundaries', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());
  async function call(route, cookie = '', body, method) {
    const response = await fetch(server.url + '/api' + route, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (username) => (await call('/auth/login', '', { username, password: 'local-test-password' })).cookie;
  const a = await login('aba-test'), b = await login('aba-other'), de = await login('aba-de');
  const route = '/aba/asin?marketplace=ES';
  const get = async (q = '', cookie = a) => (await call(route + q, cookie)).data;
  const upload = (files, cookie = a) => call('/aba/asin/import', cookie, { marketplace: 'ES', files, user_id: 999 });
  await t.test('account and market authorization; uploaded empty report persists', async () => {
    assert.equal((await call(route)).status, 401);
    assert.equal((await call(route, de)).status, 403);
    assert.equal((await upload([asinFirst], de)).status, 403);
    assert.equal((await upload([asinFirst, asinSecond, { name: 'empty.csv', text: asinFixture({ asin: 'B000000302', rows: [] }) }])).status, 200);
    assert.equal((await get()).reports.length, 3);
    assert.equal((await get('&asin=B000000302')).selectedReportCount, 1);
    assert.equal((await get('&asin=B000000302')).total, 0);
    assert.equal((await get('&scope=all&user_id=1', b)).reports.length, 0);
    assert.equal((await upload([asinFirst], b)).status, 200);
    assert.equal((await get('', b)).reports.length, 1);
  });
  await t.test('year/month from end date, weeks from report; merged rates and null sorting', async () => {
    const result = await get('&year=2026&month=09');
    assert.deepEqual(result.selectedWeeks, ['2026-09-05']);
    assert.equal(result.items[0].market_cvr, 50);
    const merged = await get('&weeks=2026-08-29,2026-09-05&sort=asin_cvr');
    assert.equal(merged.total, 4);
    const printer = merged.items.find((r) => r.query === 'hp deskjet 2820e');
    assert.equal(printer.market_clicks, 120);
    assert.equal(printer.market_cvr, 25);
    assert.equal(printer.asin_cvr, 8 / 15 * 100);
    assert.equal(printer.brand_share, 8 / 30 * 100);
    assert.equal(merged.items.at(-1).asin_cvr, null);
    assert.equal((await get('&weeks=2026-08-29,2026-09-05&merge=0')).total, 6);
    assert.equal((await get('&weeks=')).total, 0);
    assert.equal((await get('&year=1999')).total, 0);
  });
  await t.test('brand-view printer recognition and scoped type filters', async () => {
    const scope = '&weeks=2026-08-29,2026-09-05&q=305';
    const result = await get(scope + '&wordType=printer');
    assert.equal(result.total, 2);
    assert.match(result.items.find((r) => r.query === 'hp deskjet 2820e').recognition, /2820/);
    assert.equal(result.items.find((r) => r.query === 'hp 4310').candidates.length, 2);
    assert.equal((await get(scope + '&wordType=cartridge')).total, 1);
  });
  await t.test('SKU ASIN column, legacy import preservation and private live linkage', async () => {
    const sku = { country: 'ES', sku: 'TEST-305-BK', brand: 'Test CY', model: '305', setGroup: 'BK', asin: 'b000000305', stock: 20 };
    assert.equal((await call('/sku/rows', a, { rows: [sku, { ...sku, sku: 'TEST-305-BKC', setGroup: 'BKC' }] })).data.added, 2);
    await call('/sku/rows', b, { rows: [{ ...sku, sku: 'PRIVATE-OTHER-ACCOUNT' }] });
    await call('/sku/rows', a, { rows: [{ ...sku, country: 'DE', sku: 'PRIVATE-OTHER-MARKET' }] });
    await call('/sku/rows', a, { rows: [{ country: 'ES', sku: sku.sku, model: '305', stock: 99 }] });
    await call('/sku/bulk', a, { text: 'ES\tTest CY\t305\tBK\tTEST-305-BK\t88\t20' });
    const items = (await get()).skuItems;
    assert.equal(items.length, 2);
    assert.equal(items.find((s) => s.sku === sku.sku).asin, 'B000000305');
    const id = items.find((s) => s.sku === sku.sku).id;
    assert.equal((await get(`&skuId=${id}`)).total, 2);
    assert.equal((await get('&skuId=99999')).total, 0);
    assert.equal((await get(`&skuId=${id}`, b)).total, 0);
    assert.equal((await call('/sku/' + id, b, { asin: 'B000000302' }, 'PATCH')).status, 403);
    assert.equal((await call('/sku/' + id, a, { asin: 'bad' }, 'PATCH')).status, 400);
    await call('/sku/' + id, a, { asin: 'B000000302', model: '302' }, 'PATCH');
    assert.equal((await get(`&skuId=${id}`)).total, 0);
    assert.equal((await get()).skuItems.find((s) => s.id === id).model, '302');
  });
  await t.test('idempotency and atomic rejection; replacing populated report with empty report', async () => {
    assert.equal((await upload([asinFirst])).data.reports[0].status, 'unchanged');
    assert.equal((await upload([asinFirst, asinFirst])).status, 400);
    assert.equal((await upload([{ ...asinFirst, text: asinFixture({ rows: [] }) }, { name: 'bad.csv', text: 'bad' }])).status, 400);
    assert.equal((await get('&weeks=2026-08-29')).total, 4);
    assert.equal((await upload([{ ...asinFirst, text: asinFixture({ rows: [] }) }])).data.reports[0].status, 'updated');
    assert.equal((await get('&weeks=2026-08-29')).total, 0);
    assert.equal((await get('&weeks=2026-09-05')).total, 2);
    assert.equal((await get('&weeks=2026-08-29', b)).total, 4);
  });
  await t.test('global sort and pagination retain totals, persistence survives new connection', async () => {
    const rows = Array.from({ length: 110 }, (_, i) => [`query ${i}`, 100, i, 10, 5, 1, 2, 1]);
    await upload([{ ...asinFirst, text: asinFixture({ rows }) }]);
    const result = await get('&weeks=2026-08-29&sort=market_impressions&pageSize=25&page=2');
    assert.equal(result.total, 110);
    assert.equal(result.items[0].market_impressions, 84);
    assert.equal((await get('&weeks=2026-08-29&page=999')).page, 2);
    const persisted = new Database(path.join(server.directory, 'adtool.db'), { readonly: true });
    try { assert.equal(persisted.prepare('SELECT count(*) AS count FROM aba_asin_queries').get().count, 116); }
    finally { persisted.close(); }
  });
  await t.test('merged workbook import is atomic and interchangeable with CSV; grouped metrics and KW classification', async () => {
    const custom = { name: 'source.csv', text: asinFixture({ rows: [
      ['hp deskjet 2820e', 100, 1000, 100, 20, 200, 10, 5],
      ['tinta hp 2820.e', 20, 300, 20, 10, 60, 5, 2],
      ['generic ink', 10, 50, 5, 1, 10, 2, 1],
      ['hp 4310', 40, 70, 10, 4, 15, 5, 2],
    ] }) };
    const workbook = mergedFixture([custom, asinSecond]);
    assert.equal((await upload([workbook])).status, 200);
    assert.equal((await upload([custom])).data.reports[0].status, 'unchanged');
    const invalid = structuredClone(workbook); invalid.sheets[0].rows[1][34] = '';
    assert.equal((await upload([invalid])).status, 400);
    assert.equal((await upload([workbook, custom])).status, 400);
    const scope = '&asin=B000000305&weeks=2026-08-29,2026-09-05';
    const result = await get(scope + '&view=printers&sort=query_count');
    assert.equal(result.total, 3);
    const exported = await get(scope + '&view=printers&sort=query_count&pageSize=25&export=1');
    assert.equal(exported.items.length, exported.total);
    const group = result.items.find((r) => /2820/.test(r.recognition));
    assert.equal(group.query_count, 2);
    assert.equal(group.market_clicks, 140);
    assert.equal(group.asin_purchases, 10);
    assert.equal(group.market_cvr, 40 / 140 * 100);
    assert.equal(group.asin_cvr, 50);
    assert.equal(group.brand_share, 25);
    assert.equal(group.query_rows, undefined);
    const exportedGroup = exported.items.find((r) => /2820/.test(r.recognition));
    assert.deepEqual(exportedGroup.query_rows.map((row) => row.query), ['hp deskjet 2820e', 'tinta hp 2820.e']);
    assert.equal(exportedGroup.query_rows[0].market_clicks, 120);
    const children = await get(scope + '&group=' + encodeURIComponent(group.group.key));
    assert.equal(children.total, 2);
    assert.equal(children.items.reduce((n, r) => n + r.asin_purchases, 0), group.asin_purchases);
    assert.equal((await get(scope + '&wordType=cartridge')).total, 2);
    assert.equal((await get(scope + '&q=generic')).items[0].recognition, '墨盒 KW 词');
    assert.equal((await get(scope + '&view=printers', b)).items.some((r) => r.query === 'generic ink'), false);
  });
  await t.test('model filter merges color sets, deduplicates shared market data and remains account-scoped', async () => {
    const one = 'B000001001', two = 'B000001002';
    const marketRow = ['hp deskjet 2820e', 100, 1000, 100, 20, 200, 10, 5];
    const otherRow = ['hp deskjet 2820e', 100, 1000, 100, 20, 100, 20, 2];
    await call('/sku/rows', a, { rows: [
      { country: 'ES', brand: 'Series', model: '305', sku: 'SERIES-BK', asin: one },
      { country: 'ES', brand: 'Series', model: '305XL', sku: 'SERIES-BKC', asin: two },
      { country: 'ES', brand: 'Series', model: '305', sku: 'SERIES-SAME-ASIN', asin: one },
    ] });
    await upload([{ name: 'one.csv', text: asinFixture({ asin: one, rows: [marketRow] }) }, { name: 'two.csv', text: asinFixture({ asin: two, rows: [otherRow] }) }]);
    const model = (await get()).modelOptions.find((m) => m.model === '305');
    assert.ok(model.asins.includes(one) && model.asins.includes(two));
    const scope = '&weeks=2026-08-29&brand=series&model=' + encodeURIComponent(model.key);
    let result = await get(scope);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].market_clicks, 100);
    assert.equal(result.items[0].asin_clicks, 30);
    assert.equal(result.items[0].brand_share, 35);
    const group = (await get(scope + '&view=printers')).items[0];
    assert.equal(group.asin_purchases, 7);
    assert.equal((await get(scope + '&group=' + encodeURIComponent(group.group.key))).items[0].asin_purchases, 7);
    assert.equal((await get(scope + '&asin=' + two)).items[0].asin_clicks, 20);
    assert.equal((await get(scope, b)).total, 0);
    assert.equal((await get('&model=unknown')).total, 0);
    await upload([{ name: 'two.csv', text: asinFixture({ asin: two, rows: [[...otherRow.slice(0, 4), 25, ...otherRow.slice(5)]] }) }]);
    result = await get(scope);
    assert.equal(result.items[0].market_purchases, null);
    assert.equal(result.items[0].market_cvr, null);
    assert.equal(result.items[0].brand_share, null);
    assert.equal(result.items[0].asin_purchases, 7);
    assert.equal(result.items[0].conflict_count, 1);
  });
  await t.test('model then brand then ASIN/SKU cascades include every brand; averages use observed weeks', async () => {
    const one = 'B000009001', two = 'B000009002', third = 'B000009003';
    await call('/sku/rows', a, { rows: [
      { country: 'ES', brand: 'Alpha', model: '901', sku: 'ALPHA-901', asin: one },
      { country: 'ES', brand: 'Beta', model: '901XL', sku: 'BETA-901', asin: two },
      { country: 'ES', brand: 'Beta', model: '902', sku: 'BETA-902', asin: third },
    ] });
    const row = ['hp deskjet 2820e', 100, 1000, 100, 20, 200, 10, 5];
    await upload([
      { name: 'a.csv', text: asinFixture({ asin: one, rows: [row, ['tinta hp deskjet 2820e', 20, 50, 10, 2, 10, 3, 1]] }) },
      { name: 'b.csv', text: asinFixture({ asin: two, rows: [row] }) },
      { name: 'c.csv', text: asinFixture({ asin: third, rows: [row] }) },
      { name: 'next.csv', text: asinFixture({ asin: one, week: 36, start: '2026-08-30', end: '2026-09-05', rows: [[...row.slice(0, 6), 11, 5]] }) },
    ]);
    const all = await get();
    assert.ok(all.modelOptions.some((m) => m.key === '901') && all.modelOptions.some((m) => m.key === '902'));
    const model = await get('&model=901');
    assert.deepEqual(model.brands.map((b) => b.label), ['Alpha', 'Beta']);
    assert.deepEqual(model.asins, [one, two]);
    const beta = await get('&model=901&brand=beta&weeks=2026-08-29');
    assert.deepEqual(beta.asins, [two]);
    assert.ok(beta.skuItems.every((s) => s.brand === 'Beta' && s.model === '901XL'));
    assert.equal((await get('&model=901&brand=beta&asin=' + one)).total, 0);
    assert.equal((await get('&model=901&brand=beta&skuId=' + model.skuItems.find((s) => s.brand === 'Alpha').id)).total, 0);
    assert.deepEqual((await get('&model=901', b)).brands, []);
    const params = '&model=901&brand=alpha&weeks=2026-08-29,2026-09-05&aggregation=average';
    const average = await get(params);
    assert.equal(average.aggregation, 'average');
    assert.equal(average.items.find((r) => r.query === row[0]).asin_clicks, 10.5);
    assert.equal(average.items.find((r) => r.query !== row[0]).asin_clicks, 3);
    const group = (await get(params + '&view=printers')).items[0];
    assert.equal(group.asin_clicks, 13.5);
    const children = await get(params + '&group=' + encodeURIComponent(group.group.key));
    assert.equal(children.items.reduce((sum, r) => sum + r.asin_clicks, 0), group.asin_clicks);
    assert.equal((await get('&model=901&brand=alpha&weeks=2026-08-29&aggregation=average')).aggregation, 'sum');
  });
  if (process.env.ASIN_SAMPLE_DIR) await t.test('all four real reports preserve source totals, including header-only week', async () => {
    const files = fs.readdirSync(process.env.ASIN_SAMPLE_DIR).filter((f) => f.endsWith('.csv')).map((name) => ({ name, text: fs.readFileSync(path.join(process.env.ASIN_SAMPLE_DIR, name), 'utf8') }));
    assert.equal((await upload(files)).status, 200);
    const r = await get('&asin=B0GXB65GFF&weeks=2026-08-29,2026-09-05&pageSize=500');
    assert.equal(r.recordCount, 167);
    assert.equal(r.items.reduce((sum, row) => sum + row.market_clicks, 0), 9174);
    assert.equal(r.items.reduce((sum, row) => sum + row.asin_purchases, 0), 58);
    assert.equal((await get('&asin=B09MF84KVB&weeks=2026-08-29')).selectedReportCount, 1);
    assert.equal((await get('&asin=B09MF84KVB&weeks=2026-08-29')).total, 0);
  });
});
