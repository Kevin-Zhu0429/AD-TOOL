import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { AGE_BUCKETS, calculateInventory, calculateSkuFee, exportRow, MARKET_RATES, OUTPUT_COLUMNS, resultForRow, sortAgedFeeRows } from '../../shared/agedStorageFee.js';

const inventoryRow = (sku, sales7, sales14) => ({
  市场代码: 'CY_AE', SKU: sku, '7日均销量': sales7, '14日均销量': sales14,
  ...Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, bucket === '>456' ? 100 : 0])),
});

test('图片中的六个市场费率包含 AE', () => {
  assert.deepEqual(MARKET_RATES.AE, [0, 0.05, 0.18, 0.18]);
  assert.deepEqual(MARKET_RATES.US, [0.01, 0.12, 0.30, 0.35]);
});

test('7 天为零时退到 14 天，两者为零时固定 0.14', () => {
  const rows = calculateInventory([
    inventoryRow('seven', 2, 5), inventoryRow('fourteen', 0, 1), inventoryRow('fixed', 0, 0),
  ], '2026-09-01');
  assert.deepEqual(rows.map(({ dailySales, salesSource }) => [dailySales, salesSource]), [
    [2, '7天'], [1, '14天'], [0.14, '近14天无日销修正'],
  ]);
  assert.match(exportRow(resultForRow(rows[2]))[7], /0\.14（近14天无日销修正）/);
});

test('费用和日销排序使用修正后数值，空值排在末尾', () => {
  const rows = [
    { id: 1, fee: { average: 2, total: 20 }, finalSales: 1 },
    { id: 2, fee: { average: 1, total: 30 }, finalSales: 3 },
    { id: 3, fee: { average: null, total: null }, finalSales: null },
  ];
  assert.deepEqual(sortAgedFeeRows(rows, 'average').map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(sortAgedFeeRows(rows, 'total').map((row) => row.id), [2, 1, 3]);
  assert.deepEqual(sortAgedFeeRows(rows, 'sales', 'asc').map((row) => row.id), [1, 2, 3]);
});

test('14 天数据缺失且 7 天为零时拒绝整表', () => {
  const row = inventoryRow('missing', 0, 0);
  delete row['14日均销量'];
  assert.throws(() => calculateInventory([row], '2026-09-01'), /缺少14天日销列/);
});

test('每月 15 日按 FIFO 剩余库存收费，修正日销实时改变费用与可售月', () => {
  const base = calculateInventory([inventoryRow('sku', 1, 2)], '2026-09-01')[0];
  assert.equal(base.fee.total, 30.06);
  assert.equal(base.fee.average, 0.3006);
  const unchanged = resultForRow(base, { special: false, value: '2' });
  assert.equal(unchanged.finalSales, 1);
  assert.equal(unchanged.fee.total, 30.06);
  const revised = resultForRow(base, { special: true, value: '2', reason: '活动销量增加' });
  assert.equal(revised.finalSales, 2);
  assert.equal(revised.fee.total, 15.12);
  assert.equal(revised.fee.months, 100 / 2 / 30);
  assert.equal(exportRow(revised)[9], 2);
  assert.equal(exportRow(revised)[11], 2);
  assert.equal(resultForRow(base, { special: true, value: '' }).valid, false);
});

test('缺少可售周期的异常修正不会中断整张表', () => {
  const base = calculateInventory([inventoryRow('sku', 1, 1)], '2026-09-01')[0];
  assert.equal(resultForRow(base, { special: true, value: '0.00001' }).valid, false);
  assert.deepEqual(calculateSkuFee(Array(8).fill(0), 1, '2026-09-01', 'AE'), { average: 0, total: 0, months: 0 });
});

test('导出行保留要求的列顺序、日销来源和可读的 Excel 数值', () => {
  const base = calculateInventory([inventoryRow('sku', 0, 2)], '2026-09-01')[0];
  const changed = resultForRow(base, { special: true, value: '4', reason: '补货前促销' });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([OUTPUT_COLUMNS, exportRow(changed)]), '计算结果');
  const reopened = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const [header, values] = XLSX.utils.sheet_to_json(reopened.Sheets['计算结果'], { header: 1 });
  assert.equal(header[11], '最终计算日销');
  assert.equal(values[7], '2（14天）');
  assert.equal(values[8], '是');
  assert.equal(values[9], 4);
  assert.equal(values[10], '补货前促销');
  assert.equal(values[11], 4);
  assert.equal(typeof values[5], 'number');
  assert.equal(typeof values[6], 'number');
});
