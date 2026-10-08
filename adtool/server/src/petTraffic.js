// 宠物版流量:亚马逊业务报告「销售与流量」(GET_SALES_AND_TRAFFIC_REPORT),按天、按子 ASIN 存
// 访问量(sessions)、页面浏览量、订购件数、销售额、购物车占有率、转化率。
// 报告里按 ASIN 的部分是整个时间段的合计,所以一天申请一份。业务报告一般两天后出数,
// 之后几天亚马逊还会小改,所以出数后 4 天内拉到的会再拉一次。
import { db } from './db.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, petSpConfig, runReport, shiftDay } from './petAmazon.js';

const REPORT_TYPE = 'GET_SALES_AND_TRAFFIC_REPORT';
const READY_LAG_DAYS = 2;
// 拉到时离那天不满 4 天的,下次再拉一遍
const SETTLE_DAYS = 4;
export const BACKFILL_DAYS = 60;
// 一次最多申请这么多份:创建报告的额度一次最多连发 15 份、每分钟恢复 1 份,和订单、ABA 报告共用,
// 每小时只用掉 15 份,回填 60 天分几个小时做完,不挤占价格表同步
const MAX_DAYS_PER_RUN = 15;
// 失败后隔这么久再自动试
const RETRY_AFTER_ERROR_MS = 6 * 60 * 60_000;

const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
const numOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const asinOf = (value) => {
  const asin = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
};

const state = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));

let running = false;
let progress = null;

/** 一天的报告 -> { total, rows }。报告里出现不止一天时说明时间段没对上,直接报错,免得把几天的合计当成一天 */
export function trafficFromReport(payload, day) {
  const dates = (payload?.salesAndTrafficByDate ?? []).map((entry) => String(entry?.date ?? '').slice(0, 10)).filter(Boolean);
  if (new Set(dates).size > 1) throw new Error(`亚马逊返回了 ${dates.join('、')} 多天的数据，按天拆不开`);
  if (dates.length && dates[0] !== day) throw new Error(`申请的是 ${day}，亚马逊返回的是 ${dates[0]} 的数据`);
  const byDate = payload?.salesAndTrafficByDate?.[0] ?? {};
  const total = {
    sessions: intOf(byDate.trafficByDate?.sessions), pageViews: intOf(byDate.trafficByDate?.pageViews),
    units: intOf(byDate.salesByDate?.unitsOrdered), sales: numOf(byDate.salesByDate?.orderedProductSales?.amount) ?? 0,
  };
  const rows = new Map();
  for (const entry of payload?.salesAndTrafficByAsin ?? []) {
    const asin = asinOf(entry?.childAsin) ?? asinOf(entry?.parentAsin);
    if (!asin) continue;
    const traffic = entry.trafficByAsin ?? {}, sales = entry.salesByAsin ?? {};
    const row = rows.get(asin) ?? { day, asin, parentAsin: asinOf(entry.parentAsin), sessions: 0, pageViews: 0, units: 0, orderItems: 0,
      sales: 0, browserSessions: 0, mobileSessions: 0, buyBoxPct: null, unitSessionPct: null };
    row.sessions += intOf(traffic.sessions);
    row.pageViews += intOf(traffic.pageViews);
    row.browserSessions += intOf(traffic.browserSessions);
    row.mobileSessions += intOf(traffic.mobileAppSessions);
    row.units += intOf(sales.unitsOrdered);
    row.orderItems += intOf(sales.totalOrderItems);
    row.sales = Number((row.sales + (numOf(sales.orderedProductSales?.amount) ?? 0)).toFixed(2));
    row.buyBoxPct = numOf(traffic.buyBoxPercentage) ?? row.buyBoxPct;
    row.unitSessionPct = numOf(traffic.unitSessionPercentage) ?? row.unitSessionPct;
    rows.set(asin, row);
  }
  return { total, rows: [...rows.values()] };
}

function saveDay(day, { total, rows }) {
  const insert = db.prepare(`INSERT INTO pet_traffic_daily (day, asin, parent_asin, sessions, page_views, units, order_items, sales,
    browser_sessions, mobile_sessions, buy_box_pct, unit_session_pct)
    VALUES (@day, @asin, @parentAsin, @sessions, @pageViews, @units, @orderItems, @sales, @browserSessions, @mobileSessions, @buyBoxPct, @unitSessionPct)`);
  db.transaction(() => {
    db.prepare('DELETE FROM pet_traffic_daily WHERE day=?').run(day);
    for (const row of rows) insert.run(row);
    db.prepare(`INSERT INTO pet_traffic_days (day, asins, sessions, page_views, units, sales, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET asins=excluded.asins, sessions=excluded.sessions, page_views=excluded.page_views,
      units=excluded.units, sales=excluded.sales, fetched_at=excluded.fetched_at`)
      .run(day, rows.length, total.sessions, total.pageViews, total.units, total.sales, new Date().toISOString());
  })();
}

/**
 * 这次要拉哪些天:最近 BACKFILL_DAYS 天里没拉过的,和拉到时离那天还不满 SETTLE_DAYS 天的(今天拉过的不再拉);新的在前
 */
export function daysToFetch(today, backfill = BACKFILL_DAYS) {
  const last = shiftDay(today, -READY_LAG_DAYS);
  const fetched = new Map(db.prepare('SELECT day, fetched_at FROM pet_traffic_days WHERE day>=?').all(shiftDay(last, -backfill + 1))
    .map((row) => [row.day, pacificDay(row.fetched_at)]));
  const days = [];
  for (let offset = 0; offset < backfill && days.length < MAX_DAYS_PER_RUN; offset += 1) {
    const day = shiftDay(last, -offset);
    const at = fetched.get(day);
    if (!at || (at < shiftDay(day, SETTLE_DAYS) && at < today)) days.push(day);
  }
  return days;
}

function friendly(error) {
  if (error?.upstreamStatus === 403) {
    return '亚马逊拒绝了「销售与流量」报告（403）：SP-API 应用可能没有「品牌分析」(Brand Analytics) 角色，加上后要重新授权换新的 refresh token';
  }
  return String(error?.message ?? error);
}

/** 拉流量报告。没出数的天(报告被取消)跳过,下次再试 */
export async function syncTraffic({ backfill = BACKFILL_DAYS } = {}, gateway = amazonGateway, env = process.env, today = pacificDay(new Date())) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('流量报告正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  running = true;
  const startedAt = new Date().toISOString();
  setState('traffic_last_attempt', { startedAt });
  const days = daysToFetch(today, Math.max(1, Math.min(365, Number(backfill) || BACKFILL_DAYS)));
  progress = { total: days.length, done: 0, day: null, stage: 'starting', retryAt: null };
  const summary = { requested: days.length, saved: [], notReady: [] };
  try {
    for (const day of days) {
      Object.assign(progress, { day, stage: 'creating', retryAt: null });
      const payload = await runReport(account, REPORT_TYPE, {
        // 这段时间不管按 UTC 还是太平洋时间算都落在同一天,亚马逊按哪种时区取日期都是这一天
        start: new Date(`${day}T08:00:00Z`), end: new Date(`${day}T23:59:59Z`),
        options: { dateGranularity: 'DAY', asinGranularity: 'CHILD' }, parse: JSON.parse,
        onProgress: ({ stage, retryAt = null }) => Object.assign(progress, { stage, retryAt }),
      }, gateway).catch((error) => { throw new Error(`${day}：${friendly(error)}`); });
      progress.done += 1;
      if (payload === null) { summary.notReady.push(day); continue; }
      saveDay(day, trafficFromReport(payload, day));
      summary.saved.push(day);
    }
    const result = { requested: summary.requested, saved: summary.saved.length, notReady: summary.notReady,
      newest: summary.saved[0] ?? null, startedAt, completedAt: new Date().toISOString() };
    db.transaction(() => {
      setState('traffic_last_success', result);
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='traffic_last_error'").run();
    })();
    return result;
  } catch (error) {
    const message = String(error.message).slice(0, 300);
    setState('traffic_last_error', { at: new Date().toISOString(), message });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; progress = null; }
}

export function trafficCoverage() {
  const row = db.prepare('SELECT MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM pet_traffic_days').get();
  return row?.days ? { from: row.first, to: row.last, days: row.days } : null;
}

export function trafficSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  return { configured: !!account, issues, running, progress, coverage: trafficCoverage(),
    lastSuccess: state('traffic_last_success'), lastAttempt: state('traffic_last_attempt'), lastError: state('traffic_last_error') };
}

/** 每小时检查一次,有要拉的天就拉一轮(最多 15 天);失败后 6 小时内不自动重试 */
export function startTrafficSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = trafficSyncStatus();
    if (!status.configured || running) return;
    const failedAt = status.lastError ? Date.parse(status.lastError.at) : 0;
    const okAt = status.lastSuccess ? Date.parse(status.lastSuccess.completedAt) : 0;
    if (failedAt > okAt && Date.now() - failedAt < RETRY_AFTER_ERROR_MS) return;
    if (!daysToFetch(pacificDay(new Date())).length) return;
    try { await syncTraffic(); } catch (error) { console.error('[traffic-sync]', error.message); }
  };
  setTimeout(run, 8 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

// ---------- 给连接器查 ----------

const round1 = (value) => Math.round(value * 10) / 10;
const GROUPS = ['asin', 'style', 'day', 'week', 'total'];
export const TRAFFIC_GROUPS = GROUPS;

/** 周一开始的周 */
const weekStart = (day) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

/** SKU 库按 ASIN 归到款式、尺码、颜色 */
export function asinDirectory() {
  const map = new Map();
  for (const row of db.prepare(`SELECT sku, asin, style, size, color FROM sku_items
    WHERE user_id=? AND country='US' AND asin IS NOT NULL AND asin<>'' ORDER BY sku`).all(PET_SHOP_ID)) {
    const asin = row.asin.toUpperCase();
    const item = map.get(asin) ?? { asin, skus: [], style: row.style ?? null, size: row.size ?? null, color: row.color ?? null };
    item.skus.push(row.sku);
    map.set(asin, item);
  }
  return map;
}

/** 一组流量行加起来,转化率 = 订购件数 / 访问量,购物车占有率按访问量加权 */
export function trafficTotals(rows) {
  const sum = (key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const sessions = sum('sessions');
  const weighted = rows.filter((row) => row.buy_box_pct != null && row.sessions > 0);
  const weight = weighted.reduce((total, row) => total + row.sessions, 0);
  return { sessions, pageViews: sum('page_views'), units: sum('units'), orderItems: sum('order_items'), sales: Number(sum('sales').toFixed(2)),
    conversion: sessions ? round1(sum('units') / sessions * 100) : null,
    buyBox: weight ? round1(weighted.reduce((total, row) => total + row.buy_box_pct * row.sessions, 0) / weight) : null,
    mobileShare: sessions ? round1(sum('mobile_sessions') / sessions * 100) : null };
}

/**
 * 流量查询:按 ASIN / 款式 / 天 / 周 / 合计汇总访问量、浏览量、订购件数、销售额、转化率、购物车占有率。
 * 不填日期时看有数据的最近 days 天。
 */
export function trafficReport({ asin, sku, style, size, color, from, to, days = 28, groupBy = 'asin', limit = 200 } = {}) {
  const coverage = trafficCoverage();
  const status = trafficSyncStatus();
  if (!coverage) {
    return { coverage: null, rows: [], lastError: status.lastError?.message ?? null,
      notes: [status.lastError ? `还没有流量数据，上次同步失败：${status.lastError.message}` : '还没有流量数据：网站每小时自动拉一次亚马逊「销售与流量」报告，第一次要几个小时才能补完最近 60 天。'] };
  }
  const end = to ?? coverage.to;
  const start = from ?? shiftDay(end, -(Math.max(1, Math.min(365, Number(days) || 28)) - 1));
  const directory = asinDirectory();
  const lower = (value) => String(value ?? '').trim().toLowerCase();
  let asins = null;
  if (asin) asins = new Set([String(asin).trim().toUpperCase()]);
  if (sku || style || size || color) {
    const matched = [...directory.values()].filter((item) => (!sku || item.skus.some((value) => lower(value) === lower(sku)))
      && (!style || lower(item.style) === lower(style)) && (!size || lower(item.size) === lower(size)) && (!color || lower(item.color) === lower(color)))
      .map((item) => item.asin);
    asins = new Set(asins ? matched.filter((value) => asins.has(value)) : matched);
    if (!asins.size) throw new Error('SKU 库里找不到符合条件的 ASIN');
  }
  const rows = db.prepare('SELECT * FROM pet_traffic_daily WHERE day>=? AND day<=? ORDER BY day').all(start, end)
    .filter((row) => !asins || asins.has(row.asin));
  const fetchedDays = db.prepare('SELECT day FROM pet_traffic_days WHERE day>=? AND day<=? ORDER BY day').all(start, end).map((row) => row.day);
  const group = GROUPS.includes(groupBy) ? groupBy : 'asin';
  const keyOf = (row) => group === 'asin' ? row.asin : group === 'style' ? (directory.get(row.asin)?.style ?? '(SKU 库里没有的 ASIN)')
    : group === 'day' ? row.day : group === 'week' ? weekStart(row.day) : 'total';
  const buckets = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  let result = [...buckets].map(([key, items]) => {
    const totals = trafficTotals(items);
    if (group === 'asin') {
      const item = directory.get(key);
      return { asin: key, parentAsin: items.find((row) => row.parent_asin)?.parent_asin ?? null, skus: item?.skus ?? [],
        style: item?.style ?? null, size: item?.size ?? null, color: item?.color ?? null, ...totals };
    }
    if (group === 'week') return { weekStart: key, weekEnd: shiftDay(key, 6), days: new Set(items.map((row) => row.day)).size, ...totals };
    if (group === 'day') return { day: key, ...totals };
    if (group === 'style') return { style: key, asins: new Set(items.map((row) => row.asin)).size, ...totals };
    return { from: start, to: end, ...totals };
  });
  if (group === 'asin' || group === 'style') result.sort((a, b) => b.sessions - a.sessions || b.units - a.units);
  if (group === 'total' && !result.length) result = [{ from: start, to: end, ...trafficTotals([]) }];
  return { from: start, to: end, groupBy: group, coverage, daysWithData: fetchedDays.length,
    missingDays: Math.max(0, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 - fetchedDays.length),
    total: result.length, rows: result.slice(0, limit), lastError: status.lastError?.message ?? null,
    notes: ['来自亚马逊业务报告「销售与流量」(按子 ASIN、按天),一般晚 2 天出数,之后几天亚马逊还会小改。',
      'sessions 访问量(24 小时内同一买家多次浏览算一次);pageViews 页面浏览量;conversion 转化率 = 订购件数 / 访问量(%,即卖家后台的「商品会话百分比」);buyBox 购物车占有率(按访问量加权,%);mobileShare 手机 App 访问占比(%)。',
      '没出现在报告里的 ASIN 当天就是 0 访问。units、sales 是业务报告口径,和订单报告(get_sales_trend)可能差几单。'] };
}
