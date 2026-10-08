// 宠物版产品情报「本周要做」:每个在卖款式列出这周该处理的事,按轻重排,每条写清依据。
// 数据都来自已经同步好的表(销量、库存、ABA、目录、竞品快照、卖家精灵),这里只做判断,不调亚马逊。
// 能按规则直接改的(后台搜索词超字节、标题没品牌)可以一键生成「待确认改动」;要动脑子的给一段话复制给 Claude。
import express from 'express';
import { db } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { pacificDay, shiftDay } from './petAmazon.js';
import { withProfit } from './petCosts.js';
import { proposeListingChanges } from './petChanges.js';
import {
  BIG_TERM_PURCHASES, catalogMap, listingHealth, ownStyles, recentChanges, sizeLabel, styleDetail,
} from './petCompetitors.js';

const clean = (value) => String(value ?? '').trim();
const money = (value) => `$${Number(value).toFixed(2)}`;
const pct = (value) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};
const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };
const skuName = (sku) => [sku.size, sku.color].filter(Boolean).join(' ') || sku.sku;
const listOf = (items, limit = 3) => items.slice(0, limit).join('、') + (items.length > limit ? ` 等 ${items.length} 个` : '');

// ---------- 规则修改 ----------

/** 后台搜索词瘦身:去掉重复词和标题里已有的词(亚马逊本来就收录),再按词截到 249 字节以内 */
export function trimBackend(backend, title = '') {
  const inTitle = new Set(clean(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const seen = new Set();
  const kept = [];
  for (const word of clean(backend).split(/\s+/)) {
    const key = word.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key) || inTitle.has(key)) continue;
    seen.add(key);
    kept.push(word);
  }
  let value = '';
  for (const word of kept) {
    const next = value ? `${value} ${word}` : word;
    if (Buffer.byteLength(next, 'utf8') > 249) break;
    value = next;
  }
  return value;
}

/** 标题前面加品牌;加了超过 200 字符就不加 */
export function brandTitle(title, brand) {
  const text = clean(title), name = clean(brand);
  if (!text || !name || text.toLowerCase().includes(name.toLowerCase())) return null;
  const value = `${name} ${text}`;
  return value.length <= 200 ? value : null;
}

const FIXES = {
  backend_trim: { field: 'search_terms', batch: '后台搜索词瘦身到 249 字节以内',
    value: (row) => trimBackend(row.backend_terms, row.title),
    reason: (row, value) => `后台搜索词现在 ${Buffer.byteLength(row.backend_terms ?? '', 'utf8')} 字节，超过 249 字节亚马逊整段不收录。`
      + `去掉重复词和标题里已有的词后 ${Buffer.byteLength(value, 'utf8')} 字节。` },
  brand_title: { field: 'title', batch: '标题前加品牌',
    value: (row) => brandTitle(row.title, row.brand),
    reason: (row) => `标题里没有品牌「${row.brand}」，加在最前面方便搜品牌的顾客找到，也符合亚马逊标题规范。` },
};

/** 把规则修改放进「待确认改动」:只放提议,店主在待确认页确认后才改亚马逊 */
export async function proposeRuleFix(code, skus, { userId, ...deps } = {}) {
  const fix = FIXES[code];
  if (!fix) throw Object.assign(new Error('这类问题没有自动修改办法'), { status: 400 });
  const list = [...new Set((Array.isArray(skus) ? skus : []).map(clean).filter(Boolean))].slice(0, 40);
  if (!list.length) throw Object.assign(new Error('没有要改的 SKU'), { status: 400 });
  const asinOf = new Map(db.prepare(`SELECT lower(sku) AS sku, upper(asin) AS asin FROM sku_items WHERE user_id=? AND country='US'`)
    .all(PET_SHOP_ID).map((row) => [row.sku, row.asin]));
  const catalog = catalogMap(list.map((sku) => asinOf.get(sku.toLowerCase())));
  const changes = [], skipped = [];
  for (const sku of list) {
    const row = catalog.get(asinOf.get(sku.toLowerCase()));
    const value = row ? fix.value(row) : null;
    if (!value) { skipped.push(sku); continue; }
    changes.push({ sku, field: fix.field, value, reason: fix.reason(row, value) });
  }
  if (!changes.length) throw Object.assign(new Error('这些 SKU 已经不需要改了，或者改了会超长'), { status: 400 });
  const result = await proposeListingChanges({ title: fix.batch, summary: '产品情报「本周要做」按规则生成', changes },
    { userId, source: 'intel', ...deps });
  return { ...result, skipped };
}

// ---------- 判断 ----------

/** 每个 SKU 前 7 天(8–14 天前)的销量 */
function previousWeekUnits(today) {
  return new Map(db.prepare(`SELECT lower(sku) AS sku, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<? GROUP BY lower(sku)`)
    .all(shiftDay(today, -14), shiftDay(today, -7)).map((row) => [row.sku, row.units]));
}

/** 核心词每周的市场点击和我们的点击(同一周同一个词市场量取最大,不能相加) */
function weeklyClicks(asins, terms) {
  if (!asins.length || !terms.length) return { weeks: [], byTerm: new Map() };
  const weeks = db.prepare(`SELECT DISTINCT week_end FROM aba_asin_reports WHERE user_id=? AND marketplace='US'
    ORDER BY week_end DESC LIMIT 5`).all(PET_SHOP_ID).map((row) => row.week_end).reverse();
  const rows = db.prepare(`SELECT r.week_end AS week, lower(q.query) AS term, MAX(q.market_clicks) AS mc, MAX(q.market_purchases) AS mp,
      SUM(q.asin_clicks) AS ac
    FROM aba_asin_queries q JOIN aba_asin_reports r ON r.id=q.report_id
    WHERE r.user_id=? AND r.marketplace='US' AND upper(r.asin) IN (${asins.map(() => '?').join(',')})
      AND lower(q.query) IN (${terms.map(() => '?').join(',')})
    GROUP BY r.week_end, lower(q.query)`).all(PET_SHOP_ID, ...asins, ...terms);
  const byTerm = new Map();
  for (const row of rows) {
    if (!byTerm.has(row.term)) byTerm.set(row.term, new Map());
    byTerm.get(row.term).set(row.week, row);
  }
  return { weeks, byTerm };
}

/** 一段给 Claude 的话:用连接器看数据、起草改动放进待确认 */
const claudePrompt = (style, ask) => `用 Miguel_Agent 看款式「${style}」（get_style_intel、get_listing_health、get_listing），${ask}`
  + '。规格只写有依据的，拿不准先问我；起草好用 propose_listing_changes 放进待确认，我确认后再改。';

function styleActionList(style, ctx) {
  const { today, healthRows, prevUnits, transit, changes } = ctx;
  const actions = [];
  const add = (action) => actions.push({ id: `${style.key}:${action.kind}:${actions.length}`, ...action });
  const selling = style.skus.filter((sku) => sku.units30 > 0 || (sku.stock ?? 0) > 0);

  // 1. 库存:卖得动的 SKU 断货、快断货
  const out = style.skus.filter((sku) => sku.stock != null && sku.stock <= 0 && sku.units30 >= 3).sort((a, b) => b.units30 - a.units30);
  if (out.length) {
    add({ kind: 'stockout', level: 'high', title: `${out.length} 个 SKU 断货`,
      detail: out.slice(0, 4).map((sku) => `${skuName(sku)}（30 天卖 ${sku.units30} 件${transit.get(sku.sku.toLowerCase()) ? `，在途 ${transit.get(sku.sku.toLowerCase())}` : '，没有在途'}）`).join('；'),
      hint: '断货期间排名会掉，补货到了先看排名和广告。', skus: out.map((sku) => sku.sku) });
  }
  const low = style.skus.map((sku) => ({ ...sku, days: sku.units30 >= 5 && (sku.stock ?? 0) > 0 ? sku.stock / (sku.units30 / 30) : null }))
    .filter((sku) => sku.days != null && sku.days < 21).sort((a, b) => a.days - b.days);
  if (low.length) {
    add({ kind: 'lowstock', level: low[0].days < 10 ? 'high' : 'medium', title: `${low.length} 个 SKU 库存不够三周`,
      detail: low.slice(0, 4).map((sku) => `${skuName(sku)} 剩 ${sku.stock} 件，约 ${Math.max(1, Math.round(sku.days))} 天卖完${transit.get(sku.sku.toLowerCase()) ? `（在途 ${transit.get(sku.sku.toLowerCase())}）` : ''}`).join('；'),
      skus: low.map((sku) => sku.sku) });
  }

  // 2. 销量:近 7 天比前 7 天少 40% 以上
  const prev7 = style.skus.reduce((sum, sku) => sum + (prevUnits.get(sku.sku.toLowerCase()) ?? 0), 0);
  if (prev7 >= 10 && style.units7 <= prev7 * 0.6) {
    add({ kind: 'sales_drop', level: 'high', title: `近 7 天销量掉了 ${Math.round((1 - style.units7 / prev7) * 100)}%`,
      detail: `近 7 天 ${style.units7} 件，前 7 天 ${prev7} 件。${out.length ? '有 SKU 断货，先看是不是断货拖的。' : '没有断货，看下面的份额、价格和对手动态找原因。'}` });
  }

  // 3. Listing:影响展示和收录的问题(只看卖得动或有货的 ASIN)
  const sellingAsins = new Set(selling.map((sku) => sku.asin).filter(Boolean));
  const rows = healthRows.filter((row) => sellingAsins.has(row.asin));
  const withCode = (code) => rows.filter((row) => row.checks.some((check) => check.code === code));
  const label = (row) => [row.size, row.color].filter(Boolean).join(' ') || row.sku || row.asin;
  const errors = withCode('amazon_error');
  if (errors.length) {
    const first = errors[0].checks.find((check) => check.code === 'amazon_error').text;
    add({ kind: 'amazon_error', level: 'high', title: `${errors.length} 个 ASIN 被亚马逊报错`,
      detail: `${listOf(errors.map(label))}。${first}`,
      hint: /image/i.test(first) ? '主图被屏蔽时顾客看不到图，要在卖家后台重新上传主图。' : '在卖家后台「修复无在售信息的亚马逊商品」里能看到全部报错。',
      skus: errors.map((row) => row.sku).filter(Boolean),
      fix: /bullet|promotional/i.test(first) ? { type: 'claude', label: '让 Claude 改五点',
        prompt: claudePrompt(style.key, `这些 SKU 的五点被亚马逊判违规（${errors.map((row) => row.sku).filter(Boolean).join('、')}），去掉促销用语和外部链接，重写五点`) } : null });
  }
  const backend = withCode('backend_bytes');
  if (backend.length) {
    add({ kind: 'backend_bytes', level: 'high', title: `${backend.length} 个 ASIN 后台搜索词超过 249 字节，整段不生效`,
      detail: listOf(backend.map(label), 4), skus: backend.map((row) => row.sku).filter(Boolean),
      fix: { type: 'rule', code: 'backend_trim', label: '生成瘦身改动', skus: backend.map((row) => row.sku).filter(Boolean) } });
  }
  for (const [code, title] of [['title_long', '标题超过 200 字符'], ['no_bullets', '没有五点'], ['no_images', '目录里没有图片']]) {
    const hit = withCode(code);
    if (hit.length) add({ kind: code, level: 'high', title: `${hit.length} 个 ASIN ${title}`, detail: listOf(hit.map(label), 4),
      skus: hit.map((row) => row.sku).filter(Boolean),
      fix: code === 'title_long' ? { type: 'claude', label: '让 Claude 缩标题', prompt: claudePrompt(style.key, '把超过 200 字符的标题缩到 200 以内，核心词留在前面') } : null });
  }
  const noBrand = withCode('brand');
  if (noBrand.length) {
    add({ kind: 'brand', level: 'low', title: `${noBrand.length} 个 ASIN 标题里没有品牌`, detail: listOf(noBrand.map(label), 4),
      skus: noBrand.map((row) => row.sku).filter(Boolean),
      fix: { type: 'rule', code: 'brand_title', label: '生成加品牌改动', skus: noBrand.map((row) => row.sku).filter(Boolean) } });
  }

  // 4. 流量:有量的核心词没写进文案、份额在掉、点了不买
  const detail = ctx.detail;
  const terms = detail?.terms ?? [];
  const missing = terms.filter((term) => term.marketPurchases >= BIG_TERM_PURCHASES && detail.own.coverage?.[term.term] == null).slice(0, 4);
  if (missing.length) {
    add({ kind: 'term_missing', level: 'medium', title: `${missing.length} 个有量的词没写进卖得最好的那个 Listing`,
      detail: missing.map((term) => `${term.term}（4 周全市场成交 ${term.marketPurchases} 单）`).join('；'),
      fix: { type: 'claude', label: '让 Claude 埋词', prompt: claudePrompt(style.key, `把这些词合理写进标题、五点或后台搜索词：${missing.map((term) => term.term).join('、')}；只写和产品相符的`) } });
  }
  const { weeks, byTerm } = weeklyClicks(style.asins, terms.slice(0, 10).map((term) => term.term));
  if (weeks.length >= 3) {
    const last = weeks[weeks.length - 1], before = weeks.slice(Math.max(0, weeks.length - 4), -1);
    const drops = [];
    for (const [term, perWeek] of byTerm) {
      const now = perWeek.get(last);
      const prev = before.map((week) => perWeek.get(week)).filter(Boolean);
      const prevMarket = prev.reduce((sum, row) => sum + row.mc, 0), prevOurs = prev.reduce((sum, row) => sum + row.ac, 0);
      if (!now?.mc || !prevMarket || (now.mp ?? 0) < 5) continue;
      const shareNow = (now.ac ?? 0) / now.mc, sharePrev = prevOurs / prevMarket;
      if (sharePrev >= 0.01 && shareNow < sharePrev * 0.6 && prevOurs / prev.length - (now.ac ?? 0) >= 5) drops.push({ term, shareNow, sharePrev });
    }
    drops.sort((a, b) => (b.sharePrev - b.shareNow) - (a.sharePrev - a.shareNow));
    if (drops.length) {
      add({ kind: 'share_drop', level: 'medium', title: `${drops.length} 个核心词的点击份额在掉`,
        detail: drops.slice(0, 3).map((drop) => `${drop.term} ${pct(drop.sharePrev)} → ${pct(drop.shareNow)}`).join('；') + `（${last} 那周比前 ${before.length} 周平均）`,
        hint: '常见原因：断货、对手降价、广告停了或出价被压、主图或价格变了。' });
    }
  }
  const gaps = terms.filter((term) => term.ourClicks >= 20 && term.marketClicks && term.marketPurchases)
    .map((term) => ({ ...term, ours: term.ourPurchases / term.ourClicks, market: term.marketPurchases / term.marketClicks }))
    .filter((term) => term.ours < term.market * 0.5).sort((a, b) => b.ourClicks - a.ourClicks).slice(0, 3);
  if (gaps.length) {
    add({ kind: 'conversion_gap', level: 'medium', title: '有词点得多、成交少',
      detail: gaps.map((term) => `${term.term}：点击 ${term.ourClicks} 次成交 ${term.ourPurchases} 单（${pct(term.ours)}），市场平均 ${pct(term.market)}`).join('；'),
      hint: '点了不买一般是价格、评分、主图或尺码不对路，对照下面的价格和评分看。' });
  }

  // 5. 价格:和同尺码对手比
  const competitors = detail?.competitors ?? [];
  if (competitors.length) {
    const ownBySize = new Map();
    for (const child of detail.own.children) {
      if (child.price == null || !child.sizeLabel) continue;
      if (!ownBySize.has(child.sizeLabel) || child.price < ownBySize.get(child.sizeLabel).price) ownBySize.set(child.sizeLabel, child);
    }
    const high = [], cheap = [];
    for (const [size, own] of ownBySize) {
      const prices = competitors.flatMap((family) => family.children).filter((child) => child.sizeLabel === size && child.price != null).map((child) => child.price);
      const mid = prices.length >= 3 ? median(prices) : null;
      if (!mid) continue;
      if (own.price > mid * 1.2) high.push(`${size} 码 ${money(own.price)}，对手中位 ${money(mid)}（高 ${Math.round((own.price / mid - 1) * 100)}%）`);
      else if (own.price < mid * 0.8) {
        const sku = style.skus.find((item) => item.asin === own.asin);
        const profit = sku ? withProfit([{ sku: sku.sku, price: own.price }])[0] : null;
        cheap.push(`${size} 码 ${money(own.price)}，对手中位 ${money(mid)}（低 ${Math.round((1 - own.price / mid) * 100)}%${profit?.profit != null ? `，现在每件毛利 ${money(profit.profit)}` : ''}）`);
      }
    }
    if (high.length) add({ kind: 'price_high', level: 'medium', title: '比同尺码对手贵 20% 以上', detail: high.join('；'), hint: '贵得多又没有评分优势时，转化会被拖住。' });
    if (cheap.length) add({ kind: 'price_low', level: 'low', title: '比同尺码对手便宜 20% 以上', detail: cheap.join('；'), hint: '卖得动的话可以小步涨价试试，改价前看保本价。' });
  }

  // 6. 评分:比对手中位低 0.3 星以上
  const ownRating = detail?.own.rating;
  const ratings = competitors.map((family) => family.rating).filter((value) => value != null);
  if (ownRating != null && ratings.length >= 2 && ownRating < median(ratings) - 0.3) {
    add({ kind: 'rating_gap', level: 'medium', title: `评分 ${ownRating} 星，对手中位 ${median(ratings).toFixed(1)} 星`,
      detail: `我们 ${detail.own.reviews ?? '?'} 条评论（卖家精灵 ${detail.own.metricsMonth ?? ''}）。`,
      hint: '先看差评集中在哪（尺码、做工、气味），能改产品的改产品，文案里把尺寸写清楚。' });
  }

  // 7. 对手动态(近 7 天)
  const mine = changes.filter((change) => change.styleKey === style.key);
  const brandOf = (change) => change.brand ?? change.family;
  const drops = mine.filter((change) => change.kind === 'price_down');
  if (drops.length) {
    add({ kind: 'competitor_price_down', level: 'medium', title: `${new Set(drops.map(brandOf)).size} 个对手降价`,
      detail: drops.slice(0, 3).map((change) => `${brandOf(change)}${change.size ? ` ${sizeLabel(change.size)}` : ''} ${money(change.before)} → ${money(change.after)}（${change.day.slice(5)}）`).join('；') });
  }
  const gone = mine.filter((change) => change.kind === 'no_buybox');
  if (gone.length) {
    add({ kind: 'competitor_out', level: 'medium', title: `${new Set(gone.map(brandOf)).size} 个对手没有购物车（可能断货）`,
      detail: gone.slice(0, 3).map((change) => `${brandOf(change)}${change.size ? ` ${sizeLabel(change.size)}` : ''}（${change.day.slice(5)}）`).join('；'),
      hint: '对手断货是抢流量的机会，可以加一点广告预算。' });
  }
  const edits = mine.filter((change) => ['title', 'bullets', 'main_image', 'variants_added'].includes(change.kind));
  if (edits.length) {
    add({ kind: 'competitor_edit', level: 'low', title: `对手改了 ${edits.length} 处文案或图片`,
      detail: edits.slice(0, 3).map((change) => `${brandOf(change)} ${change.label}（${change.day.slice(5)}）`).join('；') });
  }
  if (!competitors.length) {
    add({ kind: 'no_competitors', level: 'low', title: '还没有对手数据',
      detail: '每日同步会自动给这个款式挑同类商品挂上；也可以在「竞品监控」里手动加你心里的对手。' });
  }
  return actions.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** 本周要做:近 30 天有销量的款式,每个款式一组事项;没销量的只给个数 */
export function weeklyActions(today = pacificDay(new Date())) {
  const styles = ownStyles(today);
  const active = styles.filter((style) => style.units30 > 0);
  const health = listingHealth(today);
  const healthByStyle = new Map();
  for (const row of health) {
    if (!healthByStyle.has(row.styleKey)) healthByStyle.set(row.styleKey, []);
    healthByStyle.get(row.styleKey).push(row);
  }
  const prevUnits = previousWeekUnits(today);
  const transit = new Map(db.prepare(`SELECT lower(sku) AS sku, transit FROM sku_items WHERE user_id=? AND country='US' AND transit>0`)
    .all(PET_SHOP_ID).map((row) => [row.sku, row.transit]));
  const changes = recentChanges(today, 7);
  const result = active.map((style) => {
    const detail = styleDetail(style.key, today);
    const actions = styleActionList(style, { today, detail, healthRows: healthByStyle.get(style.key) ?? [], prevUnits, transit, changes });
    const prev7 = style.skus.reduce((sum, sku) => sum + (prevUnits.get(sku.sku.toLowerCase()) ?? 0), 0);
    const lead = detail?.own;
    return { key: style.key, units7: style.units7, prevUnits7: prev7, units30: style.units30,
      stock: style.skus.reduce((sum, sku) => sum + Math.max(0, sku.stock ?? 0), 0), skus: style.skus.length,
      title: lead?.title ?? null, mainImage: lead?.mainImage ?? null, rating: lead?.rating ?? null, reviews: lead?.reviews ?? null,
      competitors: detail?.competitors.length ?? 0, priceBand: detail?.priceBand ?? null, actions };
  });
  const count = (level) => result.reduce((sum, style) => sum + style.actions.filter((action) => action.level === level).length, 0);
  return { today, styles: result, inactive: styles.length - active.length,
    totals: { high: count('high'), medium: count('medium'), low: count('low') } };
}

// ---------- 接口 ----------

const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

/** /api/intel:本周要做、按规则生成待确认改动(只有店主能提) */
export function createIntelRouter(deps = {}) {
  const router = express.Router();
  router.use(requireLogin);
  router.use((req, res, next) => {
    if (!isPet) return res.status(404).json({ error: '只有宠物版有产品情报' });
    if (!req.session.user.productIntel) return res.status(403).json({ error: '账号未开通产品情报' });
    next();
  });
  router.get('/actions', (req, res) => res.json(weeklyActions(todayOf())));
  router.post('/fix', async (req, res) => {
    if (req.session.user.role !== 'owner') return res.status(403).json({ error: '只有店主能提改动' });
    try {
      res.json(await proposeRuleFix(clean(req.body?.code), req.body?.skus, { userId: req.session.user.id, ...deps }));
    } catch (error) {
      res.status(error.status ?? 500).json({ error: error.message });
    }
  });
  return router;
}
