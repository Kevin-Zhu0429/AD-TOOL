import { db, audit } from './db.js';
import { isPet } from './profile.js';
import { discoverChannels, paged } from './captain.js';
import { normalizePriceRow, dailyDates, dailyIsoDates } from '../../shared/priceStrategy.js';

const daySeconds = 86400;
const toStamp = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const dayOf = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return new Date(number * (number > 1e12 ? 1 : 1000)).toISOString().slice(0, 10);
};
const positive = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const nextDate = (date, days) => new Date((toStamp(date) + days * daySeconds) * 1000).toISOString().slice(0, 10);

export function withCalculatedPriceMetrics(row) {
  const result = { ...row };
  if (result.sales7d != null) result.movement7d = result.sales7d;
  if (result.salesThroughLastMonth != null && result.monthlySales != null) {
    result.totalSales = result.salesThroughLastMonth + result.monthlySales;
  }
  if (result.totalStock != null && result.sales7d > 0) {
    result.turnoverWeeks = Number((result.totalStock / result.sales7d).toFixed(2));
    result.estimatedSelloutDate = nextDate(result.date, Math.ceil(result.totalStock * 7 / result.sales7d));
  }
  return result;
}

export function summarizeCaptainRows({ orders, ads, reports, inventory }, date) {
  const dates = dailyIsoDates(date);
  const relevant = new Set(dates);
  const previous = new Set(dates.map((day) => nextDate(day, -7)));
  const monthStart = `${date.slice(0, 7)}-01`;
  const bySku = new Map();
  const get = (sku) => {
    const key = String(sku ?? '').trim().toLowerCase();
    if (!key) return null;
    if (!bySku.has(key)) bySku.set(key, { sku: String(sku).trim(), daily: Object.fromEntries(dates.map((d) => [d, 0])), monthlySales: 0, previous7dSales: 0, monthlyOrderIds: new Set(), weekOrderIds: new Set(), clicks7d: 0, adOrders7d: 0, availableStock: null, inboundStock: null, asin: null });
    return bySku.get(key);
  };
  const seenOrders = new Set();
  for (const { channel, order } of orders) {
    if (/cancel|pending/i.test(String(order.OrderStatus ?? ''))) continue;
    const orderDay = dayOf(order.LocalDate);
    if (orderDay < nextDate(date, -13) || orderDay > date) continue;
    for (const item of Array.isArray(order.order_item) ? order.order_item : []) {
      const sku = String(item.SellerSKU ?? '').trim();
      const key = `${channel}\0${order.AmazonOrderId || order.id}\0${item.OrderItemId || item.id || sku}`;
      if (!sku || seenOrders.has(key)) continue;
      seenOrders.add(key);
      const amount = positive(item.QuantityOrdered);
      if (amount === null) continue;
      const row = get(sku);
      const orderKey = `${channel}\0${order.AmazonOrderId || order.id}`;
      if (orderDay >= monthStart) { row.monthlySales += amount; row.monthlyOrderIds.add(orderKey); }
      if (relevant.has(orderDay)) { row.daily[orderDay] += amount; row.weekOrderIds.add(orderKey); }
      if (previous.has(orderDay)) row.previous7dSales += amount;
      row.asin ||= item.ASIN || null;
    }
  }
  const adSkus = new Map();
  for (const { channel, ad } of ads) if (ad.adId && ad.sku) adSkus.set(`${channel}\0${ad.adId}`, ad.sku);
  let unmappedAds = 0;
  for (const { channel, report } of reports) {
    const sku = adSkus.get(`${channel}\0${report.adId}`);
    if (!sku) { unmappedAds++; continue; }
    const row = get(sku);
    row.clicks7d += positive(report.clicks) ?? 0;
    row.adOrders7d += positive(report.ad_order_num) ?? 0;
  }
  for (const { item } of inventory) {
    const row = get(item.SKU);
    if (!row) continue;
    const available = positive(item.fulfillable_quantity), inbound = positive(item.inbound_shipped_quantity);
    if (available !== null) row.availableStock = (row.availableStock ?? 0) + available;
    if (inbound !== null) row.inboundStock = (row.inboundStock ?? 0) + inbound;
    row.asin ||= item.asin || null;
  }
  return { rows: [...bySku.values()].map((row) => {
    const sales7d = dates.reduce((sum, day) => sum + row.daily[day], 0);
    const { daily, previous7dSales, monthlyOrderIds, weekOrderIds, ...rest } = row;
    return { ...rest, date, sales7d, monthlyOrders: monthlyOrderIds.size, orders7d: weekOrderIds.size,
      weekOverWeek: previous7dSales ? Number(((sales7d / previous7dSales - 1) * 100).toFixed(2)) : null,
      conversion7d: row.clicks7d ? Number((row.adOrders7d / row.clicks7d * 100).toFixed(2)) : null,
      movement3d: dates.slice(-3).reduce((sum, day) => sum + daily[day], 0),
      movementSpeed7d: Number((sales7d / 7).toFixed(3)), ...Object.fromEntries(dates.map((day, index) => [`day${index + 1}`, daily[day]])) };
  }), unmappedAds };
}

let running = false;
export async function syncPriceStrategy(date, actorId = null, gateway = { discoverChannels, paged }) {
  if (!isPet) throw new Error('只支持宠物版');
  if (!dailyDates(date).length) throw new Error('同步日期不合法');
  if (running) throw new Error('价格策略表正在同步');
  running = true;
  const startedAt = new Date().toISOString();
  const setState = db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  setState.run('last_attempt', JSON.stringify({ date, startedAt }));
  try {
    const groups = await gateway.discoverChannels();
    const usChannels = groups.flatMap((group) => group.channels).filter((channel) => channel.country === 'US');
    const selectedChannelId = String(process.env.PET_CAPTAIN_CHANNEL_ID ?? '').trim();
    const channels = selectedChannelId ? usChannels.filter((channel) => channel.openChannelId === selectedChannelId) : usChannels;
    if (!channels.length) throw new Error(selectedChannelId ? 'PET_CAPTAIN_CHANNEL_ID 未匹配船长美国站店铺' : '船长未返回美国站店铺，请检查授权范围');
    if (channels.length > 1) throw new Error('船长授权了多个美国站店铺，请在服务器配置 PET_CAPTAIN_CHANNEL_ID，避免混合不同店铺的数据');
    const orders = [], ads = [], reports = [], inventoryChanges = [];
    const end = toStamp(nextDate(date, 1));
    const start = Math.min(toStamp(`${date.slice(0, 7)}-01`), toStamp(nextDate(date, -13)));
    const hasInventoryCache = !!db.prepare('SELECT 1 FROM pet_price_inventory_cache LIMIT 1').get();
    const initialLookback = Math.min(365, Math.max(30, Number(process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS) || 365));
    const inventoryStart = end - (hasInventoryCache ? 30 : initialLookback) * daySeconds;
    const adCacheInitialized = !!db.prepare("SELECT 1 FROM pet_price_sync_state WHERE key='ad_cache_initialized'").get();
    const adStart = end - (adCacheInitialized ? 30 : initialLookback) * daySeconds;
    for (const channel of channels) {
      const header = { OpenChannelId: channel.openChannelId };
      const channelId = channel.openChannelId;
      for (const order of await gateway.paged('/v1/open_order/get_order_list', { start_modified_time: start, end_modified_time: end }, header)) orders.push({ channel: channelId, order });
      for (let windowStart = adStart; windowStart < end; windowStart += 30 * daySeconds) {
        for (const ad of await gateway.paged('/v1/open_cpc/advertise', {
          type: 1, start_modified_time: windowStart, end_modified_time: Math.min(end, windowStart + 30 * daySeconds),
        }, header)) ads.push({ channel: channelId, ad });
      }
      for (const day of dailyIsoDates(date)) {
        const reportDate = day.replaceAll('-', '');
        for (const report of await gateway.paged('/v1/open_cpc/advertise_report', { report_date: reportDate }, header)) reports.push({ channel: channelId, report });
      }
      for (let windowStart = inventoryStart; windowStart < end; windowStart += 30 * daySeconds) {
        for (const item of await gateway.paged('/v1/open_fba/inventory_list', {
          start_modified_time: windowStart, end_modified_time: Math.min(end, windowStart + 30 * daySeconds),
        }, header)) inventoryChanges.push({ channel: channelId, item });
      }
    }
    const saveCache = db.prepare(`INSERT INTO pet_price_inventory_cache(channel_id,sku,available_stock,inbound_stock) VALUES(?,?,?,?)
      ON CONFLICT(channel_id,sku) DO UPDATE SET available_stock=excluded.available_stock,inbound_stock=excluded.inbound_stock,updated_at=datetime('now','localtime')`);
    const saveAd = db.prepare(`INSERT INTO pet_price_ad_cache(channel_id,ad_id,sku) VALUES(?,?,?)
      ON CONFLICT(channel_id,ad_id) DO UPDATE SET sku=excluded.sku,updated_at=datetime('now','localtime')`);
    const select = db.prepare('SELECT data_json FROM pet_price_strategy WHERE snapshot_date=? AND marketplace=? AND sku=?');
    const upsert = db.prepare(`INSERT INTO pet_price_strategy(snapshot_date,marketplace,sku,data_json,updated_by)
      VALUES(?,'US',?,?,?) ON CONFLICT(snapshot_date,marketplace,sku) DO UPDATE SET
      data_json=excluded.data_json,updated_by=excluded.updated_by,updated_at=datetime('now','localtime')`);
    let summary, syncSkuCount;
    db.transaction(() => {
      for (const { channel, ad } of ads) if (ad.adId && ad.sku) saveAd.run(channel, String(ad.adId), String(ad.sku).trim());
      const cachedAds = db.prepare('SELECT channel_id AS channel, ad_id AS adId, sku FROM pet_price_ad_cache').all()
        .map(({ channel, adId, sku }) => ({ channel, ad: { adId, sku } }));
      for (const { channel, item } of inventoryChanges) if (item.SKU) saveCache.run(channel, item.SKU, positive(item.fulfillable_quantity), positive(item.inbound_shipped_quantity));
      const inventory = db.prepare('SELECT channel_id AS channel, sku AS SKU, available_stock AS fulfillable_quantity, inbound_stock AS inbound_shipped_quantity FROM pet_price_inventory_cache').all().map((item) => ({ item }));
      summary = summarizeCaptainRows({ orders, ads: cachedAds, reports, inventory }, date);
      // The existing SKU catalog supplies rows even when no order or ad has arrived yet.
      const skus = db.prepare("SELECT sku,asin,style,size,color,fabric FROM sku_items WHERE user_id=-1 AND country='US'").all();
      const sourceBySku = new Map(summary.rows.map((row) => [row.sku.toLowerCase(), row]));
      for (const sku of skus) if (!sourceBySku.has(sku.sku.toLowerCase())) sourceBySku.set(sku.sku.toLowerCase(), { sku: sku.sku, date });
      syncSkuCount = sourceBySku.size;
      for (const source of sourceBySku.values()) {
        const existing = select.get(date, 'US', source.sku);
        const old = existing ? JSON.parse(existing.data_json) : {};
        const sku = skus.find((item) => item.sku.toLowerCase() === source.sku.toLowerCase());
        const merged = normalizePriceRow(withCalculatedPriceMetrics({ ...sku, ...old, ...source, date, marketplace: 'US',
          // Keep manual fields, including profit and selling price.
          totalStock: old.totalStock, price: old.price, promoPrice: old.promoPrice,
          currentProfit: old.currentProfit, monthlyMargin: old.monthlyMargin, monthlyAdRatio: old.monthlyAdRatio }));
        upsert.run(date, merged.sku, JSON.stringify(merged), actorId);
      }
      setState.run('last_success', JSON.stringify({ date, startedAt, completedAt: new Date().toISOString(), skus: sourceBySku.size, channels: channels.length, unmappedAds: summary.unmappedAds }));
      setState.run('ad_cache_initialized', JSON.stringify({ at: new Date().toISOString() }));
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='last_error'").run();
    })();
    if (actorId) audit(actorId, 'US', 'sync', 'pet_price_strategy', null, { date, skus: syncSkuCount, channels: channels.length });
    return { date, skus: syncSkuCount, channels: channels.length, unmappedAds: summary.unmappedAds };
  } catch (error) {
    setState.run('last_error', JSON.stringify({ date, at: new Date().toISOString(), message: String(error.message).slice(0, 300) }));
    throw error;
  } finally { running = false; }
}

export function priceSyncStatus() {
  const states = Object.fromEntries(db.prepare('SELECT key,value FROM pet_price_sync_state').all().map(({ key, value }) => [key, JSON.parse(value)]));
  return { configured: !!(process.env.CAPTAIN_CLIENT_ID && process.env.CAPTAIN_CLIENT_SECRET), running,
    lastSuccess: states.last_success ?? null, lastAttempt: states.last_attempt ?? null, lastError: states.last_error ?? null };
}

export function startPriceSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (hour < 10) return;
    const todayShanghai = `${parts.year}-${parts.month}-${parts.day}`;
    const date = nextDate(todayShanghai, -1);
    const status = priceSyncStatus();
    if (!status.configured || running || status.lastSuccess?.date === date
      || status.lastAttempt?.date === date && Date.now() - Date.parse(status.lastAttempt.startedAt) < 6 * 60 * 60_000) return;
    try { await syncPriceStrategy(date); } catch (error) { console.error('[price-sync]', error.message); }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
