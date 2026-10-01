// 宠物版销售看板:价格策略表、周销量和每月数据都从 pet_daily_sales 按「今天」实时算,不再存每日快照。
// 日期一律是美国太平洋时间的自然日。
import { shiftDay } from './petAmazon.js';

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const round = (value, digits = 2) => Number(value.toFixed(digits));
const ratio = (part, whole) => (whole > 0 && part != null ? round(part / whole * 100, 1) : null);
const weekday = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** 近 7 天 = 今天之前的 7 个完整日,和墨盒表一样随日期自动往后滚 */
export const recentDays = (today) => Array.from({ length: 7 }, (_, index) => shiftDay(today, index - 7));

/**
 * 每个 SKU 一行:在库、在途、近 7 天每日销量、近 3 日动销、7 天动销速度、本月销量、可售天数和预估售罄日。
 * skus 来自 SKU 库(含库存),sales 是 pet_daily_sales 的行,listings 是 Listing 售价。
 */
export function buildPriceBoard({ skus = [], sales = [], listings = [], today }) {
  const days = recentDays(today);
  const slot = new Map(days.map((day, index) => [day, index]));
  const monthStart = `${today.slice(0, 7)}-01`;
  const rows = new Map();
  const get = (sku) => {
    const key = String(sku ?? '').trim().toLowerCase();
    if (!key) return null;
    if (!rows.has(key)) rows.set(key, { sku: String(sku).trim(), asin: null, style: null, size: null, color: null,
      stock: null, transit: null, daily: days.map(() => 0), today: 0, monthUnits: 0, price: null, listingStatus: null });
    return rows.get(key);
  };
  for (const item of skus) {
    const row = get(item.sku);
    if (!row) continue;
    Object.assign(row, { asin: item.asin || row.asin, style: item.style || null, size: item.size || null,
      color: item.color || null, stock: item.stock ?? null, transit: item.transit ?? null });
  }
  for (const sale of sales) {
    if (sale.day > today) continue;
    const row = get(sale.sku);
    if (!row) continue;
    row.asin ||= sale.asin || null;
    if (slot.has(sale.day)) row.daily[slot.get(sale.day)] += sale.units;
    if (sale.day === today) row.today += sale.units;
    if (sale.day >= monthStart) row.monthUnits += sale.units;
  }
  for (const listing of listings) {
    const row = rows.get(String(listing.sku).toLowerCase());
    if (!row) continue;
    row.asin ||= listing.asin || null;
    row.price = listing.price ?? null;
    row.listingStatus = listing.status || null;
  }
  return { today, days, rows: [...rows.values()].map((row) => {
    const sales7d = row.daily.reduce((sum, units) => sum + units, 0);
    const speed = sales7d / 7;
    const stock = row.stock ?? null;
    const withTransit = stock == null && row.transit == null ? null : (stock ?? 0) + (row.transit ?? 0);
    return { ...row, sales7d,
      movement3d: round(row.daily.slice(-3).reduce((sum, units) => sum + units, 0) / 3),
      speed7d: round(speed),
      stockDays: stock != null && speed > 0 ? Math.round(stock / speed) : null,
      stockTransitDays: withTransit != null && speed > 0 ? Math.round(withTransit / speed) : null,
      // 按 7 天平均动销把在库卖完的日子;在库为 0 记为已断货
      selloutDate: stock > 0 && speed > 0 ? shiftDay(today, Math.ceil(stock / speed)) : null,
      soldOut: stock === 0 };
  }) };
}

/** ISO 周:周一开始,含 1 月 4 日的那周是第 1 周 */
export function isoWeek(day) {
  const thursday = shiftDay(day, 3 - weekday(day));
  const yearStart = `${thursday.slice(0, 4)}-01-01`;
  return { year: Number(thursday.slice(0, 4)),
    week: 1 + Math.floor((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${yearStart}T00:00:00Z`)) / (7 * 86400000)) };
}

/** 周销量:最近 weeks 个 ISO 周(含本周),每周按周一到周日列出全店销量;今天之后的日子为 null */
export function weeklySummary(unitsByDay, today, weeks = 8, coveredFrom = null) {
  const monday = shiftDay(today, -weekday(today));
  return Array.from({ length: weeks }, (_, index) => {
    const start = shiftDay(monday, -7 * (weeks - 1 - index));
    const days = Array.from({ length: 7 }, (_, offset) => {
      const day = shiftDay(start, offset);
      if (day > today || (coveredFrom && day < coveredFrom)) return null;
      return unitsByDay.get(day) ?? 0;
    });
    const known = days.filter((units) => units != null);
    return { ...isoWeek(start), start, end: shiftDay(start, 6), days,
      total: known.length ? known.reduce((sum, units) => sum + units, 0) : null, current: start === monday };
  });
}

const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/**
 * 每月数据:1–12 月。实际销量、销售额来自同步的订单;目标、实际利润、广告花费是人工填写。
 * 早于数据起点的月份实际值为 null(不是 0),数据只覆盖一部分的月份标 partial。
 */
export function monthlySummary({ year, actuals = new Map(), targets = new Map(), today, coveredFrom = null }) {
  const currentMonth = today.slice(0, 7);
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    const target = targets.get(month) ?? {};
    const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    const covered = month <= currentMonth && (!coveredFrom || lastDay >= coveredFrom);
    const actual = covered ? actuals.get(month) ?? { units: 0, sales: 0, estimatedSales: 0 } : null;
    const progress = month < currentMonth ? 100 : month > currentMonth ? 0
      : round(Number(today.slice(8, 10)) / daysInMonth(month) * 100, 1);
    const sales = actual ? round(actual.sales) : null;
    const pick = (key) => target[key] ?? null;
    return { month, label: `${Number(month.slice(5, 7))}月`, current: month === currentMonth,
      partial: !!(covered && coveredFrom && coveredFrom > `${month}-01`), progress,
      targetUnits: pick('targetUnits'), units: actual?.units ?? null, unitsRate: ratio(actual?.units, pick('targetUnits')),
      targetSales: pick('targetSales'), sales, estimatedSales: actual ? round(actual.estimatedSales) : null,
      salesRate: ratio(sales, pick('targetSales')),
      targetProfit: pick('targetProfit'), actualProfit: pick('actualProfit'), profitRate: ratio(pick('actualProfit'), pick('targetProfit')),
      adSpend: pick('adSpend'), adRatio: ratio(pick('adSpend'), sales), margin: ratio(pick('actualProfit'), sales) };
  });
  const sum = (key) => {
    const values = months.map((row) => row[key]).filter((value) => value != null);
    return values.length ? round(values.reduce((total, value) => total + value, 0)) : null;
  };
  const total = { month: String(year), label: '全年', targetUnits: sum('targetUnits'), units: sum('units'),
    targetSales: sum('targetSales'), sales: sum('sales'), estimatedSales: sum('estimatedSales'),
    targetProfit: sum('targetProfit'), actualProfit: sum('actualProfit'), adSpend: sum('adSpend') };
  Object.assign(total, { unitsRate: ratio(total.units, total.targetUnits), salesRate: ratio(total.sales, total.targetSales),
    profitRate: ratio(total.actualProfit, total.targetProfit), adRatio: ratio(total.adSpend, total.sales),
    margin: ratio(total.actualProfit, total.sales) });
  return { months, total };
}
