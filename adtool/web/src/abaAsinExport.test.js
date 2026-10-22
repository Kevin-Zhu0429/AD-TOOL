import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAsinView } from '../../shared/abaAsin.js';
import { buildAsinExport, buildAsinGroupExport, skusForAsinRow } from './abaAsinExport.js';

test('resolved group identities contain only the exact source ASIN and report brands', () => {
  const data = { skuSource: 'aba', skuItems: [
    { id: 1, asin: 'A', brand: 'CE', sku: 'A-301' }, { id: 2, asin: 'A', brand: 'CY', sku: 'A-304' },
    { id: 3, asin: 'B', brand: 'CE', sku: 'B-301' }, { id: 4, asin: 'B', brand: 'CY', sku: 'B-304' },
  ] };
  const office = { asins: ['A', 'B'], source_brand: 'CE', source_brands: [{ asin: 'A', brand: 'CE' }, { asin: 'B', brand: 'CE' }] };
  assert.deepEqual(skusForAsinRow(office, data).map((s) => s.sku), ['A-301', 'B-301']);
  const sameAsin = { asins: ['A'], source_brand: 'CE', source_brands: [{ asin: 'A', brand: 'CE' }, { asin: 'A', brand: 'CY' }] };
  assert.deepEqual(skusForAsinRow(sameAsin, data).map((s) => s.sku), ['A-301', 'A-304']);
  assert.deepEqual(skusForAsinRow({ asins: ['A'] }, data), [], 'private ambiguity still requires an explicit brand');
});

test('query export preserves displayed merged totals once, exact SKU mappings, null metrics and averaging metadata', () => {
  const row = { query: 'hp deskjet 2700', recognition: 'HP DESKJET2700', asins: ['B000000305', 'B000000306'],
    market_impressions: null, market_clicks: 120, market_purchases: 24, market_cvr: 20,
    asin_impressions: 90, asin_clicks: 15, asin_purchases: 3, asin_cvr: 20, brand_share: 12.5,
    average_weeks: 2, periods: [
      { week_start: '2026-09-13', week_end: '2026-09-19', week_number: 38 },
      { week_start: '2026-09-20', week_end: '2026-09-26', week_number: 39 },
    ], market_conflicts: [{ week_end: '2026-09-19', query: 'hp deskjet 2700', label: '市场 IMP',
      values: [{ asin: 'B000000305', value: 1000 }, { asin: 'B000000306', value: 900 }] }],
  };
  const data = { view: 'queries', aggregation: 'average', items: [row], selectedModel: { skuIds: [1, 2] }, skuItems: [
    { id: 1, asin: 'B000000305', sku: 'BK' }, { id: 2, asin: 'B000000306', sku: 'COLOR' },
    { id: 3, asin: 'B000000305', sku: 'OUTSIDE-MODEL' },
  ] };
  const result = buildAsinExport(data);
  const exported = Object.fromEntries(result.columns.map((c, i) => [c.key, result.rows[0][i]]));
  assert.equal(result.sheetName, '搜索查询明细');
  assert.equal(result.rows.length, 1);
  assert.equal(exported.sku, 'BK\nCOLOR');
  assert.equal(exported.asin, 'B000000305\nB000000306');
  assert.equal(exported.links, 'B000000305：BK\nB000000306：COLOR');
  assert.equal(exported.market_impressions, '');
  assert.equal(exported.market_clicks, 120);
  assert.equal(exported.asin_clicks, 15);
  assert.equal(exported.market_cvr, 0.2);
  assert.equal(exported.brand_share, 0.125);
  assert.equal(exported.average_weeks, 2);
  assert.equal(exported.aggregation, '周平均');
  assert.match(exported.periods, /第 38 周.*2026-09-19[\s\S]*第 39 周/);
  assert.match(exported.market_conflicts, /B000000305 = 1000；B000000306 = 900/);
});

test('query export keeps unmerged weeks and sort order, zero-denominator rates and unlinked ASINs', () => {
  const items = [20, 10].map((clicks, i) => ({ query: 'generic ink', recognition: '墨盒 KW 词', asin: 'B000000305',
    market_clicks: clicks, market_cvr: null, asin_clicks: 0, asin_cvr: null,
    periods: [{ week_start: '2026-09-13', week_end: i ? '2026-09-19' : '2026-09-26', week_number: i ? 38 : 39 }],
  }));
  const { columns, rows } = buildAsinExport({ view: 'queries', merged: false, aggregation: 'sum', items, skuItems: [] });
  const field = (key) => columns.findIndex((c) => c.key === key);
  assert.deepEqual(rows.map((r) => r[field('market_clicks')]), [20, 10]);
  assert.ok(rows.every((r) => r[field('query')] === 'generic ink' && r[field('sku')] === ''
    && r[field('asin_cvr')] === '' && r[field('aggregation')] === '逐周'));
  assert.equal(rows[0][field('links')], 'B000000305：未关联 SKU');
  assert.equal(buildAsinExport({ view: 'queries', items: [] }).rows.length, 0);
  assert.equal(buildAsinExport({ view: 'printers', items: [] }).sheetName, '机型分类汇总');
});

test('printer-group export puts each search term, ASIN and SKU mapping on its own row', () => {
  const queryRow = {
    query: 'hp deskjet 2700', asin: 'B000000305',
    market_impressions: 1000, market_clicks: 100, market_purchases: 20, market_cvr: 20,
    asin_impressions: 200, asin_clicks: 10, asin_purchases: 5, asin_cvr: 50, brand_share: 25,
  };
  const row = { recognition: 'HP DESKJET2700', query_count: 2, query_rows: [
    queryRow,
    { ...queryRow, asin: 'B000000306', market_impressions: 900, asin_impressions: 100, asin_clicks: 20, asin_purchases: 2, asin_cvr: 10, brand_share: 10 },
    { ...queryRow, query: 'hp 305 ink', market_impressions: 300, asin_clicks: 4 },
  ] };
  const data = {
    items: [row], selectedModel: null,
    skuItems: [
      { id: 1, asin: 'B000000305', sku: '305-BK' },
      { id: 2, asin: 'B000000305', sku: '305-COLOR' },
      { id: 3, asin: 'B000000306', sku: 'OTHER' },
    ],
  };
  assert.deepEqual(skusForAsinRow(queryRow, data, { skuId: '2' }).map((item) => item.sku), ['305-COLOR']);
  const exported = buildAsinGroupExport(data);
  assert.deepEqual(exported.columns.slice(0, 4).map((column) => column.label), ['SKU', '机型分类', '搜索词', 'ASIN']);
  assert.equal(exported.rows.length, 5);
  assert.deepEqual(exported.rows.slice(0, 3).map((item) => item.slice(0, 4)), [
    ['305-BK', 'HP DESKJET2700', 'hp deskjet 2700', 'B000000305'],
    ['305-COLOR', 'HP DESKJET2700', 'hp deskjet 2700', 'B000000305'],
    ['OTHER', 'HP DESKJET2700', 'hp deskjet 2700', 'B000000306'],
  ]);
  assert.deepEqual(exported.rows[3].slice(0, 4), ['305-BK', 'HP DESKJET2700', 'hp 305 ink', 'B000000305']);
  assert.ok(exported.rows.every((item) => !String(item[0]).includes('\n') && !String(item[3]).includes('\n')));
  assert.equal(exported.rows[0][10], 0.2);
  assert.equal(exported.rows[0][13], 10);
  assert.equal(exported.rows[0][4], 1000 / 3);
  assert.equal(exported.rows[0][6], 100 / 3);
  assert.equal(exported.rows[0][8], 20 / 3);
  assert.equal(exported.rows[2][4], 300);
  assert.equal(exported.rows[3][4], 150);
  assert.equal(exported.rows[4][8], 10);
  assert.equal(exported.rows[2][13], 20);
  assert.equal(exported.rows[0][15], 0.5);
  assert.equal(exported.rows[0][16], 0.25);
});

test('printer-group export keeps unlinked SKU cell empty and respects selected model SKU scope', () => {
  const row = { recognition: '墨盒 KW 词', asins: ['B000000305'], query_count: 1 };
  const data = { items: [row], selectedModel: { skuIds: [2] }, skuItems: [
    { id: 1, asin: 'B000000305', sku: 'OUTSIDE' },
    { id: 2, asin: 'B000000305', sku: 'IN-SCOPE' },
  ] };
  assert.equal(buildAsinGroupExport(data).rows[0][0], 'IN-SCOPE');
  assert.deepEqual(buildAsinGroupExport({ ...data, skuItems: [] }).rows[0].slice(0, 4), ['', '墨盒 KW 词', '', 'B000000305']);
});

test('printer-group export splits market totals across every SKU row of a search term', () => {
  const base = { query: 'hp 305', market_impressions: 900, market_clicks: 90, market_purchases: 9, market_cvr: 10,
    asin_impressions: 30, asin_clicks: 3, asin_purchases: 1, asin_cvr: 33.3, brand_share: 11.1 };
  const data = {
    items: [{ recognition: 'HP 305', query_rows: [{ ...base, asin: 'B000000305' }, { ...base, asin: 'B000000306' }] }],
    selectedModel: null,
    skuItems: [
      { id: 1, asin: 'B000000305', sku: 'A' },
      { id: 2, asin: 'B000000305', sku: 'B' },
      { id: 3, asin: 'B000000306', sku: 'C' },
    ],
  };
  const { rows } = buildAsinGroupExport(data);
  assert.equal(rows.length, 3);
  for (const [column, total] of [[4, 900], [6, 90], [8, 9]]) {
    assert.ok(rows.every((row) => row[column] === total / 3));
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + row[column], 0) - total) < 1e-9);
  }
  assert.ok(rows.every((row) => row[10] === 0.1 && row[12] === 30));
});

test('printer-group export splits each week only across SKUs whose ASIN has that week', () => {
  const row = (asin, week_end, market_impressions) => ({
    asin, query: 'hp deskjet 2700 ink', report_id: `${asin}:${week_end}`, week_start: week_end, week_end, week_number: 1,
    recognition: 'HP DESKJET2700', group: { key: 'hp-2700' }, candidates: [],
    query_volume: 50, market_impressions, market_clicks: market_impressions / 10, market_purchases: market_impressions / 100,
    asin_impressions: 10, asin_clicks: 2, asin_purchases: 1,
  });
  // B0AAA uploaded weeks 38 and 39; B0BBB only uploaded week 39.
  const source = [row('B0AAA00000', '2026-09-19', 1000), row('B0AAA00000', '2026-09-26', 1200), row('B0BBB00000', '2026-09-26', 1200)];
  const skuItems = [{ id: 1, asin: 'B0AAA00000', sku: '305-BK' }, { id: 2, asin: 'B0BBB00000', sku: '305-CL' }];
  for (const series of [false, true]) {
    const sum = buildAsinGroupExport({ items: aggregateAsinView(source, { series, view: 'printers', includeQueries: true }), skuItems, aggregation: 'sum' });
    assert.deepEqual(sum.rows.map((item) => [item[0], item[4], item[6], item[8]]), [['305-BK', 1600, 160, 16], ['305-CL', 600, 60, 6]]);
    const average = buildAsinGroupExport({ items: aggregateAsinView(source, { series, view: 'printers', average: true, includeQueries: true }), skuItems, aggregation: 'average' });
    assert.deepEqual(average.rows.map((item) => [item[0], item[4]]), [['305-BK', 800], ['305-CL', 300]]);
  }
  const website = aggregateAsinView(source, { series: true, view: 'printers' })[0];
  assert.equal(website.market_impressions, 2200);
  assert.equal(aggregateAsinView(source, { series: true, view: 'printers', average: true })[0].market_impressions, 1100);
});

test('original-total columns are interleaved complete query market averages, independent of ASIN/SKU row counts', () => {
  const row = (asin, week_end, clicks, purchases) => ({ asin, report_id: asin + week_end,
    query: 'same query', recognition: 'HP 2700', group: { key: 'hp2700' }, candidates: [],
    week_start: week_end, week_end, week_number: 1, query_volume: 100,
    market_impressions: clicks * 10, market_clicks: clicks, market_purchases: purchases,
    asin_impressions: 10, asin_clicks: 2, asin_purchases: 1 });
  const source = [row('A', '2026-09-19', 100, 10), row('B', '2026-09-19', 100, 10), row('A', '2026-09-26', 200, 40)];
  const skuItems = [{ id: 1, asin: 'A', sku: 'A1' }, { id: 2, asin: 'A', sku: 'A2' }, { id: 3, asin: 'B', sku: 'B1' }];
  for (const average of [true, false]) {
    const result = buildAsinExport({ view: 'printers', aggregation: average ? 'average' : 'sum', skuItems,
      items: aggregateAsinView(source, { view: 'printers', average, includeQueries: true }) });
    const field = (key) => result.columns.findIndex((c) => c.key === key);
    for (const key of ['market_impressions', 'market_clicks', 'market_purchases', 'market_cvr'])
      assert.equal(field(key + '_original'), field(key) + 1);
    assert.deepEqual(result.columns.filter((c) => c.key.endsWith('_original')).map((c) => c.label),
      ['市场IMP(原始总量)', '市场点击TT(原始总量)', '市场购买TT(原始总量)', '市场CVR(原始总量)']);
    assert.equal(result.rows.length, 3);
    for (const cells of result.rows) {
      assert.equal(cells[field('market_impressions_original')], 1500);
      assert.equal(cells[field('market_clicks_original')], 150);
      assert.equal(cells[field('market_purchases_original')], 25);
      assert.ok(Math.abs(cells[field('market_cvr_original')] - 25 / 150) < 1e-12);
    }
    assert.ok(result.rows[0][field('market_impressions')] < 1500, 'legacy allocation stays available');
  }
  source[1].market_purchases = 11;
  const conflict = buildAsinExport({ view: 'printers', skuItems,
    items: aggregateAsinView(source, { view: 'printers', average: true, includeQueries: true }) });
  const field = (key) => conflict.columns.findIndex((c) => c.key === key);
  assert.ok(conflict.rows.every((cells) => cells[field('market_purchases_original')] === '' && cells[field('market_cvr_original')] === ''));
  assert.ok(conflict.rows.every((cells) => cells[field('market_clicks_original')] === 150), 'conflicts do not blank unaffected metrics');
  const zero = buildAsinExport({ view: 'printers', items: [{ recognition: 'other', query_rows: [{ query: 'zero', asin: 'A',
    market_weeks: [{ week_end: '2026-09-19', market_clicks: 0, market_purchases: 0, market_impressions: 0 }] }] }] });
  assert.equal(zero.rows[0][zero.columns.findIndex((c) => c.key === 'market_cvr_original')], '');
});
