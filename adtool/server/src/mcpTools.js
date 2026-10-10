// Claude 连接器(MCP)的工具。数据库里的数据直接查;Listing、竞品目录和图片实时调 SP-API。
// 查数据的工具只读。提议类工具只往网站的「待确认改动」队列里加记录,不改亚马逊;超级管理员在网站上确认后才执行。
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from './db.js';
import { PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, petSpConfig, shiftDay, US_MARKETPLACE } from './petAmazon.js';
import { buildPriceBoard, monthlySummary, recentDays, weeklySummary, WEEKDAYS } from './petSales.js';
import { priceSyncStatus } from './priceStrategySync.js';
import { abaSyncStatus } from './petAbaSync.js';
import { withProfit, yearGrossProfit } from './petCosts.js';
import { latestSync } from './stockEvents.js';
import { competitorSyncStatus, listingHealth, ownStyles, recentChanges, styleDetail } from './petCompetitors.js';
import { AD_ACTIONS, AD_ENTITIES, listChanges, proposeAdChanges, proposeListingChanges, STATUS_LABEL, targetLabel } from './petChanges.js';
import { TRAFFIC_GROUPS, trafficReport, trafficSyncStatus } from './petTraffic.js';
import { changeImpact } from './petImpact.js';
import { returnRecords, returnsAnalysis, returnsSyncStatus } from './petReturns.js';

// 测试可以用 PET_TODAY 固定「今天」;正式环境始终是美国太平洋时间的今天
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());
const round = (value, digits = 2) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const pct = (part, whole) => (whole > 0 ? round(part / whole * 100, 1) : null);
const lower = (value) => String(value ?? '').trim().toLowerCase();
const asinOf = (value) => (/^[A-Z0-9]{10}$/.test(String(value ?? '').trim().toUpperCase()) ? String(value).trim().toUpperCase() : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function skuLibrary() {
  return db.prepare(`SELECT sku, asin, brand, style, size, color, fabric, stock, transit FROM sku_items
    WHERE user_id=? AND country='US' ORDER BY sku`).all(PET_SHOP_ID);
}

// 在库、在途的口径(和卖家后台库存面板一致),写进工具返回的 notes
const STOCK_NOTE = '库存口径:在库 stock = 可用 available + 运营中心转运 transshipment + 正在接收 receiving;在途 transit = 处理中 working + 已发货 shipped。前台现在能买到的只有 available,stockDetail 里有拆开的数(最近一次库存同步)。';

/** 最近一次库存同步拆开的数:可用、转运、接收中、处理中、已发货 */
function inventoryDetail() {
  return new Map(db.prepare('SELECT sku, available, transshipment, receiving, working, shipped FROM pet_inventory_detail').all()
    .map(({ sku, ...detail }) => [lower(sku), detail]));
}

/** 价格策略表同款:每个 SKU 一行,含库存、近 7 天销量、动销、可售天数、售价 */
function priceBoard(today = todayOf()) {
  const skus = skuLibrary();
  const from = [recentDays(today)[0], `${today.slice(0, 7)}-01`].sort()[0];
  const sales = db.prepare('SELECT day,sku,asin,units FROM pet_daily_sales WHERE day>=? AND day<=?').all(from, today);
  const listings = db.prepare('SELECT sku,asin,price,status FROM pet_listing_cache').all();
  const board = buildPriceBoard({ skus, sales, listings, today });
  const extra = new Map(skus.map((item) => [lower(item.sku), item]));
  const detail = inventoryDetail();
  board.rows = withProfit(board.rows.map((row) => ({ ...row, brand: extra.get(lower(row.sku))?.brand ?? null, fabric: extra.get(lower(row.sku))?.fabric ?? null,
    stockDetail: detail.get(lower(row.sku)) ?? null })));
  return board;
}

/** 按 SKU / ASIN / 款式 / 关键字挑出 SKU 库里的行 */
function matchRows(rows, { sku, asin, style, size, color, query } = {}) {
  const has = (value, needle) => !needle || lower(value) === lower(needle);
  const q = lower(query);
  return rows.filter((row) => has(row.sku, sku) && has(row.asin, asin) && has(row.style, style) && has(row.size, size) && has(row.color, color)
    && (!q || [row.sku, row.asin, row.style, row.size, row.color, row.fabric].some((value) => lower(value).includes(q))));
}

function freshness() {
  const price = priceSyncStatus();
  const aba = abaSyncStatus();
  const competitors = competitorSyncStatus();
  const traffic = trafficSyncStatus();
  const returns = returnsSyncStatus();
  return { today: todayOf(), timezone: 'America/Los_Angeles', spApiConfigured: price.configured,
    trafficCoverage: traffic.coverage, lastTrafficSync: traffic.lastSuccess?.completedAt ?? null, lastTrafficSyncError: traffic.lastError?.message ?? null,
    salesCoverage: price.coverage, lastSalesSync: price.lastSuccess?.completedAt ?? null, lastSalesSyncError: price.lastError?.message ?? null,
    lastAbaSync: aba.lastSuccess?.completedAt ?? null, lastCompetitorSync: competitors.daily.lastSuccess?.completedAt ?? null,
    lastCompetitorSuggest: competitors.suggest.lastSuccess?.completedAt ?? null,
    returnsCoverage: returns.coverage, lastReturnsSync: returns.lastSuccess?.completedAt ?? null, lastReturnsSyncError: returns.lastError?.message ?? null };
}

/** 销售统计页同款的每月数据:实际销量销售额来自订单;利润没手填时按成本和亚马逊费用自动算 */
function monthlyTable(year, today, coveredFrom) {
  const actuals = new Map(db.prepare(`SELECT substr(day,1,7) AS month, SUM(units) AS units, SUM(sales) AS sales,
    SUM(estimated_sales) AS estimatedSales FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY month`)
    .all(`${year}-01-01`, `${year}-12-31`).map((row) => [row.month, row]));
  const targets = new Map(db.prepare(`SELECT month, target_units AS targetUnits, target_sales AS targetSales,
    target_profit AS targetProfit, actual_profit AS actualProfit, ad_spend AS adSpend FROM pet_monthly_targets WHERE month LIKE ?`)
    .all(`${year}-%`).map((row) => [row.month, row]));
  return monthlySummary({ year, actuals, targets, today, coveredFrom, profits: yearGrossProfit(year) });
}

const PROFIT_NOTES = ['单件毛利 = 售价 − 落地成本(FOB+头程+关税,人工维护) − FBA 配送费 − 佣金(来自亚马逊 Fee Preview 报告),未扣广告费和仓储费。',
  '每月实际利润额:手填了用手填(profitSource=manual);没填时 = 自动算的毛利 − 手填的广告花费(profitSource=auto)。缺成本的 SKU 不算进毛利,coverage 是算进去的销售额占比,missingCostSkus 列出缺成本的 SKU。'];

// ---------- 店铺总览 ----------

export function storeOverview({ weeks = 8 } = {}) {
  const today = todayOf();
  const board = priceBoard(today);
  const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const last7 = db.prepare('SELECT SUM(units) AS units, SUM(orders) AS orders, SUM(sales) AS sales FROM pet_daily_sales WHERE day>=? AND day<?')
    .get(shiftDay(today, -7), today);
  const prev7 = db.prepare('SELECT SUM(units) AS units, SUM(sales) AS sales FROM pet_daily_sales WHERE day>=? AND day<?')
    .get(shiftDay(today, -14), shiftDay(today, -7));
  const coveredFrom = priceSyncStatus().coverage?.from ?? null;
  const unitsByDay = new Map(db.prepare('SELECT day, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY day')
    .all(shiftDay(today, -7 * weeks - 7), today).map((row) => [row.day, row.units]));
  const monthly = monthlyTable(Number(today.slice(0, 4)), today, coveredFrom);
  const stockSync = latestSync(PET_SHOP_ID);
  const changes = recentChanges(today, 7);
  const brief = (row) => ({ sku: row.sku, asin: row.asin, style: row.style, size: row.size, color: row.color,
    stock: row.stock, available: row.stockDetail?.available ?? null, transit: row.transit, sales7d: row.sales7d, speed7d: row.speed7d, stockDays: row.stockDays });
  const selling = board.rows.filter((row) => row.sales7d > 0);
  return {
    data: freshness(),
    catalog: { skus: board.rows.length, asins: new Set(board.rows.map((row) => row.asin).filter(Boolean)).size,
      styles: [...new Set(board.rows.map((row) => row.style).filter(Boolean))].sort(),
      stock: sum(board.rows, 'stock'), transit: sum(board.rows, 'transit') },
    last7Days: { from: shiftDay(today, -7), to: shiftDay(today, -1), units: last7.units ?? 0, orders: last7.orders ?? 0, sales: round(last7.sales ?? 0),
      previous7DaysUnits: prev7.units ?? 0, previous7DaysSales: round(prev7.sales ?? 0) },
    today: { day: today, units: sum(board.rows, 'today') },
    thisMonth: monthly.months.find((row) => row.current) ?? null,
    weekly: weeklySummary(unitsByDay, today, weeks, coveredFrom).map(({ year: y, week, start, end, total, current }) => ({ year: y, week, start, end, units: total, current })),
    alerts: {
      soldOutWithDemand: board.rows.filter((row) => row.soldOut && row.sales7d > 0).map(brief),
      under21DaysOfStock: selling.filter((row) => row.stockDays != null && row.stockDays < 21 && !row.soldOut).sort((a, b) => a.stockDays - b.stockDays).map(brief),
      over180DaysOfStock: selling.filter((row) => row.stockDays >= 180).sort((a, b) => b.stockDays - a.stockDays).map(brief),
      stockButNoSales7d: board.rows.filter((row) => row.stock > 0 && row.sales7d === 0).map(brief),
      // 在库不是 0,但全在转运或接收中,前台暂时买不到
      inStockButNotBuyableYet: board.rows.filter((row) => row.stock > 0 && row.stockDetail?.available === 0)
        .map((row) => ({ ...brief(row), stockDetail: row.stockDetail })),
      losingMoneyPerUnit: board.rows.filter((row) => row.profit != null && row.profit < 0)
        .map((row) => ({ ...brief(row), price: row.price, profit: row.profit, breakEven: row.breakEven })),
      missingCost: board.rows.filter((row) => row.landedCost == null && (row.stock > 0 || row.sales7d > 0)).map((row) => row.sku),
    },
    // 最近一次库存同步和上一次比:在库从有变 0 是新断货,从 0 变有是补货
    lastStockSync: stockSync ? { syncedAt: stockSync.at,
      newlyOutOfStock: stockSync.outOfStock.map((event) => ({ sku: event.sku, asin: event.asin, prevStock: event.prevStock, transit: event.transit })),
      restocked: stockSync.restocked.map((event) => ({ sku: event.sku, asin: event.asin, stock: event.stock })) } : null,
    competitorChanges7d: { total: changes.length,
      byKind: changes.reduce((counts, change) => ({ ...counts, [change.label]: (counts[change.label] ?? 0) + 1 }), {}) },
    notes: ['销量来自亚马逊订单报告,按太平洋时间切日;待付款订单金额按 Listing 售价估算。',
      '广告数据(花费、点击、ACOS)要等亚马逊广告 API 开通,目前没有;广告花费是人工按月填写的。',
      STOCK_NOTE, ...PROFIT_NOTES, 'lastStockSync.syncedAt 是服务器本地时间(北京时间)。竞品变化明细用 get_competitor_overview。'],
  };
}

// ---------- 销售统计 ----------

export function salesStats({ year, weeks = 8 } = {}) {
  const today = todayOf();
  const coveredFrom = priceSyncStatus().coverage?.from ?? null;
  const unitsByDay = new Map(db.prepare('SELECT day, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY day')
    .all(shiftDay(today, -7 * weeks - 7), today).map((row) => [row.day, row.units]));
  return { today, coveredFrom, weekdays: WEEKDAYS,
    weekly: weeklySummary(unitsByDay, today, weeks, coveredFrom),
    year: year ?? Number(today.slice(0, 4)), monthly: monthlyTable(year ?? Number(today.slice(0, 4)), today, coveredFrom),
    notes: ['weekly 是全店每周周一到周日的销量(ISO 周),days 按 weekdays 的顺序;今天之后和数据起点之前为 null。',
      'monthly:目标、广告花费是人工填写;progress 是本月时间进度(%);partial 表示数据只覆盖这个月的一部分。', ...PROFIT_NOTES] };
}

// ---------- 产品情报:竞品监控 ----------

/** 款式名不分大小写;找不到时列出现有款式 */
function styleKeyFor(style, today) {
  const styles = ownStyles(today);
  const found = styles.find((item) => lower(item.key) === lower(style));
  if (!found) throw new Error(`找不到款式「${style}」。现有款式:${styles.map((item) => item.key).slice(0, 60).join('、')}`);
  return found.key;
}

export function competitorOverview({ days = 14, style } = {}) {
  const today = todayOf();
  const key = style ? styleKeyFor(style, today) : null;
  const counts = new Map();
  for (const row of db.prepare('SELECT style_key, status, COUNT(*) AS n FROM pet_competitors GROUP BY style_key, status').all()) {
    if (!counts.has(row.style_key)) counts.set(row.style_key, {});
    counts.get(row.style_key)[row.status] = row.n;
  }
  const changes = recentChanges(today, days).filter((change) => !key || change.styleKey === key);
  const sync = competitorSyncStatus();
  return { today, days,
    styles: ownStyles(today).filter((item) => !key || item.key === key).map((item) => ({ style: item.key, skus: item.skus.length, asins: item.asins,
      units7: item.units7, units30: item.units30, competitors: counts.get(item.key)?.active ?? 0, suggested: counts.get(item.key)?.suggested ?? 0,
      changes: changes.filter((change) => change.styleKey === item.key).length })),
    changes: changes.slice(0, 200).map(({ id: _id, ...change }) => change),
    sync: { lastDaily: sync.daily.lastSuccess?.completedAt ?? null, lastDailyError: sync.daily.lastError?.message ?? null,
      pricingError: sync.daily.pricingError?.message ?? null, autopickError: sync.daily.autopickError?.message ?? null, lastSuggest: sync.suggest.lastSuccess?.completedAt ?? null,
      lastSuggestWeek: sync.suggest.lastSuccess?.week ?? null },
    notes: ['款式 = SKU 库的款式,没填款式时用 SKU 开头的款号。竞品按父 ASIN(家族)挂在款式下,每天同步一次价格、排名、标题、五点和主图。',
      'changes 的 kind:price_down 降价、price_up 涨价、title 改标题、bullets 改五点、main_image 换主图、bsr_up 排名大涨、no_buybox 没购物车、variants_added/removed 变体增减。'] };
}

export function styleIntel({ style, includeHistory = false } = {}) {
  const today = todayOf();
  const detail = styleDetail(styleKeyFor(style, today), today);
  const strip = (family) => (includeHistory ? family : (({ history: _history, ...rest }) => rest)(family));
  return { ...detail, own: strip(detail.own), competitors: detail.competitors.map(strip),
    notes: ['terms 是这个款式最近 4 周 ABA 里有点击的核心词(按市场购买量排序),share 为 0–1 的小数。',
      'coverage 表示每个核心词写在标题(title)、五点(bullets)、后台搜索词(backend,只有自家有)还是没写(null)。',
      '竞品的评分、评论数、销量(rating/reviews/units)来自每月导入的卖家精灵数据,metricsMonth 是数据月份;价格和 BSR 来自每天同步。',
      'priceChange7 是竞品最低价和 7 天前比的变化;priceBand 是已监控竞品最低价的分布。suggestions 是系统推荐、还没确认的候选竞品。'] };
}

export function listingHealthReport({ style, level = 'all', limit = 100 } = {}) {
  const today = todayOf();
  const key = style ? styleKeyFor(style, today) : null;
  const rows = listingHealth(today).filter((row) => (!key || row.styleKey === key)
    && (level === 'all' || row.checks.some((check) => check.level === 'red' || (level === 'yellow' && check.level === 'yellow'))));
  const count = (wanted) => rows.filter((row) => row.checks.some((check) => check.level === wanted)).length;
  return { today, total: rows.length, withRed: count('red'), withYellow: count('yellow'), rows: rows.slice(0, limit),
    notes: ['red = 影响展示或收录,必须改:亚马逊报错(主图被屏蔽、五点违规等)、后台搜索词超过 249 字节(整段不生效)、标题超过 200 字符、没有五点或图片。'
      + 'yellow = 建议改:标题没品牌、标题短于 80 字符、五点不足 5 条、图片少于 7 张或少于竞品中位数、有量的核心词(近 4 周全市场成交 20 单以上)没写进文案、亚马逊警告、售价比同尺码竞品中位价高 20% 以上。每条检查带 code。',
      '文案数据来自每天的目录同步,不是实时;要看实时 Listing 用 get_listing。'] };
}

// ---------- SKU 列表 ----------

const SORTS = ['sales7d', 'monthUnits', 'stock', 'stockDays', 'speed7d', 'price', 'profit', 'margin', 'sku'];
export function listSkus({ query, style, size, color, sortBy = 'sales7d', limit = 200 } = {}) {
  const board = priceBoard();
  const rows = matchRows(board.rows, { query, style, size, color });
  const key = SORTS.includes(sortBy) ? sortBy : 'sales7d';
  rows.sort((a, b) => key === 'sku' ? a.sku.localeCompare(b.sku)
    : (a[key] == null) - (b[key] == null) || (['stockDays', 'profit', 'margin'].includes(key) ? a[key] - b[key] : b[key] - a[key]) || a.sku.localeCompare(b.sku));
  return { today: board.today, last7Days: board.days, total: rows.length, sortBy: key,
    rows: rows.slice(0, limit).map((row) => ({ sku: row.sku, asin: row.asin, style: row.style, size: row.size, color: row.color, fabric: row.fabric,
      price: row.price, listingStatus: row.listingStatus, stock: row.stock, transit: row.transit, stockDetail: row.stockDetail, dailyLast7: row.daily, today: row.today,
      sales7d: row.sales7d, movement3d: row.movement3d, speed7d: row.speed7d, monthUnits: row.monthUnits,
      stockDays: row.stockDays, stockTransitDays: row.stockTransitDays, selloutDate: row.selloutDate, soldOut: row.soldOut,
      fob: row.fob, firstLeg: row.firstLeg, duty: row.duty, landedCost: row.landedCost, fbaFee: row.fbaFee, referralFee: row.referralFee,
      profit: row.profit, margin: row.margin, breakEven: row.breakEven, profitMissing: row.missing })),
    notes: [STOCK_NOTE] };
}

// ---------- 销量趋势 ----------

const bucketOf = (day, groupBy) => {
  if (groupBy === 'month') return day.slice(0, 7);
  if (groupBy === 'week') return shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
  return day;
};

export function salesTrend({ sku, asin, style, size, color, from, to, groupBy = 'day', splitBySku = false } = {}) {
  const today = todayOf();
  const end = to && DAY.test(to) ? to : today;
  const start = from && DAY.test(from) ? from : shiftDay(end, -29);
  if (start > end) throw new Error('from 不能晚于 to');
  const filtered = !!(sku || asin || style || size || color);
  const matched = filtered ? matchRows(skuLibrary(), { sku, asin, style, size, color }).map((row) => row.sku) : null;
  const skus = matched?.map(lower);
  // SKU 库里没有、但订单里出现过的 SKU,按 SKU / ASIN 直接匹配
  const wanted = (row) => !filtered || skus.includes(lower(row.sku)) || (sku && lower(row.sku) === lower(sku)) || (asin && lower(row.asin) === lower(asin));
  const rows = db.prepare('SELECT day, sku, asin, units, orders, sales, estimated_sales AS estimatedSales FROM pet_daily_sales WHERE day>=? AND day<=? ORDER BY day')
    .all(start, end).filter(wanted);
  const buckets = new Map();
  for (const row of rows) {
    const key = `${bucketOf(row.day, groupBy)}\0${splitBySku ? row.sku : ''}`;
    if (!buckets.has(key)) buckets.set(key, { period: bucketOf(row.day, groupBy), ...(splitBySku ? { sku: row.sku, asin: row.asin } : {}), units: 0, orders: 0, sales: 0, estimatedSales: 0 });
    const bucket = buckets.get(key);
    bucket.units += row.units; bucket.orders += row.orders; bucket.sales += row.sales; bucket.estimatedSales += row.estimatedSales;
  }
  const series = [...buckets.values()].map((row) => ({ ...row, sales: round(row.sales), estimatedSales: round(row.estimatedSales) }));
  const total = series.reduce((sum, row) => ({ units: sum.units + row.units, orders: sum.orders + row.orders, sales: sum.sales + row.sales }), { units: 0, orders: 0, sales: 0 });
  return { from: start, to: end, groupBy, coveredFrom: priceSyncStatus().coverage?.from ?? null,
    matchedSkus: matched, total: { ...total, sales: round(total.sales) }, series,
    note: groupBy === 'week' ? 'period 是该周周一' : undefined };
}

// ---------- ABA 搜索词 ----------

const ABA_SORTS = ['query_volume', 'market_impressions', 'market_clicks', 'market_purchases', 'asin_impressions', 'asin_clicks', 'asin_purchases',
  'impression_share', 'click_share', 'purchase_share'];

export function searchTerms({ asin, weeks = 4, weekEnd, contains, sortBy = 'query_volume', limit = 50 } = {}) {
  const reports = db.prepare(`SELECT id, asin, week_start, week_end, week_number FROM aba_asin_reports
    WHERE user_id=? AND marketplace='US' ORDER BY week_end DESC`).all(PET_SHOP_ID);
  const allWeeks = [...new Set(reports.map((report) => report.week_end))];
  const pickWeeks = weekEnd ? allWeeks.filter((day) => day === weekEnd) : allWeeks.slice(0, weeks);
  const wantAsin = asin ? asinOf(asin) : null;
  if (asin && !wantAsin) throw new Error('ASIN 格式不对');
  const chosen = new Map(reports.filter((report) => pickWeeks.includes(report.week_end) && (!wantAsin || report.asin === wantAsin)).map((report) => [report.id, report]));
  const asinsWithData = [...new Set(reports.map((report) => report.asin))].sort();
  if (!chosen.size) return { asin: wantAsin, weeks: pickWeeks, availableWeeks: allWeeks.slice(0, 12), asinsWithData, total: 0, rows: [] };
  const needle = lower(contains);
  // 同一周同一个搜索词,市场数据(搜索量、市场曝光/点击/购买)对每个 ASIN 都一样,只算一次;ASIN 数据相加
  const market = new Map();
  const terms = new Map();
  const select = db.prepare('SELECT * FROM aba_asin_queries WHERE report_id=?');
  for (const report of chosen.values()) {
    for (const row of select.iterate(report.id)) {
      if (needle && !row.query.toLowerCase().includes(needle)) continue;
      const marketKey = `${row.query}\0${report.week_end}`;
      const previous = market.get(marketKey);
      market.set(marketKey, { query: row.query, query_volume: Math.max(previous?.query_volume ?? 0, row.query_volume),
        market_impressions: Math.max(previous?.market_impressions ?? 0, row.market_impressions),
        market_clicks: Math.max(previous?.market_clicks ?? 0, row.market_clicks), market_purchases: Math.max(previous?.market_purchases ?? 0, row.market_purchases) });
      if (!terms.has(row.query)) terms.set(row.query, { query: row.query, asin_impressions: 0, asin_clicks: 0, asin_purchases: 0, asins: new Set() });
      const term = terms.get(row.query);
      term.asin_impressions += row.asin_impressions; term.asin_clicks += row.asin_clicks; term.asin_purchases += row.asin_purchases;
      if (row.asin_impressions || row.asin_clicks || row.asin_purchases) term.asins.add(report.asin);
    }
  }
  for (const value of market.values()) {
    const term = terms.get(value.query);
    for (const key of ['query_volume', 'market_impressions', 'market_clicks', 'market_purchases']) term[key] = (term[key] ?? 0) + value[key];
  }
  const rows = [...terms.values()].map((term) => ({ query: term.query, query_volume: term.query_volume,
    market_impressions: term.market_impressions, market_clicks: term.market_clicks, market_purchases: term.market_purchases,
    asin_impressions: term.asin_impressions, asin_clicks: term.asin_clicks, asin_purchases: term.asin_purchases,
    impression_share: pct(term.asin_impressions, term.market_impressions), click_share: pct(term.asin_clicks, term.market_clicks),
    purchase_share: pct(term.asin_purchases, term.market_purchases),
    asin_ctr: pct(term.asin_clicks, term.asin_impressions), asin_cvr: pct(term.asin_purchases, term.asin_clicks),
    market_ctr: pct(term.market_clicks, term.market_impressions), market_cvr: pct(term.market_purchases, term.market_clicks),
    ...(wantAsin ? {} : { asins: [...term.asins].sort() }) }));
  const key = ABA_SORTS.includes(sortBy) ? sortBy : 'query_volume';
  rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.query.localeCompare(b.query));
  return { asin: wantAsin ?? 'ALL', weeks: [...new Set([...chosen.values()].map((report) => report.week_end))].sort().reverse(),
    availableWeeks: allWeeks.slice(0, 12), asinsWithData, total: rows.length, sortBy: key, rows: rows.slice(0, limit),
    notes: ['数据来自品牌分析「搜索查询表现」ASIN 视图,周为周日到周六,week 字段是周六。', 'share 是本店 ASIN 占该搜索词全市场的百分比;ctr / cvr 是点击率、转化率(%)。',
      ...(wantAsin ? [] : ['未指定 ASIN 时为全部 ASIN 合计;市场数据同一周同一个词只算一次。'])] };
}

// ---------- SP-API:Listing、目录、图片 ----------

function spAccount(env) {
  const { account, issues } = petSpConfig(env);
  if (!account) throw new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证(PET_SP_*)');
  return account;
}

/** 亚马逊属性是 [{ value, language_tag, marketplace_id }] 这种结构,压成简单的字符串或数组 */
export function flattenAttributes(attributes = {}, { skip = /image_locator$/ } = {}) {
  const simple = (entry) => {
    if (entry == null || typeof entry !== 'object') return entry;
    if ('value' in entry && Object.keys(entry).every((key) => ['value', 'language_tag', 'marketplace_id', 'unit'].includes(key))) {
      return entry.unit ? `${entry.value} ${entry.unit}` : entry.value;
    }
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'language_tag' || key === 'marketplace_id') continue;
      out[key] = Array.isArray(value) ? value.map(simple) : simple(value);
    }
    return out;
  };
  const result = {};
  for (const [name, values] of Object.entries(attributes)) {
    if (skip.test(name)) continue;
    const list = (Array.isArray(values) ? values : [values]).filter((entry) => !entry?.marketplace_id || entry.marketplace_id === US_MARKETPLACE).map(simple);
    result[name] = list.length === 1 ? list[0] : list;
  }
  return result;
}

const textList = (attributes, name) => (attributes?.[name] ?? []).map((entry) => entry?.value).filter((value) => typeof value === 'string');

/** 每个图片位置(MAIN、PT01…)挑一张:宽度最接近 1000 的 */
export function pickImages(imageSets = []) {
  const set = imageSets.find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? imageSets[0];
  const byVariant = new Map();
  for (const image of set?.images ?? []) {
    const current = byVariant.get(image.variant);
    const score = (item) => Math.abs((item.width ?? 0) - 1000);
    if (!current || score(image) < score(current)) byVariant.set(image.variant, image);
  }
  const order = (variant) => (variant === 'MAIN' ? -1 : Number(String(variant).replace(/\D/g, '')) || 99);
  return [...byVariant.values()].sort((a, b) => order(a.variant) - order(b.variant))
    .map((image) => ({ variant: image.variant, url: image.link, width: image.width, height: image.height }));
}

export async function getListing({ sku, asin }, { gateway = amazonGateway, env = process.env } = {}) {
  const account = spAccount(env);
  let target = sku;
  if (!target && asin) {
    const wanted = asinOf(asin);
    target = db.prepare("SELECT sku FROM sku_items WHERE user_id=? AND country='US' AND upper(asin)=? ORDER BY sku").get(PET_SHOP_ID, wanted)?.sku
      ?? db.prepare('SELECT sku FROM pet_listing_cache WHERE upper(asin)=? ORDER BY sku').get(wanted)?.sku;
    if (!target) throw new Error(`SKU 库里找不到 ASIN ${asin} 对应的 SKU`);
  }
  if (!target) throw new Error('请提供 sku 或 asin');
  const payload = await gateway.request(account, account.region, 'GET',
    `/listings/2021-08-01/items/${encodeURIComponent(account.sellerId)}/${encodeURIComponent(target)}`, { query: {
      marketplaceIds: US_MARKETPLACE, includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability', issueLocale: 'en_US',
    } });
  const summary = (payload?.summaries ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? payload?.summaries?.[0] ?? {};
  const attributes = payload?.attributes ?? {};
  const imageAttributes = Object.entries(attributes).filter(([name]) => /image_locator$/.test(name))
    .map(([name, values]) => ({ slot: name.replace(/_product_image_locator$|_image_locator$/, ''), url: values?.[0]?.media_location ?? null }));
  return {
    sku: payload?.sku ?? target, asin: summary.asin ?? null, productType: summary.productType ?? null,
    status: summary.status ?? [], conditionType: summary.conditionType ?? null, lastUpdated: summary.lastUpdatedDate ?? null,
    title: textList(attributes, 'item_name')[0] ?? summary.itemName ?? null,
    bulletPoints: textList(attributes, 'bullet_point'),
    description: textList(attributes, 'product_description')[0] ?? null,
    backendSearchTerms: textList(attributes, 'generic_keyword'),
    brand: textList(attributes, 'brand')[0] ?? null,
    images: imageAttributes,
    offers: (payload?.offers ?? []).filter((offer) => offer.marketplaceId === US_MARKETPLACE)
      .map((offer) => ({ type: offer.offerType, price: offer.price?.amount ?? offer.price?.listingPrice?.amount ?? null, currency: offer.price?.currencyCode ?? null })),
    fulfillment: payload?.fulfillmentAvailability ?? [],
    issues: (payload?.issues ?? []).map((issue) => ({ severity: issue.severity, code: issue.code, message: issue.message, attributes: issue.attributeNames })),
    attributes: flattenAttributes(attributes),
  };
}

export async function getCatalogItems({ asins }, { gateway = amazonGateway, env = process.env } = {}) {
  const account = spAccount(env);
  const list = [...new Set(asins.map(asinOf).filter(Boolean))];
  if (!list.length) throw new Error('请提供 1–10 个有效 ASIN');
  const payload = await gateway.request(account, account.region, 'GET', '/catalog/2022-04-01/items', { query: {
    identifiers: list.join(','), identifiersType: 'ASIN', marketplaceIds: US_MARKETPLACE,
    includedData: 'summaries,attributes,images,salesRanks,relationships', pageSize: 20,
  } });
  const own = new Set(db.prepare("SELECT upper(asin) AS asin FROM sku_items WHERE user_id=? AND country='US' AND asin IS NOT NULL").all(PET_SHOP_ID).map((row) => row.asin));
  const items = (payload?.items ?? []).map((item) => {
    const summary = (item.summaries ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? item.summaries?.[0] ?? {};
    const ranks = (item.salesRanks ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? {};
    const relations = (item.relationships ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE)?.relationships ?? [];
    return {
      asin: item.asin, ownProduct: own.has(String(item.asin).toUpperCase()),
      title: summary.itemName ?? textList(item.attributes, 'item_name')[0] ?? null, brand: summary.brand ?? summary.brandName ?? null,
      color: summary.color ?? null, size: summary.size ?? null, style: summary.style ?? null,
      bulletPoints: textList(item.attributes, 'bullet_point'), description: textList(item.attributes, 'product_description')[0] ?? null,
      salesRanks: [...(ranks.classificationRanks ?? []), ...(ranks.displayGroupRanks ?? [])].map((rank) => ({ category: rank.title, rank: rank.rank })),
      variation: relations.map((relation) => ({ type: relation.type, parentAsins: relation.parentAsins, childCount: relation.childAsins?.length ?? 0, theme: relation.variationTheme?.attributes })),
      images: pickImages(item.images),
      attributes: flattenAttributes(item.attributes),
    };
  });
  const found = new Set(items.map((item) => item.asin));
  return { items, notFound: list.filter((asin) => !found.has(asin)),
    notes: ['价格、评分、评论数不在亚马逊目录接口里;销量排名(BSR)是亚马逊目录给的当前值。'] };
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const fetchImage = async (url) => {
  if (!/^https:\/\//.test(url)) throw new Error('图片地址不是 https');
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`下载图片失败 (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片太大');
  return { data: bytes.toString('base64'), mimeType: (response.headers.get('content-type') || 'image/jpeg').split(';')[0] };
};

export async function getProductImages({ asin, limit = 7 }, { gateway = amazonGateway, env = process.env, download = fetchImage } = {}) {
  const { items } = await getCatalogItems({ asins: [asin] }, { gateway, env });
  const item = items[0];
  if (!item) throw new Error(`亚马逊目录里找不到 ASIN ${asin}`);
  const images = item.images.slice(0, limit);
  const content = [{ type: 'text', text: JSON.stringify({ asin: item.asin, title: item.title, ownProduct: item.ownProduct, totalImages: item.images.length,
    images: images.map(({ variant, url, width, height }) => ({ variant, url, width, height })) }) }];
  for (const image of images) {
    try {
      content.push({ type: 'text', text: `图片 ${image.variant}` }, { type: 'image', ...(await download(image.url)) });
    } catch (error) {
      content.push({ type: 'text', text: `图片 ${image.variant} 没取到:${error.message}` });
    }
  }
  return { content };
}

// ---------- 改动提议 ----------

/** 确认页地址:网站首页加 #changes */
function confirmUrl(siteUrl) {
  try { return new URL('/#changes', siteUrl).href; } catch { return null; }
}

const NEXT_STEP = '这些改动已放进网站「待确认改动」页，还没有改亚马逊。请店主到网站上逐条确认，确认后 Listing 改动通过 SP-API 提交，广告改动在广告 API 开通前会生成批量表。';

export async function proposeListing(input, { userId, source, gateway = amazonGateway, env = process.env, siteUrl } = {}) {
  const result = await proposeListingChanges(input, { userId, source, gateway, env });
  return { ...result, confirmUrl: confirmUrl(siteUrl), next: result.created.length ? NEXT_STEP : '没有改动进入待确认队列，原因见 rejected。' };
}

export function proposeAds(input, { userId, source, siteUrl } = {}) {
  const result = proposeAdChanges(input, { userId, source });
  return { ...result, confirmUrl: confirmUrl(siteUrl), next: result.created.length ? NEXT_STEP : '没有改动进入待确认队列，原因见 rejected。',
    notes: ['网站里还没有广告数据，编号和当前值按你给的记录，确认页会标成「未核实」。'] };
}

const ALL_STATUSES = Object.keys(STATUS_LABEL);
const PROPOSAL_VIEWS = { pending: ['pending'], active: ['queued', 'running', 'submitted', 'export', 'exported', 'failed'],
  done: ['applied', 'not_applied'], closed: ['rejected', 'superseded'], all: ALL_STATUSES };

export function changeProposals({ status = 'all', limit = 50 } = {}, { env = process.env } = {}) {
  const { items, batches, byStatus, config } = listChanges({ statuses: PROPOSAL_VIEWS[status] ?? ALL_STATUSES, limit: 1000, env });
  const titles = new Map(batches.map((batch) => [batch.id, batch.title]));
  const rows = items.sort((a, b) => b.id - a.id).slice(0, limit).map((item) => ({
    id: item.id, batch: titles.get(item.batchId) ?? null, kind: item.kind, change: item.kindLabel, status: item.status, statusLabel: item.statusLabel,
    target: targetLabel(item.kind, item.target), asin: item.target.asin ?? null, before: item.before, after: item.after, reason: item.reason,
    warnings: item.warnings, error: item.error, channel: item.channel, createdAt: item.createdAt, decidedAt: item.decidedAt, decidedBy: item.decidedBy,
    executedAt: item.executedAt, verifiedAt: item.verifiedAt, amazonIssues: item.result?.listingIssues ?? item.result?.issues ?? [] }));
  return { counts: byStatus, statusLabels: STATUS_LABEL, total: items.length, rows, writeChannels: { listing: config.spApi ? 'SP-API' : '未配置 SP-API',
    ads: config.adsApi ? '广告 API' : '批量表（广告 API 未配置）' },
  notes: ['时间是服务器本地时间(北京时间)。submitted 表示亚马逊已接受、等生效，网站每 20 分钟核对一次，生效后变 applied;48 小时还没生效变 not_applied。'] };
}

// ---------- 注册到 MCP ----------

const INSTRUCTIONS = `这是一家亚马逊美国站宠物用品店(主营宠物狗窝)的运营数据,来自店主自建的 AD-TOOL 网站。
查数据的工具都只读:数据库里同步好的销量、库存、价格、利润、ABA 搜索词、竞品,以及实时调亚马逊 SP-API 看 Listing、竞品目录和图片。
propose_listing_changes、propose_ad_changes 只把改动放进网站的「待确认改动」队列,不会直接改亚马逊;店主在网站上逐条确认后才执行。执行结果用 list_change_proposals 查。
日期都是美国太平洋时间。广告数据(花费、ACOS、搜索词报告)要等亚马逊广告 API 开通,目前网站里没有。
分析某个产品的常用顺序:store_overview 看全店(含利润、断货补货、竞品变化提醒) → list_skus 找到 SKU/ASIN、看单件毛利和库存拆分 → get_sales_trend 看趋势 → get_traffic 看访问量和转化率(分清是没流量还是转化差) → get_search_terms 看流量词和份额 → get_style_intel 看这个款式的竞品、价格带和核心词覆盖 → get_listing_health 看文案体检 → get_listing 看实时文案 → get_catalog_items / get_product_images 对比竞品。
改动执行后用 get_change_impact 看前后对比(销量、访问量、转化率、搜索份额),至少等执行后 7 天再下结论。
看退货率、退货原因和买家退货留言用 get_returns(转化正常但差评多、或某个尺码卖得好却留不住时先看它)。
看月度目标和利润用 get_sales_stats;看竞品最近的降价、改标题、换主图用 get_competitor_overview。
提改动前:先用 get_listing 看现在的文案;尺寸、材质、填充物等产品规格只写有依据的,拿不准就先问用户,不要编;同一款的不同尺码、颜色是不同 SKU,要分别提;改五点要给出全部条目;reason 写清依据的数据(搜索词份额、竞品对比、体检问题、毛利)。改价前看 list_skus 的保本价;正在做促销价的 SKU 改原价前台不变,要改前台价提 sale_price(促销价,带结束日期)。广告改动需要广告活动、广告组、关键词等的数字编号,只有用户给了批量表或报告时才能提。提完把 confirmUrl 告诉用户去确认。
用户是中文卖家,回答用中文;给优化建议时说明依据的数据。`;

export function createPetMcpServer(deps = {}) {
  const server = new McpServer({ name: 'adtool-pet', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const local = { readOnlyHint: true, openWorldHint: false };
  const remote = { readOnlyHint: true, openWorldHint: true };
  const wrap = (handler) => async (args, extra) => {
    try {
      const result = await handler(args, extra);
      return result?.content ? result : json(result);
    } catch (error) {
      return fail(error.message || String(error));
    }
  };
  const optionalText = (description) => z.string().trim().min(1).max(200).optional().describe(description);

  server.registerTool('store_overview', {
    title: '店铺总览',
    description: '全店数据新鲜度、SKU/ASIN 数、近 7 天和前 7 天销量销售额、本月目标完成和利润、最近几周周销量;断货、库存不足、积压、有货不动销、每件亏钱、缺成本的 SKU 提醒;最近一次库存同步的新断货和补货;近 7 天竞品变化数量。分析前先调用它。',
    inputSchema: { weeks: z.number().int().min(1).max(26).default(8).describe('周销量看最近几周') },
    annotations: local,
  }, wrap((args) => storeOverview(args)));

  server.registerTool('get_sales_stats', {
    title: '销售统计',
    description: '销售统计页同款:最近几周全店按周一到周日的销量;某年 1–12 月的目标销量/销售额/利润、实际销量/销售额、实际利润额(手填或按成本自动算)、毛利、利润率、广告花费、费比、完成率。',
    inputSchema: { year: z.number().int().min(2000).max(2100).optional().describe('年份,默认今年'),
      weeks: z.number().int().min(1).max(53).default(8).describe('周销量看最近几周') },
    annotations: local,
  }, wrap((args) => salesStats(args)));

  server.registerTool('list_skus', {
    title: 'SKU 列表与实时指标',
    description: '价格策略表同款:每个 SKU 的 ASIN、款式、尺码、颜色、面料、售价、在库、在途(stockDetail 拆成可用、运营中心转运、正在接收、处理中、已发货)、近 7 天每日销量、近 3 日动销、7 天动销速度、本月销量、可售天数、预估售罄日;以及成本(FOB、头程、关税、落地成本)、FBA 配送费、佣金、单件毛利(美元)、毛利率(%)、保本价。毛利未扣广告费和仓储费,缺数据时 profitMissing 列出缺哪项。可按关键字和属性筛选、排序。',
    inputSchema: {
      query: optionalText('模糊匹配 SKU、ASIN、款式、尺码、颜色、面料'),
      style: optionalText('款式(精确匹配)'), size: optionalText('尺码(精确匹配)'), color: optionalText('颜色(精确匹配)'),
      sortBy: z.enum(SORTS).default('sales7d').describe('排序字段;stockDays、profit、margin 从少到多(先看亏损的),其余从多到少'),
      limit: z.number().int().min(1).max(500).default(200),
    },
    annotations: local,
  }, wrap((args) => listSkus(args)));

  server.registerTool('get_sales_trend', {
    title: '销量趋势',
    description: '按天、周或月汇总销量、订单数、销售额(美元)。可限定 SKU、ASIN、款式、尺码、颜色,也可按 SKU 拆开。默认最近 30 天全店。',
    inputSchema: {
      sku: optionalText('SKU'), asin: optionalText('ASIN'), style: optionalText('款式'), size: optionalText('尺码'), color: optionalText('颜色'),
      from: z.string().regex(DAY).optional().describe('开始日期 YYYY-MM-DD(含)'), to: z.string().regex(DAY).optional().describe('结束日期 YYYY-MM-DD(含),默认今天'),
      groupBy: z.enum(['day', 'week', 'month']).default('day'), splitBySku: z.boolean().default(false).describe('每个 SKU 单独一行'),
    },
    annotations: local,
  }, wrap((args) => salesTrend(args)));

  server.registerTool('get_traffic', {
    title: '访问量与转化率',
    description: '亚马逊业务报告「销售与流量」:每个子 ASIN 每天的访问量(sessions)、页面浏览量、订购件数、销售额、转化率(订购件数/访问量)、购物车占有率、手机访问占比。可按 ASIN、款式、天、周或合计汇总,按 SKU/ASIN/款式/尺码/颜色筛选。用来分清一个款是没流量还是转化差、看改动前后的变化。一般晚 2 天出数。',
    inputSchema: {
      asin: optionalText('只看这个 ASIN'), sku: optionalText('只看这个 SKU 对应的 ASIN'), style: optionalText('只看这个款式'),
      size: optionalText('只看这个尺码'), color: optionalText('只看这个颜色'),
      from: z.string().regex(DAY).optional().describe('开始日 YYYY-MM-DD(太平洋时间)'), to: z.string().regex(DAY).optional().describe('结束日,默认有数据的最近一天'),
      days: z.number().int().min(1).max(365).default(28).describe('不填 from 时看最近几天'),
      groupBy: z.enum(TRAFFIC_GROUPS).default('asin').describe('asin 每个 ASIN 一行 / style 按款式 / day 按天 / week 按周(周一开始) / total 合计'),
      limit: z.number().int().min(1).max(500).default(200),
    },
    annotations: local,
  }, wrap((args) => trafficReport(args)));

  server.registerTool('get_returns', {
    title: '退货分析',
    description: '亚马逊 FBA 买家退货报告:最近 N 天每个 SKU 的退货件数、退货率(退回件数/同期卖出件数)、退货原因(亚马逊原因代码和中文、归成尺寸/与描述不符/质量/运输损坏/买家原因等大类)、退回后是否可售、买家留言(英文)和按关键词归的留言主题(偏小、太薄、不防水、做工等);按款式汇总(含每个尺码嫌小/嫌大的件数),并给出规则归纳。填 sku 时附上这个 SKU 的全部退货明细。',
    inputSchema: {
      days: z.number().int().min(7).max(365).default(30).describe('看最近几天(按退货日期,太平洋时间)'),
      sku: optionalText('只看这个 SKU,并返回全部退货明细'), style: optionalText('只看这个款式'),
      commentLimit: z.number().int().min(0).max(50).default(10).describe('每个 SKU 带几条最新的买家留言'),
      limit: z.number().int().min(1).max(500).default(100).describe('SKU 最多返回几行(按退货件数从多到少)'),
    },
    annotations: local,
  }, wrap(({ days, sku, style, commentLimit, limit }) => {
    const result = returnsAnalysis({ days, sku, style, commentLimit });
    const { sync, labels, ...rest } = result;
    return { ...rest, skus: result.skus.slice(0, limit), totalSkus: result.skus.length,
      lastSync: sync.lastSuccess?.completedAt ?? null, lastSyncError: sync.lastError?.message ?? null,
      ...(sku ? { records: returnRecords({ sku, days }) } : {}) };
  }));

  server.registerTool('get_search_terms', {
    title: 'ABA 搜索词表现',
    description: '品牌分析「搜索查询表现」:每个搜索词的搜索量、全市场曝光/点击/购买、本店 ASIN 的曝光/点击/购买,以及曝光/点击/购买份额、点击率、转化率。用来找流量词、埋词机会和转化短板。不填 ASIN 时为全部 ASIN 合计。',
    inputSchema: {
      asin: optionalText('只看这个 ASIN'), weeks: z.number().int().min(1).max(12).default(4).describe('最近几周(已同步的周)'),
      weekEnd: z.string().regex(DAY).optional().describe('只看某一周,填该周周六 YYYY-MM-DD'),
      contains: optionalText('只看包含这个词的搜索词'),
      sortBy: z.enum(ABA_SORTS).default('query_volume'), limit: z.number().int().min(1).max(300).default(50),
    },
    annotations: local,
  }, wrap((args) => searchTerms(args)));

  server.registerTool('get_competitor_overview', {
    title: '竞品监控总览',
    description: '产品情报:每个自家款式的 SKU/ASIN、近 7/30 天销量、已监控竞品数、待确认推荐数;以及最近几天竞品的变化明细(降价、涨价、改标题、改五点、换主图、排名大涨、没购物车、变体增减),带竞品品牌和标题。',
    inputSchema: { days: z.number().int().min(1).max(90).default(14).describe('看最近几天的竞品变化'), style: optionalText('只看这个款式') },
    annotations: local,
  }, wrap((args) => competitorOverview(args)));

  server.registerTool('get_style_intel', {
    title: '款式竞品情报',
    description: '一个自家款式的完整情报:自家标题/五点/后台搜索词/价格/排名/评分;每个已监控竞品家族的标题、五点、价格区间、BSR、评分评论、月销量、各尺码子体价格、7 天价格变化;竞品价格带;待确认的推荐竞品;核心词列表和每个词在自家及竞品文案里的覆盖情况。做文案对比、定价和埋词时用。',
    inputSchema: { style: z.string().trim().min(1).max(200).describe('款式(get_competitor_overview 里的 style)'),
      includeHistory: z.boolean().default(false).describe('是否带上竞品近 30 天每天的价格和排名') },
    annotations: local,
  }, wrap((args) => styleIntel(args)));

  server.registerTool('get_listing_health', {
    title: 'Listing 体检',
    description: '自家每个在售 ASIN 的文案体检:标题品牌和长度、五点条数、图片数、核心词是否写进文案、后台搜索词字节数、亚马逊报的错误警告、比同尺码竞品贵多少。按问题严重程度排序。',
    inputSchema: { style: optionalText('只看这个款式'), level: z.enum(['all', 'red', 'yellow']).default('all').describe('red 只看有必须改问题的;yellow 看有任何问题的'),
      limit: z.number().int().min(1).max(500).default(100) },
    annotations: local,
  }, wrap((args) => listingHealthReport(args)));

  server.registerTool('get_listing', {
    title: '本店 Listing 内容',
    description: '实时从亚马逊读取本店某个 SKU 的 Listing:标题、五点描述、产品描述、后台搜索词(generic_keyword)、品牌、图片地址、报价、配送、Listing 问题(违规/缺字段),以及全部商品属性。填 ASIN 时取 SKU 库里该 ASIN 的第一个 SKU。',
    inputSchema: { sku: optionalText('卖家 SKU'), asin: optionalText('ASIN') },
    annotations: remote,
  }, wrap((args) => getListing(args, deps)));

  server.registerTool('get_catalog_items', {
    title: '亚马逊目录信息(含竞品)',
    description: '实时从亚马逊目录读取任意 ASIN(本店或竞品)的标题、品牌、五点、描述、尺码颜色、BSR 排名、变体关系、图片地址和全部属性。一次 1–10 个 ASIN,适合竞品对比。',
    inputSchema: { asins: z.array(z.string().trim()).min(1).max(10).describe('ASIN 列表') },
    annotations: remote,
  }, wrap((args) => getCatalogItems(args, deps)));

  server.registerTool('get_product_images', {
    title: '查看商品图片',
    description: '下载某个 ASIN(本店或竞品)的主图和副图,以图片形式返回,用来诊断主图、卖点表达和与竞品的差距。',
    inputSchema: { asin: z.string().trim().describe('ASIN'), limit: z.number().int().min(1).max(9).default(7).describe('最多几张,主图在前') },
    annotations: remote,
  }, wrap((args) => getProductImages(args, deps)));

  // 提议类:只写网站自己的待确认队列,不碰亚马逊
  const propose = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const userOf = (extra) => extra?.authInfo?.extra?.userId ?? null;
  const sourceOf = (extra) => extra?.authInfo?.extra?.source === 'chatgpt' ? 'chatgpt' : 'claude';
  const reason = z.string().trim().min(1).max(1000).describe('为什么改:写依据的数据');

  server.registerTool('propose_listing_changes', {
    title: '提议修改 Listing',
    description: '把标题、五点描述、后台搜索词、原价、促销价的修改放进网站「待确认改动」队列,店主确认后网站才用 SP-API 提交到亚马逊。会实时读亚马逊上的当前值记为「改动前」,并检查标题 200 字符、后台搜索词 249 字节、和现在一样、低于保本价等;不合格的放在 rejected 里。同一个 SKU 同一项还没确认的旧提议会被替代。',
    inputSchema: {
      title: z.string().trim().min(1).max(100).describe('这批改动的标题,如「方窝牛津 S/M 标题和五点」'),
      summary: z.string().trim().max(2000).optional().describe('整批的思路和依据,显示在确认页上'),
      changes: z.array(z.object({
        sku: z.string().trim().min(1).max(100).describe('卖家 SKU(list_skus 里的 sku)'),
        field: z.enum(['title', 'bullets', 'search_terms', 'price', 'sale_price'])
          .describe('title 标题 / bullets 五点 / search_terms 后台搜索词 / price 原价 / sale_price 促销价'),
        value: z.union([z.string(), z.array(z.string()).max(10), z.number()])
          .describe('新值:title、search_terms 填文字(后台词用空格分隔);bullets 填文字数组,按顺序给全部条目;price、sale_price 填美元数字,sale_price 填 0 表示取消促销价'),
        saleStart: z.string().regex(DAY).optional().describe('sale_price 才用:促销开始日 YYYY-MM-DD(太平洋时间),不填时沿用现有促销的开始日或今天'),
        saleEnd: z.string().regex(DAY).optional().describe('sale_price 才用:促销结束日 YYYY-MM-DD,新设促销价必填;已有促销不填就沿用原结束日'),
        reason,
      })).min(1).max(40),
    },
    annotations: { ...propose, openWorldHint: true },
  }, wrap((args, extra) => proposeListing(args, { ...deps, userId: userOf(extra), source: sourceOf(extra) })));

  server.registerTool('propose_ad_changes', {
    title: '提议修改广告',
    description: '把广告改动放进网站「待确认改动」队列:暂停/启用广告活动、广告组、关键词、商品定向、商品广告,改竞价、广告组默认竞价、每日预算,加否定关键词或否定商品。店主确认后:配置了亚马逊广告 API 就直接执行,没配置就生成批量表让店主上传。需要广告后台的数字编号(批量表里的广告活动编号、广告组编号、关键词编号、商品投放 ID、广告编号)。',
    inputSchema: {
      title: z.string().trim().min(1).max(100).describe('这批改动的标题'),
      summary: z.string().trim().max(2000).optional().describe('整批的思路和依据'),
      changes: z.array(z.object({
        action: z.enum(AD_ACTIONS).describe('pause 暂停 / enable 启用 / set_bid 改竞价 / set_budget 改每日预算 / add_negative 加否定'),
        entity: z.enum(AD_ENTITIES).optional().describe('pause、enable、set_bid 时的对象:campaign 广告活动 / adGroup 广告组(set_bid 时是默认竞价) / keyword 关键词 / productTarget 商品定向 / productAd 商品广告'),
        campaignId: z.string().trim().min(1).max(20).describe('广告活动编号'),
        adGroupId: z.string().trim().max(20).optional().describe('广告组编号:对象不是广告活动时、以及广告组级否定时必填'),
        entityId: z.string().trim().max(20).optional().describe('关键词编号、商品投放 ID 或广告编号(对象是 keyword、productTarget、productAd 时必填)'),
        campaignName: z.string().trim().max(200).optional().describe('广告活动名称,显示用'),
        adGroupName: z.string().trim().max(200).optional().describe('广告组名称,显示用'),
        label: z.string().trim().max(300).optional().describe('关键词文本、定向表达式或 SKU,显示用'),
        bid: z.number().optional().describe('set_bid 的新竞价(美元)'),
        budget: z.number().optional().describe('set_budget 的新每日预算(美元)'),
        current: z.union([z.number(), z.string()]).optional().describe('当前竞价/预算,或当前状态 enabled/paused,来自用户给的数据'),
        level: z.enum(['adGroup', 'campaign']).optional().describe('add_negative 加在广告组(默认)还是广告活动上'),
        matchType: z.enum(['exact', 'phrase', 'asin']).optional().describe('add_negative:exact 否定精准 / phrase 否定词组 / asin 否定商品'),
        negativeText: z.string().trim().max(100).optional().describe('add_negative 的否定词或 ASIN'),
        reason,
      })).min(1).max(40),
    },
    annotations: propose,
  }, wrap((args, extra) => proposeAds(args, { ...deps, userId: userOf(extra), source: sourceOf(extra) })));

  server.registerTool('list_change_proposals', {
    title: '待确认改动的进度',
    description: '查看提过的改动现在什么状态:待确认、已确认排队、已提交亚马逊等生效、已生效、未生效、待导出批量表、失败(带原因和亚马逊报的问题)、已拒绝。',
    inputSchema: { status: z.enum(['all', 'pending', 'active', 'done', 'closed']).default('all')
      .describe('pending 待确认 / active 执行中、待导出、失败 / done 已生效或未生效 / closed 已拒绝或被替代'),
    limit: z.number().int().min(1).max(200).default(50) },
    annotations: local,
  }, wrap((args) => changeProposals(args, deps)));

  server.registerTool('get_change_impact', {
    title: '改动效果对比',
    description: '执行过的 Listing 改动(标题、五点、后台词、原价、促销价)执行前后各 N 天的对比:SKU 的日均销量和销售额、ASIN 的日均访问量、转化率、购物车占有率,以及 ABA 搜索曝光/点击/购买份额(按整周);同时列出同期同一 SKU 的其它改动和断货补货。可看一条(id)、一个 SKU 的最近改动,或全店最近执行的改动。',
    inputSchema: {
      id: z.number().int().min(1).optional().describe('改动编号(list_change_proposals 里的 id)'),
      sku: optionalText('只看这个 SKU 的改动'),
      days: z.number().int().min(3).max(90).default(14).describe('前后各看几天'),
      limit: z.number().int().min(1).max(30).default(10),
    },
    annotations: local,
  }, wrap((args) => changeImpact(args, { today: todayOf() })));

  return server;
}
