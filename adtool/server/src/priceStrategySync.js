import { db, audit } from './db.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { normalizePriceRow, dailyDates, dailyIsoDates } from '../../shared/priceStrategy.js';
import {
  amazonGateway, fetchCatalogAttributes, fetchInventory, fetchListings, fetchOrderLines,
  pacificDay, pacificMidnight, petSpConfig, shiftDay,
} from './petAmazon.js';

// 订单报告晚于下单几分钟才完整,当天的区间截到现在之前
const REPORT_LAG_MS = 5 * 60_000;
const savedState = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const stateUpsert = db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

export function withCalculatedPriceMetrics(row) {
  const result = { ...row };
  if (result.sales7d != null) result.movement7d = result.sales7d;
  if (result.salesThroughLastMonth != null && result.monthlySales != null) {
    result.totalSales = result.salesThroughLastMonth + result.monthlySales;
  }
  if (result.totalStock != null && result.sales7d > 0) {
    result.turnoverWeeks = Number((result.totalStock / result.sales7d).toFixed(2));
    result.estimatedSelloutDate = shiftDay(result.date, Math.ceil(result.totalStock * 7 / result.sales7d));
  }
  if (result.clicks7d > 0 && result.adOrders7d != null) {
    result.conversion7d = Number((result.adOrders7d / result.clicks7d * 100).toFixed(2));
  }
  return result;
}

/** 订单行 + 库存 + Listing → 每个 SKU 一行快照指标。date 是太平洋时间的快照日 */
export function summarizeAmazonRows({ orderLines = [], inventory = [], listings = [] }, date) {
  const dates = dailyIsoDates(date);
  const relevant = new Set(dates);
  const previous = new Set(dates.map((day) => shiftDay(day, -7)));
  const monthStart = `${date.slice(0, 7)}-01`;
  const bySku = new Map();
  const get = (sku) => {
    const key = String(sku ?? '').trim().toLowerCase();
    if (!key) return null;
    if (!bySku.has(key)) bySku.set(key, { sku: String(sku).trim(), daily: Object.fromEntries(dates.map((d) => [d, 0])),
      monthlySales: 0, previous7dSales: 0, monthlyOrderIds: new Set(), weekOrderIds: new Set(),
      availableStock: null, inboundStock: null, asin: null, listingPrice: null });
    return bySku.get(key);
  };
  for (const line of orderLines) {
    if (line.day > date) continue;
    const row = get(line.sku);
    if (line.day >= monthStart) { row.monthlySales += line.quantity; row.monthlyOrderIds.add(line.orderId); }
    if (relevant.has(line.day)) { row.daily[line.day] += line.quantity; row.weekOrderIds.add(line.orderId); }
    if (previous.has(line.day)) row.previous7dSales += line.quantity;
    row.asin ||= line.asin || null;
  }
  for (const item of inventory) {
    const row = get(item.sku);
    row.availableStock = item.stock;
    row.inboundStock = item.transit;
    row.asin ||= item.asin || null;
  }
  for (const listing of listings) {
    const row = bySku.get(listing.sku.toLowerCase());
    if (!row) continue;
    row.asin ||= listing.asin;
    row.listingPrice = listing.price;
  }
  return [...bySku.values()].map((row) => {
    const sales7d = dates.reduce((sum, day) => sum + row.daily[day], 0);
    const { daily, previous7dSales, monthlyOrderIds, weekOrderIds, ...rest } = row;
    return { ...rest, date, sales7d, monthlyOrders: monthlyOrderIds.size, orders7d: weekOrderIds.size,
      weekOverWeek: previous7dSales ? Number(((sales7d / previous7dSales - 1) * 100).toFixed(2)) : null,
      movement3d: dates.slice(-3).reduce((sum, day) => sum + daily[day], 0),
      movementSpeed7d: Number((sales7d / 7).toFixed(3)),
      ...Object.fromEntries(dates.map((day, index) => [`day${index + 1}`, daily[day]])) };
  });
}

/**
 * 把亚马逊的 Listing、库存和目录属性写进共享 SKU 库。
 * 新 SKU 自动加入;已有 SKU 更新 ASIN 和库存,尺码、颜色只补空白,款式、面料等人工字段不动。
 */
export function applySkuLibrary({ listings, inventory, attributes = new Map(), brand = '' }) {
  const existing = new Map(db.prepare("SELECT * FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID)
    .map((row) => [row.sku.toLowerCase(), row]));
  const stockBySku = new Map(inventory.map((item) => [item.sku.toLowerCase(), item]));
  const insert = db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, stock, transit, size, color, dedupe)
    VALUES (@userId, 'US', @brand, @sku, @asin, @stock, @transit, @size, @color, @dedupe)`);
  const update = db.prepare(`UPDATE sku_items SET asin=@asin, stock=@stock, transit=@transit, size=@size, color=@color,
    brand=@brand, updated_at=datetime('now','localtime') WHERE id=@id`);
  let added = 0, updated = 0;
  const seen = new Set();
  db.transaction(() => {
    for (const source of [...listings, ...inventory]) {
      const key = source.sku.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const stock = stockBySku.get(key);
      const asin = source.asin || stock?.asin || null;
      const attribute = (asin && attributes.get(asin)) || {};
      const current = existing.get(key);
      if (!current) {
        insert.run({ userId: PET_SHOP_ID, brand: brand || null, sku: source.sku, asin,
          stock: stock ? stock.stock : null, transit: stock ? stock.transit : null,
          size: attribute.size ?? null, color: attribute.color ?? null, dedupe: `US|${key}` });
        added++;
        continue;
      }
      const next = { id: current.id, asin: asin || current.asin,
        stock: stock ? stock.stock : current.stock, transit: stock ? stock.transit : current.transit,
        size: current.size || attribute.size || null, color: current.color || attribute.color || null,
        brand: current.brand || brand || null };
      if (['asin', 'stock', 'transit', 'size', 'color', 'brand'].some((field) => (next[field] ?? null) !== (current[field] ?? null))) {
        update.run(next);
        updated++;
      }
    }
  })();
  return { added, updated };
}

// 录入时留空的列存成 null,合并时不能把 SKU 库里的款式、尺码等盖掉
const present = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null && value !== undefined));

function persistSnapshot({ date, actorId, rows }) {
  const skus = db.prepare("SELECT sku,asin,style,size,color,fabric FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID);
  const skuByKey = new Map(skus.map((item) => [item.sku.toLowerCase(), item]));
  const sourceBySku = new Map(rows.map((row) => [row.sku.toLowerCase(), row]));
  for (const sku of skus) if (!sourceBySku.has(sku.sku.toLowerCase())) sourceBySku.set(sku.sku.toLowerCase(), { sku: sku.sku, date });
  const select = db.prepare('SELECT data_json FROM pet_price_strategy WHERE snapshot_date=? AND marketplace=? AND sku=?');
  const upsert = db.prepare(`INSERT INTO pet_price_strategy(snapshot_date,marketplace,sku,data_json,updated_by)
    VALUES(?,'US',?,?,?) ON CONFLICT(snapshot_date,marketplace,sku) DO UPDATE SET
    data_json=excluded.data_json,updated_by=excluded.updated_by,updated_at=datetime('now','localtime')`);
  db.transaction(() => {
    for (const { listingPrice, ...source } of sourceBySku.values()) {
      const existing = select.get(date, 'US', source.sku);
      const old = existing ? JSON.parse(existing.data_json) : {};
      const filled = present(old);
      const sku = skuByKey.get(source.sku.toLowerCase());
      // 售价:录入过的保留,空白时用亚马逊 Listing 当前价;其余人工列不被同步覆盖
      const merged = normalizePriceRow(withCalculatedPriceMetrics({ ...sku, ...filled, ...present(source), date, marketplace: 'US',
        totalStock: old.totalStock, price: old.price ?? listingPrice ?? null, promoPrice: old.promoPrice,
        currentProfit: old.currentProfit, monthlyMargin: old.monthlyMargin, monthlyAdRatio: old.monthlyAdRatio }));
      upsert.run(date, merged.sku, JSON.stringify(merged), actorId);
    }
  })();
  return sourceBySku.size;
}

let running = false;
export async function syncPriceStrategy(date, actorId = null, gateway = amazonGateway, env = process.env) {
  if (!isPet) throw new Error('只支持宠物版');
  if (!dailyDates(date).length) throw new Error('同步日期不合法');
  if (running) throw new Error('亚马逊数据正在同步');
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  if (date > pacificDay(new Date())) throw Object.assign(new Error('美国站这一天还没有开始'), { status: 400 });
  running = true;
  const startedAt = new Date().toISOString();
  stateUpsert.run('last_attempt', JSON.stringify({ date, startedAt }));
  let stage = '读取 Listing';
  try {
    const listings = await fetchListings(account, gateway);
    stage = '读取 FBA 库存';
    const inventory = await fetchInventory(account, gateway);
    stage = '读取商品尺码颜色';
    const known = new Map(db.prepare("SELECT lower(sku) AS sku, size, color FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID)
      .map((row) => [row.sku, row]));
    const needAttributes = [...listings, ...inventory].filter((item) => {
      const current = known.get(item.sku.toLowerCase());
      return item.asin && (!current || !current.size || !current.color);
    }).map((item) => item.asin);
    const attributes = await fetchCatalogAttributes(account, needAttributes, gateway);
    stage = '更新 SKU 库';
    const library = applySkuLibrary({ listings, inventory, attributes, brand: account.brand });

    stage = '读取订单报告';
    const start = pacificMidnight([`${date.slice(0, 7)}-01`, shiftDay(date, -13)].sort()[0]);
    const end = new Date(Math.min(pacificMidnight(shiftDay(date, 1)).getTime(), Date.now() - REPORT_LAG_MS));
    const orderLines = await fetchOrderLines(account, start, end, gateway);

    stage = '保存价格策略表';
    const rows = summarizeAmazonRows({ orderLines, inventory, listings }, date);
    const skus = persistSnapshot({ date, actorId, rows });
    const result = { date, skus, listings: listings.length, inventorySkus: inventory.length,
      orderLines: orderLines.length, skuAdded: library.added, skuUpdated: library.updated };
    db.transaction(() => {
      stateUpsert.run('last_success', JSON.stringify({ ...result, startedAt, completedAt: new Date().toISOString(), complete: true }));
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='last_error'").run();
    })();
    if (actorId) audit(actorId, 'US', 'sync', 'pet_price_strategy', null, result);
    return result;
  } catch (error) {
    const message = `${stage}：${String(error.message)}`.slice(0, 300);
    stateUpsert.run('last_error', JSON.stringify({ date, at: new Date().toISOString(), stage, message }));
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; }
}

export function priceSyncStatus(env = process.env) {
  const states = Object.fromEntries(db.prepare('SELECT key,value FROM pet_price_sync_state').all().map(({ key, value }) => [key, JSON.parse(value)]));
  const { account, issues } = petSpConfig(env);
  return { source: 'amazon', configured: !!account, issues, running,
    latestDay: shiftDay(pacificDay(new Date()), -1),
    lastSuccess: states.last_success ?? null, lastAttempt: states.last_attempt ?? null, lastError: states.last_error ?? null };
}

/** 每小时检查一次:太平洋时间凌晨 3 点后同步美国站前一天 */
export function startPriceSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const pacificHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (pacificHour < 3) return;
    const date = shiftDay(pacificDay(new Date()), -1);
    const status = priceSyncStatus();
    if (!status.configured || running || status.lastSuccess?.date === date && status.lastSuccess?.complete
      || status.lastAttempt?.date === date && Date.now() - Date.parse(status.lastAttempt.startedAt) < 3 * 60 * 60_000) return;
    try { await syncPriceStrategy(date); } catch (error) { console.error('[price-sync]', error.message); }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
