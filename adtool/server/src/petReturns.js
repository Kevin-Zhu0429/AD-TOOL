// 宠物版退货分析:亚马逊 FBA 买家退货报告(GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA),每件退货一行,
// 带退货原因代码、买家留言和退回后的处理结果(可售回库、残次等)。
// 退货率 = 这段时间退回的件数 / 这段时间卖出的件数(订单报告),两边都按太平洋时间的日期算。
// 网站没有接 AI,原因归纳全靠规则:原因代码归大类 + 买家留言按关键词归主题;更深的分析交给 Claude 连接器。
import express from 'express';
import { db } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, pacificMidnight, petSpConfig, runReport, shiftDay } from './petAmazon.js';

const REPORT_TYPE = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
// 第一次回填多少天;之后每次重拉最近 REFRESH_DAYS 天(退货状态、处理结果会在几天内更新)
export const BACKFILL_DAYS = 180;
const REFRESH_DAYS = 30;
// 一份报告最多覆盖多少天
const WINDOW_DAYS = 30;
// 自动同步:上次成功超过这么久就再拉;失败后隔 6 小时再自动试
const REFRESH_EVERY_MS = 12 * 60 * 60_000;
const RETRY_AFTER_ERROR_MS = 6 * 60 * 60_000;
// 退货率偏高:至少退了这么多件,且是全店退货率的 1.5 倍以上、不低于 8%
const MIN_FLAG_RETURNS = 3;
const MIN_FLAG_RATE = 8;

const clean = (value) => String(value ?? '').trim();
const lower = (value) => clean(value).toLowerCase();
const round1 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
const rateOf = (returned, sold) => (sold > 0 ? round1(returned / sold * 100) : null);
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

// ---------- 原因代码 ----------

/** 原因大类:label 中文名,fix 这类退货一般从哪里下手 */
export const CATEGORIES = {
  size: { label: '尺寸不合适', fix: '尺码图、五点和标题里写清楚每个尺码的内径和适合体重' },
  mismatch: { label: '与描述/预期不符', fix: '对照图片、标题和五点，看哪里说过头或和实物不一样' },
  quality: { label: '质量问题', fix: '把留言整理给工厂，看是不是某批货或某道工序' },
  damage: { label: '运输/仓库损坏', fix: '多数不是产品问题；看包装是否够结实，并核对亚马逊有没有赔偿' },
  buyer: { label: '买家自身原因', fix: '一般无需处理' },
  logistics: { label: '物流问题', fix: '一般无需处理' },
  abnormal: { label: '异常退货', fix: '退回的不是原商品，可以开 case 申请赔偿' },
  other: { label: '其他/未说明', fix: '看买家留言' },
};

/** 亚马逊退货原因代码 -> 中文和大类。没列到的代码原样显示,归到「其他」 */
export const REASONS = {
  APPAREL_TOO_SMALL: ['尺寸偏小', 'size'], APPAREL_TOO_LARGE: ['尺寸偏大', 'size'],
  'AMZ-PG-APP-TOO-SMALL': ['尺寸偏小', 'size'], 'AMZ-PG-APP-TOO-LARGE': ['尺寸偏大', 'size'],
  NOT_AS_DESCRIBED: ['与描述不符', 'mismatch'], 'AMZ-PG-BAD-DESC': ['与描述不符', 'mismatch'],
  DIFFERENT_PRODUCT: ['和下单的不一样', 'mismatch'], APPAREL_STYLE: ['不喜欢款式', 'mismatch'],
  DID_NOT_LIKE_FABRIC: ['不喜欢面料', 'mismatch'], NOT_COMPATIBLE: ['不合用', 'mismatch'], PART_NOT_COMPATIBLE: ['不合用', 'mismatch'],
  DEFECTIVE: ['有缺陷/坏了', 'quality'], 'AMZ-PG-BAD-ITEM': ['有缺陷/坏了', 'quality'], QUALITY_UNACCEPTABLE: ['质量不满意', 'quality'],
  MISSING_PARTS: ['缺件', 'quality'], EXCESSIVE_INSTALLATION: ['安装太麻烦', 'quality'],
  DAMAGED_BY_CARRIER: ['运输途中损坏', 'damage'], DAMAGED_BY_FC: ['亚马逊仓库损坏', 'damage'], 'AMZ-PG-DAMAGED': ['收到时已损坏', 'damage'],
  UNWANTED_ITEM: ['不想要了', 'buyer'], ORDERED_WRONG_ITEM: ['买错了', 'buyer'], MISORDERED: ['买错了', 'buyer'],
  'AMZ-PG-MISORDERED': ['买错了', 'buyer'], FOUND_BETTER_PRICE: ['别处更便宜', 'buyer'], UNAUTHORIZED_PURCHASE: ['未经授权购买', 'buyer'],
  MISSED_ESTIMATED_DELIVERY: ['没按时送到', 'logistics'], NEVER_ARRIVED: ['没收到货', 'logistics'], EXTRA_ITEM: ['多收到一件', 'logistics'],
  UNDELIVERABLE_REFUSED: ['拒收', 'logistics'], UNDELIVERABLE_UNKNOWN: ['无法投递', 'logistics'],
  UNDELIVERABLE_INSUFFICIENT_ADDRESS: ['地址不全无法投递', 'logistics'], UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS: ['多次投递失败', 'logistics'],
  UNDELIVERABLE_CARRIER_MISS_SORTED: ['承运商分拣错误', 'logistics'],
  SWITCHEROO: ['退回的不是原商品', 'abnormal'],
  NO_REASON_GIVEN: ['买家未说明', 'other'],
};

export function reasonInfo(code) {
  const key = clean(code).toUpperCase();
  if (!key) return { code: '', label: '没有原因', category: 'other' };
  const known = REASONS[key] ?? (key.startsWith('UNDELIVERABLE') ? ['无法投递', 'logistics'] : null);
  return { code: key, label: known?.[0] ?? key, category: known?.[1] ?? 'other' };
}

/** 退回后的处理结果:SELLABLE 可以重新卖,其他都卖不了 */
export const DISPOSITIONS = {
  SELLABLE: '可售回库', DEFECTIVE: '残次', CUSTOMER_DAMAGED: '买家损坏', CARRIER_DAMAGED: '承运商损坏',
  DAMAGED: '仓库损坏', EXPIRED: '过期',
};

// ---------- 买家留言主题 ----------

/** 买家留言(英文)按关键词归主题。一条留言可以落进几个主题 */
export const THEMES = [
  { key: 'too_small', label: '偏小/狗睡不下', test: /too small|small(er)? than|runs? small|not big enough|tiny|too tight|cramped|too short|too narrow|could(n'?t| not) fit|does(n'?t| not) fit (my|our|him|her)|size up|bigger size/ },
  { key: 'too_large', label: '偏大', test: /too (big|large|huge|wide|long)|bigger than|larger than|way too much room|size down|smaller size/ },
  { key: 'thin', label: '太薄/太扁/不够软', test: /\bthin\b|\bflat\b|not (thick|soft|fluffy|comfortable|cushy)|too (hard|firm|stiff)|no (padding|support|cushion)|stuffing|filling|lumpy|uncomfortable/ },
  { key: 'waterproof', label: '不防水/渗水', test: /waterproof|water ?resistant|leak|soak|seeped|got wet|not water/ },
  { key: 'quality', label: '做工/破损', test: /\brip(ped)?\b|\btear\b|\btore\b|\btorn\b|seam|stitch|\bhole\b|broke|broken|zipper|fell apart|falling apart|cheap|flimsy|poor(ly)? (quality|made)|defect|came apart/ },
  { key: 'chewed', label: '被咬坏', test: /chew|destroy|shredded/ },
  { key: 'smell', label: '有异味', test: /smell|odou?r|stink|chemical|fume/ },
  { key: 'looks', label: '颜色/外观和图片不符', test: /colou?r|look(s|ed)? (different|nothing)|picture|photo|image|not as (described|pictured|shown|advertised)|different (from|than)|misleading/ },
  { key: 'pet_refused', label: '宠物不爱用', test: /(dog|cat|pup|puppy|pet|he|she|they) (did ?n[o']t|does ?n[o']t|do ?n[o']t|won'?t|wouldn'?t|would not|will not|refuse[sd]?|never) (like|use|lay|lie|sleep|want|go|touch|get)|(dog|cat|pet)s? (hate|hated|ignore|ignored)|didn'?t like it/ },
  { key: 'wash', label: '洗后变形/不好洗', test: /wash|dryer|shrink|shrank|laundry/ },
  { key: 'slip', label: '底部打滑', test: /slip|slid(e|es|ing)|skid/ },
  { key: 'hair', label: '粘毛/掉毛起球', test: /\bpill(ing|s)?\b|\blint\b|shed(ding)?|fuzz|attracts? hair/ },
  { key: 'not_needed', label: '不需要了/买重了', test: /no longer need|do(n'?t| not) need|not needed|changed (my|our) mind|bought (two|2|another|the wrong)|duplicate|gift|passed away/ },
  { key: 'late', label: '送晚了', test: /arrived late|too late|took too long|late delivery|never (arrived|came)/ },
  { key: 'price', label: '价格', test: /cheaper|better price|too expensive|overpriced|price/ },
];

export function commentThemes(comment) {
  const text = lower(comment);
  if (!text) return [];
  return THEMES.filter((theme) => theme.test.test(text)).map((theme) => theme.key);
}
const THEME_LABEL = Object.fromEntries(THEMES.map((theme) => [theme.key, theme.label]));

// ---------- 报告 ----------

/** 报告行 -> 存库的行。return-date 是带时区的时间,换成太平洋时间的日期 */
export function returnFromReport(row) {
  const sku = clean(row.sku);
  const at = clean(row['return-date']);
  const day = at ? (/^\d{4}-\d{2}-\d{2}$/.test(at) ? at : pacificDay(at)) : '';
  if (!sku || !day) return null;
  const quantity = Math.max(1, Math.round(Number(row.quantity) || 1));
  return { day, returnedAt: at, orderId: clean(row['order-id']) || null, sku, asin: clean(row.asin).toUpperCase() || null,
    fnsku: clean(row.fnsku) || null, productName: clean(row['product-name']) || null, quantity,
    fulfillmentCenter: clean(row['fulfillment-center-id']) || null, disposition: clean(row['detailed-disposition']).toUpperCase() || null,
    reason: clean(row.reason).toUpperCase() || null, status: clean(row.status) || null,
    lpn: clean(row['license-plate-number']) || null, comments: clean(row['customer-comments']) || null };
}

/** 这次要拉的日期段(新的在前):没有覆盖过的回填段,加上最近 REFRESH_DAYS 天 */
export function windowsToFetch(today, coverage, backfill = BACKFILL_DAYS) {
  const oldest = shiftDay(today, -(backfill - 1));
  const windows = [];
  const push = (from, to) => {
    for (let end = to; end >= from; end = shiftDay(end, -WINDOW_DAYS)) {
      const start = [from, shiftDay(end, -(WINDOW_DAYS - 1))].sort().at(-1);
      windows.push({ from: start, to: end });
    }
  };
  const refreshFrom = shiftDay(today, -(REFRESH_DAYS - 1));
  if (!coverage?.from) { push(oldest, today); return windows; }
  // 最近一段:最近 30 天,上次覆盖到的最后一天比这还早就从那天拉起
  const recentFrom = [[refreshFrom, coverage.to ?? refreshFrom].sort()[0], oldest].sort().at(-1);
  push(recentFrom, today);
  if (recentFrom > oldest && coverage.from > oldest) push(oldest, [shiftDay(coverage.from, -1), shiftDay(recentFrom, -1)].sort()[0]);
  return windows;
}

const state = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));

export const returnsCoverage = () => state('returns_coverage');

function saveWindow({ from, to }, rows) {
  const insert = db.prepare(`INSERT INTO pet_returns (day, returned_at, order_id, sku, asin, fnsku, product_name, quantity,
    fulfillment_center, disposition, reason, status, lpn, comments) VALUES (@day, @returnedAt, @orderId, @sku, @asin, @fnsku, @productName,
    @quantity, @fulfillmentCenter, @disposition, @reason, @status, @lpn, @comments)`);
  let saved = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM pet_returns WHERE day>=? AND day<=?').run(from, to);
    for (const row of rows) {
      // 报告按 UTC 取时间段,头尾可能多出相邻那天的退货,只存这段里的
      if (row.day < from || row.day > to) continue;
      insert.run(row);
      saved += 1;
    }
    const coverage = returnsCoverage();
    setState('returns_coverage', { from: [from, coverage?.from ?? from].sort()[0], to: [to, coverage?.to ?? to].sort().at(-1) });
  })();
  return saved;
}

function friendly(error) {
  if (error?.upstreamStatus === 403) {
    return '亚马逊拒绝了 FBA 退货报告（403）：SP-API 应用需要「亚马逊物流」(Amazon Fulfillment) 角色，加上后要重新授权换新的 refresh token';
  }
  return String(error?.message ?? error);
}

let running = false;
let progress = null;

/** 拉退货报告:第一次回填 180 天(6 份报告),之后每次重拉最近 30 天 */
export async function syncReturns({ backfill = BACKFILL_DAYS } = {}, gateway = amazonGateway, env = process.env, today = todayOf()) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('退货报告正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  running = true;
  const startedAt = new Date().toISOString();
  setState('returns_last_attempt', { startedAt });
  const windows = windowsToFetch(today, returnsCoverage(), Math.max(REFRESH_DAYS, Math.min(730, Number(backfill) || BACKFILL_DAYS)));
  progress = { total: windows.length, done: 0, step: null, stage: 'starting', retryAt: null };
  let saved = 0;
  try {
    for (const window of windows) {
      Object.assign(progress, { step: `${window.from} 至 ${window.to}`, stage: 'creating', retryAt: null });
      const end = window.to >= today ? new Date(Date.now() - 5 * 60_000) : new Date(pacificMidnight(shiftDay(window.to, 1)).getTime() - 1000);
      const rows = await runReport(account, REPORT_TYPE, {
        start: pacificMidnight(window.from), end,
        onProgress: ({ stage, retryAt = null }) => Object.assign(progress, { stage, retryAt }),
      }, gateway).catch((error) => { throw new Error(`${window.from} 至 ${window.to}：${friendly(error)}`); });
      progress.stage = 'saving';
      saved += saveWindow(window, rows.map(returnFromReport).filter(Boolean));
      progress.done += 1;
    }
    const result = { windows: windows.length, saved, coverage: returnsCoverage(), startedAt, completedAt: new Date().toISOString() };
    db.transaction(() => {
      setState('returns_last_success', result);
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='returns_last_error'").run();
    })();
    return result;
  } catch (error) {
    const message = String(error.message).slice(0, 300);
    setState('returns_last_error', { at: new Date().toISOString(), message });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; progress = null; }
}

export function returnsSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  return { configured: !!account, issues, running, progress, coverage: returnsCoverage(),
    lastSuccess: state('returns_last_success'), lastAttempt: state('returns_last_attempt'), lastError: state('returns_last_error') };
}

/** 每小时看一次:12 小时没成功同步过就拉一轮;失败后 6 小时内不自动重试 */
export function startReturnsSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = returnsSyncStatus();
    if (!status.configured || running) return;
    const failedAt = status.lastError ? Date.parse(status.lastError.at) : 0;
    const okAt = status.lastSuccess ? Date.parse(status.lastSuccess.completedAt) : 0;
    if (failedAt > okAt && Date.now() - failedAt < RETRY_AFTER_ERROR_MS) return;
    if (Date.now() - okAt < REFRESH_EVERY_MS) return;
    try { await syncReturns(); } catch (error) { console.error('[returns-sync]', error.message); }
  };
  setTimeout(run, 12 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

// ---------- 分析 ----------

function skuDirectory() {
  return new Map(db.prepare(`SELECT sku, asin, style, size, color FROM sku_items WHERE user_id=? AND country='US' ORDER BY sku`)
    .all(PET_SHOP_ID).map((row) => [lower(row.sku), row]));
}

const emptyGroup = () => ({ sold: 0, returned: 0, records: 0, sellable: 0, small: 0, large: 0, reasons: new Map(), categories: new Map(), themes: new Map(), comments: [] });
const bump = (map, key, by) => map.set(key, (map.get(key) ?? 0) + by);

function addReturn(group, row, info, themes) {
  group.returned += row.quantity;
  group.records += 1;
  if (row.disposition === 'SELLABLE') group.sellable += row.quantity;
  // 嫌小/嫌大:原因代码或留言说了都算,一件只算一次
  if (/TOO-?_?SMALL/.test(info.code) || themes.includes('too_small')) group.small += row.quantity;
  else if (/TOO-?_?LARGE/.test(info.code) || themes.includes('too_large')) group.large += row.quantity;
  bump(group.reasons, info.code, row.quantity);
  bump(group.categories, info.category, row.quantity);
  for (const theme of themes) bump(group.themes, theme, row.quantity);
  if (row.comments) group.comments.push({ day: row.day, sku: row.sku, reason: info.label, comment: row.comments, themes: themes.map((key) => THEME_LABEL[key]) });
}

/** Map -> [{ key, label, count, share }],按件数从多到少 */
function ranked(map, total, labelOf) {
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, label: labelOf(key), count, share: rateOf(count, total) }));
}
const reasonList = (map, total) => ranked(map, total, (code) => reasonInfo(code).label)
  .map((item) => ({ ...item, category: reasonInfo(item.key).category }));
const categoryList = (map, total) => ranked(map, total, (key) => CATEGORIES[key]?.label ?? key);
const themeList = (map, total) => ranked(map, total, (key) => THEME_LABEL[key] ?? key);

function summarize(group, commentLimit) {
  const comments = group.comments.sort((a, b) => b.day.localeCompare(a.day));
  return { sold: group.sold, returned: group.returned, rate: rateOf(group.returned, group.sold),
    sellable: group.sellable, sellableShare: rateOf(group.sellable, group.returned),
    reasons: reasonList(group.reasons, group.returned), categories: categoryList(group.categories, group.returned),
    themes: themeList(group.themes, group.returned), commentCount: comments.length, comments: comments.slice(0, commentLimit) };
}

const sizeOrder = (size) => {
  const index = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'].indexOf(clean(size).toUpperCase());
  if (index >= 0) return index;
  const inches = Number(/\d+/.exec(clean(size))?.[0]);
  return Number.isFinite(inches) ? 100 + inches : 999;
};
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' ') || row.sku;
const topLabels = (items, limit = 2) => items.slice(0, limit).map((item) => `${item.label} ${item.count} 件`).join('、');

/** 规则归纳:每条 { level, title, detail } */
export function returnFindings(total, skus, styles) {
  const findings = [];
  if (!total.returned) return findings;
  const top = total.categories[0];
  findings.push({ level: 'info', title: `全店退货率 ${total.rate ?? '—'}%（退 ${total.returned} 件 / 卖 ${total.sold} 件）`,
    detail: `最多的是「${top.label}」，占 ${top.share}%。${CATEGORIES[top.key]?.fix ?? ''}。${total.themes.length ? `买家留言里提得最多的是：${topLabels(total.themes, 3)}。` : ''}` });
  const threshold = Math.max(MIN_FLAG_RATE, (total.rate ?? 0) * 1.5);
  for (const row of skus.filter((item) => item.returned >= MIN_FLAG_RETURNS && item.rate != null && item.rate >= threshold).slice(0, 6)) {
    findings.push({ level: 'high', title: `${nameOf(row)}（${row.sku}）退货率 ${row.rate}%，偏高`,
      detail: `退 ${row.returned} 件 / 卖 ${row.sold} 件。主要原因：${topLabels(row.reasons)}${row.themes.length ? `；留言提到：${topLabels(row.themes)}` : ''}。${CATEGORIES[row.categories[0]?.key]?.fix ?? ''}。` });
  }
  for (const style of styles) {
    if (style.returned < MIN_FLAG_RETURNS || !style.style) continue;
    const size = style.categories.find((item) => item.key === 'size');
    if (size && size.share >= 40) {
      const small = style.sizes.filter((item) => item.small > item.large && item.small > 0).map((item) => item.size);
      const large = style.sizes.filter((item) => item.large > item.small && item.large > 0).map((item) => item.size);
      findings.push({ level: 'medium', title: `${style.style}：尺寸问题占退货的 ${size.share}%`,
        detail: `${small.length ? `${small.join('、')} 码多是嫌小` : ''}${small.length && large.length ? '，' : ''}${large.length ? `${large.join('、')} 码多是嫌大` : ''}${small.length || large.length ? '。' : ''}${CATEGORIES.size.fix}；嫌小多的话可以在五点里建议「量狗身长后选大一码」。` });
    }
    const quality = (style.themeCounts.quality ?? 0) + (style.themeCounts.chewed ?? 0);
    const qualityReasons = style.categories.find((item) => item.key === 'quality')?.count ?? 0;
    if (Math.max(quality, qualityReasons) >= MIN_FLAG_RETURNS) {
      findings.push({ level: 'medium', title: `${style.style}：${Math.max(quality, qualityReasons)} 件退货和质量有关`,
        detail: `${style.qualityNotes.length ? `留言例：「${style.qualityNotes.slice(0, 2).join('」「')}」。` : ''}${CATEGORIES.quality.fix}。` });
    }
    const looks = style.themeCounts.looks ?? 0, mismatch = style.categories.find((item) => item.key === 'mismatch')?.count ?? 0;
    if (Math.max(looks, mismatch) >= MIN_FLAG_RETURNS) {
      findings.push({ level: 'medium', title: `${style.style}：${Math.max(looks, mismatch)} 件退货说和描述/图片不符`,
        detail: `${CATEGORIES.mismatch.fix}。` });
    }
    if ((style.themeCounts.waterproof ?? 0) >= 2) {
      findings.push({ level: 'medium', title: `${style.style}：${style.themeCounts.waterproof} 件退货留言提到防水`,
        detail: '核对标题和五点里的防水说法是否和实物一致（防水面料 vs 防水内胆、能不能机洗）。' });
    }
    if ((style.themeCounts.thin ?? 0) >= 2) {
      findings.push({ level: 'low', title: `${style.style}：${style.themeCounts.thin} 件退货嫌太薄/太扁/不够软`,
        detail: '看图片和五点里的厚度、填充写法会不会让人期待过高；尺码图写清楚厚度。' });
    }
  }
  const damage = total.categories.find((item) => item.key === 'damage');
  if (damage?.count) findings.push({ level: 'low', title: `${damage.count} 件是运输或亚马逊仓库损坏`, detail: CATEGORIES.damage.fix + '。' });
  const abnormal = total.categories.find((item) => item.key === 'abnormal');
  if (abnormal?.count) findings.push({ level: 'medium', title: `${abnormal.count} 件退回的不是原商品`, detail: CATEGORIES.abnormal.fix + '。' });
  const unsellable = total.returned - total.sellable;
  if (unsellable > 0) findings.push({ level: 'low', title: `${unsellable} 件退回后不可售（占 ${rateOf(unsellable, total.returned)}%）`,
    detail: '残次和买家损坏的件会一直占库容，可以在卖家后台定期移除或弃置。' });
  const levels = { high: 0, medium: 1, low: 2, info: -1 };
  return findings.sort((a, b) => levels[a.level] - levels[b.level]);
}

/**
 * 退货分析:最近 days 天(到今天)每个 SKU 的退货率、原因、留言主题,按款式汇总,并给出规则归纳。
 * style / sku 只看这些;commentLimit 每个 SKU 带几条最新留言。
 */
export function returnsAnalysis({ days = 30, style, sku, commentLimit = 5, today = todayOf() } = {}) {
  const span = Math.max(1, Math.min(365, Number(days) || 30));
  const from = shiftDay(today, -(span - 1));
  const directory = skuDirectory();
  const wanted = (code) => {
    const item = directory.get(lower(code));
    return (!sku || lower(code) === lower(sku)) && (!style || lower(item?.style) === lower(style));
  };
  const groups = new Map();
  const groupOf = (code) => {
    const key = lower(code);
    if (!groups.has(key)) {
      const item = directory.get(key);
      groups.set(key, { sku: item?.sku ?? code, asin: item?.asin ?? null, style: item?.style ?? null, size: item?.size ?? null, color: item?.color ?? null, ...emptyGroup() });
    }
    return groups.get(key);
  };
  for (const row of db.prepare('SELECT sku, asin, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY lower(sku)').all(from, today)) {
    if (wanted(row.sku) && row.units > 0) groupOf(row.sku).sold += row.units;
  }
  const totalGroup = emptyGroup();
  for (const row of db.prepare('SELECT * FROM pet_returns WHERE day>=? AND day<=? ORDER BY day DESC').all(from, today)) {
    if (!wanted(row.sku)) continue;
    const group = groupOf(row.sku);
    group.asin ??= row.asin;
    const info = reasonInfo(row.reason);
    const themes = commentThemes(row.comments);
    addReturn(group, row, info, themes);
    addReturn(totalGroup, row, info, themes);
  }
  totalGroup.sold = [...groups.values()].reduce((sum, group) => sum + group.sold, 0);

  const skus = [...groups.values()].filter((group) => group.returned > 0 || group.sold > 0).map((group) => {
    const qualityNotes = group.comments.filter((item) => /quality|rip|tear|torn|seam|stitch|hole|broke|zipper|apart|flimsy|chew/i.test(item.comment)).map((item) => item.comment);
    return { sku: group.sku, asin: group.asin, style: group.style, size: group.size, color: group.color, ...summarize(group, commentLimit),
      _small: group.small, _large: group.large, _themes: Object.fromEntries(group.themes), _qualityNotes: qualityNotes };
  }).sort((a, b) => b.returned - a.returned || (b.rate ?? 0) - (a.rate ?? 0) || b.sold - a.sold);

  // 按款式汇总
  const styleMap = new Map();
  for (const row of skus) {
    const key = row.style ?? '(SKU 库里没有款式)';
    if (!styleMap.has(key)) styleMap.set(key, { style: row.style, name: key, ...emptyGroup(), skus: 0, sizes: new Map(), themeCounts: {}, qualityNotes: [] });
    const item = styleMap.get(key);
    item.skus += 1; item.sold += row.sold; item.returned += row.returned; item.sellable += row.sellable;
    for (const reason of row.reasons) bump(item.reasons, reason.key, reason.count);
    for (const category of row.categories) bump(item.categories, category.key, category.count);
    for (const [theme, count] of Object.entries(row._themes)) { bump(item.themes, theme, count); item.themeCounts[theme] = (item.themeCounts[theme] ?? 0) + count; }
    item.qualityNotes.push(...row._qualityNotes);
    const size = row.size ?? '—';
    const bySize = item.sizes.get(size) ?? { size, sold: 0, returned: 0, small: 0, large: 0 };
    bySize.sold += row.sold; bySize.returned += row.returned; bySize.small += row._small; bySize.large += row._large;
    item.sizes.set(size, bySize);
  }
  const styles = [...styleMap.values()].map((item) => ({ style: item.name, skus: item.skus, sold: item.sold, returned: item.returned,
    rate: rateOf(item.returned, item.sold), sellable: item.sellable, sellableShare: rateOf(item.sellable, item.returned),
    reasons: reasonList(item.reasons, item.returned), categories: categoryList(item.categories, item.returned), themes: themeList(item.themes, item.returned),
    sizes: [...item.sizes.values()].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size)).map((entry) => ({ ...entry, rate: rateOf(entry.returned, entry.sold) })),
    themeCounts: item.themeCounts, qualityNotes: item.qualityNotes }))
    .sort((a, b) => b.returned - a.returned || b.sold - a.sold);

  const total = summarize(totalGroup, 0);
  const findings = returnFindings(total, skus, styles);
  const coverage = returnsCoverage();
  const notes = [];
  if (!coverage) notes.push('还没有退货数据：网站会自动拉亚马逊 FBA 退货报告，第一次回填最近 180 天，也可以点「立即同步」。');
  else if (coverage.from > from) notes.push(`退货数据从 ${coverage.from} 开始，这段时间前面几天还没有数据。`);
  return { today, from, to: today, days: span, coverage, sync: returnsSyncStatus(),
    total: { ...total, comments: undefined, skus: skus.filter((row) => row.returned > 0).length },
    findings, styles: styles.map(({ themeCounts, qualityNotes, ...rest }) => rest),
    skus: skus.map(({ _small, _large, _themes, _qualityNotes, ...rest }) => rest),
    labels: { categories: Object.fromEntries(Object.entries(CATEGORIES).map(([key, value]) => [key, value.label])), dispositions: DISPOSITIONS },
    notes: [...notes,
      '退货率 = 这段时间退回的件数 ÷ 这段时间卖出的件数（都按美国太平洋时间）。退货一般比下单晚 1～4 周，所以销量少或刚断货的 SKU 波动大。',
      '只含 FBA 订单的退货；原因是买家在亚马逊退货时选的，留言是买家写的（英文，很多为空）。原因归纳按规则：原因代码归大类，留言按关键词归主题。'] };
}

/** 一个 SKU 这段时间的全部退货记录(页面展开看明细) */
export function returnRecords({ sku, days = 30, today = todayOf() } = {}) {
  const from = shiftDay(today, -(Math.max(1, Math.min(365, Number(days) || 30)) - 1));
  return db.prepare('SELECT day, order_id, sku, asin, quantity, disposition, reason, status, comments, fulfillment_center FROM pet_returns WHERE lower(sku)=lower(?) AND day>=? AND day<=? ORDER BY day DESC, id DESC')
    .all(clean(sku), from, today).map((row) => ({ day: row.day, orderId: row.order_id, quantity: row.quantity,
      reason: reasonInfo(row.reason).label, reasonCode: row.reason, category: reasonInfo(row.reason).category,
      disposition: DISPOSITIONS[row.disposition] ?? row.disposition, status: row.status, comment: row.comments,
      themes: commentThemes(row.comments).map((key) => THEME_LABEL[key]), fulfillmentCenter: row.fulfillment_center }));
}

// ---------- 网站接口 ----------

export const returnsRouter = express.Router();
returnsRouter.use(requireLogin);
returnsRouter.use((req, res, next) => isPet ? next() : res.status(404).json({ error: '只有宠物版有退货分析' }));
returnsRouter.get('/', (req, res) => res.json(returnsAnalysis({ days: req.query.days, style: clean(req.query.style) || undefined, commentLimit: 3 })));
returnsRouter.get('/records', (req, res) => {
  if (!clean(req.query.sku)) return res.status(400).json({ error: '缺少 SKU' });
  res.json({ records: returnRecords({ sku: req.query.sku, days: req.query.days }) });
});
returnsRouter.get('/status', (req, res) => res.json(returnsSyncStatus()));
returnsRouter.post('/sync', (req, res) => {
  const status = returnsSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  if (status.running) return res.status(409).json({ error: '退货报告正在同步' });
  void syncReturns().catch((error) => console.error('[returns-sync]', error.message));
  res.status(202).json({ accepted: true });
});
