import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADERS } from './adEngine.js';
import { changeSheetRows, termChanges, wordDiff } from './changeExport.js';

const cell = (row, header) => row[HEADERS.indexOf(header)];

test('confirmed ad changes become bulk-sheet rows with IDs kept as text', () => {
  const ids = { campaignId: '123456789012345678', adGroupId: '222' };
  const [head, pause, bid, defaultBid, budget, negative, campaignNegative, asin] = changeSheetRows([
    { group: 'ad', kind: 'ad_state', target: { ...ids, entity: 'keyword', entityId: '333' }, after: { state: 'paused' } },
    { group: 'ad', kind: 'ad_bid', target: { ...ids, entity: 'productTarget', entityId: '444' }, after: { bid: 0.45 } },
    { group: 'ad', kind: 'ad_bid', target: { ...ids, entity: 'adGroup', entityId: '222' }, after: { bid: 0.6 } },
    { group: 'ad', kind: 'ad_budget', target: { ...ids, entity: 'campaign', entityId: ids.campaignId, adGroupId: null }, after: { budget: 25 } },
    { group: 'ad', kind: 'ad_negative', target: { ...ids, level: 'adGroup' }, after: { matchType: 'exact', text: 'cat tree' } },
    { group: 'ad', kind: 'ad_negative', target: { ...ids, level: 'campaign', adGroupId: null }, after: { matchType: 'phrase', text: 'toy' } },
    { group: 'ad', kind: 'ad_negative', target: { ...ids, level: 'adGroup' }, after: { matchType: 'asin', text: 'B0ABCDEFGH' } },
    { group: 'listing', kind: 'listing_title', target: { sku: 'X' }, after: 'ignored' },
  ]);
  assert.deepEqual(head, HEADERS);
  assert.deepEqual([cell(pause, '实体层级'), cell(pause, '操作'), cell(pause, '广告活动编号'), cell(pause, '广告组编号'), cell(pause, '关键词编号'), cell(pause, '状态')],
    ['关键词', '更新', '123456789012345678', '222', '333', '已暂停']);
  assert.deepEqual([cell(bid, '实体层级'), cell(bid, '商品投放 ID'), cell(bid, '竞价')], ['商品定向', '444', 0.45]);
  assert.deepEqual([cell(defaultBid, '实体层级'), cell(defaultBid, '广告组默认竞价'), cell(defaultBid, '竞价')], ['广告组', 0.6, '']);
  assert.deepEqual([cell(budget, '实体层级'), cell(budget, '广告组编号'), cell(budget, '每日预算')], ['广告活动', '', 25]);
  assert.deepEqual([cell(negative, '实体层级'), cell(negative, '操作'), cell(negative, '关键词文本'), cell(negative, '匹配类型')], ['否定关键词', '创建', 'cat tree', '否定精准匹配']);
  assert.deepEqual([cell(campaignNegative, '实体层级'), cell(campaignNegative, '广告组编号'), cell(campaignNegative, '匹配类型')], ['广告活动否定关键词', '', '否定词组']);
  assert.deepEqual([cell(asin, '实体层级'), cell(asin, '拓展商品投放编号')], ['否定商品定向', 'asin="B0ABCDEFGH"']);
});

test('word diff marks added and removed words; term changes ignore order and case', () => {
  assert.deepEqual(wordDiff('PawNest Dog Bed Small', 'PawNest Calming Dog Bed Small Cat Bed').filter((part) => part.type !== 'same').map((part) => [part.type, part.text]),
    [['add', 'Calming'], ['add', 'Cat'], ['add', 'Bed']]);
  assert.deepEqual(wordDiff('Old Dog Bed', 'New Dog Bed').map((part) => part.type), ['add', 'del', 'same', 'same']);
  assert.deepEqual(termChanges('dog bed Calming', 'calming cat bed'), { added: ['cat'], removed: ['dog'] });
});
