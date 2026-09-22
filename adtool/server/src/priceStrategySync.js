import { db, audit } from './db.js';
import { isPet } from './profile.js';
import { captainUsageStatus, discoverChannels, paged, pagedChunk, withCaptainRequestBudget } from './captain.js';
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
const shanghaiDay = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const shanghaiDayOf = (value) => new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const isRateLimitError = (message) => /请求频率过快|rate.?limit|too many requests/i.test(String(message ?? ''));
const CALLS_PER_SYNC = 20;
const savedState = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
function historyWindow(key, date, end) {
  const previous = savedState(key);
  const offset = previous?.date === date ? previous.offset : previous?.nextOffset ?? 30;
  const bounded = offset >= 365 ? 30 : offset;
  return { start: end - Math.min(365, bounded + 30) * daySeconds,
    end: end - bounded * daySeconds, offset: bounded, nextOffset: bounded + 30 };
}

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

const stateUpsert = db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const saveInventory = db.prepare(`INSERT INTO pet_price_inventory_cache(channel_id,sku,available_stock,inbound_stock) VALUES(?,?,?,?)
  ON CONFLICT(channel_id,sku) DO UPDATE SET available_stock=excluded.available_stock,inbound_stock=excluded.inbound_stock,updated_at=datetime('now','localtime')`);
const saveAd = db.prepare(`INSERT INTO pet_price_ad_cache(channel_id,ad_id,sku) VALUES(?,?,?)
  ON CONFLICT(channel_id,ad_id) DO UPDATE SET sku=excluded.sku,updated_at=datetime('now','localtime')`);
const saveAdReport = db.prepare(`INSERT INTO pet_price_ad_report_cache(channel_id,report_date,ad_id,clicks,ad_orders) VALUES(?,?,?,?,?)
  ON CONFLICT(channel_id,report_date,ad_id) DO UPDATE SET clicks=excluded.clicks,ad_orders=excluded.ad_orders,updated_at=datetime('now','localtime')`);
const saveOrder = db.prepare(`INSERT INTO pet_price_order_cache(snapshot_date,channel_id,order_key,data_json) VALUES(?,?,?,?)
  ON CONFLICT(snapshot_date,channel_id,order_key) DO UPDATE SET data_json=excluded.data_json,updated_at=datetime('now','localtime')`);

async function readChunk(gateway, path, query, headers, key, maxPages) {
  const cursor = savedState(key);
  if (cursor?.complete) return { items: [], complete: true, nextPage: 1 };
  const result = gateway.pagedChunk
    ? await gateway.pagedChunk(path, query, headers, cursor?.nextPage ?? 1, maxPages)
    : { items: await gateway.paged(path, query, headers), complete: true, nextPage: 1 };
  stateUpsert.run(key, JSON.stringify({ complete: result.complete, nextPage: result.nextPage, updatedAt: new Date().toISOString() }));
  return result;
}

function persistSnapshot({ date, actorId, channelId, startedAt, complete, stage, callsThisRun }) {
  const dates = dailyIsoDates(date);
  const orders = db.prepare('SELECT data_json FROM pet_price_order_cache WHERE snapshot_date=? AND channel_id=?').all(date, channelId)
    .map(({ data_json: dataJson }) => ({ channel: channelId, order: JSON.parse(dataJson) }));
  const ads = db.prepare('SELECT channel_id AS channel, ad_id AS adId, sku FROM pet_price_ad_cache WHERE channel_id=?').all(channelId)
    .map(({ channel, adId, sku }) => ({ channel, ad: { adId, sku } }));
  const reports = db.prepare(`SELECT channel_id AS channel, ad_id AS adId, clicks, ad_orders AS ad_order_num
    FROM pet_price_ad_report_cache WHERE channel_id=? AND report_date BETWEEN ? AND ?`).all(channelId, dates[0], dates.at(-1))
    .map(({ channel, ...report }) => ({ channel, report }));
  const inventory = db.prepare(`SELECT channel_id AS channel, sku AS SKU, available_stock AS fulfillable_quantity,
    inbound_stock AS inbound_shipped_quantity FROM pet_price_inventory_cache WHERE channel_id=?`).all(channelId).map((item) => ({ item }));
  const summary = summarizeCaptainRows({ orders, ads, reports, inventory }, date);
  const skus = db.prepare("SELECT sku,asin,style,size,color,fabric FROM sku_items WHERE user_id=-1 AND country='US'").all();
  const skuByKey = new Map(skus.map((item) => [item.sku.toLowerCase(), item]));
  const sourceBySku = new Map(summary.rows.map((row) => [row.sku.toLowerCase(), row]));
  for (const sku of skus) if (!sourceBySku.has(sku.sku.toLowerCase())) sourceBySku.set(sku.sku.toLowerCase(), { sku: sku.sku, date });
  const select = db.prepare('SELECT data_json FROM pet_price_strategy WHERE snapshot_date=? AND marketplace=? AND sku=?');
  const upsert = db.prepare(`INSERT INTO pet_price_strategy(snapshot_date,marketplace,sku,data_json,updated_by)
    VALUES(?,'US',?,?,?) ON CONFLICT(snapshot_date,marketplace,sku) DO UPDATE SET
    data_json=excluded.data_json,updated_by=excluded.updated_by,updated_at=datetime('now','localtime')`);
  db.transaction(() => {
    for (const source of sourceBySku.values()) {
      const existing = select.get(date, 'US', source.sku);
      const old = existing ? JSON.parse(existing.data_json) : {};
      const sku = skuByKey.get(source.sku.toLowerCase());
      const merged = normalizePriceRow(withCalculatedPriceMetrics({ ...sku, ...old, ...source, date, marketplace: 'US',
        totalStock: old.totalStock, price: old.price, promoPrice: old.promoPrice,
        currentProfit: old.currentProfit, monthlyMargin: old.monthlyMargin, monthlyAdRatio: old.monthlyAdRatio }));
      upsert.run(date, merged.sku, JSON.stringify(merged), actorId);
    }
    stateUpsert.run('last_success', JSON.stringify({ date, startedAt, completedAt: new Date().toISOString(),
      skus: sourceBySku.size, channels: 1, unmappedAds: summary.unmappedAds, complete, stage, callsThisRun }));
    db.prepare("DELETE FROM pet_price_sync_state WHERE key='last_error'").run();
  })();
  return { skus: sourceBySku.size, unmappedAds: summary.unmappedAds };
}

let running = false;
export async function syncPriceStrategy(date, actorId = null, gateway = { discoverChannels, paged, pagedChunk }) {
  if (!isPet) throw new Error('只支持宠物版');
  if (!dailyDates(date).length) throw new Error('同步日期不合法');
  if (running) throw new Error('价格策略表正在同步');
  const pauseReason = priceSyncStatus().pauseReason;
  if (pauseReason) throw new Error(pauseReason);
  running = true;
  const startedAt = new Date().toISOString();
  stateUpsert.run('last_attempt', JSON.stringify({ date, startedAt }));
  let stage = '读取店铺';
  let coreSaved = false;
  try {
    return await withCaptainRequestBudget(CALLS_PER_SYNC, async (requestBudget) => {
    const groups = await gateway.discoverChannels();
    const usChannels = groups.flatMap((group) => group.channels).filter((channel) => channel.country === 'US');
    const selectedChannelId = String(process.env.PET_CAPTAIN_CHANNEL_ID ?? '').trim();
    const channels = selectedChannelId ? usChannels.filter((channel) => channel.openChannelId === selectedChannelId) : usChannels;
    if (!channels.length) throw new Error(selectedChannelId ? 'PET_CAPTAIN_CHANNEL_ID 未匹配船长美国站店铺' : '船长未返回美国站店铺，请检查授权范围');
    if (channels.length > 1) throw new Error('船长授权了多个美国站店铺，请在服务器配置 PET_CAPTAIN_CHANNEL_ID，避免混合不同店铺的数据');
    const end = toStamp(nextDate(date, 1));
    const start = Math.min(toStamp(`${date.slice(0, 7)}-01`), toStamp(nextDate(date, -13)));
    const recentStart = end - 30 * daySeconds;
    const adHistory = historyWindow('ad_history', date, end);
    const inventoryHistory = historyWindow('inventory_history', date, end);
    const channel = channels[0], channelId = channel.openChannelId, header = { OpenChannelId: channelId };
    stage = '读取订单';
    const orderKey = `order_cursor:${channelId}:${date}:${start}:${end}`;
    const orderChunk = await readChunk(gateway, '/v1/open_order/get_order_list', {
      start_modified_time: start, end_modified_time: end,
    }, header, orderKey, 1);
    db.transaction(() => { orderChunk.items.forEach((order, index) => {
      const key = String(order.AmazonOrderId ?? order.id ?? `${order.LocalDate ?? ''}:${order.order_item?.[0]?.OrderItemId ?? index}`);
      saveOrder.run(date, channelId, key, JSON.stringify(order));
    }); })();

    let allComplete = orderChunk.complete;
    for (const [label, windowStart, windowEnd, history] of [
      ['近期', recentStart, end, false], ['历史', inventoryHistory.start, inventoryHistory.end, true],
    ]) {
      stage = `读取 FBA 库存（${label}）`;
      const key = `inventory_cursor:${channelId}:${windowStart}:${windowEnd}`;
      const chunk = await readChunk(gateway, '/v1/open_fba/inventory_list', {
        start_modified_time: windowStart, end_modified_time: windowEnd,
      }, header, key, 1);
      db.transaction(() => { for (const item of chunk.items) if (item.SKU) saveInventory.run(channelId, item.SKU,
        positive(item.fulfillable_quantity), positive(item.inbound_shipped_quantity)); })();
      allComplete &&= chunk.complete;
      if (history && chunk.complete) stateUpsert.run('inventory_history', JSON.stringify({ date, offset: inventoryHistory.offset, nextOffset: inventoryHistory.nextOffset }));
    }
    stage = '保存订单和库存';
    let result = persistSnapshot({ date, actorId, channelId, startedAt, complete: false,
      stage: '订单和库存已保存，广告仍在补齐', callsThisRun: requestBudget.used });
    coreSaved = true;

    for (const [label, windowStart, windowEnd, history] of [
      ['近期', recentStart, end, false], ['历史', adHistory.start, adHistory.end, true],
    ]) {
      stage = `读取广告清单（${label}）`;
      const key = `ad_cursor:${channelId}:${windowStart}:${windowEnd}`;
      const chunk = await readChunk(gateway, '/v1/open_cpc/advertise', {
        type: 1, start_modified_time: windowStart, end_modified_time: windowEnd,
      }, header, key, 1);
      db.transaction(() => { for (const ad of chunk.items) if (ad.adId && ad.sku) saveAd.run(channelId, String(ad.adId), String(ad.sku).trim()); })();
      allComplete &&= chunk.complete;
      if (history && chunk.complete) stateUpsert.run('ad_history', JSON.stringify({ date, offset: adHistory.offset, nextOffset: adHistory.nextOffset }));
    }

    for (const day of dailyIsoDates(date)) {
      stage = `读取广告日报（${day}）`;
      const key = `ad_report_cursor:${channelId}:${day}`;
      const chunk = await readChunk(gateway, '/v1/open_cpc/advertise_report', {
        report_date: day.replaceAll('-', ''), start_modified_time: toStamp(day), end_modified_time: toStamp(nextDate(day, 1)),
      }, header, key, 1);
      db.transaction(() => { for (const report of chunk.items) if (report.adId) saveAdReport.run(channelId, day,
        String(report.adId), positive(report.clicks) ?? 0, positive(report.ad_order_num) ?? 0); })();
      allComplete &&= chunk.complete;
    }
    stage = '保存广告汇总';
    result = persistSnapshot({ date, actorId, channelId, startedAt, complete: allComplete,
      stage: allComplete ? '全部数据已完成' : '基础数据已保存，广告分页将在后续同步继续', callsThisRun: requestBudget.used });
    if (actorId) audit(actorId, 'US', 'sync', 'pet_price_strategy', null, { date, skus: result.skus, channels: 1, complete: allComplete });
    return { date, skus: result.skus, channels: 1, unmappedAds: result.unmappedAds,
      complete: allComplete, callsThisRun: requestBudget.used };
    });
  } catch (error) {
    if (error.code === 'CAPTAIN_BATCH_LIMIT' && coreSaved) {
      const saved = savedState('last_success') ?? {};
      stateUpsert.run('last_success', JSON.stringify({ ...saved, complete: false, stage: error.message, completedAt: new Date().toISOString() }));
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='last_error'").run();
      return { date, complete: false, callsThisRun: CALLS_PER_SYNC };
    }
    const message = `${stage}：${String(error.message)}`.slice(0, 300);
    stateUpsert.run('last_error', JSON.stringify({ date, at: new Date().toISOString(), stage, message, coreSaved }));
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; }
}

export function priceSyncStatus() {
  const states = Object.fromEntries(db.prepare('SELECT key,value FROM pet_price_sync_state').all().map(({ key, value }) => [key, JSON.parse(value)]));
  const lastError = states.last_error ?? null;
  const usage = captainUsageStatus();
  const pauseReason = usage.calls >= usage.limit
    ? `本应用今天已用完 ${usage.limit} 次安全额度，请明天再同步`
    : lastError && lastError.at && shanghaiDayOf(lastError.at) === shanghaiDay() && isRateLimitError(lastError.message)
      ? '船长今天已提示请求过快，为保护免费额度，请明天再同步' : null;
  return { configured: !!(process.env.CAPTAIN_CLIENT_ID && process.env.CAPTAIN_CLIENT_SECRET), running,
    callsPerSync: CALLS_PER_SYNC,
    rateLimitedToday: !!pauseReason, pauseReason, usage,
    lastSuccess: states.last_success ?? null, lastAttempt: states.last_attempt ?? null, lastError };
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
    if (!status.configured || status.rateLimitedToday || running || status.lastSuccess?.date === date && status.lastSuccess?.complete
      || status.lastAttempt?.date === date && Date.now() - Date.parse(status.lastAttempt.startedAt) < 6 * 60 * 60_000) return;
    try { await syncPriceStrategy(date); } catch (error) { console.error('[price-sync]', error.message); }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
