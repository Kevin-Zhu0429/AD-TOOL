import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseBulkWorkbookFile } from './largeWorkbook.js';

function fixture() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['产品', '实体层级', '操作', '广告组合编号', '广告组合名称', '预算金额', '预算的货币代码'],
    ['广告组合', '广告组合', null, '88', '组合 & 一', null, 'USD'],
  ]), '广告组合');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['产品', '实体层级', '操作', '广告活动编号', '广告组编号', '广告活动名称', '广告组名称', '状态', '每日预算', '展示量', '点击量', '花费', '销量', '订单数量', '商品数量'],
    ['商品推广', '广告活动', null, '123', null, '测试 <活动>', null, '已启用', 10, 100, 4, 2, 20, 1, 1],
    ['商品推广', '广告组', null, '123', '456', null, '测试组', '已启用', null, 100, 4, 2, 20, 1, 1],
  ]), '商品推广活动');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['产品', '广告活动编号', '广告组编号', '关键词编号', '顾客搜索词', '展示量', '点击量', '花费', '销量', '订单数量', '商品数量'],
    ['商品推广', '123', '456', '789', 'dog bed & mat', 10, 2, 1.2, 8, 1, 1],
  ]), '商品推广搜索词报告');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return new File([bytes], '批量表.xlsx');
}

test('大文件路径逐行解析批量表、搜索词和币种', async () => {
  const stages = new Set();
  const result = await parseBulkWorkbookFile(fixture(), {
    streamThresholdBytes: 1,
    onProgress: (progress) => stages.add(progress.stage),
  });

  assert.equal(result.streamed, true);
  assert.equal(result.raw, null);
  assert.equal(result.model.currency, 'USD');
  assert.equal(result.model.rows.length, 2);
  assert.equal(result.model.campaigns.length, 1);
  assert.equal(result.model.campaigns[0].name, '测试 <活动>');
  assert.equal(result.model.campaigns[0].adGroups[0].name, '测试组');
  assert.equal(result.model.searchTerms.length, 1);
  assert.equal(result.model.searchTerms[0].term, 'dog bed & mat');
  assert.equal(result.model.searchTerms[0].m.cvr, 0.5);
  assert.ok(stages.has('正在解析商品推广活动'));
  assert.ok(stages.has('正在解析搜索词报告'));
});

test('普通文件继续使用原解析路径', async () => {
  const result = await parseBulkWorkbookFile(fixture(), { streamThresholdBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(result.streamed, false);
  assert.ok(result.raw instanceof Uint8Array);
  assert.equal(result.model.campaigns[0].name, '测试 <活动>');
});

test('大文件读取可以取消', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    parseBulkWorkbookFile(fixture(), { streamThresholdBytes: 1, signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});
