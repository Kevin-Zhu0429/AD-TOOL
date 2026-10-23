import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { repairSheetRefs, retainExportSheets } from './optCore.js';

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

test('工作表 dimension 写错时按实际单元格重算范围', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['产品', '实体层级', '操作'], ['商品推广', '广告活动', ''], ['商品推广', '广告组', '', 'x']]);
  ws['!ref'] = 'A1:C1'; // 后台导出的表只写了表头那一行
  XLSX.utils.book_append_sheet(wb, ws, '商品推广活动');

  repairSheetRefs(wb, XLSX);

  assert.equal(ws['!ref'], 'A1:D3');
  assert.equal(XLSX.utils.sheet_to_json(ws, { header: 1 }).length, 3);
});
