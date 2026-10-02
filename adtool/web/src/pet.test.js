import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfile, searchPetSkus } from '../../shared/profile.js';
import { normalizePetProduct, petHeaderMap, parsePetProductSheet } from '../../shared/petProducts.js';

test('pet SKU exact attribute filters preserve L, XL, numeric styles and Chinese names', () => {
  const rows = [{ sku: 'A-L', style: '雨衣301', size: 'L' }, { sku: 'A-XL', style: '雨衣301XL', size: 'XL' }];
  assert.deepEqual(getProfile('pet').markets, ['US']);
  assert.deepEqual(searchPetSkus(rows, '', { size: 'L' }).map((s) => s.sku), ['A-L']);
  assert.deepEqual(searchPetSkus(rows, '雨衣', { style: '雨衣301XL' }).map((s) => s.sku), ['A-XL']);
});
test('pet products retain source values without guessing attributes from titles', () => {
  const p = normalizePetProduct({ asin: 'b000000001', title: 'Dog coat 301XL red', price: '$19.99', stock: 0 });
  assert.equal(p.style, ''); assert.equal(p.size, ''); assert.equal(p.color, ''); assert.equal(p.price, 19.99); assert.equal(p.sales, null);
  assert.throws(() => normalizePetProduct({ asin: p.asin, country: 'DE' }), /美国/);
  assert.throws(() => normalizePetProduct({ asin: p.asin, reviews: 2.5 }), /整数/);
});
test('pet product import maps columns explicitly and rejects duplicate ASINs and wrong markets', () => {
  const sheet = [['ASIN', '款式', '尺码', '价格 USD'], ['B000000001', 'A', 'XL', 12]];
  const map = petHeaderMap(sheet[0]);
  assert.equal(parsePetProductSheet(sheet, map)[0].size, 'XL');
  assert.throws(() => parsePetProductSheet([...sheet, sheet[1]], map), /重复/);
  assert.throws(() => parsePetProductSheet(sheet, { ...map, size: map.style }), /多个字段/);
  const foreign = [['ASIN', '国家'], ['B000000001', 'DE']];
  assert.throws(() => parsePetProductSheet(foreign, petHeaderMap(foreign[0])), /美国/);
});
test('pet cost sheet maps the uploaded CSV headers and keeps absent columns out', async () => {
  const { mapCostSheet, groupSpans, formatCell, PROFIT_COLS } = await import('./petProfit.js');
  const csv = mapCostSheet([['sku', 'fob_usd', 'first_leg_usd', 'duty_usd'], ['RR22002GRAS', 7.38, 0.99, 0.35], ['', '', '', '']]);
  assert.deepEqual(csv.rows, [{ sku: 'RR22002GRAS', fob: '7.38', firstLeg: '0.99', duty: '0.35' }]);
  const partial = mapCostSheet([['卖家SKU', '关税'], ['A', '1']]);
  assert.deepEqual(partial.rows, [{ sku: 'A', duty: '1' }]);
  assert.match(mapCostSheet([['款式', 'FOB']]).error, /SKU 列/);
  assert.deepEqual(groupSpans(PROFIT_COLS).map((group) => `${group.label}${group.span}`), ['商品5', '成本4', '亚马逊费用2', '毛利4']);
  assert.equal(formatCell({ money: true }, -8.01), '−$8.01');
  assert.equal(formatCell({ pct: true }, null), '—');
});
