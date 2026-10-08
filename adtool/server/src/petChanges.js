// 宠物版改动待确认队列:Claude 通过连接器提议 → 超级管理员在「待确认改动」页勾选确认 → 写回亚马逊 → 核对是否生效。
// Listing(标题、五点、后台搜索词、售价)用 SP-API Listings Items 接口提交,提交前先让亚马逊预检一遍;
// 广告改动有广告 API 凭证时直接调用,没有时转成批量表,下载后到广告后台上传。每一步都记进 pet_change_log。
import express from 'express';
import { db, audit } from './db.js';
import { requireRole } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, pacificMidnight, petSpConfig, shiftDay, US_MARKETPLACE } from './petAmazon.js';
import { withProfit } from './petCosts.js';
import { adsGateway, executeAdChange, petAdsConfig } from './petAds.js';

export const KINDS = {
  listing_title: { group: 'listing', label: '标题', attribute: 'item_name' },
  listing_bullets: { group: 'listing', label: '五点描述', attribute: 'bullet_point' },
  listing_search_terms: { group: 'listing', label: '后台搜索词', attribute: 'generic_keyword' },
  listing_price: { group: 'listing', label: '售价', attribute: 'purchasable_offer' },
  listing_sale_price: { group: 'listing', label: '促销价', attribute: 'purchasable_offer' },
  ad_state: { group: 'ad', label: '投放状态' },
  ad_bid: { group: 'ad', label: '竞价' },
  ad_budget: { group: 'ad', label: '每日预算' },
  ad_negative: { group: 'ad', label: '新增否定' },
};
export const LISTING_FIELDS = { title: 'listing_title', bullets: 'listing_bullets', search_terms: 'listing_search_terms', price: 'listing_price',
  sale_price: 'listing_sale_price' };
// 原价和促销价都在 purchasable_offer 这一个属性里
const OFFER_KINDS = new Set(['listing_price', 'listing_sale_price']);
export const AD_ENTITIES = ['campaign', 'adGroup', 'keyword', 'productTarget', 'productAd'];
export const AD_ACTIONS = ['pause', 'enable', 'set_bid', 'set_budget', 'add_negative'];
export const STATUS_LABEL = {
  pending: '待确认', queued: '排队中', running: '执行中', submitted: '已提交，等亚马逊生效', applied: '已生效', not_applied: '未生效',
  export: '待导出批量表', exported: '已导出，待上传', failed: '失败', rejected: '已拒绝', superseded: '已被新提议替代',
};
const VIEWS = {
  pending: ['pending'],
  active: ['queued', 'running', 'submitted', 'export', 'exported', 'failed'],
  history: ['applied', 'not_applied', 'rejected', 'superseded'],
};
export const ACTION_LABEL = {
  proposed: '提议', superseded: '被新提议替代', edited: '修改提议值', approved: '确认执行', rejected: '拒绝', stale: '亚马逊上的值变了，退回待确认',
  submitted: '已提交亚马逊', applied: '已生效', verified: '核对已生效', not_applied: '核对未生效', failed: '失败', retried: '重试',
  to_export: '转为批量表', exported: '已导出批量表', uploaded: '标记已上传', reverted: '生成撤回改动',
};
// 亚马逊的限制:标题 200 字符,后台搜索词 250 字节以内(超了整段不收录),五点最多 10 条
export const LIMITS = { titleChars: 200, bulletChars: 500, bullets: 10, searchTermBytes: 249, batch: 40, reason: 1000 };
// 提交后超过这么久亚马逊上还是旧值,就算没生效
const VERIFY_HOURS = 48;

const clean = (value) => String(value ?? '').trim();
const normText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const parseJson = (text, fallback = null) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
const round2 = (value) => Number(Number(value).toFixed(2));
const money = (value) => `$${Number(value).toFixed(2)}`;
const lowerKey = (value) => clean(value).toLowerCase();
const defaultDeps = { gateway: amazonGateway, adsGateway, env: process.env };
// 和库里其它时间一样用服务器本地时间
const nowLocal = () => db.prepare("SELECT datetime('now','localtime') AS t").get().t;

// ---------- 读亚马逊 Listing ----------

const listingPath = (account, sku) => `/listings/2021-08-01/items/${encodeURIComponent(account.sellerId)}/${encodeURIComponent(sku)}`;
const forUs = (entry) => !entry?.marketplace_id || entry.marketplace_id === US_MARKETPLACE;
const textValues = (attributes, name) => (attributes?.[name] ?? []).filter(forUs).map((entry) => entry?.value).filter((value) => typeof value === 'string');
const mainOffer = (attributes) => (attributes?.purchasable_offer ?? []).find((offer) => forUs(offer) && (!offer.audience || offer.audience === 'ALL')) ?? null;
const offerPrice = (offer) => {
  const value = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 亚马逊返回的促销起止时间可能是完整时间也可能只有日期,统一成太平洋时间的日期
const dayOf = (value) => (!value ? null : DAY_RE.test(String(value)) ? String(value) : pacificDay(value) || null);
const todayPacific = () => pacificDay(new Date());

/** 报价里还没结束的促销价:{ price, start, end },没有就是 null */
function saleOf(offer) {
  for (const entry of offer?.discounted_price?.[0]?.schedule ?? []) {
    const price = Number(entry?.value_with_tax);
    const end = dayOf(entry?.end_at);
    if (!Number.isFinite(price) || (end && end < todayPacific())) continue;
    return { price: round2(price), start: dayOf(entry?.start_at), end };
  }
  return null;
}

/** 促销价写回亚马逊的时间:开始日太平洋时间 0 点,结束日太平洋时间最后一秒 */
const saleSchedule = ({ price, start, end }) => ({ value_with_tax: price, start_at: pacificMidnight(start).toISOString(),
  end_at: new Date(pacificMidnight(shiftDay(end, 1)).getTime() - 1000).toISOString() });
const nearDay = (a, b) => a === b || (a && b && Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) <= 86400000);

async function readListing(account, sku, gateway) {
  let payload;
  try {
    payload = await gateway.request(account, account.region, 'GET', listingPath(account, sku), { query: {
      marketplaceIds: US_MARKETPLACE, includedData: 'summaries,attributes,issues', issueLocale: 'en_US',
    } });
  } catch (error) {
    if (error.upstreamStatus === 404) throw new Error(`亚马逊上找不到 SKU ${sku}`);
    throw error;
  }
  const summary = (payload?.summaries ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? payload?.summaries?.[0] ?? {};
  return { sku, asin: summary.asin ?? null, productType: summary.productType ?? null, attributes: payload?.attributes ?? {}, issues: payload?.issues ?? [] };
}

/** 某种 Listing 改动在亚马逊上的当前值 */
export function currentValue(kind, attributes) {
  if (kind === 'listing_title') return textValues(attributes, 'item_name')[0] ?? null;
  if (kind === 'listing_bullets') return textValues(attributes, 'bullet_point');
  if (kind === 'listing_search_terms') return textValues(attributes, 'generic_keyword').join(' ');
  if (kind === 'listing_price') return offerPrice(mainOffer(attributes));
  if (kind === 'listing_sale_price') return saleOf(mainOffer(attributes));
  return null;
}

export function sameValue(kind, a, b) {
  if (kind === 'listing_bullets') {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => normText(item) === normText(b[index]));
  }
  if (kind === 'listing_price') return a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
  // 促销价:都没有算一样;起止日差一天以内算一样(亚马逊存时间时可能换了时区)
  if (kind === 'listing_sale_price') {
    if (a == null || b == null) return a == null && b == null;
    return Math.abs(Number(a.price) - Number(b.price)) < 0.005 && nearDay(a.start, b.start) && nearDay(a.end, b.end);
  }
  if (kind === 'listing_search_terms') return normText(a).toLowerCase() === normText(b).toLowerCase();
  return normText(a) === normText(b);
}

/**
 * 亚马逊 Listings Items 的 patch:文字类属性带语言和站点;售价只改 our_price,促销价只改 discounted_price,
 * 同一报价里的其它字段原样保留。pending 是同一 SKU 已提交、亚马逊还没生效的原价 / 促销价改动,一起带上,免得互相覆盖。
 */
export function patchFor(kind, after, attributes = {}, pending = []) {
  const tag = { language_tag: 'en_US', marketplace_id: US_MARKETPLACE };
  if (kind === 'listing_title') return { op: 'replace', path: '/attributes/item_name', value: [{ value: after, ...tag }] };
  if (kind === 'listing_bullets') return { op: 'replace', path: '/attributes/bullet_point', value: after.map((value) => ({ value, ...tag })) };
  if (kind === 'listing_search_terms') return { op: 'replace', path: '/attributes/generic_keyword', value: [{ value: after, ...tag }] };
  if (OFFER_KINDS.has(kind)) {
    const offers = (attributes.purchasable_offer ?? []).filter(forUs);
    const main = mainOffer(attributes);
    if (!main && kind === 'listing_sale_price') throw new Error('这个 SKU 在亚马逊上还没有报价（原价），没法设促销价');
    const updated = main ? { ...structuredClone(main), marketplace_id: US_MARKETPLACE, currency: main.currency ?? 'USD' }
      : { marketplace_id: US_MARKETPLACE, currency: 'USD' };
    for (const change of [...pending, { kind, after }]) {
      if (change.kind === 'listing_price') updated.our_price = [{ schedule: [{ value_with_tax: change.after }] }];
      else if (change.after == null) delete updated.discounted_price;
      else updated.discounted_price = [{ schedule: [saleSchedule(change.after)] }];
    }
    const value = main ? offers.map((offer) => (offer === main ? updated : offer)) : [...offers, updated];
    return { op: 'replace', path: '/attributes/purchasable_offer', value };
  }
  throw new Error(`不是 Listing 改动：${kind}`);
}

// ---------- 检查提议的新值 ----------

const SMALL_WORDS = new Set(['a', 'an', 'and', 'or', 'for', 'the', 'with', 'to', 'of', 'in', 'on', 'by', 'at', 'from', '&', '-', '|', ',']);

function repeatedWords(text, limit) {
  const counts = new Map();
  for (const word of text.toLowerCase().split(/[\s,;/|]+/).filter(Boolean)) {
    if (SMALL_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > limit).map(([word]) => word);
}

/** 毛利:按 SKU 的成本和亚马逊费用算新旧售价下的单件毛利 */
function priceImpact(sku, before, after) {
  const [old, next] = withProfit([{ sku, price: before ?? null }, { sku, price: after }]);
  return { profitBefore: before == null ? null : old.profit, marginBefore: before == null ? null : old.margin,
    profitAfter: next.profit, marginAfter: next.margin, breakEven: next.breakEven, missing: next.missing };
}

/**
 * 检查一条 Listing 提议:返回整理好的新值、拦下来的错误和要提醒的问题。
 * before 是亚马逊上的当前值;attributes 只有提议时才有,用来看有没有促销价。
 */
export function checkListingValue(kind, raw, before, { sku, attributes, listPrice } = {}) {
  const errors = [], warnings = [];
  let value, extra = {};
  if (kind === 'listing_title') {
    if (typeof raw !== 'string') return { errors: ['标题要填文字'] };
    value = normText(raw);
    if (!value) errors.push('标题不能为空');
    if (value.length > LIMITS.titleChars) errors.push(`标题 ${value.length} 个字符，超过亚马逊上限 ${LIMITS.titleChars}`);
    if (/[!$?_{}^¬¦]/.test(value)) warnings.push('标题里有 ! $ ? _ { } ^ ¬ ¦ 这类字符，亚马逊规定除非是品牌名的一部分否则不能用');
    const repeated = repeatedWords(value, 2);
    if (repeated.length) warnings.push(`标题里 ${repeated.join('、')} 出现超过 2 次，亚马逊不允许同一个词重复超过两次`);
  } else if (kind === 'listing_bullets') {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return { errors: ['五点要填文字列表，每条一句'] };
    value = raw.map(normText).filter(Boolean);
    if (!value.length) errors.push('五点不能为空');
    if (value.length > LIMITS.bullets) errors.push(`五点最多 ${LIMITS.bullets} 条，这里有 ${value.length} 条`);
    const long = value.map((item, index) => [index + 1, item.length]).filter(([, length]) => length > LIMITS.bulletChars);
    if (long.length) warnings.push(`第 ${long.map(([index]) => index).join('、')} 条超过 ${LIMITS.bulletChars} 个字符，前台可能显示不全`);
    if (Array.isArray(before) && value.length < before.length) warnings.push(`比现在少 ${before.length - value.length} 条，少掉的会从 Listing 上删掉`);
  } else if (kind === 'listing_search_terms') {
    if (typeof raw !== 'string') return { errors: ['后台搜索词要填文字，词之间用空格'] };
    value = normText(raw);
    const size = Buffer.byteLength(value, 'utf8');
    if (!value) errors.push('后台搜索词不能为空');
    if (size > LIMITS.searchTermBytes) errors.push(`后台搜索词 ${size} 字节，超过 ${LIMITS.searchTermBytes} 字节亚马逊会整段不收录`);
    if (/[,;，；]/.test(value)) warnings.push('后台搜索词不需要逗号分号，空格分隔就行，标点也占字节');
    const repeated = repeatedWords(value, 1);
    if (repeated.length) warnings.push(`${repeated.join('、')} 重复出现，重复的词不会多加权重，白占字节`);
    extra = { bytes: size };
  } else if (kind === 'listing_price') {
    const number = typeof raw === 'number' ? raw : Number(clean(raw).replace(/^\$/, ''));
    if (!Number.isFinite(number) || number <= 0 || number > 10000) return { errors: ['售价要填大于 0 的美元金额'] };
    value = round2(number);
    if (before != null && Math.abs(value - before) / before > 0.3) warnings.push(`改价幅度 ${((value - before) / before * 100).toFixed(0)}%，超过 30%`);
    if (sku) {
      const impact = priceImpact(sku, before, value);
      extra = { priceImpact: impact };
      if (impact.profitAfter != null && impact.profitAfter < 0) warnings.push(`按新价每件亏 ${money(-impact.profitAfter)}（保本价 ${money(impact.breakEven)}）`);
      else if (impact.breakEven != null && value < impact.breakEven) warnings.push(`低于保本价 ${money(impact.breakEven)}`);
      if (impact.missing?.length) warnings.push(`缺${impact.missing.join('、')}，算不出新价的毛利`);
    }
    const sale = saleOf(mainOffer(attributes));
    if (sale) warnings.push(`这个 SKU 有促销价 ${money(sale.price)}（${sale.start ?? '?'} 到 ${sale.end ?? '不限'}），改原价不影响前台显示的促销价，要改前台价请改促销价`);
  } else if (kind === 'listing_sale_price') {
    const list = listPrice ?? offerPrice(mainOffer(attributes));
    const today = todayPacific();
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { price: raw };
    const priceText = clean(input.price).replace(/^\$/, '');
    if (input.price == null || priceText === '' || Number(priceText) === 0) {
      // 0 或空:取消促销价
      if (before == null) return { errors: ['现在没有促销价，不用取消'] };
      value = null;
      extra = { listPrice: list };
      if (list != null) warnings.push(`取消后前台恢复原价 ${money(list)}`);
    } else {
      const number = Number(priceText);
      if (!Number.isFinite(number) || number <= 0 || number > 10000) return { errors: ['促销价要填大于 0 的美元金额，填 0 表示取消促销价'] };
      const start = clean(input.start) || (before?.start && before.start <= today ? before.start : today);
      const end = clean(input.end) || before?.end || '';
      if (!DAY_RE.test(start)) errors.push('促销开始日期要写成 YYYY-MM-DD');
      if (!end) errors.push('新设促销价要写结束日期（saleEnd，YYYY-MM-DD）');
      else if (!DAY_RE.test(end)) errors.push('促销结束日期要写成 YYYY-MM-DD');
      else if (end < start) errors.push('促销结束日期早于开始日期');
      else if (end < today) errors.push('促销结束日期已经过了');
      value = { price: round2(number), start, end };
      if (list == null) errors.push('亚马逊上读不到这个 SKU 的原价，没法设促销价');
      else if (value.price >= list) errors.push(`促销价要低于原价 ${money(list)}`);
      const shown = before?.price ?? list;
      if (shown != null && Math.abs(value.price - shown) / shown > 0.3) warnings.push(`前台价从 ${money(shown)} 变成 ${money(value.price)}，幅度 ${((value.price - shown) / shown * 100).toFixed(0)}%，超过 30%`);
      extra = { listPrice: list };
      if (sku) {
        const impact = priceImpact(sku, shown, value.price);
        extra.priceImpact = impact;
        if (impact.profitAfter != null && impact.profitAfter < 0) warnings.push(`按促销价每件亏 ${money(-impact.profitAfter)}（保本价 ${money(impact.breakEven)}）`);
        else if (impact.breakEven != null && value.price < impact.breakEven) warnings.push(`低于保本价 ${money(impact.breakEven)}`);
        if (impact.missing?.length) warnings.push(`缺${impact.missing.join('、')}，算不出促销价的毛利`);
      }
    }
  } else {
    return { errors: [`不认识的改动类型：${kind}`] };
  }
  if (!errors.length && (before != null || kind === 'listing_sale_price') && sameValue(kind, value, before)) errors.push('和亚马逊上现在的一样，不用改');
  return { value, errors, warnings, extra };
}

// ---------- 写库和日志 ----------

function log(proposalId, batchId, actor, userId, action, detail = null) {
  db.prepare('INSERT INTO pet_change_log (proposal_id, batch_id, actor, user_id, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(proposalId, batchId ?? null, actor, userId ?? null, action, detail == null ? null : JSON.stringify(detail));
}

function update(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE pet_change_proposals SET ${keys.map((key) => `${key}=@${key}`).join(', ')}, updated_at=datetime('now','localtime') WHERE id=@id`)
    .run({ ...fields, id });
}

/** 一批提议写库:同一个对象同一个字段还在待确认的旧提议会被替代 */
function saveProposals({ title, summary, source, userId, items }) {
  if (!items.length) return { batchId: null, ids: [], superseded: 0 };
  let batchId = null, superseded = 0;
  const ids = [];
  const actor = source === 'claude' ? 'claude' : 'user';
  db.transaction(() => {
    batchId = Number(db.prepare('INSERT INTO pet_change_batches (title, summary, source, created_by) VALUES (?, ?, ?, ?)')
      .run(title, summary || null, source, userId ?? null).lastInsertRowid);
    for (const item of items) {
      for (const old of db.prepare("SELECT id, batch_id FROM pet_change_proposals WHERE target_key=? AND status='pending'").all(item.targetKey)) {
        update(old.id, { status: 'superseded' });
        log(old.id, old.batch_id, actor, userId, 'superseded', { by: 'batch', batchId });
        superseded += 1;
      }
      const id = Number(db.prepare(`INSERT INTO pet_change_proposals (batch_id, kind, target_key, target_json, before_json, after_json, reason,
        warnings_json, source, revert_of, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(batchId, item.kind, item.targetKey,
        JSON.stringify(item.target), item.before === undefined ? null : JSON.stringify(item.before), JSON.stringify(item.after), item.reason,
        item.warnings?.length ? JSON.stringify(item.warnings) : null, source, item.revertOf ?? null, userId ?? null).lastInsertRowid);
      log(id, batchId, actor, userId, 'proposed', { after: item.after });
      ids.push(id);
    }
  })();
  return { batchId, ids, superseded };
}

function skuDirectory() {
  const rows = db.prepare("SELECT sku, asin, style, size, color FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID);
  const map = new Map(rows.map((row) => [lowerKey(row.sku), row]));
  for (const row of db.prepare('SELECT sku, asin FROM pet_listing_cache').all()) {
    if (!map.has(lowerKey(row.sku))) map.set(lowerKey(row.sku), { sku: row.sku, asin: row.asin });
  }
  return map;
}

function checkBatch({ title, summary, changes }) {
  const name = normText(title);
  if (!name) throw new Error('请给这批改动起个标题，比如「方窝牛津 S/M 标题和五点」');
  if (!Array.isArray(changes) || !changes.length) throw new Error('没有改动');
  if (changes.length > LIMITS.batch) throw new Error(`一批最多 ${LIMITS.batch} 条改动`);
  return { title: name.slice(0, 100), summary: clean(summary).slice(0, 2000) };
}

function checkReason(reason) {
  const text = normText(reason);
  if (!text) return { error: '请写明为什么改（依据的数据）' };
  return { text: text.slice(0, LIMITS.reason) };
}

/**
 * 提议 Listing 改动。每条 { sku, field: title|bullets|search_terms|price, value, reason }。
 * 先从亚马逊读当前值记成「改动前」,检查不过的放进 rejected,不写库。
 */
export async function proposeListingChanges(input, { userId = null, source = 'claude', gateway = amazonGateway, env = process.env } = {}) {
  const { title, summary } = checkBatch(input);
  const { account, issues } = petSpConfig(env);
  if (!account) throw new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证(PET_SP_*)');
  const directory = skuDirectory();
  const listings = new Map();
  const items = [], rejected = [];
  const seen = new Set();
  for (const [index, change] of input.changes.entries()) {
    const sku = clean(change?.sku), kind = LISTING_FIELDS[change?.field];
    const reject = (error) => rejected.push({ index, sku, field: change?.field ?? null, error });
    if (!kind) { reject('field 只能是 title、bullets、search_terms、price、sale_price'); continue; }
    const known = directory.get(lowerKey(sku));
    if (!known) { reject(`SKU 库里没有 ${sku || '(空)'}`); continue; }
    const reason = checkReason(change.reason);
    if (reason.error) { reject(reason.error); continue; }
    const targetKey = `listing:${lowerKey(known.sku)}:${kind}`;
    if (seen.has(targetKey)) { reject('同一批里同一个 SKU 的同一项重复了'); continue; }
    let listing = listings.get(lowerKey(known.sku));
    if (!listing) {
      try {
        listing = await readListing(account, known.sku, gateway);
      } catch (error) {
        listing = { error: error.message };
      }
      listings.set(lowerKey(known.sku), listing);
    }
    if (listing.error) { reject(`读不到亚马逊上的 Listing：${listing.error}`); continue; }
    if (!listing.productType) { reject('亚马逊没有返回这个 SKU 的商品类型，没法提交修改'); continue; }
    const before = currentValue(kind, listing.attributes);
    const raw = kind === 'listing_sale_price' ? { price: change.value, start: change.saleStart, end: change.saleEnd } : change.value;
    const checked = checkListingValue(kind, raw, before, { sku: known.sku, attributes: listing.attributes });
    if (checked.errors.length) { reject(checked.errors.join('；')); continue; }
    seen.add(targetKey);
    items.push({ kind, targetKey, before, after: checked.value, reason: reason.text, warnings: checked.warnings,
      target: { sku: known.sku, asin: listing.asin ?? known.asin ?? null, productType: listing.productType,
        style: known.style ?? null, size: known.size ?? null, color: known.color ?? null, ...checked.extra } });
  }
  const saved = saveProposals({ title, summary, source, userId, items });
  return { batchId: saved.batchId, created: items.map((item, index) => ({ id: saved.ids[index], sku: item.target.sku,
    field: Object.keys(LISTING_FIELDS).find((key) => LISTING_FIELDS[key] === item.kind), warnings: item.warnings })),
  rejected, superseded: saved.superseded };
}

const AD_ID = /^\d{1,20}$/;

/** 检查一条广告提议,返回要写库的样子;不合法抛错 */
export function checkAdChange(change) {
  const action = clean(change?.action);
  if (!AD_ACTIONS.includes(action)) throw new Error(`action 只能是 ${AD_ACTIONS.join('、')}`);
  const id = (key, label) => {
    const value = clean(change[key]);
    if (!AD_ID.test(value)) throw new Error(`${label}（${key}）要填广告后台的数字编号`);
    return value;
  };
  const warnings = [];
  const names = { campaignName: normText(change.campaignName).slice(0, 200) || null, adGroupName: normText(change.adGroupName).slice(0, 200) || null,
    label: normText(change.label).slice(0, 300) || null };
  const campaignId = id('campaignId', '广告活动编号');
  const current = change.current;
  if (action === 'add_negative') {
    const level = clean(change.level) || 'adGroup';
    if (!['adGroup', 'campaign'].includes(level)) throw new Error('level 只能是 adGroup 或 campaign');
    const matchType = clean(change.matchType);
    if (!['exact', 'phrase', 'asin'].includes(matchType)) throw new Error('否定的 matchType 只能是 exact、phrase、asin');
    let text = normText(change.negativeText);
    if (matchType === 'asin') {
      text = text.replace(/^asin\s*=\s*"?|"$/gi, '').toUpperCase();
      if (!/^B0[0-9A-Z]{8}$/.test(text)) throw new Error('否定商品要填 B0 开头的 ASIN');
      if (level !== 'adGroup') throw new Error('否定商品定向只能加在广告组上');
    } else {
      if (!text) throw new Error('否定关键词不能为空');
      if (text.length > 80) throw new Error('否定关键词太长（超过 80 个字符）');
      if (text.split(' ').length > 10) warnings.push('否定词超过 10 个单词，亚马逊可能拒收');
    }
    const adGroupId = level === 'adGroup' ? id('adGroupId', '广告组编号') : null;
    return { kind: 'ad_negative', warnings, before: null, after: { matchType, text },
      targetKey: `ad:negative:${level}:${campaignId}:${adGroupId ?? ''}:${matchType}:${text.toLowerCase()}`,
      target: { level, campaignId, adGroupId, ...names } };
  }
  const entity = action === 'set_budget' ? 'campaign' : clean(change.entity);
  if (!AD_ENTITIES.includes(entity)) throw new Error(`entity 只能是 ${AD_ENTITIES.join('、')}`);
  const adGroupId = entity === 'campaign' ? null : id('adGroupId', '广告组编号');
  const entityId = entity === 'campaign' ? campaignId : entity === 'adGroup' ? adGroupId : id('entityId', `${entity} 的编号`);
  const target = { entity, entityId, campaignId, adGroupId, ...names, currentReported: current != null };
  const key = (field) => `ad:${entity}:${entityId}:${field}`;
  if (action === 'pause' || action === 'enable') {
    const state = action === 'pause' ? 'paused' : 'enabled';
    const before = ['enabled', 'paused'].includes(clean(current).toLowerCase()) ? { state: clean(current).toLowerCase() } : null;
    if (before?.state === state) throw new Error(`已经是${state === 'paused' ? '暂停' : '启用'}状态`);
    return { kind: 'ad_state', warnings, before, after: { state }, targetKey: key('state'), target };
  }
  const now = current == null || current === '' ? null : Number(current);
  if (now != null && !Number.isFinite(now)) throw new Error('current 要填数字');
  if (action === 'set_bid') {
    if (!['keyword', 'productTarget', 'adGroup'].includes(entity)) throw new Error('竞价只能改关键词、商品定向或广告组默认竞价');
    const bid = round2(change.bid);
    if (!Number.isFinite(bid) || bid < 0.02) throw new Error('竞价最低 0.02 美元');
    if (bid > 100) throw new Error('竞价超过 100 美元，请确认金额');
    if (bid > 5) warnings.push(`竞价 ${money(bid)} 偏高`);
    if (now != null && now > 0 && Math.abs(bid - now) / now > 0.5) warnings.push(`竞价变动 ${((bid - now) / now * 100).toFixed(0)}%，超过 50%`);
    if (now != null && Math.abs(bid - now) < 0.005) throw new Error('和现在的竞价一样');
    return { kind: 'ad_bid', warnings, before: now == null ? null : { bid: round2(now) }, after: { bid }, targetKey: key('bid'), target };
  }
  const budget = round2(change.budget);
  if (!Number.isFinite(budget) || budget < 1) throw new Error('每日预算最低 1 美元');
  if (budget > 100000) throw new Error('每日预算太大，请确认金额');
  if (now != null && now > 0 && (budget - now) / now > 1) warnings.push(`预算翻了 ${(budget / now).toFixed(1)} 倍`);
  if (now != null && Math.abs(budget - now) < 0.005) throw new Error('和现在的预算一样');
  return { kind: 'ad_budget', warnings, before: now == null ? null : { budget: round2(now) }, after: { budget }, targetKey: key('budget'), target };
}

/** 提议广告改动。广告 API 还没开通,网站里没有广告数据,编号和当前值由提议方给,页面上标明「未核实」 */
export function proposeAdChanges(input, { userId = null, source = 'claude' } = {}) {
  const { title, summary } = checkBatch(input);
  const items = [], rejected = [];
  const seen = new Set();
  for (const [index, change] of input.changes.entries()) {
    try {
      const reason = checkReason(change?.reason);
      if (reason.error) throw new Error(reason.error);
      const item = checkAdChange(change);
      if (seen.has(item.targetKey)) throw new Error('同一批里同一个对象的同一项重复了');
      seen.add(item.targetKey);
      items.push({ ...item, reason: reason.text });
    } catch (error) {
      rejected.push({ index, action: change?.action ?? null, error: error.message });
    }
  }
  const saved = saveProposals({ title, summary, source, userId, items });
  return { batchId: saved.batchId, created: items.map((item, index) => ({ id: saved.ids[index], kind: item.kind, target: item.target, warnings: item.warnings })),
    rejected, superseded: saved.superseded };
}

// ---------- 执行 ----------

class ListingIssueError extends Error {
  constructor(message, issues) { super(message); this.issues = issues; }
}

const issueText = (issues) => issues.map((issue) => `${issue.code ? `[${issue.code}] ` : ''}${clean(issue.message)}`).join('；').slice(0, 800);
const issueList = (issues = []) => issues.map((issue) => ({ severity: issue.severity, code: issue.code ?? null, message: clean(issue.message).slice(0, 400),
  attributes: issue.attributeNames ?? [] }));

async function executeListing(row, target, before, after, deps) {
  const { account, issues } = petSpConfig(deps.env);
  if (!account) throw new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证(PET_SP_*)');
  const listing = await readListing(account, target.sku, deps.gateway);
  const current = currentValue(row.kind, listing.attributes);
  if (sameValue(row.kind, current, after)) {
    update(row.id, { status: 'applied', channel: 'sp_api', executed_at: nowLocal(),
      verified_at: nowLocal(), result_json: JSON.stringify({ note: '亚马逊上已经是这个值，没有再提交' }) });
    log(row.id, row.batch_id, 'system', null, 'applied', { note: 'already' });
    return;
  }
  if (!sameValue(row.kind, current, before)) {
    const warnings = [...new Set([...parseJson(row.warnings_json, []), '确认前亚马逊上的值变了（可能有人在后台改过），改动前已更新成最新值，请再看一遍'])];
    update(row.id, { status: 'pending', before_json: JSON.stringify(current), warnings_json: JSON.stringify(warnings), decided_by: null, decided_at: null });
    log(row.id, row.batch_id, 'system', null, 'stale', { expected: before, found: current });
    return;
  }
  // 同一 SKU 刚提交、亚马逊还没生效的原价 / 促销价改动:这次整段替换报价时一起带上
  const pending = OFFER_KINDS.has(row.kind) ? db.prepare(`SELECT kind, after_json FROM pet_change_proposals
    WHERE target_key IN (?, ?) AND status='submitted' AND id<>? ORDER BY executed_at, id`)
    .all(`listing:${lowerKey(target.sku)}:listing_price`, `listing:${lowerKey(target.sku)}:listing_sale_price`, row.id)
    .map((item) => ({ kind: item.kind, after: parseJson(item.after_json) })) : [];
  const body = { productType: listing.productType ?? target.productType, patches: [patchFor(row.kind, after, listing.attributes, pending)] };
  const preview = await deps.gateway.request(account, account.region, 'PATCH', listingPath(account, target.sku),
    { query: { marketplaceIds: US_MARKETPLACE, mode: 'VALIDATION_PREVIEW', issueLocale: 'en_US' }, body });
  const previewErrors = (preview?.issues ?? []).filter((issue) => issue.severity === 'ERROR');
  if (preview?.status === 'INVALID' || previewErrors.length) {
    throw new ListingIssueError(`亚马逊预检没通过，没有提交：${issueText(previewErrors.length ? previewErrors : preview?.issues ?? []) || preview?.status}`, preview?.issues ?? []);
  }
  const response = await deps.gateway.request(account, account.region, 'PATCH', listingPath(account, target.sku),
    { query: { marketplaceIds: US_MARKETPLACE, issueLocale: 'en_US' }, body });
  if (response?.status !== 'ACCEPTED') {
    throw new ListingIssueError(`亚马逊没有接受：${issueText(response?.issues ?? []) || response?.status || '没有返回状态'}`, response?.issues ?? []);
  }
  update(row.id, { status: 'submitted', channel: 'sp_api', executed_at: nowLocal(), error: null,
    result_json: JSON.stringify({ submissionId: response.submissionId ?? null, issues: issueList(response.issues), previewIssues: issueList(preview?.issues) }) });
  log(row.id, row.batch_id, 'system', null, 'submitted', { submissionId: response.submissionId ?? null });
}

async function executeAd(row, target, after, deps) {
  const { account } = petAdsConfig(deps.env);
  if (!account) {
    update(row.id, { status: 'export', channel: 'bulk_sheet' });
    log(row.id, row.batch_id, 'system', null, 'to_export');
    return;
  }
  const result = await executeAdChange(account, { kind: row.kind, target, after }, deps.adsGateway);
  const now = nowLocal();
  update(row.id, { status: 'applied', channel: 'ads_api', executed_at: now, verified_at: now, error: null, result_json: JSON.stringify(result) });
  log(row.id, row.batch_id, 'system', null, 'applied', result.response);
}

async function executeOne(row, deps) {
  const target = parseJson(row.target_json, {}), before = parseJson(row.before_json), after = parseJson(row.after_json);
  if (KINDS[row.kind]?.group === 'listing') return executeListing(row, target, before, after, deps);
  return executeAd(row, target, after, deps);
}

let running = null;

/** 把排队的改动一条一条执行完。已经在跑就返回同一个任务,执行中途新确认的也会接着做 */
export function kickQueue(deps = defaultDeps) {
  if (running) return running;
  running = (async () => {
    for (;;) {
      const row = db.prepare("SELECT * FROM pet_change_proposals WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (!row) return;
      update(row.id, { status: 'running' });
      try {
        await executeOne(row, deps);
      } catch (error) {
        update(row.id, { status: 'failed', error: clean(error.message).slice(0, 1000) || '执行失败',
          result_json: error.issues ? JSON.stringify({ issues: issueList(error.issues) }) : row.result_json });
        log(row.id, row.batch_id, 'system', null, 'failed', { error: clean(error.message).slice(0, 1000) });
      }
    }
  })().finally(() => { running = null; });
  return running;
}

export const waitForQueue = async () => { while (running) await running; };

/**
 * 核对已提交的 Listing 改动:亚马逊上变成新值就算生效;提交满 48 小时还是旧值算没生效,带上亚马逊报的问题。
 * 同一个 SKU 只读一次。
 */
export async function verifySubmitted(deps = defaultDeps) {
  const rows = db.prepare(`SELECT *, (julianday('now','localtime') - julianday(executed_at)) * 24 AS age_hours
    FROM pet_change_proposals WHERE status='submitted' ORDER BY id`).all();
  if (!rows.length) return { checked: 0 };
  const { account } = petSpConfig(deps.env);
  if (!account) return { checked: 0 };
  const listings = new Map();
  let checked = 0;
  for (const row of rows) {
    const target = parseJson(row.target_json, {}), after = parseJson(row.after_json);
    const key = lowerKey(target.sku);
    if (!listings.has(key)) {
      try { listings.set(key, await readListing(account, target.sku, deps.gateway)); } catch (error) { listings.set(key, { error: error.message }); }
    }
    const listing = listings.get(key);
    if (listing.error) continue;
    checked += 1;
    const current = currentValue(row.kind, listing.attributes);
    const related = issueList(listing.issues.filter((issue) => (issue.attributeNames ?? []).includes(KINDS[row.kind].attribute)));
    const result = { ...parseJson(row.result_json, {}), listingIssues: related, checkedAt: new Date().toISOString() };
    if (sameValue(row.kind, current, after)) {
      update(row.id, { status: 'applied', verified_at: nowLocal(), result_json: JSON.stringify(result) });
      log(row.id, row.batch_id, 'system', null, 'verified');
    } else if (row.age_hours >= VERIFY_HOURS) {
      const error = `提交 ${VERIFY_HOURS} 小时后亚马逊上仍不是新值${related.length ? `；亚马逊报的问题：${issueText(related)}` : ''}`;
      update(row.id, { status: 'not_applied', error, result_json: JSON.stringify({ ...result, current }) });
      log(row.id, row.batch_id, 'system', null, 'not_applied', { current });
    } else {
      update(row.id, { result_json: JSON.stringify(result) });
    }
  }
  return { checked };
}

// ---------- 读给页面和连接器 ----------

export function targetLabel(kind, target = {}) {
  if (KINDS[kind]?.group === 'listing') return [target.sku, [target.style, target.size, target.color].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return [target.campaignName ?? target.campaignId, target.adGroupName, target.label].filter(Boolean).join(' / ');
}

function shape(row) {
  return {
    id: row.id, batchId: row.batch_id, kind: row.kind, kindLabel: KINDS[row.kind]?.label ?? row.kind, group: KINDS[row.kind]?.group ?? 'ad',
    status: row.status, statusLabel: STATUS_LABEL[row.status] ?? row.status, channel: row.channel,
    target: parseJson(row.target_json, {}), before: parseJson(row.before_json), after: parseJson(row.after_json), reason: row.reason,
    warnings: parseJson(row.warnings_json, []), result: parseJson(row.result_json), error: row.error, source: row.source, revertOf: row.revert_of,
    createdAt: row.created_at, createdBy: row.created_name ?? null, decidedAt: row.decided_at, decidedBy: row.decided_name ?? null,
    executedAt: row.executed_at, verifiedAt: row.verified_at, updatedAt: row.updated_at,
  };
}

export function changeConfig(env = process.env) {
  const sp = petSpConfig(env), ads = petAdsConfig(env);
  return { spApi: !!sp.account, adsApi: !!ads.account, issues: [...sp.issues, ...ads.issues] };
}

export function listChanges({ view = 'pending', statuses, limit = 500, env = process.env } = {}) {
  const wanted = statuses?.length ? statuses : VIEWS[view] ?? VIEWS.pending;
  const rows = db.prepare(`SELECT p.*, cu.display_name AS created_name, du.display_name AS decided_name FROM pet_change_proposals p
    LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users du ON du.id=p.decided_by
    WHERE p.status IN (${wanted.map(() => '?').join(',')}) ORDER BY ${view === 'history' ? 'p.updated_at DESC, p.id DESC' : 'p.id'} LIMIT ?`)
    .all(...wanted, limit);
  const items = rows.map(shape);
  const batchIds = [...new Set(items.map((item) => item.batchId).filter(Boolean))];
  const batches = batchIds.length ? db.prepare(`SELECT b.id, b.title, b.summary, b.source, b.created_at AS createdAt, u.display_name AS createdBy
    FROM pet_change_batches b LEFT JOIN users u ON u.id=b.created_by WHERE b.id IN (${batchIds.map(() => '?').join(',')}) ORDER BY b.id`).all(...batchIds) : [];
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM pet_change_proposals GROUP BY status').all().map((row) => [row.status, row.n]));
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([name, list]) => [name, list.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0)]));
  return { items, batches, counts, byStatus, config: changeConfig(env) };
}

export function changeLog({ limit = 300, proposalId } = {}) {
  const rows = db.prepare(`SELECT l.*, u.display_name AS user_name, p.kind, p.target_json FROM pet_change_log l
    LEFT JOIN users u ON u.id=l.user_id LEFT JOIN pet_change_proposals p ON p.id=l.proposal_id
    ${proposalId ? 'WHERE l.proposal_id=?' : ''} ORDER BY l.id DESC LIMIT ?`).all(...(proposalId ? [proposalId, limit] : [limit]));
  return rows.map((row) => ({ id: row.id, at: row.at, actor: row.actor, userName: row.user_name, action: row.action,
    actionLabel: ACTION_LABEL[row.action] ?? row.action, proposalId: row.proposal_id, batchId: row.batch_id,
    kind: row.kind, kindLabel: KINDS[row.kind]?.label ?? row.kind, target: targetLabel(row.kind, parseJson(row.target_json, {})),
    detail: parseJson(row.detail_json) }));
}

// ---------- 页面操作 ----------

function pick(ids, statuses) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  if (!list.length) throw Object.assign(new Error('请先勾选改动'), { status: 400 });
  if (list.length > 500) throw Object.assign(new Error('一次最多 500 条'), { status: 400 });
  const rows = db.prepare(`SELECT * FROM pet_change_proposals WHERE id IN (${list.map(() => '?').join(',')})`).all(...list);
  const wrong = rows.filter((row) => !statuses.includes(row.status));
  if (rows.length !== list.length) throw Object.assign(new Error('有改动找不到了，请刷新页面'), { status: 404 });
  if (wrong.length) throw Object.assign(new Error(`有 ${wrong.length} 条状态已经变了（${[...new Set(wrong.map((row) => STATUS_LABEL[row.status]))].join('、')}），请刷新页面`), { status: 409 });
  return rows;
}

/** 确认执行:Listing 排队提交;广告有 API 就排队调用,没有就转成待导出批量表 */
export function approveChanges(ids, userId, env = process.env) {
  const rows = pick(ids, ['pending']);
  const adsReady = !!petAdsConfig(env).account;
  const result = { queued: 0, export: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const toExport = KINDS[row.kind]?.group === 'ad' && !adsReady;
      update(row.id, { status: toExport ? 'export' : 'queued', channel: toExport ? 'bulk_sheet' : null, decided_by: userId,
        decided_at: nowLocal(), error: null });
      log(row.id, row.batch_id, 'user', userId, 'approved');
      if (toExport) log(row.id, row.batch_id, 'system', null, 'to_export');
      result[toExport ? 'export' : 'queued'] += 1;
    }
  })();
  audit(userId, 'US', 'approve', 'pet_change_proposals', null, { ids: rows.map((row) => row.id) });
  return result;
}

export function moveChanges(ids, userId, { from, to, action }) {
  const rows = pick(ids, from);
  db.transaction(() => {
    for (const row of rows) {
      const fields = { status: to };
      if (to === 'rejected') Object.assign(fields, { decided_by: userId, decided_at: nowLocal() });
      if (to === 'queued') fields.error = null;
      if (to === 'applied') Object.assign(fields, { executed_at: nowLocal(),
        verified_at: nowLocal(), result_json: JSON.stringify({ manual: '在广告后台上传批量表后人工标记' }) });
      update(row.id, fields);
      log(row.id, row.batch_id, 'user', userId, action);
    }
  })();
  audit(userId, 'US', action, 'pet_change_proposals', null, { ids: rows.map((row) => row.id) });
  return { updated: rows.length };
}

/** 确认前改提议值(比如标题措辞);按原来的「改动前」重新检查 */
export function editChange(id, value, userId) {
  const row = db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('找不到这条改动'), { status: 404 });
  // 失败的(比如亚马逊预检报错)也能改,改完退回待确认,要重新确认才执行
  if (!['pending', 'failed'].includes(row.status)) throw Object.assign(new Error('只有待确认或失败的改动能修改'), { status: 409 });
  const target = parseJson(row.target_json, {}), before = parseJson(row.before_json), old = parseJson(row.after_json);
  let after, warnings, extra = {};
  if (KINDS[row.kind]?.group === 'listing') {
    const checked = checkListingValue(row.kind, value, before, { sku: target.sku, listPrice: target.listPrice });
    if (checked.errors.length) throw Object.assign(new Error(checked.errors.join('；')), { status: 400 });
    ({ value: after, warnings, extra } = checked);
  } else if (row.kind === 'ad_bid' || row.kind === 'ad_budget') {
    const field = row.kind === 'ad_bid' ? 'bid' : 'budget';
    const checked = checkAdChange({ action: row.kind === 'ad_bid' ? 'set_bid' : 'set_budget', entity: target.entity, entityId: target.entityId,
      campaignId: target.campaignId, adGroupId: target.adGroupId, [field]: value, current: before?.[field] });
    ({ after, warnings } = checked);
  } else {
    throw Object.assign(new Error('这类改动不能修改，不想要就拒绝'), { status: 400 });
  }
  update(row.id, { after_json: JSON.stringify(after), warnings_json: warnings.length ? JSON.stringify(warnings) : null,
    target_json: JSON.stringify({ ...target, ...extra }), ...(row.status === 'failed' ? { status: 'pending', error: null } : {}) });
  log(row.id, row.batch_id, 'user', userId, 'edited', { from: old, to: after });
  return shape({ ...db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(row.id) });
}

/** 撤回:生成一条反向的待确认改动(改回原来的值),同样要确认后才执行 */
export function revertChange(id, userId) {
  const row = db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('找不到这条改动'), { status: 404 });
  if (!['applied', 'submitted', 'not_applied'].includes(row.status)) throw Object.assign(new Error('只有执行过的改动能撤回'), { status: 409 });
  const before = parseJson(row.before_json), after = parseJson(row.after_json), target = parseJson(row.target_json, {});
  if (row.kind === 'ad_negative') throw Object.assign(new Error('否定词没法用撤回改回去，请到广告后台把它存档'), { status: 400 });
  // 促销价改动前是 null 表示原来没有促销价,撤回就是取消促销价
  const knownBefore = row.kind === 'listing_sale_price' ? row.before_json != null : before != null && (Array.isArray(before) ? before.length > 0 : before !== '');
  if (!knownBefore) throw Object.assign(new Error('不知道改动前的值，没法撤回'), { status: 400 });
  const label = targetLabel(row.kind, target);
  const saved = saveProposals({ title: `撤回：${label} 的${KINDS[row.kind]?.label ?? '改动'}`.slice(0, 100), summary: `撤回第 ${row.id} 条改动，改回原来的值`,
    source: 'revert', userId, items: [{ kind: row.kind, targetKey: row.target_key, target: KINDS[row.kind]?.group === 'ad' ? { ...target, currentReported: false } : target,
      before: after, after: before, reason: `撤回第 ${row.id} 条改动`, warnings: [], revertOf: row.id }] });
  log(row.id, row.batch_id, 'user', userId, 'reverted', { revertId: saved.ids[0] });
  return { id: saved.ids[0] };
}

// ---------- 接口 ----------

export function createChangeRouter(deps = defaultDeps) {
  const router = express.Router();
  router.use((req, res, next) => (isPet ? next() : res.status(404).json({ error: '只有宠物版有待确认改动' })));
  router.use(requireRole('owner'));
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (error) { res.status(error.status ?? 400).json({ error: error.message }); }
  };
  router.get('/', handle((req) => listChanges({ view: Object.hasOwn(VIEWS, req.query.view) ? req.query.view : 'pending', env: deps.env })));
  // 导航栏角标:待确认和待导出的条数
  router.get('/counts', handle(() => {
    const byStatus = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM pet_change_proposals WHERE status IN ('pending','export','failed') GROUP BY status")
      .all().map((row) => [row.status, row.n]));
    return { pending: byStatus.pending ?? 0, export: byStatus.export ?? 0, failed: byStatus.failed ?? 0 };
  }));
  router.get('/log', handle((req) => ({ events: changeLog({ limit: Math.min(1000, Number(req.query.limit) || 300) }) })));
  router.put('/:id', handle((req) => editChange(Number(req.params.id), req.body?.value, req.session.user.id)));
  router.post('/approve', handle((req) => {
    const result = approveChanges(req.body?.ids, req.session.user.id, deps.env);
    void kickQueue(deps);
    return result;
  }));
  router.post('/reject', handle((req) => moveChanges(req.body?.ids, req.session.user.id, { from: ['pending'], to: 'rejected', action: 'rejected' })));
  router.post('/retry', handle((req) => {
    const result = moveChanges(req.body?.ids, req.session.user.id, { from: ['failed'], to: 'queued', action: 'retried' });
    void kickQueue(deps);
    return result;
  }));
  router.post('/drop', handle((req) => moveChanges(req.body?.ids, req.session.user.id, { from: ['failed', 'export'], to: 'rejected', action: 'rejected' })));
  router.post('/exported', handle((req) => moveChanges(req.body?.ids, req.session.user.id, { from: ['export', 'exported'], to: 'exported', action: 'exported' })));
  router.post('/uploaded', handle((req) => moveChanges(req.body?.ids, req.session.user.id, { from: ['exported'], to: 'applied', action: 'uploaded' })));
  router.post('/:id/revert', handle((req) => revertChange(Number(req.params.id), req.session.user.id)));
  return router;
}

/** 启动时把上次没跑完的接着跑;每 20 分钟核对一次已提交的 Listing 改动有没有生效 */
export function startChangeScheduler(deps = defaultDeps) {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  db.prepare("UPDATE pet_change_proposals SET status='queued' WHERE status='running'").run();
  void kickQueue(deps);
  const verify = () => void verifySubmitted(deps).catch((error) => console.error('[changes-verify]', error.message));
  setTimeout(verify, 2 * 60_000).unref();
  setInterval(verify, 20 * 60_000).unref();
}
