import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildSbPlan, buildSbWorkbookData, parseSbAssets, resolveAsins, S, SB_HEADERS } from './sbEngine.js';

const base = (patch = {}) => ({
  camp: 'SBC-CPC-302-Series', portfolio: '234683778414094', date: '20261016', budget: 2,
  format: 'collManual', brandEntity: 'ENTITY3GOUUEW2BL7Y7', brandName: 'COLORETTO',
  logoId: 'amzn1.assetlibrary.asset1.logo:version_v1', logoCrop: '', videoId: '',
  skus: 'B09R9GQQXH\nB0BNQ6VTJT\nB0CLGCST7R', autoBid: false,
  places: { TOS: '', ROS: '', HOME: '', PP: '' }, wf: { on: false, place: 'TOS', tiers: '' },
  bidMode: 'bid', baseBid: 0.5, rounding: 'round', mode: 'kw', kwTriple: false, kwShared: '',
  kw: { 精准: { on: true, bid: '', text: 'cartucce hp 302' }, 词组: { on: false, bid: '', text: '' }, 广泛: { on: false, bid: '', text: '' } },
  tgt: { asin: { on: true, bid: '', text: '' }, category: { on: false, bid: '', text: '' } },
  ...patch,
});
const negs = { negs: [
  { entity: '广告活动否定关键词', match: '否定词组', text: 'epson' },
  { entity: '否定关键词', match: '否定词组', text: 'Epson' },
  { entity: '否定关键词', match: '否定精准匹配', text: 'canon' },
], asins: [], problems: [] };

test('手动商品集:一条活动,四个广告位,否定全写到广告组,活动级和组级重复的只留一份', () => {
  const plan = buildSbPlan(base(), negs, { market: 'IT' });
  assert.equal(plan.ok, true, plan.problems.join(';'));
  const wb = buildSbWorkbookData([{ plan }]);
  assert.deepEqual(wb.bad, []);
  const rows = wb.aoa.slice(1);
  assert.deepEqual(rows.map((r) => r[S.ENTITY]), [
    '广告活动', '按广告位调整竞价', '按广告位调整竞价', '按广告位调整竞价', '按广告位调整竞价',
    '广告组', '手动合集广告', '关键词', '否定关键词', '否定关键词',
  ]);
  assert.equal(wb.aoa[0].length, SB_HEADERS.length);
  const ad = rows[6];
  assert.equal(ad[S.ASINS], 'B09R9GQQXH, B0BNQ6VTJT, B0CLGCST7R');
  assert.equal(ad[S.LANDTYPE], '商品列表');
  assert.equal(rows[0][S.ENTITYID], 'ENTITY3GOUUEW2BL7Y7');
  assert.equal(rows[0][S.AUTOBID], 'false');
  assert.equal(rows[7][S.KWTEXT], '[cartucce hp 302]');
  assert.equal(rows[7][S.BID], 0.5);
});

test('瀑布流:一个档位一条活动,CPC 模式按溢价反推出价,命名带 Tos 档位', () => {
  const plan = buildSbPlan(base({ wf: { on: true, place: 'TOS', tiers: '20,100' }, bidMode: 'cpc', baseBid: 0.6 }), negs, { market: 'IT' });
  assert.equal(plan.ok, true, plan.problems.join(';'));
  assert.deepEqual(plan.campaigns.map((c) => [c.name, c.places.TOS, c.bids['精准']]), [
    ['SBC-CPC-302-Series-Tos20', 20, 0.5],
    ['SBC-CPC-302-Series-Tos100', 100, 0.3],
  ]);
  const wb = buildSbWorkbookData([{ plan }]);
  assert.deepEqual(wb.bad, []);
  const tos = wb.aoa.filter((r) => r[S.PLACEMENT] === '搜索结果首页首位').map((r) => r[S.PCT]);
  assert.deepEqual(tos, [20, 100]);
});

test('视频广告:1 个 ASIN,落地页拼成本站详情页;自动竞价不写广告位行', () => {
  const plan = buildSbPlan(base({ format: 'video', skus: 'SKU-A', videoId: 'vid1', autoBid: true, mode: 'tgt',
    tgt: { asin: { on: true, bid: '0.4', text: 'b0glph26c6' }, category: { on: false, bid: '', text: '' } } }),
  negs, { market: 'IT', skuItems: [{ sku: 'SKU-A', asin: 'B0CLGCST7R' }] });
  assert.equal(plan.ok, true, plan.problems.join(';'));
  const wb = buildSbWorkbookData([{ plan }]);
  assert.deepEqual(wb.bad, []);
  const ad = wb.aoa.find((r) => r[S.ENTITY] === '视频广告');
  assert.equal(ad[S.LANDURL], 'https://www.amazon.it/dp/B0CLGCST7R');
  assert.equal(ad[S.VIDEO], 'vid1');
  assert.equal(wb.aoa.filter((r) => r[S.ENTITY] === '按广告位调整竞价').length, 0);
  assert.equal(wb.aoa.find((r) => r[S.ENTITY] === '商品定向')[S.TARGET], 'asin="B0GLPH26C6"');
});

test('拦截:手动商品集 ASIN 不够、没选徽标、SKU 库里找不到', () => {
  const plan = buildSbPlan(base({ skus: 'B09R9GQQXH\nSKU-X', logoId: '' }), negs, { market: 'IT', skuItems: [] });
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some((p) => p.includes('3–10')));
  assert.ok(plan.problems.some((p) => p.includes('徽标')));
  assert.ok(plan.problems.some((p) => p.includes('SKU-X')));
});

test('resolveAsins:SKU 走库,ASIN 直接认,去重', () => {
  assert.deepEqual(resolveAsins('a1\nB0CLGCST7R\nb0clgcst7r', [{ sku: 'A1', asin: 'B09R9GQQXH' }]),
    { asins: ['B09R9GQQXH', 'B0CLGCST7R'], missing: [] });
});

test('从后台 SB 批量表读品牌、徽标、视频,徽标裁剪从已有广告抄', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['品牌实体编号', '品牌名称'], ['ENTITY3GOUUEW2BL7Y7', 'COLORETTO'], [],
    ['素材类型', '品牌实体编号', '素材编号', '素材名称', '素材 URL'],
    ['品牌徽标', null, 'logo1', 'logo.png', 'https://x/logo.png'],
    ['视频', null, 'vid1', 'v.mp4', 'https://x/v.mp4'],
    ['其他图片', null, 'img1', 'a.jpg', 'https://x/a.jpg'],
  ]), '品牌资产数据（只读）');
  const h = SB_HEADERS;
  const row = new Array(h.length).fill(null);
  row[h.indexOf('品牌徽标素材编号')] = 'logo1';
  row[h.indexOf('品牌徽标裁剪')] = '{"left":"0","top":"0","width":"600","height":"600"}';
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([h, row]), '品牌推广多个广告组广告活动');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const out = parseSbAssets(buf);
  assert.deepEqual(out.brands, [{ entityId: 'ENTITY3GOUUEW2BL7Y7', name: 'COLORETTO' }]);
  assert.equal(out.logos.length, 1);
  assert.equal(out.logos[0].crop, '{"left":"0","top":"0","width":"600","height":"600"}');
  assert.deepEqual(out.videos.map((v) => v.assetId), ['vid1']);
});
