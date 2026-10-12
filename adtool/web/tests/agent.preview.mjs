// AI 日报、改动日志示例数据截图(不是自动化测试):node web/tests/agent.preview.mjs <输出目录>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startPetTestServer } from '../../server/tests/petHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.PET_TODAY = '2026-10-12';
process.env.TZ = 'UTC';
const backend = await startPetTestServer();
const { db } = backend;
const agent = await import('../../server/src/petAgent.js');
const TODAY = '2026-10-12';
const shift = (days) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const at = (day, time = '18:00:00') => `${day} ${time}`;

// SKU:款式、尺码、颜色、售价、日销(补货/改动前, 后)、改动或补货那天(示例数据)
const skus = [
  ['RR22002BKS', '方窝牛津', 'S', 'Black', 32.99, [0, 6], '2026-10-03'], ['RR22002BKM', '方窝牛津', 'M', 'Black', 36.99, [0, 5], '2026-10-03'],
  ['RR22002BKL', '方窝牛津', 'L', 'Black', 42.99, [3, 2.6], '2026-09-28'], ['CM22001GRY36', '牛津防水垫子', '36 inch', 'Grey', 29.99, [4.3, 2.8], '2026-10-01'],
  ['CM22001GRY42', '牛津防水垫子', '42 inch', 'Grey', 34.99, [2.1, 2.9], '2026-09-18'], ['BM25001AG24', '帆布平垫', '24 inch', 'Army Green', 24.99, [3, 3], null],
  ['BM25001AG30', '帆布平垫', '30 inch', 'Army Green', 29.99, [4, 4.1], '2026-09-20'], ['RR26001BRM', '灯芯绒方窝', 'M', 'Brown', 24.99, [0.6, 1.4], '2026-09-24'],
];
const insertSku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, stock, transit, dedupe) VALUES (-1, 'US', ?, ?, ?, ?, ?, 80, 0, ?)");
const insertSale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
const insertTraffic = db.prepare('INSERT INTO pet_traffic_daily (day, asin, sessions, page_views, units, order_items, sales, buy_box_pct) VALUES (?, ?, ?, ?, ?, ?, ?, 98)');
const asinOf = new Map();
let seed = 7;
const noise = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
skus.forEach(([sku, style, size, color, price, [before, after], pivot], index) => {
  const asin = `B0PET0000${index}`;
  asinOf.set(sku, asin);
  insertSku.run(sku, asin, style, size, color, `us|${sku.toLowerCase()}`);
  for (let back = 1; back <= 50; back += 1) {
    const day = shift(back);
    const rate = pivot && day > pivot ? after : before;
    // 10/11 全店比前几天好一点
    const units = Math.max(0, Math.round(rate * (0.6 + noise() * 0.8) * (day === '2026-10-11' ? 1.25 : 1)));
    if (units) insertSale.run(day, sku, asin, units, units, Number((units * price).toFixed(2)));
    if (day <= '2026-10-10') {
      const conv = sku === 'CM22001GRY36' && day > '2026-10-01' ? 0.062 : sku === 'RR22002BKM' ? 0.068 : 0.085;
      const sessions = Math.round((rate || 1) / conv * (0.85 + noise() * 0.3));
      insertTraffic.run(day, asin, sessions, Math.round(sessions * 1.4), Math.round(sessions * conv), Math.round(sessions * conv), Number((sessions * conv * price).toFixed(2)));
    }
  }
});
const insertDay = db.prepare("INSERT INTO pet_traffic_days (day, asins, fetched_at) VALUES (?, 8, '2026-10-12 01:00:00')");
for (let back = 2; back <= 50; back += 1) insertDay.run(shift(back));
db.prepare("INSERT INTO pet_price_sync_state (key, value) VALUES ('sales_coverage', ?)").run(JSON.stringify({ from: shift(50), to: shift(1) }));

// 改动:每条 [编号, 类型, SKU 或广告, 前, 后, 原因, 状态, 提议日, 确认日, 执行日, 生效日, 来源]
const target = (sku) => { const row = skus.find((item) => item[0] === sku); return { sku, asin: asinOf.get(sku), style: row[1], size: row[2], color: row[3] }; };
const ad = (extra) => ({ campaignId: '284019557310', campaignName: 'SP-方窝牛津-精准', adGroupId: '119038827461', adGroupName: '防水词', ...extra });
const changes = [
  [101, 'listing_title', target('CM22001GRY42'), 'MIGUELPET Waterproof Dog Crate Pad, Durable Oxford Kennel Mat',
    'MIGUELPET Waterproof Dog Crate Pad 42 Inch for Large Dogs, Fits 42" Wire Crates, Durable 600D Oxford Kennel Mat, Wipe Clean, Grey',
    'ABA:"42 inch crate pad" 搜索量 1.9 万/周，我们点击份额 0.3%；标题前 80 字符没有尺寸', 'applied', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-18'],
  [102, 'listing_search_terms', target('BM25001AG30'), 'carhartt dog bed canvas durable outdoor', 'canvas dog bed durable outdoor waterproof bottom chew resistant cover elevated mat',
    '后台词含竞品品牌 carhartt，有被下架风险；补上 ABA 里转化好的 outdoor / waterproof bottom', 'applied', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-20'],
  [103, 'listing_sale_price', { ...target('RR26001BRM'), listPrice: 29.99 }, null, { price: 19.99, start: '2026-09-24', end: '2026-10-31' },
    '灯芯绒 M 积压 82 件，近 30 天日均 0.6 件，可售 130 天；促销价 $19.99 仍高于保本价 $17.40', 'applied', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-24'],
  [104, 'listing_bullets', target('RR22002BKL'), ['Durable oxford fabric', 'Easy to clean', 'Non-slip bottom', 'Multiple sizes', 'Gift for pets'],
    ['WATERPROOF LINER — keeps pee and spills off the filling', 'WIPE-CLEAN 600D OXFORD — rinse and air dry in minutes', 'NON-SLIP BOTTOM — stays put on hard floors',
      'SIZE L 36"x27" — fits dogs up to 65 lbs, measure before you buy', 'BOLSTER SUPPORT — raised edges for dogs that like to lean'],
    '体检：五点只有卖点名词，没写尺寸和体重范围；退货里 L 码"嫌小"占 40%', 'applied', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-28'],
  [105, 'listing_price', { ...target('CM22001GRY36'), priceImpact: { profitBefore: 6.12, profitAfter: 7.92, marginAfter: 25.5, breakEven: 23.87 } }, 29.99, 31.99,
    '36 寸垫子毛利只有 20%，竞品同尺码 $30–34，试涨 $2', 'applied', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-01'],
  [106, 'ad_bid', ad({ entity: 'keyword', entityId: '401928374651', label: 'waterproof dog bed（精准）' }), { bid: 1.2 }, { bid: 0.95 },
    'Miguelpet：近 14 天花费 $96、订单 4、ACOS 48%，高于全店 29%；降竞价到 0.95 看排名', 'exported', '2026-10-10', '2026-10-10', '2026-10-10', null],
  [107, 'ad_negative', ad({ level: 'adGroup' }), null, { matchType: 'phrase', text: 'carhartt' },
    'Miguelpet 搜索词报告：含 carhartt 的词 30 天花费 $41、0 订单', 'applied', '2026-10-05', '2026-10-05', '2026-10-06', '2026-10-06'],
  [108, 'listing_title', target('RR22002BKS'), 'MIGUELPET Waterproof Dog Bed Small, Oxford Pet Bed with Bolster',
    'MIGUELPET Waterproof Dog Bed for Small Dogs and Cats, Washable Oxford Cat Bed with Bolster, Non-Slip, 24"x18", Black',
    'ABA:"waterproof cat bed" 购买份额 30.8%，S 码标题没有 cat bed；按你的规则猫词只写 S/M', 'submitted', '2026-10-10', '2026-10-11', '2026-10-11', null],
  [109, 'listing_bullets', target('RR22002BKM'), ['Durable oxford fabric', 'Easy to clean', 'Non-slip bottom', 'Multiple sizes', 'Gift for pets'],
    ['WATERPROOF LINER — accidents stay on the surface, filling stays dry', 'WIPE-CLEAN 600D OXFORD — no washing machine needed', 'NON-SLIP BOTTOM — stays put on hard floors',
      'SIZE M 30"x22" — fits dogs and cats up to 35 lbs', 'BOLSTER SUPPORT — raised edges for dogs that like to lean'],
    'M 转化 6.8%，低于 S 的 9.1%；五点没写防水内胆和尺寸', 'pending', '2026-10-12', null, null, null],
  [110, 'listing_price', { ...target('CM22001GRY36'), priceImpact: { profitBefore: 7.92, profitAfter: 6.12, marginAfter: 20.4, breakEven: 23.87 } }, 31.99, 29.99,
    '涨价后 10 天日均销量 4.3 → 2.8（-35%），转化 8.5% → 6.2%，涨的毛利抵不上掉的销量，恢复原价', 'pending', '2026-10-12', null, null, null, 'revert'],
  [111, 'ad_budget', ad({ campaignId: '284019557998', campaignName: 'SP-方窝牛津-词组', adGroupId: undefined, adGroupName: undefined }), { budget: 15 }, { budget: 25 },
    'Miguelpet：outdoor dog bed 词组 7 天 ACOS 18%，预算每天 18 点前用完', 'pending', '2026-10-12', null, null, null],
  [112, 'listing_search_terms', target('BM25001AG24'), 'canvas dog bed', 'canvas dog bed chew proof indestructible', '加 chew proof 抢流量', 'rejected', '2026-10-08', '2026-10-09', null, null],
  [113, 'listing_title', target('BM25001AG24'), 'MIGUELPET Canvas Dog Bed', 'MIGUELPET Canvas Dog Bed 24" — Heavy Duty!! Elevated Mat', '标题加尺寸', 'failed', '2026-10-06', '2026-10-07', null, null],
];
const insertChange = db.prepare(`INSERT INTO pet_change_proposals (id, kind, target_key, target_json, before_json, after_json, reason, status, channel, error, source,
  created_at, updated_at, decided_at, executed_at, verified_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertLog = db.prepare('INSERT INTO pet_change_log (proposal_id, actor, user_id, action, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)');
const owner = db.prepare("SELECT id FROM users WHERE username='pet-owner'").get().id;
for (const [id, kind, tgt, before, after, reason, status, proposed, decided, executed, verified, source = 'claude'] of changes) {
  const isAd = kind.startsWith('ad_');
  insertChange.run(id, kind, `${kind}|${id}`, JSON.stringify(tgt), JSON.stringify(before), JSON.stringify(after), reason, status,
    isAd ? 'bulk_sheet' : 'sp_api', status === 'failed' ? '亚马逊预检没通过：标题里不能有 "!!" 这类重复标点' : null, source,
    at(proposed, '17:20:00'), at(verified ?? executed ?? decided ?? proposed, '19:00:00'), decided ? at(decided, '01:30:00') : null,
    executed ? at(executed, '02:10:00') : null, verified ? at(verified, '05:30:00') : null, decided ? owner : null);
  insertLog.run(id, 'claude', owner, 'proposed', JSON.stringify({ after }), at(proposed, '17:20:00'));
  if (status === 'rejected') insertLog.run(id, 'user', owner, 'rejected', null, at(decided, '01:30:00'));
  if (decided && status !== 'rejected') insertLog.run(id, 'user', owner, 'approved', null, at(decided, '01:30:00'));
  if (status === 'failed') insertLog.run(id, 'system', null, 'failed', JSON.stringify({ error: '亚马逊预检没通过：标题里不能有 "!!" 这类重复标点' }), at(decided, '01:31:00'));
  if (executed && !isAd) insertLog.run(id, 'system', null, 'submitted', JSON.stringify({ submissionId: `a1b2c3${id}` }), at(executed, '02:10:00'));
  if (executed && isAd) { insertLog.run(id, 'system', null, 'to_export', null, at(executed, '02:10:00')); insertLog.run(id, 'user', owner, 'exported', null, at(executed, '02:40:00')); }
  if (verified && !isAd) insertLog.run(id, 'system', null, 'verified', null, at(verified, '05:30:00'));
  if (verified && isAd) insertLog.run(id, 'user', owner, 'uploaded', null, at(verified, '05:30:00'));
}

// 经验库(示例)
const lesson = (input, day) => agent.saveLesson(input, { today: day });
const L1 = lesson({ title: '垫子类标题前 80 字符要写尺寸和对应笼子尺寸', body: '买笼垫的人按笼子尺寸搜（42 inch crate pad），手机端标题只显示前 80 字符。尺寸放进前 80 字符后点击份额和销量都涨。适用于牛津防水垫子、帆布平垫所有尺寸。',
  area: 'listing', changeKind: 'listing_title', verdict: 'works', confidence: 'medium', changeIds: [101], evidence: '#101 执行后 14 天日均销量 2.1 → 2.9（+38%），"42 inch crate pad" 点击份额 0.3% → 1.1%' }, '2026-10-03');
const L2 = lesson({ title: '后台词删掉竞品品牌不影响销量，只是为了合规', body: '删 carhartt 后 14 天销量和访问量没有变化，说明这个词本来就没带来流量。以后看到竞品品牌直接删，不用等复盘。',
  area: 'listing', changeKind: 'listing_search_terms', verdict: 'no_effect', confidence: 'low', changeIds: [102], evidence: '#102 前后 14 天日均 4.0 → 4.1' }, '2026-10-05');
const L3 = lesson({ title: '积压款用带结束日期的促销价清货，比直接降原价快', body: '促销价会在前台显示划线价，原价不动，结束后自动恢复。灯芯绒 M 促销 $19.99 后日均从 0.6 涨到 1.4 件。保本价以上才提。',
  area: 'listing', changeKind: 'listing_sale_price', verdict: 'works', confidence: 'medium', changeIds: [103], evidence: '#103 执行后 7 天日均 0.6 → 1.4（+133%）' }, '2026-10-02');
const L4 = lesson({ title: '36 寸垫子对价格敏感，$29.99 以上销量明显掉', body: '涨 $2 后销量掉 35%、转化掉 2.3 个点，竞品 Furhaven 同期降到 $24.99。这个尺寸先守 $29.99，要提毛利从头程和包装上想办法。',
  area: 'listing', changeKind: 'listing_price', style: '牛津防水垫子', verdict: 'hurts', confidence: 'medium', changeIds: [105], evidence: '#105 涨价后 10 天日均 4.3 → 2.8，转化 8.5% → 6.2%' }, '2026-10-12');
const L5 = lesson({ title: '猫相关词只写在方窝牛津 S/M，L/XL 文案只写狗', body: '店主 10/04 定的规则：L/XL 买家几乎都是大狗，写猫词会拉低相关性。', area: 'listing', style: '方窝牛津', verdict: 'rule', confidence: 'high' }, '2026-10-04');
lesson({ title: '同一 SKU 的 Listing 改动执行后 14 天内不再改', body: '两条改动挨得太近就分不清哪条起作用，复盘结论不可信。库存和广告不受限制。', area: 'other', verdict: 'rule', confidence: 'high' }, '2026-10-04');
const L7 = lesson({ title: '周末给方窝牛津加预算能多出单', body: '9/26–27 周末预算 +50%，订单 +20%。', area: 'ads', changeKind: 'ad_budget', verdict: 'works', confidence: 'low' }, '2026-09-29');
agent.setLessonStatus(L7.id, 'retired', '样本只有一个周末，那周刚好在补货，不算数');

// 每天的日报(示例)。先写早的,复盘挂在对应那天
const report = (day, input) => agent.saveDailyReport({ day, ...input }, { today: TODAY });
const simple = (headline, status = 'done', extra = {}) => ({ headline, status, sections: [{ area: 'inventory', status: 'watch', summary: '方窝牛津 S/M 补货到仓，其它正常。', findings: [] }], ...extra });
report('2026-09-29', simple('周末销量平稳；灯芯绒 M 促销价生效第 5 天，日均已到 1.3 件。', 'done', { lessonsUsed: [L3.id] }));
report('2026-09-30', simple('方窝牛津 S/M 还在断货，全店日均比 8 月少 30%，补货货件已在接收。'));
report('2026-10-01', simple('灯芯绒促销有效，记进经验库；36 寸垫子今天涨价 $2，进入观察。', 'done',
  { reviews: [{ changeId: 103, verdict: 'works', text: '执行后 7 天日均 0.6 → 1.4 件（+133%），同期没有其它改动和补货，访问量 +60%。', metrics: { unitsPerDayPct: 133, sessionsPct: 60 }, lessonId: L3.id }] }));
report('2026-10-02', simple('42 寸垫子新标题满 14 天，销量 +38%，把"标题写尺寸"的经验提到中可信度。', 'done',
  { reviews: [{ changeId: 101, verdict: 'works', text: '执行后 14 天日均 2.1 → 2.9（+38%），点击份额 0.3% → 1.1%，同期无补货。', metrics: { unitsPerDayPct: 38, sessionsPct: 31, conversionPoints: 0.4 }, lessonId: L1.id }],
    lessonsUsed: [L1.id] }));
report('2026-10-03', simple('方窝牛津 S/M 补货上架，第一天卖了 9 件。'));
report('2026-10-04', simple('帆布平垫后台词改完 14 天，销量没变化。', 'done',
  { reviews: [{ changeId: 102, verdict: 'no_effect', text: '前后 14 天日均 4.0 → 4.1，访问量持平。删的是竞品品牌，本来就没流量，属于合规修改。', metrics: { unitsPerDayPct: 2.5, sessionsPct: 0 }, lessonId: L2.id }] }));
report('2026-10-05', simple('方窝牛津 L 五点改完 7 天，同期 S/M 补货，看不清效果。', 'done',
  { reviews: [{ changeId: 104, verdict: 'unclear', text: '日均 3.0 → 2.6，但 10/03 S/M 补货分走了一部分 L 的买家，等 14 天再看退货率。', metrics: { unitsPerDayPct: -13, conversionPoints: -0.2 } }] }));
report('2026-10-06', simple('否定 carhartt 已上传，进入观察。'));
report('2026-10-08', simple('访问量和转化率数据没同步到，只看了订单和库存。', 'partial', { dataGaps: ['业务报告同步失败（亚马逊限流），访问量和转化率缺 10/06–10/07'] }));
report('2026-10-09', simple('36 寸垫子涨价第 8 天，销量掉了三成，再观察 2 天确认。'));
report('2026-10-10', simple('方窝牛津 M 卖得比预期快，可售天数降到 11 天；提了 1 条广告降竞价。', 'done', { actions: [{ type: 'proposal', priority: 'medium', text: '"waterproof dog bed" 竞价 1.20 → 0.95', proposalIds: [106] }] }));
const yesterday = agent.salesKpis('2026-10-11').units;
report('2026-10-11', {
  headline: `昨天卖了 ${yesterday.value} 件，比前 7 天日均多 ${Math.round(yesterday.changePct)}%，主要是补货后的方窝牛津 S/M；36 寸垫子涨价后销量掉了 35%，已提议恢复原价。今天有 3 条改动等你确认。`,
  ads: { source: 'Miguelpet', spend: { value: 58.4, avg7: 61.2, changePct: -4.6 }, sales: { value: 212.3, avg7: 196.1, changePct: 8.3 },
    acos: { value: 27.5, avg7: 31.2, changePct: -11.9 }, tacos: { value: 4.0 } },
  sections: [
    { area: 'inventory', status: 'bad', summary: '方窝牛津 M 黑色按近 7 天速度只够卖 9 天，补货货件 FBA18Z3K9QWM 还在处理中没发出。',
      findings: [{ level: 'high', sku: 'RR22002BKM', text: '在库 46 件，7 天日均 5.1 件，预计 10/21 断货' },
        { level: 'medium', sku: 'CM22001GRY42', text: '42 寸灰色垫子在库 210 件，可售 72 天，偏多但在消化' },
        { level: 'low', text: '灯芯绒 M 促销后积压从 82 件降到 61 件' }] },
    { area: 'listing', status: 'watch', summary: '方窝牛津 S 新标题（加 cat bed）已提交亚马逊，等生效；M 的五点改写提议等你确认。',
      findings: [{ level: 'medium', sku: 'RR22002BKM', text: 'M 转化 6.8%，S 是 9.1%，五点没写防水内胆和尺寸' },
        { level: 'low', sku: 'CM22001GRY42', text: '在冷却期（10/02 才过 14 天），今天不提新改动' }] },
    { area: 'search', status: 'good', summary: 'ABA 最新一周（到 10/03）"waterproof dog bed" 购买份额 2.1% → 2.6%，"42 inch crate pad" 点击份额保持在 1.1%。',
      findings: [{ level: 'low', text: '"waterproof cat bed" 曝光份额只有 0.4%，S 码新标题生效后重点看这个词' }] },
    { area: 'rank', status: 'watch', summary: '方窝牛津小类排名 7 天均值 #48 → #41；36 寸垫子 #120 → #165，和涨价时间吻合。', findings: [] },
    { area: 'ads', status: 'watch', summary: '全店 ACOS 27.5%，比前 7 天低；精准组"waterproof dog bed"仍然偏贵，词组组"outdoor dog bed"预算不够用。',
      findings: [{ level: 'medium', text: '"waterproof dog bed" 14 天 ACOS 48%，降竞价的批量表已导出，还没上传' },
        { level: 'medium', text: '"outdoor dog bed" 7 天 ACOS 18%，预算每天 18 点前用完，提议 $15 → $25' }] },
    { area: 'returns', status: 'good', summary: '近 30 天退货率 3.1%，没有异常尺码；方窝牛津 L "嫌小"从 4 件降到 1 件。', findings: [] },
    { area: 'competitors', status: 'watch', summary: '竞品 Furhaven 36 寸垫子 10/05 降到 $24.99，是我们 36 寸掉量的另一个原因。', findings: [] },
  ],
  actions: [
    { type: 'proposal', priority: 'high', text: '36 寸灰色垫子恢复原价 $29.99：涨价后 10 天日均 4.3 → 2.8 件，涨的毛利抵不上掉的销量', proposalIds: [110] },
    { type: 'todo', priority: 'high', text: '方窝牛津 M 黑色 9 天后断货，货件 FBA18Z3K9QWM 还在处理中，尽快发出；来不及就先补一小批空运' },
    { type: 'proposal', priority: 'medium', text: '方窝牛津 M 五点改写，第一条讲防水内胆，第四条写尺寸和体重范围', proposalIds: [109] },
    { type: 'proposal', priority: 'medium', text: '"outdoor dog bed" 词组活动预算 $15 → $25', proposalIds: [111] },
    { type: 'todo', priority: 'medium', text: '上传 10/10 导出的批量表（"waterproof dog bed" 竞价 1.20 → 0.95）', proposalIds: [106] },
    { type: 'watch', priority: 'low', text: '方窝牛津 S 新标题生效后，看"waterproof cat bed"曝光份额' },
  ],
  reviews: [
    { changeId: 105, verdict: 'hurts', text: '涨价后 10 天日均 4.3 → 2.8 件（-35%），转化 8.5% → 6.2%，访问量基本不变，说明是价格劝退；同期竞品降价也有影响，但方向一致。已提议恢复原价。',
      metrics: { unitsPerDayPct: -35, sessionsPct: -3, conversionPoints: -2.3 }, lessonId: L4.id },
    { changeId: 107, verdict: 'works', text: 'Miguelpet：否定后 5 天含 carhartt 的词花费 $0，广告组 ACOS 34% → 29%，订单数没变。', metrics: { unitsPerDayPct: 0 } },
    { changeId: 104, verdict: 'unclear', text: '执行后 13 天日均 3.0 → 2.7，S/M 补货分流还在；退货里"嫌小"从 4 件降到 1 件，等 28 天再下结论。', metrics: { unitsPerDayPct: -10, conversionPoints: 0.3 } },
  ],
  lessonsUsed: [L1.id, L3.id, L4.id, L5.id],
  dataGaps: ['业务报告（访问量、转化率）最新到 10/10，晚 2 天是正常的', 'ABA 最新一周到 10/03', '广告数据来自 Miguelpet，归因窗口 7 天，近 3 天的广告订单还会再涨'],
});

let vite, browser;
try {
  vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByLabel('用户名').fill('pet-owner'); await page.getByLabel('密码').fill('pet-test-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.locator('.topnav').getByRole('button', { name: 'AI 日报', exact: true }).click();
  await page.locator('.agt-headline').waitFor();
  await page.setViewportSize({ width: 1600, height: 2300 });
  await page.screenshot({ path: `${output}/AI日报.png`, fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.getByRole('tab', { name: '经验库' }).click();
  await page.locator('.agt-lessons').waitFor();
  await page.locator('.agt-lessons').screenshot({ path: `${output}/AI日报-经验库.png` });
  await page.getByRole('tab', { name: '每日分析' }).click();
  await page.locator('.agt-headline').waitFor();
  await page.setViewportSize({ width: 390, height: 3600 });
  await page.screenshot({ path: `${output}/AI日报-手机.png`, fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.locator('.topnav').getByRole('button', { name: '改动日志', exact: true }).click();
  await page.locator('.cl-list').first().waitFor();
  await page.locator('.cl-row').filter({ hasText: '#105' }).click();
  await page.locator('.cl-events').waitFor();
  await page.setViewportSize({ width: 1600, height: 2400 });
  await page.screenshot({ path: `${output}/改动日志.png`, fullPage: true });
  await page.locator('.cl-list > li.open').screenshot({ path: `${output}/改动日志-展开.png` });
  if (errors.length) console.error('page errors', errors);
  console.log('done', output);
} finally {
  await browser?.close(); await vite?.close(); await backend.close();
}
