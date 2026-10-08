// 改动效果对比:执行过的 Listing 改动,比较执行前后同样天数的销量(订单报告)、访问量和转化率(业务报告)、
// ABA 搜索份额(按周),并列出同期同一 SKU 的其它改动和断货补货,方便判断变化是不是这条改动带来的。
import { db } from './db.js';
import { PET_SHOP_ID } from './profile.js';
import { pacificDay, shiftDay } from './petAmazon.js';
import { KINDS, STATUS_LABEL } from './petChanges.js';
import { trafficCoverage, trafficTotals } from './petTraffic.js';

const DONE = ['submitted', 'applied', 'not_applied'];
const round1 = (value) => Math.round(value * 10) / 10;
const lower = (value) => String(value ?? '').trim().toLowerCase();
const parseJson = (text, fallback = null) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
const daysBetween = (from, to) => (from > to ? 0 : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
const pct = (before, after) => (before > 0 && after != null ? round1((after - before) / before * 100) : null);

/** 库里的时间是服务器本地时间,换成太平洋时间的日期 */
function pacificDayOfLocal(local) {
  const seconds = db.prepare("SELECT CAST(strftime('%s', ?, 'utc') AS INTEGER) AS s").get(local)?.s;
  return seconds ? pacificDay(new Date(seconds * 1000)) : null;
}

function salesWindow(sku, from, to) {
  const days = daysBetween(from, to);
  if (!days) return null;
  const row = db.prepare('SELECT SUM(units) AS units, SUM(orders) AS orders, SUM(sales) AS sales FROM pet_daily_sales WHERE sku=? AND day>=? AND day<=?')
    .get(sku, from, to);
  const units = row?.units ?? 0;
  return { from, to, days, units, orders: row?.orders ?? 0, sales: Number((row?.sales ?? 0).toFixed(2)), unitsPerDay: round1(units / days) };
}

function trafficWindow(asin, from, to) {
  const days = daysBetween(from, to);
  if (!asin || !days) return null;
  const fetched = db.prepare('SELECT COUNT(*) AS n FROM pet_traffic_days WHERE day>=? AND day<=?').get(from, to).n;
  if (!fetched) return null;
  const totals = trafficTotals(db.prepare('SELECT * FROM pet_traffic_daily WHERE asin=? AND day>=? AND day<=?').all(asin, from, to));
  return { from, to, daysWithData: fetched, ...totals, sessionsPerDay: round1(totals.sessions / fetched) };
}

/** ABA 搜索查询表现:每周这个 ASIN 在全部搜索词上的曝光、点击、购买份额(%),几周取平均 */
function searchShare(asin, weeks) {
  if (!asin || !weeks.length) return null;
  const share = (part, whole) => (whole > 0 ? part / whole * 100 : null);
  const avg = (values) => {
    const list = values.filter((value) => value != null);
    return list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null;
  };
  return { weeks: weeks.map((week) => week.week_end),
    impressionShare: avg(weeks.map((week) => share(week.ai, week.mi))), clickShare: avg(weeks.map((week) => share(week.ac, week.mc))),
    purchaseShare: avg(weeks.map((week) => share(week.ap, week.mp))),
    clicksPerWeek: round1(weeks.reduce((sum, week) => sum + week.ac, 0) / weeks.length),
    purchasesPerWeek: round1(weeks.reduce((sum, week) => sum + week.ap, 0) / weeks.length) };
}

function abaWeeks(asin) {
  if (!asin) return [];
  return db.prepare(`SELECT r.week_start, r.week_end, SUM(q.asin_impressions) AS ai, SUM(q.market_impressions) AS mi,
    SUM(q.asin_clicks) AS ac, SUM(q.market_clicks) AS mc, SUM(q.asin_purchases) AS ap, SUM(q.market_purchases) AS mp
    FROM aba_asin_reports r JOIN aba_asin_queries q ON q.report_id=r.id
    WHERE r.user_id=? AND r.marketplace='US' AND upper(r.asin)=? GROUP BY r.id ORDER BY r.week_end`).all(PET_SHOP_ID, asin.toUpperCase());
}

/**
 * 执行过的 Listing 改动的前后对比。id 看一条;sku 看这个 SKU 最近的改动;都不填看最近执行的。
 * days:前后各看几天(执行当天不算)。
 */
export function changeImpact({ id, sku, days = 14, limit = 10 } = {}, { today = pacificDay(new Date()) } = {}) {
  const span = Math.max(3, Math.min(90, Number(days) || 14));
  const salesTo = shiftDay(today, -1);
  const traffic = trafficCoverage();
  const where = [`status IN (${DONE.map(() => '?').join(',')})`, "kind LIKE 'listing_%'", 'executed_at IS NOT NULL'];
  const params = [...DONE];
  if (id) { where.push('id=?'); params.push(Number(id)); }
  if (sku) { where.push("lower(json_extract(target_json, '$.sku'))=?"); params.push(lower(sku)); }
  const rows = db.prepare(`SELECT * FROM pet_change_proposals WHERE ${where.join(' AND ')} ORDER BY executed_at DESC, id DESC LIMIT ?`)
    .all(...params, Math.max(1, Math.min(30, Number(limit) || 10)));
  if (id && !rows.length) {
    const row = db.prepare('SELECT status, kind FROM pet_change_proposals WHERE id=?').get(Number(id));
    throw new Error(!row ? `没有第 ${id} 条改动` : !row.kind.startsWith('listing_') ? '广告改动要等广告数据接进来才能对比效果'
      : `第 ${id} 条改动还没执行（${STATUS_LABEL[row.status] ?? row.status}）`);
  }
  const items = rows.map((row) => {
    const target = parseJson(row.target_json, {});
    const day = pacificDayOfLocal(row.executed_at);
    const beforeFrom = shiftDay(day, -span), beforeTo = shiftDay(day, -1);
    const afterFrom = shiftDay(day, 1);
    const salesAfterTo = [shiftDay(day, span), salesTo].sort()[0];
    const trafficAfterTo = traffic ? [shiftDay(day, span), traffic.to].sort()[0] : null;
    const asin = target.asin ? String(target.asin).toUpperCase() : null;
    const sales = { before: salesWindow(target.sku, beforeFrom, beforeTo), after: salesWindow(target.sku, afterFrom, salesAfterTo) };
    sales.unitsPerDayChangePct = pct(sales.before?.unitsPerDay, sales.after?.unitsPerDay);
    const visits = { before: trafficWindow(asin, beforeFrom, beforeTo), after: trafficAfterTo ? trafficWindow(asin, afterFrom, trafficAfterTo) : null };
    visits.sessionsPerDayChangePct = pct(visits.before?.sessionsPerDay, visits.after?.sessionsPerDay);
    visits.conversionChangePoints = visits.before?.conversion != null && visits.after?.conversion != null
      ? round1(visits.after.conversion - visits.before.conversion) : null;
    const weeks = abaWeeks(asin);
    const search = { before: searchShare(asin, weeks.filter((week) => week.week_end < day && week.week_end >= beforeFrom)),
      after: searchShare(asin, weeks.filter((week) => week.week_start > day && week.week_start <= shiftDay(day, span))) };
    // 同一 SKU 前后窗口里的其它改动、断货补货,都会影响对比
    const others = db.prepare(`SELECT id, kind, status, executed_at FROM pet_change_proposals WHERE id<>? AND executed_at IS NOT NULL
      AND status IN (${DONE.map(() => '?').join(',')}) AND lower(json_extract(target_json, '$.sku'))=?`).all(row.id, ...DONE, lower(target.sku))
      .map((other) => ({ id: other.id, kind: KINDS[other.kind]?.label ?? other.kind, day: pacificDayOfLocal(other.executed_at), status: STATUS_LABEL[other.status] }))
      .filter((other) => other.day >= beforeFrom && other.day <= shiftDay(day, span));
    const stock = db.prepare(`SELECT kind, stock, created_at FROM sku_stock_events WHERE user_id=? AND country='US' AND sku_key=? ORDER BY id`)
      .all(PET_SHOP_ID, lower(target.sku)).map((event) => ({ event: event.kind === 'out' ? '断货' : '补货', day: pacificDayOfLocal(event.created_at), stock: event.stock }))
      .filter((event) => event.day >= beforeFrom && event.day <= shiftDay(day, span));
    const afterDays = Math.max(sales.after?.days ?? 0, visits.after?.daysWithData ?? 0);
    return { id: row.id, kind: KINDS[row.kind]?.label ?? row.kind, status: STATUS_LABEL[row.status] ?? row.status, sku: target.sku, asin,
      style: target.style ?? null, size: target.size ?? null, color: target.color ?? null, executedDay: day,
      before: parseJson(row.before_json), after: parseJson(row.after_json), reason: row.reason,
      sales, traffic: visits, searchShare: search, otherChangesNearby: others, stockEvents: stock,
      caution: afterDays < 7 ? `执行后只有 ${afterDays} 天数据，结论不稳，至少等满 7 天` : null };
  });
  return { today, days: span, trafficCoverage: traffic, total: items.length, items,
    notes: ['before / after 是执行当天之前、之后各 days 天(执行当天不算,太平洋时间);after 只算到有数据的那天,看 days / daysWithData。',
      'sales 来自订单报告;traffic 来自业务报告「销售与流量」(访问量、转化率 = 订购件数 / 访问量);searchShare 是 ABA 搜索查询表现里这个 ASIN 在全部搜索词上的曝光、点击、购买份额(%),按整周比,执行那周不算。',
      '同期的其它改动(otherChangesNearby)、断货补货(stockEvents)、季节和广告变化都会影响对比,下结论前要排除。'] };
}
