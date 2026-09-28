import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkuInventoryIndex,
  isNewlyOutOfStock,
  isOutOfStock,
  isRestocked,
  isZeroStock,
  stockEventDate,
  summarizeSkuInventory,
} from './skuMatch.js';

test('只把库存接口明确返回的 0 判定为在库为 0', () => {
  assert.equal(isZeroStock({ stock: 0 }), true);
  assert.equal(isZeroStock({ stock: '0' }), true);
  assert.equal(isZeroStock({ stock: null }), false);
  assert.equal(isZeroStock({ stock: '' }), false);
  assert.equal(isZeroStock({ stock: 8 }), false);
});

test('在库为 0 时即使有在途也会提醒，但不标记为完全断货', () => {
  assert.equal(isZeroStock({ stock: 0, transit: 20 }), true);
  assert.equal(isOutOfStock({ stock: 0, transit: 20 }), false);
  assert.equal(isOutOfStock({ stock: 0, transit: 0 }), true);
});

test('广告 SKU 与库存按忽略大小写和首尾空格的口径联动', () => {
  const index = buildSkuInventoryIndex([
    { sku: ' CY-ES-301-BK ', stock: 0, transit: 12 },
    { sku: 'CY-ES-301-C', stock: 9, transit: 0 },
    { sku: 'CY-ES-301-M', stock: null, transit: null },
  ]);
  const result = summarizeSkuInventory(index, [
    'cy-es-301-bk',
    'CY-ES-301-C',
    'CY-ES-301-M',
    'CY-ES-NOT-IN-LIB',
  ]);

  assert.equal(result.totalCount, 4);
  assert.equal(result.matchedCount, 3);
  assert.equal(result.zeroStockCount, 1);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.stock, 9);
  assert.equal(result.transit, 12);
});

test('船长同步带来的新断货 / 补货会汇总到广告矩阵项', () => {
  const out = { sku: 'A', stock: 0, transit: 0, stockEvent: { kind: 'out', at: '2026-09-28 10:15:00' } };
  const back = { sku: 'B', stock: 30, transit: 0, stockEvent: { kind: 'restock', at: '2026-09-27 09:00:00' } };
  const plain = { sku: 'C', stock: 0, transit: 5 };
  assert.equal(isNewlyOutOfStock(out), true);
  assert.equal(isRestocked(out), false);
  assert.equal(isRestocked(back), true);
  assert.equal(isNewlyOutOfStock(plain), false);
  assert.equal(stockEventDate(out), '09-28');

  const result = summarizeSkuInventory(buildSkuInventoryIndex([out, back, plain]), ['A', 'B', 'C']);
  assert.equal(result.zeroStockCount, 2);
  assert.equal(result.newOutCount, 1);
  assert.equal(result.restockedCount, 1);
});
