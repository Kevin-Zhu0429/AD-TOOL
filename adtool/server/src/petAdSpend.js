// 宠物版每天全店广告花费。亚马逊广告 API 还没开通,网站自己拉不到:
// 由 Claude 每天用 Miguelpet(SellerSpace)查好,通过 MCP save_ad_spend 写进来;以后广告 API 开通了改成网站自己同步。
// 销售统计里没手填广告花费的月份,按这里每天的数加起来,再从利润里扣掉。
import { db } from './db.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const round = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);
const optional = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** 写入每天的广告花费,同一天再写就覆盖(广告归因要几天才稳定,最近几天会重写) */
export function saveAdSpend(days, source = 'miguelpet') {
  const rows = [];
  for (const raw of days ?? []) {
    const day = String(raw?.day ?? '').trim();
    const spend = Number(raw?.spend);
    if (!DAY.test(day)) throw new Error(`日期格式应为 YYYY-MM-DD：${day || '(空)'}`);
    if (!Number.isFinite(spend) || spend < 0) throw new Error(`${day} 的广告花费不是有效金额`);
    rows.push({ day, spend: round(spend), sales: optional(raw.sales), orders: optional(raw.orders), clicks: optional(raw.clicks),
      impressions: optional(raw.impressions), source });
  }
  const upsert = db.prepare(`INSERT INTO pet_ad_spend_daily(day, spend, sales, orders, clicks, impressions, source)
    VALUES(@day, @spend, @sales, @orders, @clicks, @impressions, @source)
    ON CONFLICT(day) DO UPDATE SET spend=excluded.spend, sales=excluded.sales, orders=excluded.orders, clicks=excluded.clicks,
      impressions=excluded.impressions, source=excluded.source, updated_at=datetime('now','localtime')`);
  db.transaction(() => { for (const row of rows) upsert.run(row); })();
  return { saved: rows.length, ...adSpendCoverage() };
}

/** 有哪些天的数:最早、最晚、天数 */
export function adSpendCoverage() {
  const row = db.prepare('SELECT MIN(day) AS first, MAX(day) AS last, COUNT(*) AS days FROM pet_ad_spend_daily').get();
  return { firstDay: row.first ?? null, lastDay: row.last ?? null, days: row.days ?? 0 };
}

/** 某年每月的广告花费合计:Map(month → { spend, days, lastDay }) */
export function monthlyAdSpend(year) {
  return new Map(db.prepare(`SELECT substr(day,1,7) AS month, SUM(spend) AS spend, COUNT(*) AS days, MAX(day) AS lastDay
    FROM pet_ad_spend_daily WHERE day LIKE ? GROUP BY month`).all(`${year}-%`)
    .map((row) => [row.month, { spend: round(row.spend), days: row.days, lastDay: row.lastDay }]));
}

// ---------- 每个 SKU 每月的广告数据 ----------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 写入某个月每个 SKU 的广告花费和广告销售额,整月替换(月内归因还在变,每天重写本月)。
 * 同一个 SKU 出现多行(多个广告活动)就加起来。throughDay 是数据截到哪天。
 */
export function saveSkuAdStats(month, skus, { throughDay = null, source = 'miguelpet' } = {}) {
  if (!MONTH.test(String(month ?? ''))) throw new Error(`月份格式应为 YYYY-MM：${month || '(空)'}`);
  if (throughDay != null && (!DAY.test(throughDay) || !throughDay.startsWith(month))) throw new Error(`throughDay 应是 ${month} 里的日期`);
  const merged = new Map();
  for (const raw of skus ?? []) {
    const sku = String(raw?.sku ?? '').trim();
    const spend = Number(raw?.spend);
    if (!sku) throw new Error('每行都要有 SKU');
    if (!Number.isFinite(spend) || spend < 0) throw new Error(`${sku} 的广告花费不是有效金额`);
    const key = sku.toLowerCase();
    const row = merged.get(key) ?? { month, sku, asin: null, spend: 0, sales: null, orders: null, units: null, clicks: null, impressions: null };
    row.asin ||= raw.asin ? String(raw.asin).trim().toUpperCase() : null;
    row.spend += spend;
    for (const field of ['sales', 'orders', 'units', 'clicks', 'impressions']) {
      const value = optional(raw[field]);
      if (value != null) row[field] = (row[field] ?? 0) + value;
    }
    merged.set(key, row);
  }
  const insert = db.prepare(`INSERT INTO pet_ad_sku_monthly(month, sku, asin, spend, sales, orders, units, clicks, impressions, through_day, source)
    VALUES(@month, @sku, @asin, @spend, @sales, @orders, @units, @clicks, @impressions, @throughDay, @source)`);
  db.transaction(() => {
    db.prepare('DELETE FROM pet_ad_sku_monthly WHERE month=?').run(month);
    for (const row of merged.values()) insert.run({ ...row, spend: round(row.spend), sales: round(row.sales), throughDay, source });
  })();
  const rows = [...merged.values()];
  return { month, saved: rows.length, throughDay, spend: round(rows.reduce((sum, row) => sum + row.spend, 0)),
    sales: round(rows.reduce((sum, row) => sum + (row.sales ?? 0), 0)), months: skuAdMonths() };
}

/** 哪些月份有 SKU 广告数据,各截到哪天 */
export function skuAdMonths() {
  return db.prepare(`SELECT month, COUNT(*) AS skus, ROUND(SUM(spend), 2) AS spend, MAX(through_day) AS throughDay, MAX(updated_at) AS updatedAt
    FROM pet_ad_sku_monthly GROUP BY month ORDER BY month`).all();
}

/** 某月每个 SKU 的广告数据:Map(小写 SKU → 行) */
export function skuAdStats(month) {
  return new Map(db.prepare('SELECT * FROM pet_ad_sku_monthly WHERE month=?').all(month).map((row) => [row.sku.toLowerCase(), row]));
}
