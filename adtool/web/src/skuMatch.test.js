import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkuInventoryIndex,
  isOutOfStock,
  isZeroStock,
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
