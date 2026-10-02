// Claude 连接器(MCP)的只读工具。数据库里的数据直接查;Listing、竞品目录和图片实时调 SP-API。
// 所有工具都只读,不写数据库,也不改亚马逊上的任何东西。
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from './db.js';
import { PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, petSpConfig, shiftDay, US_MARKETPLACE } from './petAmazon.js';
import { buildPriceBoard, monthlySummary, recentDays, weeklySummary } from './petSales.js';
import { priceSyncStatus } from './priceStrategySync.js';
import { abaSyncStatus } from './petAbaSync.js';

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

/** 价格策略表同款:每个 SKU 一行,含库存、近 7 天销量、动销、可售天数、售价 */
function priceBoard(today = todayOf()) {
  const skus = skuLibrary();
  const from = [recentDays(today)[0], `${today.slice(0, 7)}-01`].sort()[0];
  const sales = db.prepare('SELECT day,sku,asin,units FROM pet_daily_sales WHERE day>=? AND day<=?').all(from, today);
  const listings = db.prepare('SELECT sku,asin,price,status FROM pet_listing_cache').all();
  const board = buildPriceBoard({ skus, sales, listings, today });
  const extra = new Map(skus.map((item) => [lower(item.sku), item]));
  board.rows = board.rows.map((row) => ({ ...row, brand: extra.get(lower(row.sku))?.brand ?? null, fabric: extra.get(lower(row.sku))?.fabric ?? null }));
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
  return { today: todayOf(), timezone: 'America/Los_Angeles', spApiConfigured: price.configured,
    salesCoverage: price.coverage, lastSalesSync: price.lastSuccess?.completedAt ?? null, lastSalesSyncError: price.lastError?.message ?? null,
    lastAbaSync: aba.lastSuccess?.completedAt ?? null };
}

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
  const year = Number(today.slice(0, 4));
  const actuals = new Map(db.prepare(`SELECT substr(day,1,7) AS month, SUM(units) AS units, SUM(sales) AS sales,
    SUM(estimated_sales) AS estimatedSales FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY month`)
    .all(`${year}-01-01`, `${year}-12-31`).map((row) => [row.month, row]));
  const targets = new Map(db.prepare(`SELECT month, target_units AS targetUnits, target_sales AS targetSales,
    target_profit AS targetProfit, actual_profit AS actualProfit, ad_spend AS adSpend FROM pet_monthly_targets WHERE month LIKE ?`)
    .all(`${year}-%`).map((row) => [row.month, row]));
  const monthly = monthlySummary({ year, actuals, targets, today, coveredFrom });
  const brief = (row) => ({ sku: row.sku, asin: row.asin, style: row.style, size: row.size, color: row.color,
    stock: row.stock, transit: row.transit, sales7d: row.sales7d, speed7d: row.speed7d, stockDays: row.stockDays });
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
    },
    notes: ['销量来自亚马逊订单报告,按太平洋时间切日;待付款订单金额按 Listing 售价估算。',
      '广告数据(花费、点击、ACOS)要等亚马逊广告 API 开通,目前没有。月度利润和广告花费是人工填写的。'],
  };
}

// ---------- SKU 列表 ----------

const SORTS = ['sales7d', 'monthUnits', 'stock', 'stockDays', 'speed7d', 'price', 'sku'];
export function listSkus({ query, style, size, color, sortBy = 'sales7d', limit = 200 } = {}) {
  const board = priceBoard();
  const rows = matchRows(board.rows, { query, style, size, color });
  const key = SORTS.includes(sortBy) ? sortBy : 'sales7d';
  rows.sort((a, b) => key === 'sku' ? a.sku.localeCompare(b.sku)
    : (a[key] == null) - (b[key] == null) || (key === 'stockDays' ? a[key] - b[key] : b[key] - a[key]) || a.sku.localeCompare(b.sku));
  return { today: board.today, last7Days: board.days, total: rows.length, sortBy: key,
    rows: rows.slice(0, limit).map((row) => ({ sku: row.sku, asin: row.asin, style: row.style, size: row.size, color: row.color, fabric: row.fabric,
      price: row.price, listingStatus: row.listingStatus, stock: row.stock, transit: row.transit, dailyLast7: row.daily, today: row.today,
      sales7d: row.sales7d, movement3d: row.movement3d, speed7d: row.speed7d, monthUnits: row.monthUnits,
      stockDays: row.stockDays, stockTransitDays: row.stockTransitDays, selloutDate: row.selloutDate, soldOut: row.soldOut })) };
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

// ---------- 注册到 MCP ----------

const INSTRUCTIONS = `这是一家亚马逊美国站宠物用品店(主营宠物狗窝)的运营数据,来自店主自建的 AD-TOOL 网站。
所有工具只读:查数据库里同步好的销量、库存、价格、ABA 搜索词,以及实时调亚马逊 SP-API 看 Listing、竞品目录和图片。不能修改任何东西。
日期都是美国太平洋时间。广告数据(花费、ACOS、搜索词报告)要等亚马逊广告 API 开通,目前没有。
分析某个产品的常用顺序:store_overview 看全店 → list_skus 找到 SKU/ASIN → get_sales_trend 看趋势 → get_search_terms 看流量词和份额 → get_listing 看当前文案 → get_catalog_items / get_product_images 对比竞品。
用户是中文卖家,回答用中文;给优化建议时说明依据的数据。`;

export function createPetMcpServer(deps = {}) {
  const server = new McpServer({ name: 'adtool-pet', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const local = { readOnlyHint: true, openWorldHint: false };
  const remote = { readOnlyHint: true, openWorldHint: true };
  const wrap = (handler) => async (args) => {
    try {
      const result = await handler(args);
      return result?.content ? result : json(result);
    } catch (error) {
      return fail(error.message || String(error));
    }
  };
  const optionalText = (description) => z.string().trim().min(1).max(200).optional().describe(description);

  server.registerTool('store_overview', {
    title: '店铺总览',
    description: '全店数据新鲜度、SKU/ASIN 数、近 7 天和前 7 天销量销售额、本月目标完成情况、最近几周周销量,以及断货、库存不足、积压、有货不动销的 SKU 提醒。分析前先调用它。',
    inputSchema: { weeks: z.number().int().min(1).max(26).default(8).describe('周销量看最近几周') },
    annotations: local,
  }, wrap((args) => storeOverview(args)));

  server.registerTool('list_skus', {
    title: 'SKU 列表与实时指标',
    description: '价格策略表同款:每个 SKU 的 ASIN、款式、尺码、颜色、面料、售价、在库、在途、近 7 天每日销量、近 3 日动销、7 天动销速度、本月销量、可售天数、预估售罄日。可按关键字和属性筛选、排序。',
    inputSchema: {
      query: optionalText('模糊匹配 SKU、ASIN、款式、尺码、颜色、面料'),
      style: optionalText('款式(精确匹配)'), size: optionalText('尺码(精确匹配)'), color: optionalText('颜色(精确匹配)'),
      sortBy: z.enum(SORTS).default('sales7d').describe('排序字段;stockDays 从少到多,其余从多到少'),
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

  return server;
}
