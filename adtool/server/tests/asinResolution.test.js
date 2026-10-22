import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';
import { resolutionAsins as ids, resolutionFiles, resolutionSkus, resolutionReports, resolutionQuery,
  seedResolution, seedResolutionReport } from './asinResolutionFixture.js';
import { buildAsinExport, skusForAsinRow } from '../../web/src/abaAsinExport.js';

test('private/public multi-printer assignment preserves source counts, grouping, averages, review filters and exports', async (t) => {
  const server = await startAbaTestServer(); t.after(() => server.close()); seedResolution(server.db);
  const post = async (route, body, cookie = '') => {
    const response = await fetch(server.url + '/api' + route, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const cookie = (await post('/auth/login', { username: 'aba-test', password: 'local-test-password' })).cookie;
  const owner = (await post('/auth/login', { username: 'aba-other', password: 'local-test-password' })).cookie;
  await post('/aba/asin/import', { marketplace: 'ES', files: resolutionFiles }, cookie);
  await post('/sku/rows', { rows: resolutionSkus }, cookie);
  const get = async (endpoint, query = {}) => {
    const response = await fetch(server.url + '/api' + endpoint + '?' + new URLSearchParams({ marketplace: 'ES', year: '',
      weeks: '2026-09-19,2026-09-26', view: 'printers', ...query }), { headers: { cookie } });
    assert.equal(response.status, 200); return response.json();
  };
  for (const endpoint of ['/aba/asin', '/aba-public/asin']) {
    const sum = await get(endpoint, { export: '1' });
    assert.equal(sum.total, 3);
    assert.equal(sum.items.reduce((n, r) => n + r.asin_clicks, 0), 75);
    assert.equal(sum.items.find((r) => r.group.key === 'hp|officejet2620').asin_clicks, 40);
    assert.equal(sum.items.find((r) => r.group.key === 'hp|deskjet2620').asin_clicks, 20);
    const avg = await get(endpoint, { aggregation: 'average', export: '1' });
    const office = avg.items.find((r) => r.group.key === 'hp|officejet2620');
    const desk = avg.items.find((r) => r.group.key === 'hp|deskjet2620');
    assert.equal(office.market_impressions, 2000); assert.equal(office.asin_clicks, 20);
    assert.equal(desk.market_impressions, 1000); assert.equal(desk.asin_clicks, 20);
    assert.equal(office.query_rows.length, 1); assert.equal(desk.query_rows.length, 1);
    assert.deepEqual(office.asins, [ids[0]]); assert.deepEqual(desk.asins, [ids[1]]);
    const child = await get(endpoint, { view: 'queries', group: office.group.key, aggregation: 'average' });
    assert.equal(child.total, 1); assert.equal(child.items[0].query, resolutionQuery);
    assert.equal(child.items[0].asin_clicks, office.asin_clicks);
    const review = await get(endpoint, { alignment: 'multi', export: '1', aggregation: 'average', pageSize: '25' });
    assert.equal(review.total, 1); assert.deepEqual(review.items[0].asins, ids.slice(2));
    assert.equal(review.items[0].asin_clicks, 15);
    const detail = await get(endpoint, { view: 'queries', alignment: 'multi', merge: '0' });
    assert.equal(detail.total, 3);
    const reviewChild = await get(endpoint, { view: 'queries', group: review.items[0].group.key, alignment: 'multi' });
    assert.deepEqual(reviewChild.items[0].asins, ids.slice(2));
    assert.equal((await get(endpoint, { alignment: 'multi', asin: ids[0] })).total, 0);
    assert.equal((await get(endpoint, { asin: ids[1] })).items[0].group.key, 'hp|deskjet2620');
    assert.equal((await get(endpoint, { model: '301' })).items.find((r) => r.asins.includes(ids[4])).group.kind, 'review', 'a model filter cannot hide conflicting source mappings');
    const exported = buildAsinExport(avg);
    const column = (key) => exported.columns.findIndex((c) => c.key === key);
    const a = exported.rows.find((r) => r[column('asin')] === ids[0]);
    const b = exported.rows.find((r) => r[column('asin')] === ids[1]);
    assert.equal(a[column('recognition')], office.recognition); assert.equal(a[column('asin_clicks')], 20);
    assert.equal(b[column('recognition')], desk.recognition); assert.equal(b[column('asin_clicks')], 20);
    assert.equal(a[column('market_impressions_original')], 2000); assert.equal(b[column('market_impressions_original')], 1000);
    const filtered = buildAsinExport(review);
    assert.ok(filtered.rows.every((r) => ![ids[0], ids[1]].includes(r[column('asin')])));
  }
  // Dedicated mappings retain public report brands; private reports require a brand when an ASIN has several.
  await post('/aba-skus/import', { rows: [resolutionSkus[0], resolutionSkus[1], resolutionSkus[2],
    { ...resolutionSkus[3], model: '301/304' }, { ...resolutionSkus[0], brand: 'CY', sku: 'SOURCE-CY-304', model: '304' }] }, owner);
  seedResolutionReport(server.db, resolutionReports[0], 'CY');
  const ambiguous = await get('/aba/asin', { asin: ids[0] });
  assert.equal(ambiguous.items[0].group.kind, 'review');
  const explicit = await get('/aba/asin', { asin: ids[0], brand: 'ce' });
  assert.equal(explicit.items[0].group.key, 'hp|officejet2620');
  const shared = await get('/aba-public/asin', { export: '1', aggregation: 'average' });
  const desk = shared.items.find((r) => r.group.key === 'hp|deskjet2620');
  assert.deepEqual(new Set(skusForAsinRow(desk, shared).map((s) => s.sku)), new Set(['SOURCE-304', 'SOURCE-CY-304']));
  const office = shared.items.find((r) => r.group.key === 'hp|officejet2620');
  assert.deepEqual(skusForAsinRow(office, shared).map((s) => s.sku), ['SOURCE-301']);
  assert.equal(office.query_rows.length, 1); assert.equal(desk.query_rows.length, 2);
  const book = buildAsinExport(shared), col = (key) => book.columns.findIndex((c) => c.key === key);
  const cy = book.rows.find((r) => r[col('sku')] === 'SOURCE-CY-304');
  assert.equal(cy[col('recognition')], desk.recognition); assert.equal(cy[col('asin_clicks')], 10);
  assert.equal((await get('/aba-public/asin', { alignment: 'multi' })).items[0].asins.includes(ids[0]), false);
});
