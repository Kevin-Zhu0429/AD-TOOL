// 宠物版产品情报:竞品监控 + 自家 Listing 体检。
// 竞品按家族(父 ASIN)挂在自家款式下;每天从亚马逊目录和价格接口拉一次快照,对比前一天找出变化。
// 候选竞品每周从品牌分析「搜索词报告」里自动推荐:自家款式的核心词下,点击前 3 的别家 ASIN。
// 评分、评论数、子体销量亚马逊接口没有,由卖家精灵等导出的表按月导入。
import express from 'express';
import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { completeWeeks } from './petAbaSync.js';
import {
  amazonGateway, createArrayRecordScanner, fetchCatalogDetails, fetchItemOffers, fetchOwnListing,
  pacificDay, petSpConfig, runReport, searchCatalogItems, shiftDay,
} from './petAmazon.js';

const SEARCH_TERMS_REPORT = 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT';
// 每个款式取 ABA 里市场购买量最大的这么多个词当核心词
export const TERMS_PER_STYLE = 20;
const ABA_WEEKS = 4;
// 每个款式最多推荐几个竞品家族
const SUGGEST_PER_STYLE = 10;
// 一个竞品家族最多跟踪多少个子体(太多的变体只跟前面这些)
const MAX_CHILDREN = 60;
// 快照保留天数
const KEEP_DAYS = 400;
// 每个在卖款式自动挂几个对手;每次每日同步最多给几个款式挑
const AUTO_TARGET = 5;
const AUTO_STYLES = 12;
// 标题相似度低于这个不算同类商品
const MIN_RELEVANCE = 0.25;

const clean = (value) => String(value ?? '').trim();
const asinOf = (value) => {
  const asin = clean(value).toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
};
const parseJson = (text, fallback) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};
const round = (value, digits = 4) => (value == null ? null : Number(value.toFixed(digits)));

// ---------- 自家款式 ----------

/** SKU 的款式键:SKU 库填了款式就用款式,没填用 SKU 开头的款号(RR22002BKM → RR22002) */
export function styleKeyOf(row) {
  const style = clean(row.style);
  if (style) return style;
  const code = /^([A-Za-z]+\d{3,})/.exec(clean(row.sku));
  return (code ? code[1] : clean(row.sku)).toUpperCase();
}

/** 自家款式 → SKU、ASIN、尺码,按近 30 天销量从高到低 */
export function ownStyles(today = pacificDay(new Date())) {
  const rows = db.prepare(`SELECT sku, upper(asin) AS asin, style, size, color, stock FROM sku_items
    WHERE user_id=? AND country='US' ORDER BY sku`).all(PET_SHOP_ID);
  const units = new Map(db.prepare(`SELECT lower(sku) AS sku, SUM(CASE WHEN day>=? THEN units ELSE 0 END) AS u7, SUM(units) AS u30
    FROM pet_daily_sales WHERE day>=? AND day<? GROUP BY lower(sku)`).all(shiftDay(today, -7), shiftDay(today, -30), today)
    .map((row) => [row.sku, row]));
  // 亚马逊自动生成的 SKU(AMAZON.FOUND.<ASIN>)跟同一个 ASIN 的正常 SKU 算一个款式
  const keyByAsin = new Map();
  for (const row of rows) if (row.asin && !/^amazon\.found\./i.test(row.sku) && !keyByAsin.has(row.asin)) keyByAsin.set(row.asin, styleKeyOf(row));
  const styles = new Map();
  for (const row of rows) {
    const key = (/^amazon\.found\./i.test(row.sku) && !clean(row.style) && keyByAsin.get(row.asin)) || styleKeyOf(row);
    if (!styles.has(key)) styles.set(key, { key, skus: [], asins: [], sizes: new Set(), units7: 0, units30: 0, asinUnits: new Map() });
    const style = styles.get(key);
    const sold = units.get(row.sku.toLowerCase());
    style.skus.push({ sku: row.sku, asin: asinOf(row.asin), size: row.size, color: row.color, stock: row.stock,
      units7: sold?.u7 ?? 0, units30: sold?.u30 ?? 0 });
    if (asinOf(row.asin) && !style.asins.includes(row.asin)) style.asins.push(row.asin);
    if (row.size) style.sizes.add(sizeLabel(row.size));
    style.units7 += sold?.u7 ?? 0;
    style.units30 += sold?.u30 ?? 0;
    if (row.asin) style.asinUnits.set(row.asin, (style.asinUnits.get(row.asin) ?? 0) + (sold?.u30 ?? 0));
  }
  return [...styles.values()].sort((a, b) => b.units30 - a.units30 || a.key.localeCompare(b.key, 'zh-CN', { numeric: true }));
}

/** 尺码归一:Small → S、X-Large → XL;认不出的保留原文 */
export function sizeLabel(text) {
  const value = clean(text).toLowerCase().replace(/[()（）]/g, ' ');
  if (!value) return '';
  const rules = [[/\b(xxx-?large|3xl|xxxl)\b/, 'XXXL'], [/\b(xx-?large|2xl|xxl|extra extra large)\b/, 'XXL'],
    [/\b(x-?large|xl|extra large)\b/, 'XL'], [/\b(large|l)\b/, 'L'], [/\b(medium|m)\b/, 'M'],
    [/\b(x-?small|xs|extra small)\b/, 'XS'], [/\b(small|s)\b/, 'S']];
  for (const [pattern, label] of rules) if (pattern.test(value)) return label;
  return clean(text);
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const sortSizes = (sizes) => sizes.sort((a, b) => {
  const left = SIZE_ORDER.indexOf(a), right = SIZE_ORDER.indexOf(b);
  if (left >= 0 || right >= 0) return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
  return a.localeCompare(b, 'en', { numeric: true });
});

// ---------- 核心词与覆盖 ----------

/**
 * 款式的核心词:最近 4 周 ABA 里我们有点击的词,按市场购买量排序。
 * 同一周同一个词,每个 ASIN 的报告里市场总量是同一个数,取最大值,不能相加。
 */
export function coreTerms(asins, limit = TERMS_PER_STYLE) {
  if (!asins.length) return [];
  const weeks = db.prepare(`SELECT DISTINCT week_end FROM aba_asin_reports WHERE user_id=? AND marketplace='US'
    ORDER BY week_end DESC LIMIT ?`).all(PET_SHOP_ID, ABA_WEEKS).map((row) => row.week_end);
  if (!weeks.length) return [];
  const rows = db.prepare(`SELECT query AS term, SUM(mp) AS marketPurchases, SUM(mc) AS marketClicks,
      SUM(ac) AS ourClicks, SUM(ap) AS ourPurchases, SUM(mi) AS marketImpressions, SUM(ai) AS ourImpressions
    FROM (SELECT r.week_end, lower(q.query) AS query, MAX(q.market_purchases) AS mp, MAX(q.market_clicks) AS mc,
        MAX(q.market_impressions) AS mi, SUM(q.asin_clicks) AS ac, SUM(q.asin_purchases) AS ap, SUM(q.asin_impressions) AS ai
      FROM aba_asin_queries q JOIN aba_asin_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace='US' AND upper(r.asin) IN (${asins.map(() => '?').join(',')})
        AND r.week_end IN (${weeks.map(() => '?').join(',')})
      GROUP BY r.week_end, lower(q.query))
    GROUP BY query HAVING SUM(ac) > 0 ORDER BY marketPurchases DESC, ourClicks DESC LIMIT ?`)
    .all(PET_SHOP_ID, ...asins, ...weeks, limit);
  return rows.map((row) => ({ ...row,
    clickShare: row.marketClicks ? round(row.ourClicks / row.marketClicks) : null,
    purchaseShare: row.marketPurchases ? round(row.ourPurchases / row.marketPurchases) : null }));
}

const wordsOf = (text) => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
  .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));

/** 搜索词的每个词都出现在文字里(不分大小写、单复数)就算覆盖 */
export function termCovered(term, text) {
  const have = new Set(wordsOf(text));
  const need = wordsOf(term);
  return need.length > 0 && need.every((word) => have.has(word));
}

/** 一个词在标题、五点、后台搜索词哪里出现:title / bullets / backend / null */
export function coverageOf(term, { title, bullets = [], backend = '' }) {
  if (termCovered(term, title)) return 'title';
  if (termCovered(term, bullets.join(' '))) return 'bullets';
  if (backend && termCovered(term, backend)) return 'backend';
  return null;
}

// ---------- 同类商品判断 ----------

// 比标题时不看的词:品类通用词、尺码、颜色、卖点套话
const GENERIC_WORDS = new Set(('dog cat bed pet puppy puppie kitten for with and the of to in on or by from up size sized small medium large '
  + 'extra inch inche lbs pound black grey gray brown green blue beige white pink red khaki charcoal navy dark light cream olive coffee tan '
  + 'best new pack set piece pcs one two cover removable washable machine wash easy clean all soft comfortable comfy durable premium '
  + 'quality perfect great gift anti slip non skid bottom design indoor use home house type').split(' '));
// 形态词:对方是笼垫、垫子、圆窝、高架床而我们不是,多半不是同一种东西
const FORM_WORDS = ['crate', 'mat', 'pad', 'kennel', 'cot', 'elevated', 'raised', 'donut', 'round', 'cave', 'hooded', 'tent',
  'sofa', 'couch', 'blanket', 'heated', 'heating', 'cooling', 'stair', 'step', 'ramp'];

/** 标题里有区分度的词(去掉通用词、数字、品牌) */
export function titleWords(title, brand = '') {
  const skip = clean(brand).toLowerCase();
  return new Set(wordsOf(title).filter((word) => word.length > 2 && !/\d/.test(word) && !GENERIC_WORDS.has(word) && word !== skip));
}

/** 两个标题是不是同类商品:有区分度的词的重合度(0–1);形态不同的打对折 */
export function relevance(ownTitle, otherTitle, brand = '') {
  const own = titleWords(ownTitle, brand), other = titleWords(otherTitle, brand);
  if (!own.size || !other.size) return 0;
  let common = 0;
  for (const word of own) if (other.has(word)) common += 1;
  const score = common / Math.sqrt(own.size * other.size);
  const conflict = FORM_WORDS.some((word) => other.has(word) && !own.has(word));
  return round(conflict ? score / 2 : score, 3);
}

// ---------- 目录缓存 ----------

export function catalogMap(asins) {
  const list = [...new Set(asins.filter(Boolean))];
  const result = new Map();
  for (let index = 0; index < list.length; index += 500) {
    const part = list.slice(index, index + 500);
    for (const row of db.prepare(`SELECT * FROM pet_catalog_items WHERE asin IN (${part.map(() => '?').join(',')})`).all(...part)) result.set(row.asin, row);
  }
  return result;
}

/** 目录详情写进缓存;价格只在这次拉到时覆盖,后台搜索词和问题由 Listing 体检单独写 */
function saveCatalog(details, offers = new Map()) {
  const upsert = db.prepare(`INSERT INTO pet_catalog_items (asin, parent_asin, children_json, title, brand, bullets_json, size, color,
      product_type, main_image, image_count, bsr, bsr_category, sub_bsr, sub_category, price, list_price, offers, updated_at)
    VALUES (@asin, @parentAsin, @children, @title, @brand, @bullets, @size, @color, @productType, @mainImage, @imageCount,
      @bsr, @bsrCategory, @subBsr, @subCategory, @price, @listPrice, @offers, datetime('now','localtime'))
    ON CONFLICT(asin) DO UPDATE SET parent_asin=excluded.parent_asin, children_json=excluded.children_json, title=excluded.title,
      brand=excluded.brand, bullets_json=excluded.bullets_json, size=excluded.size, color=excluded.color, product_type=excluded.product_type,
      main_image=excluded.main_image, image_count=excluded.image_count, bsr=excluded.bsr, bsr_category=excluded.bsr_category,
      sub_bsr=excluded.sub_bsr, sub_category=excluded.sub_category,
      price=CASE WHEN @hasOffer THEN excluded.price ELSE pet_catalog_items.price END,
      list_price=CASE WHEN @hasOffer THEN excluded.list_price ELSE pet_catalog_items.list_price END,
      offers=CASE WHEN @hasOffer THEN excluded.offers ELSE pet_catalog_items.offers END,
      updated_at=excluded.updated_at`);
  for (const detail of details.values()) {
    const offer = offers.get(detail.asin);
    upsert.run({ ...detail, children: JSON.stringify(detail.children ?? []), bullets: JSON.stringify(detail.bullets ?? []),
      price: offer?.price ?? null, listPrice: offer?.listPrice ?? null, offers: offer?.offers ?? null, hasOffer: offer ? 1 : 0 });
  }
}

// ---------- 同步状态 ----------

const state = (key) => parseJson(db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value, null);
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
const clearState = (key) => db.prepare('DELETE FROM pet_price_sync_state WHERE key=?').run(key);

// 两个任务各管各的:推荐要等几十分钟的大报告,不能挡住每日同步。值是正在跑的进度
const jobs = { daily: null, suggest: null };
const BUSY = { daily: '竞品数据正在同步', suggest: '正在生成竞品推荐' };
// 搜索词报告整站几 GB,亚马逊生成常要半小时到一两个小时
const SEARCH_TERMS_MAX_WAIT_MS = 4 * 60 * 60_000;

function accountOrThrow(env) {
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  return account;
}

async function exclusive(name, prefix, work) {
  if (!isPet) throw new Error('只支持宠物版');
  if (jobs[name]) throw Object.assign(new Error(BUSY[name]), { status: 409 });
  jobs[name] = { total: 1, done: 0, step: '准备中', stage: 'starting', retryAt: null };
  const startedAt = new Date().toISOString();
  setState(`${prefix}_attempt`, { startedAt, day: pacificDay(new Date()) });
  try {
    const result = await work();
    db.transaction(() => {
      setState(`${prefix}_success`, { ...result, startedAt, completedAt: new Date().toISOString() });
      clearState(`${prefix}_error`);
    })();
    return result;
  } catch (error) {
    const message = String(error.message).slice(0, 300);
    // 失败时停在哪一步、进度写到哪,一起记下,方便看慢在哪
    const where = jobs[name] ? [jobs[name].step, jobs[name].detail].filter(Boolean).join(' · ') : '';
    setState(`${prefix}_error`, { at: new Date().toISOString(), message, where: where || null });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { jobs[name] = null; }
}

export function competitorSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  const pick = (prefix) => ({ lastSuccess: state(`${prefix}_success`), lastAttempt: state(`${prefix}_attempt`), lastError: state(`${prefix}_error`) });
  const running = Object.keys(jobs).filter((name) => jobs[name]);
  return { configured: !!account, issues, running: running[0] ?? null, jobs: { ...jobs },
    daily: { ...pick('competitors_daily'), pricingError: state('competitors_pricing_error'), listingError: state('competitors_listing_error') },
    suggest: pick('competitors_suggest') };
}

// ---------- 每日快照 ----------

const bulletsHash = (bullets) => (bullets?.length ? crypto.createHash('sha1').update(bullets.join('\n')).digest('hex').slice(0, 16) : null);
const textOf = (row) => ({ title: row?.title ?? null, bullets: parseJson(row?.bullets_json, []) });

/** 一个家族的标题/五点/主图来源:家族本身有五点就用它,否则用第一个有五点的子体 */
function familyText(family, children, catalog) {
  const own = catalog.get(family);
  if (own?.title && parseJson(own.bullets_json, []).length) return own;
  return children.map((asin) => catalog.get(asin)).find((row) => row?.title && parseJson(row.bullets_json, []).length) ?? own ?? null;
}

/**
 * 写今天的快照,和之前的快照比出变化。
 * 价格变化按子体算(差 0.5 美元以上);排名大涨 = 最好排名比 7 天前好一倍以上;标题、五点、主图、变体按家族算。
 */
export function recordSnapshots(families, today) {
  const familyAsins = [...families.keys()];
  const childAsins = [...new Set([...families.values()].flat())];
  const catalog = catalogMap([...familyAsins, ...childAsins]);
  const previous = db.prepare('SELECT * FROM pet_catalog_snapshots WHERE asin=? AND day<? ORDER BY day DESC LIMIT 1');
  const weekAgo = db.prepare('SELECT * FROM pet_catalog_snapshots WHERE asin=? AND day<=? ORDER BY day DESC LIMIT 1');
  const upsert = db.prepare(`INSERT OR REPLACE INTO pet_catalog_snapshots (asin, day, price, bsr, sub_bsr, title, bullets_hash, main_image, children_json)
    VALUES (@asin, @day, @price, @bsr, @subBsr, @title, @bulletsHash, @mainImage, @children)`);
  const change = db.prepare(`INSERT OR REPLACE INTO pet_competitor_changes (day, family_asin, asin, kind, before_value, after_value)
    VALUES (?, ?, ?, ?, ?, ?)`);
  let changes = 0;
  const note = (...args) => { change.run(today, ...args); changes += 1; };
  db.transaction(() => {
    for (const [family, children] of families) {
      const rows = children.map((asin) => catalog.get(asin)).filter(Boolean);
      const prices = rows.map((row) => row.price).filter((value) => value != null);
      const ranks = rows.map((row) => row.bsr).filter((value) => value != null);
      const subRanks = rows.map((row) => row.sub_bsr).filter((value) => value != null);
      const source = familyText(family, children, catalog);
      const text = textOf(source);
      const current = { asin: family, day: today, price: prices.length ? Math.min(...prices) : null,
        bsr: ranks.length ? Math.min(...ranks) : null, subBsr: subRanks.length ? Math.min(...subRanks) : null,
        title: text.title, bulletsHash: bulletsHash(text.bullets), mainImage: catalog.get(family)?.main_image ?? rows[0]?.main_image ?? null,
        children: JSON.stringify([...children].sort()) };
      const before = previous.get(family, today);
      if (before) {
        if (before.title && current.title && before.title !== current.title) note(family, family, 'title', before.title, current.title);
        if (before.bullets_hash && current.bulletsHash && before.bullets_hash !== current.bulletsHash) note(family, family, 'bullets', null, null);
        if (before.main_image && current.mainImage && before.main_image !== current.mainImage) note(family, family, 'main_image', before.main_image, current.mainImage);
        const was = new Set(parseJson(before.children_json, []));
        const added = children.filter((asin) => !was.has(asin));
        const removed = [...was].filter((asin) => !children.includes(asin));
        if (was.size && added.length) note(family, family, 'variants_added', String(was.size), added.join(' '));
        if (was.size && removed.length) note(family, family, 'variants_removed', String(was.size), removed.join(' '));
      }
      const old = weekAgo.get(family, shiftDay(today, -7));
      if (old?.bsr && current.bsr && current.bsr <= old.bsr / 2) note(family, family, 'bsr_up', String(old.bsr), String(current.bsr));
      upsert.run(current);
      for (const row of rows) {
        if (row.asin === family && children.length === 1 && children[0] === family) continue;
        const snapshot = { asin: row.asin, day: today, price: row.price, bsr: row.bsr, subBsr: row.sub_bsr,
          title: null, bulletsHash: null, mainImage: null, children: null };
        const last = previous.get(row.asin, today);
        if (last?.price != null && row.price != null && Math.abs(row.price - last.price) >= 0.5) {
          note(family, row.asin, row.price < last.price ? 'price_down' : 'price_up', String(last.price), String(row.price));
        }
        if (last?.price != null && row.price == null) note(family, row.asin, 'no_buybox', String(last.price), null);
        upsert.run(snapshot);
      }
      // 没有变体的家族,价格变化记在家族那一行
      if (children.length === 1 && children[0] === family && before?.price != null) {
        if (current.price != null && Math.abs(current.price - before.price) >= 0.5) {
          note(family, family, current.price < before.price ? 'price_down' : 'price_up', String(before.price), String(current.price));
        } else if (current.price == null) note(family, family, 'no_buybox', String(before.price), null);
      }
    }
    db.prepare('DELETE FROM pet_catalog_snapshots WHERE day<?').run(shiftDay(today, -KEEP_DAYS));
    db.prepare('DELETE FROM pet_competitor_changes WHERE day<?').run(shiftDay(today, -KEEP_DAYS));
  })();
  return changes;
}

/**
 * 自动给在卖款式挂对手,每个款式凑够 AUTO_TARGET 个(手动加的、已有的都算)。
 * 候选:款式最大的两个核心词在目录里搜出来的商品 + 每周推荐里这个款式的候选。
 * 只要:不是自家、品牌不同、商品类型相同、标题相似度够、价格在我们的一半到两倍之间;按相似度 × 排名挑。
 * 被删掉(忽略)的不会再挂回来。
 */
export async function autoPickCompetitors(account, gateway, today, styles, onStep = () => {}) {
  const ownAsins = new Set(styles.flatMap((style) => style.asins));
  const rows = db.prepare('SELECT style_key, asin, status FROM pet_competitors').all();
  const activeCount = new Map();
  for (const row of rows) if (row.status === 'active') activeCount.set(row.style_key, (activeCount.get(row.style_key) ?? 0) + 1);
  const targets = styles.filter((style) => style.units30 > 0 && style.asins.length && (activeCount.get(style.key) ?? 0) < AUTO_TARGET)
    .slice(0, AUTO_STYLES);
  if (!targets.length) return { styles: 0, added: 0 };
  // 自家商品的标题、类型:目录缓存里没有的现查
  const own = catalogMap([...ownAsins]);
  const missing = [...ownAsins].filter((asin) => !own.get(asin)?.title);
  if (missing.length) {
    const fetched = await fetchCatalogDetails(account, missing, gateway);
    saveCatalog(fetched);
    for (const [asin, row] of catalogMap([...fetched.keys()])) own.set(asin, row);
  }
  const ownBrands = new Set([...own.values()].map((row) => clean(row.brand).toLowerCase()).filter(Boolean));
  const listingPrice = new Map(db.prepare(`SELECT upper(asin) AS asin, MIN(price) AS price FROM pet_listing_cache
    WHERE asin IS NOT NULL AND price IS NOT NULL GROUP BY upper(asin)`).all().map((row) => [row.asin, row.price]));
  const upsert = db.prepare(`INSERT INTO pet_competitors (style_key, asin, status, source, score, evidence_json)
    VALUES (?, ?, 'active', 'auto', ?, ?)
    ON CONFLICT(style_key, asin) DO UPDATE SET status='active', source='auto', score=excluded.score,
      evidence_json=excluded.evidence_json, updated_at=datetime('now','localtime') WHERE pet_competitors.status='suggested'`);
  let added = 0;
  for (const [index, style] of targets.entries()) {
    onStep(`给「${style.key}」挑对手 ${index + 1}/${targets.length}`);
    const lead = [...style.asins].sort((a, b) => (style.asinUnits.get(b) ?? 0) - (style.asinUnits.get(a) ?? 0))
      .map((asin) => own.get(asin)).find((row) => row?.title);
    if (!lead) continue;
    const brand = clean(lead.brand).toLowerCase();
    const taken = new Set(rows.filter((row) => row.style_key === style.key && row.status !== 'suggested').map((row) => row.asin));
    const stylePrice = median(style.asins.map((asin) => listingPrice.get(asin)));
    // 候选池:目录搜索 + 推荐
    const pool = new Map();
    const terms = coreTerms(style.asins, 10).filter((term) => !ownBrands.has(term.term.split(' ')[0]));
    for (const term of terms.slice(0, 2)) {
      let found = [];
      try { found = await searchCatalogItems(account, term.term, gateway); } catch { found = []; }
      for (const detail of found) if (!pool.has(detail.asin)) pool.set(detail.asin, { detail, term: term.term, via: 'search' });
    }
    const suggested = rows.filter((row) => row.style_key === style.key && row.status === 'suggested').map((row) => row.asin);
    const needDetails = suggested.filter((asin) => !pool.has(asin));
    if (needDetails.length) {
      for (const [asin, detail] of await fetchCatalogDetails(account, needDetails, gateway)) pool.set(asin, { detail, term: null, via: 'aba' });
    }
    // 收成家族,过滤
    const families = new Map();
    for (const { detail, term, via } of pool.values()) {
      const family = detail.parentAsin ?? detail.asin;
      if (ownAsins.has(detail.asin) || ownAsins.has(family) || taken.has(family) || taken.has(detail.asin)) continue;
      const otherBrand = clean(detail.brand).toLowerCase();
      if (otherBrand && (otherBrand === brand || ownBrands.has(otherBrand))) continue;
      if (lead.product_type && detail.productType && detail.productType !== lead.product_type) continue;
      const score = relevance(lead.title, detail.title, brand);
      if (score < MIN_RELEVANCE) continue;
      const current = families.get(family);
      if (!current || score > current.relevance) families.set(family, { family, detail, term, via, relevance: score });
    }
    let candidates = [...families.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 20);
    let offers = new Map();
    try { offers = await fetchItemOffers(account, candidates.map((item) => item.detail.asin), gateway); } catch { offers = new Map(); }
    candidates = candidates.map((item) => ({ ...item, price: offers.get(item.detail.asin)?.price ?? null }))
      .filter((item) => !(item.price && stylePrice && (item.price > stylePrice * 2 || item.price < stylePrice / 2)));
    // 相似度为主,排名靠前的优先(BSR 1 万比 10 万好)
    const popularity = (bsr) => (bsr ? 1 / Math.log10(bsr + 10) : 0.15);
    candidates.sort((a, b) => b.relevance * popularity(b.detail.bsr) - a.relevance * popularity(a.detail.bsr));
    const picked = candidates.slice(0, AUTO_TARGET - (activeCount.get(style.key) ?? 0));
    if (!picked.length) continue;
    db.transaction(() => {
      for (const item of picked) {
        const result = upsert.run(style.key, item.family, item.relevance, JSON.stringify({
          auto: true, via: item.via, term: item.term, relevance: item.relevance, title: item.detail.title, brand: item.detail.brand,
          image: item.detail.mainImage, price: item.price, stylePrice, bsr: item.detail.bsr,
        }));
        added += result.changes;
      }
    })();
    saveCatalog(new Map(picked.map((item) => [item.detail.asin, item.detail])), offers);
  }
  return { styles: targets.length, added };
}

/**
 * 每天同步一次:竞品家族 → 子体目录 → 竞品价格 → 自家 Listing(后台搜索词、问题)→ 快照和变化。
 * 价格接口要「定价」角色,没有也不影响其它数据,只记下原因。
 */
export function syncCompetitors(actorId = null, gateway = amazonGateway, env = process.env, now = () => new Date()) {
  return exclusive('daily', 'competitors_daily', async () => {
    const account = accountOrThrow(env);
    const today = pacificDay(now());
    const styles = ownStyles(today);
    const ownAsins = [...new Set(styles.flatMap((style) => style.asins))];
    if (!ownAsins.length) throw Object.assign(new Error('SKU 库里还没有 ASIN'), { status: 400 });
    const progress = Object.assign(jobs.daily, { total: 6, done: 0, step: '给在卖款式挑对手', stage: 'working', retryAt: null });
    const step = (name) => Object.assign(progress, { done: progress.done + 1, step: name, stage: 'working' });

    // 0. 在卖款式对手不够的,自动挑几个挂上
    let auto = { styles: 0, added: 0 };
    try {
      auto = await autoPickCompetitors(account, gateway, today, styles, (name) => { progress.step = name; });
      clearState('competitors_autopick_error');
    } catch (error) {
      setState('competitors_autopick_error', { at: new Date().toISOString(), message: String(error.message).slice(0, 300) });
    }
    step('读取竞品家族');
    let tracked = db.prepare("SELECT id, style_key, asin FROM pet_competitors WHERE status='active'").all();

    // 1. 家族本身。存的是子体的(手动加的子体 ASIN),换成父 ASIN
    let details = await fetchCatalogDetails(account, tracked.map((row) => row.asin), gateway);
    const parents = [];
    for (const row of tracked) {
      const parent = details.get(row.asin)?.parentAsin;
      if (!parent || parent === row.asin) continue;
      const clash = db.prepare('SELECT id FROM pet_competitors WHERE style_key=? AND asin=?').get(row.style_key, parent);
      if (clash) db.prepare('DELETE FROM pet_competitors WHERE id=?').run(row.id);
      else db.prepare("UPDATE pet_competitors SET asin=?, updated_at=datetime('now','localtime') WHERE id=?").run(parent, row.id);
      parents.push(parent);
    }
    if (parents.length) {
      for (const [asin, detail] of await fetchCatalogDetails(account, parents, gateway)) details.set(asin, detail);
      tracked = db.prepare("SELECT id, style_key, asin FROM pet_competitors WHERE status='active'").all();
    }

    // 2. 子体和自家 ASIN
    step('读取竞品子体和自家商品');
    const families = new Map();
    for (const { asin } of tracked) {
      if (families.has(asin)) continue;
      const children = details.get(asin)?.children ?? [];
      families.set(asin, children.length ? children.slice(0, MAX_CHILDREN) : [asin]);
    }
    const wanted = [...new Set([...[...families.values()].flat(), ...ownAsins])].filter((asin) => !details.has(asin));
    for (const [asin, detail] of await fetchCatalogDetails(account, wanted, gateway,
      (done, total) => Object.assign(progress, { step: `读取竞品子体和自家商品 ${done}/${total}` }))) details.set(asin, detail);

    // 3. 竞品价格
    step('读取竞品价格');
    const competitorChildren = [...new Set([...families.values()].flat())].filter((asin) => !ownAsins.includes(asin));
    let offers = new Map();
    try {
      offers = await fetchItemOffers(account, competitorChildren, gateway,
        (done, total) => Object.assign(progress, { step: `读取竞品价格 ${done}/${total}` }));
      clearState('competitors_pricing_error');
    } catch (error) {
      setState('competitors_pricing_error', { at: new Date().toISOString(), message: String(error.message).slice(0, 300) });
    }
    saveCatalog(details, offers);
    // 自家价格用 Listing 售价
    const ownPrice = db.prepare('UPDATE pet_catalog_items SET price=? WHERE asin=?');
    for (const row of db.prepare(`SELECT upper(asin) AS asin, MIN(price) AS price FROM pet_listing_cache
      WHERE asin IS NOT NULL AND price IS NOT NULL GROUP BY upper(asin)`).all()) ownPrice.run(row.price, row.asin);

    // 4. 自家 Listing:后台搜索词和亚马逊报的问题
    step('读取自家 Listing');
    let listingErrors = 0;
    const saveListing = db.prepare("UPDATE pet_catalog_items SET backend_terms=?, issues_json=? WHERE asin=?");
    const skuOf = new Map();
    for (const style of styles) for (const sku of style.skus) if (sku.asin && !skuOf.has(sku.asin)) skuOf.set(sku.asin, sku.sku);
    for (const [index, [asin, sku]] of [...skuOf].entries()) {
      progress.step = `读取自家 Listing ${index + 1}/${skuOf.size}`;
      try {
        const listing = await fetchOwnListing(account, sku, gateway);
        saveListing.run(listing.backendTerms || null, JSON.stringify(listing.issues), asin);
      } catch (error) {
        listingErrors += 1;
        setState('competitors_listing_error', { at: new Date().toISOString(), message: `${sku}：${String(error.message).slice(0, 260)}` });
        if (error.status === 403) break;
      }
    }
    if (!listingErrors) clearState('competitors_listing_error');

    // 5. 快照和变化
    step('记录快照和变化');
    for (const asin of ownAsins) if (!families.has(asin)) families.set(asin, [asin]);
    const changes = recordSnapshots(families, today);
    // 自家 ASIN 的变化不提醒
    if (ownAsins.length) {
      db.prepare(`DELETE FROM pet_competitor_changes WHERE day=? AND family_asin IN (${ownAsins.map(() => '?').join(',')})`).run(today, ...ownAsins);
    }
    const result = { today, autoAdded: auto.added, families: tracked.length, children: competitorChildren.length, ownAsins: ownAsins.length,
      prices: offers.size, changes: db.prepare('SELECT COUNT(*) AS n FROM pet_competitor_changes WHERE day=?').get(today).n,
      recorded: changes, listingErrors };
    if (actorId) audit(actorId, 'US', 'sync', 'pet_competitors', null, result);
    return result;
  });
}

// ---------- 推荐竞品 ----------

/** 搜索词报告的一行 → 我们关心的字段 */
const topRow = (record) => ({
  term: clean(record.searchTerm).toLowerCase(), rank: Number(record.clickShareRank) || 0, asin: asinOf(record.clickedAsin),
  itemName: clean(record.clickedItemName).slice(0, 300) || null, clickShare: Number(record.clickShare) || 0,
  conversionShare: Number(record.conversionShare) || 0, searchRank: Number(record.searchFrequencyRank) || null,
});

/**
 * 给候选 ASIN 打分:款式每个核心词按市场购买量占比加权,ASIN 在这个词的(点击份额 + 转化份额)/ 2 乘上权重。
 * 自家 ASIN 不算。返回 Map(asin → { score, terms })
 */
export function scoreCandidates(terms, topByTerm, ownAsins) {
  const total = terms.reduce((sum, term) => sum + (term.marketPurchases || 0), 0) || terms.length;
  const own = new Set(ownAsins);
  const result = new Map();
  for (const term of terms) {
    const weight = (term.marketPurchases || (total === terms.length ? 1 : 0)) / total;
    for (const row of topByTerm.get(term.term) ?? []) {
      if (!row.asin || own.has(row.asin)) continue;
      if (!result.has(row.asin)) result.set(row.asin, { score: 0, terms: [] });
      const item = result.get(row.asin);
      item.score += weight * (row.clickShare + row.conversionShare) / 2;
      item.terms.push({ term: term.term, rank: row.rank, clickShare: round(row.clickShare), conversionShare: round(row.conversionShare) });
    }
  }
  return result;
}

/** 下载一周的搜索词报告,只留核心词那几行,连同各段耗时(看慢在亚马逊还是下载)。报告还没出返回 null */
const SEARCH_TERM_FIELD = /"searchTerm"\s*:\s*"((?:[^"\\]|\\.)*)"/;

async function fetchTopClicked(account, week, termSet, gateway, progress) {
  const rows = [];
  let records = 0;
  const label = `${week.week_start.slice(5)}~${week.week_end.slice(5)}`;
  const scan = createArrayRecordScanner((record) => {
    const term = clean(record?.searchTerm).toLowerCase();
    if (!termSet.has(term)) return;
    const row = topRow(record);
    if (row.asin && row.rank) rows.push(row);
  }, { keep: (raw) => {
    records += 1;
    const match = SEARCH_TERM_FIELD.exec(raw);
    if (!match) return true;
    try { return termSet.has(clean(JSON.parse(`"${match[1]}"`)).toLowerCase()); } catch { return true; }
  } });
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));
  const startedAt = Date.now();
  const timing = { amazonMin: null, waitMin: null, downloadMin: null, mb: null, records: 0 };
  let downloadStart = null, bytes = 0;
  const onBytes = (received, total) => {
    bytes = received;
    const seconds = (Date.now() - downloadStart) / 1000;
    const speed = seconds > 5 ? received / seconds : 0;
    const left = speed && total ? Math.ceil((total - received) / speed / 60) : null;
    Object.assign(progress, { stage: 'downloading',
      detail: `已下载 ${mb(received)}${total ? ` / ${mb(total)}` : ''}${speed ? `，${(speed / 1048576).toFixed(1)} MB/秒` : ''}${left != null ? `，大约还要 ${left} 分钟` : ''}；扫过 ${records.toLocaleString('en-US')} 行，找到核心词 ${rows.length} 行` });
  };
  const done = await runReport(account, SEARCH_TERMS_REPORT, {
    start: new Date(`${week.week_start}T00:00:00Z`), end: new Date(`${week.week_end}T00:00:00Z`),
    options: { reportPeriod: 'WEEK' }, maxWaitMs: SEARCH_TERMS_MAX_WAIT_MS, reuse: true,
    onDocument: async (document, refresh) => { await gateway.stream(document, scan, onBytes, refresh); return true; },
    onProgress: ({ stage, retryAt = null, waitedMs, amazonMs }) => {
      const begins = stage === 'downloading' && downloadStart == null;
      if (begins) {
        downloadStart = Date.now();
        timing.waitMin = minutes(downloadStart - startedAt);
        if (amazonMs != null) timing.amazonMin = minutes(amazonMs);
      }
      Object.assign(progress, { stage, retryAt, step: `搜索词报告（${label} 那周）`,
        detail: stage === 'processing' ? `亚马逊正在生成整站报告，已等 ${minutes(waitedMs ?? 0)} 分钟（常要 30–90 分钟）`
          : stage === 'downloading' ? (begins ? '开始下载' : progress.detail) : undefined });
    },
  }, gateway);
  if (!done) return null;
  Object.assign(timing, { downloadMin: minutes(Date.now() - downloadStart), mb: Math.round(bytes / 1048576), records });
  console.log(`[competitors-suggest] ${week.week_end} 亚马逊生成 ${timing.amazonMin ?? '?'} 分钟，本次等待 ${timing.waitMin} 分钟，`
    + `下载 ${timing.downloadMin} 分钟 ${timing.mb} MB，${records} 行，核心词 ${rows.length} 行`);
  return { rows, timing };
}

/**
 * 每周一次:按自家款式的核心词,从搜索词报告里找点击前 3 的别家 ASIN,换成家族后给每个款式推荐前 10。
 * 同一个家族只推荐给重合分最高的款式;已加入、已忽略的不再推荐。类目和我们不同的不推荐,价格差一倍以上的降权。
 */
export function suggestCompetitors(actorId = null, gateway = amazonGateway, env = process.env, now = () => new Date()) {
  return exclusive('suggest', 'competitors_suggest', async () => {
    const account = accountOrThrow(env);
    const today = pacificDay(now());
    const styles = ownStyles(today).map((style) => ({ ...style, terms: coreTerms(style.asins) })).filter((style) => style.terms.length);
    if (!styles.length) throw Object.assign(new Error('ABA 还没有自家 ASIN 的搜索词数据,请先在 ABA 页面同步'), { status: 400 });
    const termSet = new Set(styles.flatMap((style) => style.terms.map((term) => term.term)));
    const progress = Object.assign(jobs.suggest, { total: 4, done: 0, step: '搜索词报告', stage: 'creating', retryAt: null });

    // 1. 最近一周的报告还没出就用上一周
    let week = null, rows = null, timing = null;
    for (const candidate of completeWeeks(today, 2)) {
      const fetched = await fetchTopClicked(account, candidate, termSet, gateway, progress);
      if (fetched) { ({ rows, timing } = fetched); week = candidate; break; }
    }
    if (!rows) throw new Error('亚马逊最近两周的搜索词报告都还没有生成,过几天再试');
    db.transaction(() => {
      db.prepare('DELETE FROM pet_search_term_top WHERE week_end=?').run(week.week_end);
      const insert = db.prepare(`INSERT OR REPLACE INTO pet_search_term_top (week_end, term, rank, asin, item_name, click_share, conversion_share, search_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) insert.run(week.week_end, row.term, row.rank, row.asin, row.itemName, row.clickShare, row.conversionShare, row.searchRank);
    })();
    const topByTerm = new Map();
    for (const row of rows) {
      if (!topByTerm.has(row.term)) topByTerm.set(row.term, []);
      topByTerm.get(row.term).push(row);
    }

    // 2. 打分,再查候选的目录(家族、类目)
    Object.assign(progress, { done: 1, step: '读取候选竞品的目录', stage: 'working', detail: undefined });
    const ownAsins = [...new Set(styles.flatMap((style) => style.asins))];
    const scored = styles.map((style) => ({ style, candidates: scoreCandidates(style.terms, topByTerm, ownAsins) }));
    const candidateAsins = [...new Set(scored.flatMap(({ candidates }) => [...candidates.keys()]))];
    const details = await fetchCatalogDetails(account, [...candidateAsins, ...ownAsins], gateway);
    const ownFamilies = new Set(ownAsins.flatMap((asin) => [asin, details.get(asin)?.parentAsin]).filter(Boolean));

    // 3. 价格(没有「定价」角色就不按价格降权)
    Object.assign(progress, { done: 2, step: '读取候选竞品价格' });
    let offers = new Map();
    try { offers = await fetchItemOffers(account, candidateAsins, gateway); } catch { offers = new Map(); }
    saveCatalog(new Map([...details].filter(([asin]) => candidateAsins.includes(asin))), offers);

    // 4. 合成家族,挑最合适的款式
    Object.assign(progress, { done: 3, step: '生成推荐' });
    const listingPrice = new Map(db.prepare(`SELECT upper(asin) AS asin, MIN(price) AS price FROM pet_listing_cache
      WHERE asin IS NOT NULL AND price IS NOT NULL GROUP BY upper(asin)`).all().map((row) => [row.asin, row.price]));
    const best = new Map();
    for (const { style, candidates } of scored) {
      const types = style.asins.map((asin) => details.get(asin)?.productType).filter(Boolean);
      const styleType = types.sort((a, b) => types.filter((t) => t === b).length - types.filter((t) => t === a).length)[0] ?? null;
      const stylePrice = median(style.asins.map((asin) => listingPrice.get(asin)));
      const families = new Map();
      for (const [asin, item] of candidates) {
        const detail = details.get(asin);
        const family = detail?.parentAsin ?? asin;
        if (ownFamilies.has(family) || ownFamilies.has(asin)) continue;
        if (styleType && detail?.productType && detail.productType !== styleType) continue;
        let score = item.score;
        const price = offers.get(asin)?.price ?? null;
        const priceFar = !!(price && stylePrice && (price > stylePrice * 2 || price < stylePrice / 2));
        if (priceFar) score /= 2;
        if (!families.has(family)) families.set(family, { family, score: 0, terms: [], asins: [], title: null, brand: null, image: null, prices: [], priceFar: false });
        const entry = families.get(family);
        entry.score += score;
        entry.asins.push(asin);
        entry.priceFar ||= priceFar;
        if (price) entry.prices.push(price);
        for (const term of item.terms) if (!entry.terms.some((existing) => existing.term === term.term)) entry.terms.push(term);
        entry.title ||= detail?.title ?? topByTerm.get(item.terms[0]?.term)?.find((row) => row.asin === asin)?.itemName ?? null;
        entry.brand ||= detail?.brand ?? null;
        entry.image ||= detail?.mainImage ?? null;
      }
      // 标题和我们不像的(笼垫推给狗窝、毛绒圆窝推给牛津布窝)不推荐
      const lead = [...style.asins].sort((a, b) => (style.asinUnits.get(b) ?? 0) - (style.asinUnits.get(a) ?? 0))
        .map((asin) => details.get(asin)).find((detail) => detail?.title);
      for (const entry of families.values()) {
        if (lead && entry.title && relevance(lead.title, entry.title, lead.brand) < MIN_RELEVANCE) continue;
        const current = best.get(entry.family);
        if (!current || entry.score > current.entry.score) best.set(entry.family, { style: style.key, entry, stylePrice });
      }
    }
    const taken = new Set(db.prepare("SELECT asin FROM pet_competitors WHERE status IN ('active','ignored')").all().map((row) => row.asin));
    const byStyle = new Map();
    for (const { style, entry, stylePrice } of best.values()) {
      if (taken.has(entry.family) || entry.asins.some((asin) => taken.has(asin)) || entry.score <= 0) continue;
      if (!byStyle.has(style)) byStyle.set(style, []);
      byStyle.get(style).push({ ...entry, stylePrice });
    }
    let suggested = 0;
    db.transaction(() => {
      db.prepare("DELETE FROM pet_competitors WHERE status='suggested'").run();
      const insert = db.prepare(`INSERT INTO pet_competitors (style_key, asin, status, source, score, evidence_json)
        VALUES (?, ?, 'suggested', 'aba', ?, ?)`);
      for (const [style, list] of byStyle) {
        for (const entry of list.sort((a, b) => b.score - a.score).slice(0, SUGGEST_PER_STYLE)) {
          insert.run(style, entry.family, round(entry.score, 5), JSON.stringify({
            week: week.week_end, terms: entry.terms.sort((a, b) => a.rank - b.rank), asins: entry.asins, title: entry.title,
            brand: entry.brand, image: entry.image, price: median(entry.prices), stylePrice: entry.stylePrice, priceFar: entry.priceFar,
          }));
          suggested += 1;
        }
      }
    })();
    const result = { week: week.week_end, terms: termSet.size, matchedRows: rows.length, candidates: candidateAsins.length, suggested, timing };
    if (actorId) audit(actorId, 'US', 'sync', 'pet_competitor_suggestions', null, result);
    return result;
  });
}

// ---------- 页面数据 ----------

const KIND_LABEL = { price_down: '降价', price_up: '涨价', title: '改了标题', bullets: '改了五点', main_image: '换了主图',
  bsr_up: '排名大涨', no_buybox: '没有购物车', variants_added: '新增变体', variants_removed: '下架变体' };

/** 最近 days 天的变化提醒,带上竞品挂在哪个款式、品牌和标题 */
export function recentChanges(today, days = 30) {
  const styleOf = new Map(db.prepare("SELECT asin, style_key FROM pet_competitors WHERE status='active'").all().map((row) => [row.asin, row.style_key]));
  const rows = db.prepare('SELECT * FROM pet_competitor_changes WHERE day>=? ORDER BY day DESC, id DESC LIMIT 500').all(shiftDay(today, -days));
  const catalog = catalogMap(rows.flatMap((row) => [row.family_asin, row.asin]));
  return rows.filter((row) => styleOf.has(row.family_asin)).map((row) => ({
    id: row.id, day: row.day, kind: row.kind, label: KIND_LABEL[row.kind] ?? row.kind, styleKey: styleOf.get(row.family_asin),
    family: row.family_asin, asin: row.asin, before: row.before_value, after: row.after_value,
    brand: catalog.get(row.family_asin)?.brand ?? catalog.get(row.asin)?.brand ?? null,
    title: catalog.get(row.family_asin)?.title ?? catalog.get(row.asin)?.title ?? null,
    size: catalog.get(row.asin)?.size ?? null, color: catalog.get(row.asin)?.color ?? null,
  }));
}

/** 每个 ASIN 最新一个月的第三方数据 */
function latestMetrics(asins) {
  const list = [...new Set(asins)];
  if (!list.length) return new Map();
  const result = new Map();
  for (let index = 0; index < list.length; index += 500) {
    const part = list.slice(index, index + 500);
    for (const row of db.prepare(`SELECT m.* FROM pet_competitor_metrics m WHERE m.asin IN (${part.map(() => '?').join(',')})
      AND m.month=(SELECT MAX(month) FROM pet_competitor_metrics WHERE asin=m.asin)`).all(...part)) result.set(row.asin, row);
  }
  return result;
}

const childView = (row, metrics, ownSizes) => ({
  asin: row.asin, size: row.size, color: row.color, sizeLabel: sizeLabel(row.size), sameSize: ownSizes.has(sizeLabel(row.size)),
  price: row.price, listPrice: row.list_price, offers: row.offers, bsr: row.bsr, subBsr: row.sub_bsr, subCategory: row.sub_category,
  rating: metrics?.rating ?? null, reviews: metrics?.reviews ?? null, units: metrics?.units ?? null, metricsMonth: metrics?.month ?? null,
});

/** 家族汇总:价格区间、最好排名、评分(评论数最多的那个子体)、子体销量合计 */
function familySummary(children) {
  const prices = children.map((child) => child.price).filter((value) => value != null);
  const ranks = children.map((child) => child.bsr).filter((value) => value != null);
  const subRanks = children.filter((child) => child.subBsr != null).sort((a, b) => a.subBsr - b.subBsr);
  const reviewed = children.filter((child) => child.reviews != null).sort((a, b) => b.reviews - a.reviews)[0];
  const sold = children.filter((child) => child.units != null);
  return {
    priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    bsr: ranks.length ? Math.min(...ranks) : null, subBsr: subRanks[0]?.subBsr ?? null, subCategory: subRanks[0]?.subCategory ?? null,
    rating: reviewed?.rating ?? null, reviews: reviewed?.reviews ?? null,
    units: sold.length ? sold.reduce((sum, child) => sum + child.units, 0) : null, metricsMonth: sold[0]?.metricsMonth ?? reviewed?.metricsMonth ?? null,
  };
}

function history(asin, today, days = 30) {
  return db.prepare('SELECT day, price, bsr FROM pet_catalog_snapshots WHERE asin=? AND day>? ORDER BY day')
    .all(asin, shiftDay(today, -days));
}

/** 一个款式的完整情报:自家、竞品家族、推荐、核心词覆盖矩阵 */
export function styleDetail(styleKey, today) {
  const style = ownStyles(today).find((item) => item.key === styleKey);
  if (!style) return null;
  const ownSizes = style.sizes;
  const competitors = db.prepare(`SELECT * FROM pet_competitors WHERE style_key=? AND status IN ('active','suggested')
    ORDER BY status='suggested', score DESC, created_at`).all(styleKey);
  const ignored = db.prepare("SELECT COUNT(*) AS n FROM pet_competitors WHERE style_key=? AND status='ignored'").get(styleKey).n;
  const familyCatalog = catalogMap(competitors.map((row) => row.asin));
  const childrenOf = (row) => {
    const children = parseJson(familyCatalog.get(row.asin)?.children_json, []).slice(0, MAX_CHILDREN);
    return children.length ? children : [row.asin];
  };
  const allChildren = competitors.filter((row) => row.status === 'active').flatMap(childrenOf);
  const catalog = catalogMap([...allChildren, ...style.asins]);
  const metrics = latestMetrics([...allChildren, ...style.asins]);
  const terms = coreTerms(style.asins);

  // 自家:每个 ASIN 一行;覆盖矩阵用近 30 天卖得最多的那个 ASIN 的文案
  const ownChildren = style.asins.map((asin) => catalog.get(asin)).filter(Boolean)
    .map((row) => ({ ...childView(row, metrics.get(row.asin), ownSizes), units30: style.asinUnits.get(row.asin) ?? 0 }));
  const lead = [...style.asins].sort((a, b) => (style.asinUnits.get(b) ?? 0) - (style.asinUnits.get(a) ?? 0))
    .map((asin) => catalog.get(asin)).find((row) => row?.title) ?? null;
  const ownText = { title: lead?.title ?? null, bullets: parseJson(lead?.bullets_json, []), backend: lead?.backend_terms ?? '' };
  const own = { key: style.key, skus: style.skus, asins: style.asins, sizes: sortSizes([...ownSizes]), units7: style.units7, units30: style.units30,
    brand: lead?.brand ?? null, title: ownText.title, bullets: ownText.bullets, backend: ownText.backend, leadAsin: lead?.asin ?? null,
    mainImage: lead?.main_image ?? null, imageCount: lead?.image_count ?? null, children: ownChildren, ...familySummary(ownChildren) };

  const families = competitors.map((row) => {
    const evidence = parseJson(row.evidence_json, {});
    const family = familyCatalog.get(row.asin);
    if (row.status === 'suggested') {
      return { id: row.id, asin: row.asin, status: row.status, source: row.source, score: row.score, evidence,
        title: family?.title ?? evidence.title ?? null, brand: family?.brand ?? evidence.brand ?? null,
        mainImage: family?.main_image ?? evidence.image ?? null };
    }
    const children = childrenOf(row).map((asin) => catalog.get(asin)).filter(Boolean).map((child) => childView(child, metrics.get(child.asin), ownSizes));
    const source = familyText(row.asin, childrenOf(row), new Map([...catalog, ...familyCatalog]));
    const text = textOf(source);
    const snapshots = history(row.asin, today);
    const weekAgo = snapshots.find((point) => point.day >= shiftDay(today, -7) && point.price != null);
    const summary = familySummary(children);
    return { id: row.id, asin: row.asin, status: row.status, source: row.source, score: row.score, evidence,
      addedAt: row.created_at, title: text.title ?? family?.title ?? null, brand: family?.brand ?? source?.brand ?? null,
      bullets: text.bullets, mainImage: family?.main_image ?? (children[0] ? catalog.get(children[0].asin)?.main_image : null) ?? null,
      imageCount: source?.image_count ?? family?.image_count ?? null, synced: !!family, children, history: snapshots,
      priceChange7: weekAgo && summary.priceMin != null ? round(summary.priceMin - weekAgo.price, 2) : null,
      coverage: Object.fromEntries(terms.map((term) => [term.term, coverageOf(term.term, text)])), ...summary };
  });
  const active = families.filter((family) => family.status === 'active');
  const competitorPrices = active.map((family) => family.priceMin).filter((value) => value != null);
  return {
    today, own: { ...own, coverage: Object.fromEntries(terms.map((term) => [term.term, coverageOf(term.term, ownText)])), history: [] },
    competitors: active, suggestions: families.filter((family) => family.status === 'suggested'), ignored,
    terms, priceBand: competitorPrices.length ? { min: Math.min(...competitorPrices), median: median(competitorPrices), max: Math.max(...competitorPrices) } : null,
  };
}

// 近 4 周市场成交到这个数才算「有量的词」
export const BIG_TERM_PURCHASES = 20;

/**
 * 自家 Listing 体检:每个 ASIN 一行。红 = 影响展示或收录(亚马逊报错、后台搜索词超 249 字节、标题超 200、没五点没图),
 * 黄 = 建议改(品牌、标题长度、五点条数、图片数、有量的核心词没写、亚马逊警告、比同尺码竞品贵 20% 以上)。
 * 每条检查带 code,页面和「本周要做」按 code 给修改办法。
 */
export function listingHealth(today) {
  const styles = ownStyles(today);
  const rows = [];
  for (const style of styles) {
    if (!style.asins.length) continue;
    const terms = coreTerms(style.asins, 10);
    const catalog = catalogMap(style.asins);
    const families = db.prepare("SELECT asin FROM pet_competitors WHERE style_key=? AND status='active'").all(style.key).map((row) => row.asin);
    const familyCatalog = catalogMap(families);
    const competitorChildren = families.flatMap((asin) => {
      const children = parseJson(familyCatalog.get(asin)?.children_json, []);
      return children.length ? children.slice(0, MAX_CHILDREN) : [asin];
    });
    const childCatalog = catalogMap(competitorChildren);
    // 同尺码比价:竞品里尺码和我们一样的子体的中位价
    const priceBySize = new Map();
    for (const asin of competitorChildren) {
      const child = childCatalog.get(asin);
      if (child?.price == null || !child.size) continue;
      const label = sizeLabel(child.size);
      if (!priceBySize.has(label)) priceBySize.set(label, []);
      priceBySize.get(label).push(child.price);
    }
    const imageMedian = median(families.map((asin) => familyCatalog.get(asin)?.image_count ?? null));
    for (const asin of style.asins) {
      const row = catalog.get(asin);
      const sku = style.skus.find((item) => item.asin === asin);
      const checks = [];
      const add = (level, code, text) => checks.push({ level, code, text });
      if (!row) {
        rows.push({ styleKey: style.key, asin, sku: sku?.sku ?? null, size: sku?.size ?? null, color: sku?.color ?? null,
          units30: style.asinUnits.get(asin) ?? 0, title: null, checks: [{ level: 'info', code: 'no_data', text: '还没同步到这个 ASIN 的目录数据' }] });
        continue;
      }
      const title = row.title ?? '';
      const bullets = parseJson(row.bullets_json, []);
      const backend = row.backend_terms ?? '';
      const issues = parseJson(row.issues_json, []);
      const errors = issues.filter((issue) => /error/i.test(issue.severity));
      const warnings = issues.filter((issue) => /warn/i.test(issue.severity));
      // 红 = 影响展示或收录:亚马逊报错(主图被屏蔽、五点违规)、后台搜索词超字节整段不生效、标题超长、没有五点或图片
      if (errors.length) add('red', 'amazon_error', `亚马逊报错 ${errors.length} 条：${errors[0].message}`);
      if (Buffer.byteLength(backend, 'utf8') > 249) add('red', 'backend_bytes', `后台搜索词 ${Buffer.byteLength(backend, 'utf8')} 字节，超过 249 字节整段不生效`);
      if (title.length > 200) add('red', 'title_long', `标题 ${title.length} 字符，超过 200 可能被亚马逊压制`);
      if (!bullets.length) add('red', 'no_bullets', '没有五点描述');
      if (!row.image_count) add('red', 'no_images', '目录里没有图片');
      // 黄 = 建议改
      if (row.brand && !title.toLowerCase().includes(row.brand.toLowerCase())) add('yellow', 'brand', `标题里没有品牌「${row.brand}」`);
      if (title.length && title.length < 80) add('yellow', 'title_short', `标题只有 ${title.length} 字符，可以多放核心词`);
      if (bullets.length && bullets.length < 5) add('yellow', 'bullets', `五点只有 ${bullets.length} 条`);
      if (row.image_count && row.image_count < 7) add('yellow', 'images', `图片 ${row.image_count} 张，少于 7 张`);
      if (imageMedian && row.image_count && row.image_count < imageMedian) add('yellow', 'images_vs', `图片比竞品中位数（${imageMedian} 张）少`);
      // 只提有量的词(近 4 周市场成交 20 单以上),颜色、品牌这类小词不算
      const missing = terms.filter((term) => term.marketPurchases >= BIG_TERM_PURCHASES && !coverageOf(term.term, { title, bullets, backend }));
      if (missing.length) add('yellow', 'terms', `有量的核心词没写：${missing.map((term) => `${term.term}（4 周 ${term.marketPurchases} 单）`).join('、')}`);
      if (warnings.length) add('yellow', 'amazon_warning', `亚马逊警告 ${warnings.length} 条：${warnings[0].message}`);
      const sizeKey = sizeLabel(row.size ?? sku?.size);
      const priceMedian = sizeKey ? median(priceBySize.get(sizeKey) ?? []) : null;
      if (priceMedian && row.price && row.price > priceMedian * 1.2) {
        add('yellow', 'price', `售价 $${row.price.toFixed(2)} 比同尺码（${sizeKey}）竞品中位价 $${priceMedian.toFixed(2)} 高 ${Math.round((row.price / priceMedian - 1) * 100)}%`);
      }
      rows.push({ styleKey: style.key, asin, sku: sku?.sku ?? null, size: row.size ?? sku?.size ?? null, color: row.color ?? sku?.color ?? null,
        units30: style.asinUnits.get(asin) ?? 0, title, brand: row.brand, bulletCount: bullets.length, imageCount: row.image_count,
        backendBytes: row.backend_terms == null ? null : Buffer.byteLength(backend, 'utf8'), price: row.price, checks });
    }
  }
  // 有红的在前;同一档里卖得多的在前(不卖的老款排后面)
  const reds = (row) => row.checks.some((check) => check.level === 'red') ? 1 : 0;
  const yellows = (row) => row.checks.filter((check) => check.level === 'yellow').length;
  return rows.sort((a, b) => reds(b) - reds(a) || b.units30 - a.units30 || yellows(b) - yellows(a));
}

// ---------- 第三方月度数据(卖家精灵) ----------

/** 导入一行:ASIN 必填,其它选填;数字带 $ , % 都能认 */
export function normalizeMetric(input) {
  const asin = asinOf(input?.asin);
  if (!asin) throw new Error(`ASIN「${clean(input?.asin)}」不是 10 位字母或数字`);
  const number = (value, integer = false) => {
    const text = clean(value).replace(/[$,\s]/g, '');
    if (!text || text === '-' || text === '—') return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${asin} 的数字「${clean(value)}」不合法`);
    return integer ? Math.round(parsed) : parsed;
  };
  const rating = number(input.rating);
  if (rating != null && rating > 5) throw new Error(`${asin} 的评分不能超过 5`);
  return { asin, parentAsin: asinOf(input.parentAsin), rating, reviews: number(input.reviews, true), units: number(input.units, true),
    revenue: number(input.revenue), price: number(input.price) };
}

export function saveMetrics(rows, month, sourceFile, userId) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('请选择数据月份'), { status: 400 });
  const normalized = rows.map(normalizeMetric);
  const upsert = db.prepare(`INSERT INTO pet_competitor_metrics (asin, month, parent_asin, rating, reviews, units, revenue, price, source_file, updated_by, updated_at)
    VALUES (@asin, @month, @parentAsin, @rating, @reviews, @units, @revenue, @price, @sourceFile, @userId, datetime('now','localtime'))
    ON CONFLICT(asin, month) DO UPDATE SET parent_asin=excluded.parent_asin, rating=excluded.rating, reviews=excluded.reviews,
      units=excluded.units, revenue=excluded.revenue, price=excluded.price, source_file=excluded.source_file,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
  db.transaction(() => { for (const row of normalized) upsert.run({ ...row, month, sourceFile, userId }); })();
  return normalized.length;
}

// ---------- 接口 ----------

const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

export const competitorRouter = express.Router();
competitorRouter.use(requireLogin);
competitorRouter.use((req, res, next) => {
  if (!isPet) return res.status(404).json({ error: '只有宠物版有竞品监控' });
  if (!req.session.user.productIntel) return res.status(403).json({ error: '账号未开通产品情报' });
  next();
});

competitorRouter.get('/overview', (req, res) => {
  const today = todayOf();
  const counts = new Map();
  for (const row of db.prepare('SELECT style_key, status, COUNT(*) AS n FROM pet_competitors GROUP BY style_key, status').all()) {
    if (!counts.has(row.style_key)) counts.set(row.style_key, {});
    counts.get(row.style_key)[row.status] = row.n;
  }
  const changes = recentChanges(today);
  const styles = ownStyles(today).map((style) => ({ key: style.key, skus: style.skus.length, asins: style.asins.length,
    units7: style.units7, units30: style.units30, active: counts.get(style.key)?.active ?? 0, suggested: counts.get(style.key)?.suggested ?? 0,
    changes7: changes.filter((change) => change.styleKey === style.key && change.day >= shiftDay(today, -7)).length }));
  res.json({ today, styles, changes, sync: competitorSyncStatus() });
});

competitorRouter.get('/style', (req, res) => {
  const detail = styleDetail(clean(req.query.key), todayOf());
  if (!detail) return res.status(404).json({ error: '找不到这个款式' });
  res.json(detail);
});

competitorRouter.get('/health', (req, res) => res.json({ today: todayOf(), rows: listingHealth(todayOf()), sync: competitorSyncStatus() }));

/** 手动加竞品:粘贴 ASIN,一次最多 50 个。子体 ASIN 下次同步时自动换成父 ASIN */
competitorRouter.post('/', async (req, res) => {
  const styleKey = clean(req.body?.styleKey);
  if (!ownStyles(todayOf()).some((style) => style.key === styleKey)) return res.status(400).json({ error: '请选择自家款式' });
  const asins = [...new Set(String(req.body?.asins ?? '').toUpperCase().match(/\b[A-Z0-9]{10}\b/g) ?? [])];
  if (!asins.length) return res.status(400).json({ error: '没有找到 ASIN（10 位字母或数字）' });
  if (asins.length > 50) return res.status(400).json({ error: '一次最多加 50 个 ASIN' });
  const own = new Set(db.prepare("SELECT upper(asin) AS asin FROM sku_items WHERE user_id=? AND country='US' AND asin IS NOT NULL").all(PET_SHOP_ID).map((row) => row.asin));
  // 配好了亚马逊凭证就先查一次家族,马上能看到标题和图片;查不到不影响加入
  let details = new Map();
  const { account } = petSpConfig();
  if (account) {
    try { details = await fetchCatalogDetails(account, asins); saveCatalog(details); } catch { details = new Map(); }
  }
  const upsert = db.prepare(`INSERT INTO pet_competitors (style_key, asin, status, source, added_by) VALUES (?, ?, 'active', 'manual', ?)
    ON CONFLICT(style_key, asin) DO UPDATE SET status='active', added_by=excluded.added_by, updated_at=datetime('now','localtime')`);
  const added = [], skipped = [];
  db.transaction(() => {
    for (const asin of asins) {
      const family = details.get(asin)?.parentAsin ?? asin;
      if (own.has(asin) || own.has(family)) { skipped.push(asin); continue; }
      db.prepare("DELETE FROM pet_competitors WHERE asin=? AND style_key<>? AND status IN ('suggested','ignored')").run(family, styleKey);
      upsert.run(styleKey, family, req.session.user.id);
      added.push(family);
    }
  })();
  audit(req.session.user.id, 'US', 'create', 'pet_competitors', null, { styleKey, added, skipped });
  res.json({ added: [...new Set(added)], skipped });
});

/** 推荐的点「加入」、「忽略」;已加入的也可以忽略(不再推荐),或换到别的款式 */
competitorRouter.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pet_competitors WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '找不到这个竞品' });
  const status = clean(req.body?.status) || row.status;
  if (!['active', 'ignored'].includes(status)) return res.status(400).json({ error: '状态只能是加入或忽略' });
  const styleKey = clean(req.body?.styleKey) || row.style_key;
  if (styleKey !== row.style_key && !ownStyles(todayOf()).some((style) => style.key === styleKey)) return res.status(400).json({ error: '请选择自家款式' });
  db.transaction(() => {
    if (styleKey !== row.style_key) db.prepare('DELETE FROM pet_competitors WHERE style_key=? AND asin=?').run(styleKey, row.asin);
    db.prepare(`UPDATE pet_competitors SET status=?, style_key=?, added_by=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(status, styleKey, req.session.user.id, row.id);
  })();
  audit(req.session.user.id, 'US', 'update', 'pet_competitors', row.id, { asin: row.asin, from: row.status, status, styleKey });
  res.json({ ok: true });
});

/** 移出监控(以后还可能被推荐;不想再看到就用「忽略」) */
competitorRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM pet_competitors WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '找不到这个竞品' });
  // 自动挂上的移出后记成忽略,不然第二天又会被自动挂回来
  if (row.source === 'auto') db.prepare("UPDATE pet_competitors SET status='ignored', updated_at=datetime('now','localtime') WHERE id=?").run(row.id);
  else db.prepare('DELETE FROM pet_competitors WHERE id=?').run(row.id);
  audit(req.session.user.id, 'US', 'delete', 'pet_competitors', row.id, { asin: row.asin, styleKey: row.style_key });
  res.json({ ok: true });
});

competitorRouter.post('/metrics', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的行' });
  if (rows.length > 20000) return res.status(400).json({ error: '一次最多导入 20000 行' });
  try {
    const count = saveMetrics(rows, clean(req.body?.month), clean(req.body?.sourceFile).slice(0, 200), req.session.user.id);
    audit(req.session.user.id, 'US', 'import', 'pet_competitor_metrics', null, { month: req.body.month, count });
    res.json({ imported: count });
  } catch (error) { res.status(error.status ?? 400).json({ error: error.message }); }
});

competitorRouter.get('/status', (req, res) => res.json(competitorSyncStatus()));

/** kind = daily(同步竞品数据)或 suggest(重新生成推荐) */
competitorRouter.post('/sync', (req, res) => {
  const status = competitorSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  const kind = req.body?.kind === 'suggest' ? 'suggest' : 'daily';
  if (status.jobs[kind]) return res.status(409).json({ error: BUSY[kind] });
  const run = kind === 'suggest' ? suggestCompetitors : syncCompetitors;
  void run(req.session.user.id).catch((error) => console.error(`[competitors-${kind}]`, error.message));
  res.status(202).json({ accepted: true, kind });
});

/**
 * 每小时检查一次:美西时间每天第一次检查时同步竞品数据;
 * 推荐每周一次(上次成功满 6 天;失败的 3 小时后重试),需要 ABA 已经有自家 ASIN 的数据。两个任务互不等待。
 */
export function startCompetitorScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const ago = (time) => (time ? Date.now() - Date.parse(time) : Infinity);
  const run = () => {
    const status = competitorSyncStatus();
    if (!status.configured) return;
    const today = pacificDay(new Date());
    const hasAba = db.prepare("SELECT 1 FROM aba_asin_reports WHERE user_id=? AND marketplace='US' LIMIT 1").get(PET_SHOP_ID);
    // 推荐:上次成功满 6 天;失败或中途重启的,3 小时后再试(亚马逊那边已申请的报告会接着用)
    if (hasAba && !status.jobs.suggest && ago(status.suggest.lastSuccess?.completedAt) >= 6 * 86400000
      && ago(status.suggest.lastAttempt?.startedAt) >= 3 * 60 * 60_000) {
      void suggestCompetitors().catch((error) => console.error('[competitors-suggest]', error.message));
    }
    if (!status.jobs.daily && status.daily.lastAttempt?.day !== today) {
      void syncCompetitors().catch((error) => console.error('[competitors-daily]', error.message));
    }
  };
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

export { KIND_LABEL };
