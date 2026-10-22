import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';
import { coreA, coreB, coreFiles, coreSkus, seedPublicCoreReports } from './abaCoreFixture.js';
import { buildAsinExport } from '../../web/src/abaAsinExport.js';

test('private/public core summaries merge language variants, keep generic terms, exclude four digit printers and export complete market averages', async (t) => {
  const server = await startAbaTestServer(); t.after(() => server.close());
  const login = await fetch(server.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'aba-test', password: 'local-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (route, body) => {
    const response = await fetch(server.url + '/api' + route, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  await post('/aba/asin/import', { marketplace: 'ES', files: coreFiles });
  await post('/sku/rows', { rows: coreSkus }); seedPublicCoreReports(server.db);
  for (const endpoint of ['/aba/asin', '/aba-public/asin']) {
    const get = async (query) => {
      const response = await fetch(server.url + '/api' + endpoint + '?' + new URLSearchParams({ marketplace: 'ES', year: '',
        weeks: '2026-09-19,2026-09-26', ...query }), { headers: { cookie } });
      assert.equal(response.status, 200); return response.json();
    };
    const result = await get({ view: 'cores', aggregation: 'average', export: '1' });
    assert.equal(result.view, 'cores'); assert.equal(result.total, 6);
    const hp = result.items.find((r) => r.recognition === 'HP 305');
    assert.equal(hp.query_count, 5); assert.equal(hp.market_impressions, 1980); assert.equal(hp.asin_clicks, 11);
    assert.deepEqual(hp.asins, [coreA, coreB]);
    assert.equal(result.items.find((r) => r.recognition === '超大词').query_count, 4);
    assert.ok(result.items.some((r) => r.recognition === '未识别核心词'));
    assert.ok(result.items.some((r) => r.recognition === 'CANON 545'));
    assert.ok(result.items.some((r) => r.recognition === 'CANON 541'));
    assert.ok(result.items.some((r) => r.recognition === '301'));
    const nested = await get({ view: 'queries', group: hp.group.key, aggregation: 'average' });
    assert.equal(nested.total, 5); assert.ok(nested.coreClassified);
    for (const word of ['hp 305', '305xl', 'cartucce 305']) assert.ok(nested.items.some((r) => r.query === word && r.recognition === 'HP 305'), word);
    assert.deepEqual(nested.items.find((r) => r.query === 'cartouche hp 305').asins, [coreA, coreB]);
    const exported = buildAsinExport(result);
    assert.equal(exported.sheetName, '核心词分类汇总');
    assert.equal(exported.columns[1].label, '核心词分类');
    const field = (key) => exported.columns.findIndex((c) => c.key === key);
    const wordRows = exported.rows.filter((r) => r[field('query')] === 'cartouche hp 305');
    assert.equal(wordRows.length, 2);
    assert.ok(wordRows.every((r) => r[field('market_impressions_original')] === 1500));
    assert.ok(wordRows.every((r) => Math.abs(r[field('market_cvr_original')] - 0.1) < 1e-9));
    assert.doesNotMatch(JSON.stringify(exported.rows), /9999|deskjet 2700/);
    for (const word of ['hp 305', '305xl', 'cartucce 305']) {
      const row = exported.rows.find((r) => r[field('query')] === word);
      assert.equal(row[field('recognition')], 'HP 305', word);
    }
    assert.doesNotMatch(JSON.stringify(exported.rows), /墨盒泛词/);
    const selected = await get({ view: 'cores', asin: coreB, aggregation: 'average' });
    assert.equal(selected.total, 1); assert.deepEqual(selected.items[0].asins, [coreB]);
    const printers = await get({ view: 'queries', wordType: 'printer', aggregation: 'sum', merge: '0' });
    assert.ok(printers.items.some((r) => r.query === 'hp ink 9999' && r.group.kind === 'review'));
    const unknown = await get({ view: 'queries', wordType: 'printer', q: '9999' });
    assert.equal(unknown.items[0].query, 'hp ink 9999');
  }
});
