import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAsinView } from '../../shared/abaAsin.js';
import { buildAsinGroupExport, skusForAsinRow } from './abaAsinExport.js';

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
  assert.equal(exported.rows[0][7], 0.2);
  assert.equal(exported.rows[0][9], 10);
  assert.equal(exported.rows[0][4], 1000 / 3);
  assert.equal(exported.rows[0][5], 100 / 3);
  assert.equal(exported.rows[0][6], 20 / 3);
  assert.equal(exported.rows[2][4], 300);
  assert.equal(exported.rows[3][4], 150);
  assert.equal(exported.rows[4][6], 10);
  assert.equal(exported.rows[2][9], 20);
  assert.equal(exported.rows[0][11], 0.5);
  assert.equal(exported.rows[0][12], 0.25);
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
  for (const [column, total] of [[4, 900], [5, 90], [6, 9]]) {
    assert.ok(rows.every((row) => row[column] === total / 3));
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + row[column], 0) - total) < 1e-9);
  }
  assert.ok(rows.every((row) => row[7] === 0.1 && row[8] === 30));
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
    assert.deepEqual(sum.rows.map((item) => [item[0], item[4], item[5], item[6]]), [['305-BK', 1600, 160, 16], ['305-CL', 600, 60, 6]]);
    const average = buildAsinGroupExport({ items: aggregateAsinView(source, { series, view: 'printers', average: true, includeQueries: true }), skuItems, aggregation: 'average' });
    assert.deepEqual(average.rows.map((item) => [item[0], item[4]]), [['305-BK', 800], ['305-CL', 300]]);
  }
  const website = aggregateAsinView(source, { series: true, view: 'printers' })[0];
  assert.equal(website.market_impressions, 2200);
  assert.equal(aggregateAsinView(source, { series: true, view: 'printers', average: true })[0].market_impressions, 1100);
});
