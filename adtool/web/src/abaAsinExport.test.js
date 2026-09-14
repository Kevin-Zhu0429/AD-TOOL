import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAsinGroupExport, skusForAsinRow } from './abaAsinExport.js';

test('printer-group export puts one search term on each row with its own metrics', () => {
  const queryRow = {
    query: 'hp deskjet 2700', asins: ['B000000305'],
    market_impressions: 1000, market_clicks: 100, market_purchases: 20, market_cvr: 20,
    asin_impressions: 200, asin_clicks: 10, asin_purchases: 5, asin_cvr: 50, brand_share: 25,
  };
  const row = { recognition: 'HP DESKJET2700', query_count: 2, query_rows: [
    queryRow,
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
  assert.equal(exported.rows.length, 2);
  assert.deepEqual(exported.rows[0].slice(0, 4), ['305-BK\n305-COLOR', 'HP DESKJET2700', 'hp deskjet 2700', 'B000000305']);
  assert.deepEqual(exported.rows[1].slice(1, 4), ['HP DESKJET2700', 'hp 305 ink', 'B000000305']);
  assert.equal(exported.rows[0][7], 0.2);
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
  assert.equal(buildAsinGroupExport({ ...data, skuItems: [] }).rows[0][0], '');
});
