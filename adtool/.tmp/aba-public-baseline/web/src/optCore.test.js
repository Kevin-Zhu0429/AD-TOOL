import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { retainExportSheets } from './optCore.js';

test('导出工作簿只保留广告组合和商品推广活动', () => {
  const wb = XLSX.utils.book_new();
  for (const name of ['广告组合', '商品推广活动', '品牌推广活动', '商品推广搜索词报告']) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[name]]), name);
  }

  const dropped = retainExportSheets(wb, '商品推广活动');

  assert.deepEqual(wb.SheetNames, ['广告组合', '商品推广活动']);
  assert.deepEqual(dropped, ['品牌推广活动', '商品推广搜索词报告']);
  assert.equal(wb.Sheets['品牌推广活动'], undefined);
});

test('英文批量表保留 Portfolios 和 Sponsored Products Campaigns', () => {
  const wb = XLSX.utils.book_new();
  for (const name of ['Portfolios', 'Sponsored Products Campaigns', 'Sponsored Brands Campaigns']) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[name]]), name);
  }

  retainExportSheets(wb, 'Sponsored Products Campaigns');
  assert.deepEqual(wb.SheetNames, ['Portfolios', 'Sponsored Products Campaigns']);
});
