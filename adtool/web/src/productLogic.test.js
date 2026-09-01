import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataMonthFromFilename, formatDataMonth, headerField, marketplaceFromCell, parseProductRows,
} from './productLogic.js';

test('全市场数据表按国家分流，并直接读取墨盒系列、颜色套组、品牌和美元价格', () => {
  const rows = [
    ['国家', '墨盒系列', '颜色套组', '品牌', 'ASIN', '价格($)', '商品标题'],
    ['DE', 62, '1黑', 'HP', 'B00MWOSVZS', 22.34, 'HP 62 Black'],
    ['西班牙', 62, '1彩', 'CYES', 'B00MWOTQ6Q', '28.14', 'CYES 62 Color'],
  ];
  const parsed = parseProductRows(rows, 'US');

  assert.deepEqual(Object.keys(parsed.productsByMarketplace), ['DE', 'ES']);
  assert.deepEqual(
    {
      model: parsed.productsByMarketplace.DE[0].model,
      color: parsed.productsByMarketplace.DE[0].color_grp,
      brand: parsed.productsByMarketplace.DE[0].brand,
      price: parsed.productsByMarketplace.DE[0].price,
      currency: parsed.productsByMarketplace.DE[0].currency,
    },
    { model: '62', color: '1黑', brand: 'HP', price: 22.34, currency: 'USD' },
  );
});

test('旧版单站点表没有国家列时继续使用当前站点', () => {
  const parsed = parseProductRows([
    ['ASIN', '型号', '色组', '品牌', '价格(€)'],
    ['B012345678', '61XL', '黑彩', 'CYES', 19.99],
  ], 'FR');

  assert.equal(parsed.hasMarketplaceColumn, false);
  assert.equal(parsed.productsByMarketplace.FR[0].currency, 'EUR');
});

test('国家别名和新增表头可识别', () => {
  assert.equal(marketplaceFromCell('澳洲'), 'AU');
  assert.equal(headerField('墨盒系列'), 'model');
  assert.equal(headerField('颜色套组'), 'color_grp');
  assert.equal(headerField('价格($)'), 'price');
});

test('国家列出现未知值时整批拒绝，避免导错市场', () => {
  assert.throws(() => parseProductRows([
    ['国家', 'ASIN'],
    ['未知站', 'B012345678'],
  ], 'DE'), /无法识别/);
});

test('从常见产品表文件名中识别并规范化月份', () => {
  assert.equal(dataMonthFromFilename('全市场产品数据_2026-08.xlsx'), '2026-08');
  assert.equal(dataMonthFromFilename('卖家精灵_202608_干净数据源.xlsx'), '2026-08');
  assert.equal(dataMonthFromFilename('2026年8月份产品表.xlsx'), '2026-08');
  assert.equal(dataMonthFromFilename('8月产品表.xlsx', new Date(2027, 0, 1)), '2027-08');
  assert.equal(dataMonthFromFilename('产品表.xlsx'), '');
  assert.equal(dataMonthFromFilename('202613产品表.xlsx'), '');
  assert.equal(formatDataMonth('2026-08'), '2026年8月');
  assert.equal(formatDataMonth('legacy'), '历史数据');
});
