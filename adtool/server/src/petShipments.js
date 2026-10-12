// 宠物版 FBA 入库货件:亚马逊 Fulfillment Inbound API v0 的 getShipments + getShipmentItemsByShipmentId。
// 能拿到每个货件的编号、名称、状态、目的仓,以及货件里每个 SKU 的发货件数和已收件数;
// 拿不到物流单号、创建时间和预计到仓日期,所以「发了几天」按网站第一次看到它变成已发货的时间算。
// 和库存联动:未完成货件里每个 SKU 还没收的件数,按状态归到库存接口的 处理中 / 已发货 / 正在接收,
// 拿来对 pet_inventory_detail(价格策略表那次同步的库存拆分);SKU 库、价格策略表的「在途」能点进这里。
import express from 'express';
import { db } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, petSpConfig, shiftDay, US_MARKETPLACE } from './petAmazon.js';
import { buildPriceBoard, recentDays } from './petSales.js';
import { priceSyncStatus } from './priceStrategySync.js';

const REGION = 'na';
const DAY_MS = 86400000;
// 第一次同步回填最近多少天里更新过的货件(含已完成的),按 WINDOW_DAYS 一段查
export const BACKFILL_DAYS = 365;
const WINDOW_DAYS = 60;
// 自动同步:和库存同步一样每 3 小时;失败后隔 1 小时再自动试
const REFRESH_EVERY_MS = 3 * 60 * 60_000;
const RETRY_AFTER_ERROR_MS = 60 * 60_000;
// 提醒阈值(天)
const STUCK_WORKING_DAYS = 14;
const STUCK_SHIPPED_DAYS = 30;
const STUCK_RECEIVING_DAYS = 14;
const SHORTFALL_LOOKBACK_DAYS = 90;
const LOW_STOCK_DAYS = 30;
const MAX_PAGES = 200;

/** 货件接口调用间隔。getShipmentItemsByShipmentId 每秒 2 次;测试调成 0 */
export const inboundTiming = { gapMs: 600 };

/**
 * 亚马逊货件状态 -> 中文和归类。bucket 对应库存接口:
 *   working 处理中(inboundWorkingQuantity) / shipped 已发货(inboundShippedQuantity) / receiving 正在接收(inboundReceivingQuantity)
 *   closed 已完成 / cancelled 取消或删除
 */
export const STATUSES = {
  WORKING: { label: '处理中', bucket: 'working', order: 1 },
  READY_TO_SHIP: { label: '待发货', bucket: 'working', order: 2 },
  SHIPPED: { label: '已发货', bucket: 'shipped', order: 3 },
  IN_TRANSIT: { label: '运输中', bucket: 'shipped', order: 4 },
  DELIVERED: { label: '已送达', bucket: 'shipped', order: 5 },
  CHECKED_IN: { label: '已签到', bucket: 'shipped', order: 6 },
  RECEIVING: { label: '接收中', bucket: 'receiving', order: 7 },
  CLOSED: { label: '已完成', bucket: 'closed', order: 8 },
  CANCELLED: { label: '已取消', bucket: 'cancelled', order: 9 },
  DELETED: { label: '已删除', bucket: 'cancelled', order: 10 },
  ERROR: { label: '出错', bucket: 'cancelled', order: 11 },
};
const OPEN_STATUSES = Object.keys(STATUSES).filter((code) => ['working', 'shipped', 'receiving'].includes(STATUSES[code].bucket));
export const statusInfo = (code) => STATUSES[code] ?? { label: code || '未知', bucket: 'cancelled', order: 99 };
const isOpen = (code) => OPEN_STATUSES.includes(code);

const clean = (value) => String(value ?? '').trim();
const lower = (value) => clean(value).toLowerCase();
const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

// ---------- 接口 ----------

/** 货件名称里的日期:Send to Amazon 默认名「FBA STA (10/05/2026 10:23)-ONT8」,也认 2026-10-05 这种写法 */
export function nameDay(name) {
  const text = clean(name);
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(text);
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  let year, month, day;
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3].length === 2 ? `20${us[3]}` : us[3])];
  else return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** getShipments 的一条 -> 存库字段 */
export function shipmentFromApi(raw) {
  const id = clean(raw?.ShipmentId).toUpperCase();
  if (!id) return null;
  const from = raw.ShipFromAddress ?? {};
  return {
    shipmentId: id, name: clean(raw.ShipmentName) || null, status: clean(raw.ShipmentStatus).toUpperCase() || 'ERROR',
    destination: clean(raw.DestinationFulfillmentCenterId) || null,
    shipFrom: [from.City, from.StateOrProvinceCode, from.CountryCode].map(clean).filter(Boolean).join(', ') || null,
    labelPrep: clean(raw.LabelPrepType) || null, boxContentsSource: clean(raw.BoxContentsSource) || null,
    needByDate: clean(raw.ConfirmedNeedByDate) || null, createdDay: nameDay(raw.ShipmentName),
  };
}

/** 按条件查货件,自动翻页 */
export async function fetchShipments(account, query, gateway = amazonGateway) {
  const shipments = [];
  let nextToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page) await sleep(inboundTiming.gapMs);
    const params = nextToken
      ? { QueryType: 'NEXT_TOKEN', NextToken: nextToken, MarketplaceId: US_MARKETPLACE }
      : { ...query, MarketplaceId: US_MARKETPLACE };
    const payload = await gateway.request(account, REGION, 'GET', '/fba/inbound/v0/shipments', { query: params });
    for (const raw of payload?.payload?.ShipmentData ?? []) {
      const shipment = shipmentFromApi(raw);
      if (shipment) shipments.push(shipment);
    }
    nextToken = clean(payload?.payload?.NextToken);
    if (!nextToken) return shipments;
  }
  throw new Error('亚马逊货件分页超过安全上限，请联系管理员检查接口数据');
}

/** 一个货件里每个 SKU 的发货、已收件数 */
export async function fetchShipmentItems(account, shipmentId, gateway = amazonGateway) {
  const payload = await gateway.request(account, REGION, 'GET', `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`,
    { query: { MarketplaceId: US_MARKETPLACE } });
  const items = new Map();
  for (const raw of payload?.payload?.ItemData ?? []) {
    const sku = clean(raw?.SellerSKU);
    if (!sku) continue;
    const item = items.get(lower(sku)) ?? { sku, fnsku: clean(raw.FulfillmentNetworkSKU) || null, shipped: 0, received: 0, inCase: null };
    item.shipped += intOf(raw.QuantityShipped);
    item.received += intOf(raw.QuantityReceived);
    item.inCase = intOf(raw.QuantityInCase) || item.inCase;
    items.set(lower(sku), item);
  }
  return [...items.values()];
}

// ---------- 同步 ----------

const state = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));

/** DATE_RANGE 查询的时间段(新的在前)。第一次回填 BACKFILL_DAYS 天;之后从上次成功同步前 1 天查起 */
export function rangesToFetch(now, lastSuccessAt, backfill = BACKFILL_DAYS) {
  const end = new Date(now.getTime() - 2 * 60_000);
  const start = lastSuccessAt ? new Date(Math.max(Date.parse(lastSuccessAt) - DAY_MS, end.getTime() - backfill * DAY_MS))
    : new Date(end.getTime() - backfill * DAY_MS);
  const ranges = [];
  for (let to = end; to > start;) {
    const from = new Date(Math.max(start.getTime(), to.getTime() - WINDOW_DAYS * DAY_MS));
    ranges.push({ from, to });
    to = from;
  }
  return ranges;
}

/** 存货件:新货件记下第一次看到的时间;状态变了记下变的时间和第一次进入发货、接收、完成的时间 */
function saveShipments(shipments, at) {
  const existing = new Map(db.prepare('SELECT * FROM pet_inbound_shipments').all().map((row) => [row.shipment_id, row]));
  const insert = db.prepare(`INSERT INTO pet_inbound_shipments (shipment_id, name, status, destination, ship_from, label_prep, box_contents_source,
    need_by_date, created_day, first_seen_at, status_changed_at, shipped_at, receiving_at, closed_at, last_seen_at)
    VALUES (@shipmentId, @name, @status, @destination, @shipFrom, @labelPrep, @boxContentsSource, @needByDate, @createdDay,
    @at, @at, @shippedAt, @receivingAt, @closedAt, @at)`);
  const update = db.prepare(`UPDATE pet_inbound_shipments SET name=@name, status=@status, destination=@destination, ship_from=@shipFrom,
    label_prep=@labelPrep, box_contents_source=@boxContentsSource, need_by_date=@needByDate, created_day=COALESCE(created_day, @createdDay),
    status_changed_at=@statusChangedAt, shipped_at=@shippedAt, receiving_at=@receivingAt, closed_at=@closedAt, last_seen_at=@at
    WHERE shipment_id=@shipmentId`);
  const changed = new Set();
  db.transaction(() => {
    for (const shipment of shipments) {
      const bucket = statusInfo(shipment.status).bucket;
      const current = existing.get(shipment.shipmentId);
      // 第一次看到就已经发了货:发货时间只能记成现在(第一次同步时对已在路上的货件偏晚)
      const reached = (field, buckets) => current?.[field] ?? (buckets.includes(bucket) ? at : null);
      const values = { ...shipment, at,
        shippedAt: reached('shipped_at', ['shipped', 'receiving', 'closed']),
        receivingAt: reached('receiving_at', ['receiving', 'closed']),
        closedAt: reached('closed_at', ['closed']) };
      if (!current) { insert.run(values); changed.add(shipment.shipmentId); continue; }
      if (current.status !== shipment.status) changed.add(shipment.shipmentId);
      update.run({ ...values, statusChangedAt: current.status === shipment.status ? current.status_changed_at : at });
    }
  })();
  return changed;
}

function saveItems(shipmentId, items, at) {
  const insert = db.prepare(`INSERT INTO pet_inbound_shipment_items (shipment_id, sku, fnsku, quantity_shipped, quantity_received, quantity_in_case)
    VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM pet_inbound_shipment_items WHERE shipment_id=?').run(shipmentId);
    for (const item of items) insert.run(shipmentId, item.sku, item.fnsku, item.shipped, item.received, item.inCase);
    db.prepare('UPDATE pet_inbound_shipments SET items_synced_at=? WHERE shipment_id=?').run(at, shipmentId);
  })();
}

function friendly(error) {
  if (error?.upstreamStatus === 403) {
    return '亚马逊拒绝了货件接口（403）：SP-API 应用需要「亚马逊物流」(Amazon Fulfillment) 角色，加上后要重新授权换新的 refresh token';
  }
  return String(error?.message ?? error);
}

let running = false;
let progress = null;

/**
 * 同步货件:
 *   1. 所有未完成的货件(处理中到接收中)
 *   2. 最近更新过的货件(含已完成、取消),第一次回填 365 天
 *   3. 库里还记着未完成、但这两步都没返回的,按编号再查一次最新状态
 * 然后拉货件明细:未完成的每次都拉(已收件数在变),已完成的只在状态刚变或还没拉过时拉。
 */
export async function syncShipments({ backfill = BACKFILL_DAYS } = {}, gateway = amazonGateway, env = process.env, now = () => new Date()) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('货件正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  running = true;
  const startedAt = now().toISOString();
  setState('shipments_last_attempt', { startedAt });
  progress = { total: 0, done: 0, step: '查货件列表', stage: 'working', retryAt: null };
  try {
    const found = new Map();
    const keep = (list) => { for (const shipment of list) found.set(shipment.shipmentId, shipment); };
    keep(await fetchShipments(account, { QueryType: 'SHIPMENT', ShipmentStatusList: OPEN_STATUSES.join(',') }, gateway));
    for (const range of rangesToFetch(now(), state('shipments_last_success')?.startedAt, backfill)) {
      await sleep(inboundTiming.gapMs);
      keep(await fetchShipments(account, { QueryType: 'DATE_RANGE', ShipmentStatusList: Object.keys(STATUSES).join(','),
        LastUpdatedAfter: range.from.toISOString(), LastUpdatedBefore: range.to.toISOString() }, gateway));
    }
    const missing = db.prepare(`SELECT shipment_id FROM pet_inbound_shipments WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`)
      .all(...OPEN_STATUSES).map((row) => row.shipment_id).filter((id) => !found.has(id));
    for (let index = 0; index < missing.length; index += 50) {
      await sleep(inboundTiming.gapMs);
      keep(await fetchShipments(account, { QueryType: 'SHIPMENT', ShipmentIdList: missing.slice(index, index + 50).join(',') }, gateway));
    }
    const at = now().toISOString();
    const changed = saveShipments([...found.values()], at);
    const synced = new Map(db.prepare('SELECT shipment_id, items_synced_at FROM pet_inbound_shipments').all().map((row) => [row.shipment_id, row.items_synced_at]));
    const needItems = [...found.values()].filter((shipment) => shipment.status !== 'DELETED'
      && (isOpen(shipment.status) || changed.has(shipment.shipmentId) || !synced.get(shipment.shipmentId)));
    Object.assign(progress, { total: needItems.length, done: 0 });
    for (const shipment of needItems) {
      Object.assign(progress, { step: `货件明细 ${shipment.shipmentId}` });
      await sleep(inboundTiming.gapMs);
      saveItems(shipment.shipmentId, await fetchShipmentItems(account, shipment.shipmentId, gateway), now().toISOString());
      progress.done += 1;
    }
    const result = { shipments: found.size, open: [...found.values()].filter((shipment) => isOpen(shipment.status)).length,
      itemsFetched: needItems.length, startedAt, completedAt: now().toISOString() };
    db.transaction(() => {
      setState('shipments_last_success', result);
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='shipments_last_error'").run();
    })();
    return result;
  } catch (error) {
    const message = friendly(error).slice(0, 300);
    setState('shipments_last_error', { at: now().toISOString(), message });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; progress = null; }
}

export function shipmentsSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  return { configured: !!account, issues, running, progress,
    lastSuccess: state('shipments_last_success'), lastAttempt: state('shipments_last_attempt'), lastError: state('shipments_last_error') };
}

/** 每 20 分钟看一次:3 小时没成功同步过就拉一轮;失败后 1 小时内不自动重试 */
export function startShipmentsSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = shipmentsSyncStatus();
    if (!status.configured || running) return;
    const failedAt = status.lastError ? Date.parse(status.lastError.at) : 0;
    const okAt = status.lastSuccess ? Date.parse(status.lastSuccess.completedAt) : 0;
    if (failedAt > okAt && Date.now() - failedAt < RETRY_AFTER_ERROR_MS) return;
    if (Date.now() - okAt < REFRESH_EVERY_MS) return;
    try { await syncShipments(); } catch (error) { console.error('[shipments-sync]', error.message); }
  };
  setTimeout(run, 8 * 60_000).unref();
  setInterval(run, 20 * 60_000).unref();
}

// ---------- 看板 ----------

const daysSince = (at, nowMs) => (at ? Math.max(0, Math.floor((nowMs - Date.parse(at)) / DAY_MS)) : null);
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' ') || row.sku;

/** SKU 库 + 库存拆分 + 7 天动销(和价格策略表同一套算法) */
function inventoryBySku(today) {
  const skus = db.prepare("SELECT sku,asin,style,size,color,stock,transit FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID);
  const sales = db.prepare('SELECT day,sku,asin,units FROM pet_daily_sales WHERE day>=? AND day<=?').all(recentDays(today)[0], today);
  const board = buildPriceBoard({ skus, sales, today });
  const detail = new Map(db.prepare('SELECT * FROM pet_inventory_detail').all().map((row) => [lower(row.sku), row]));
  return new Map(board.rows.map((row) => {
    const parts = detail.get(lower(row.sku));
    return [lower(row.sku), { sku: row.sku, asin: row.asin, style: row.style, size: row.size, color: row.color,
      stock: row.stock, transit: row.transit, speed7d: row.speed7d, sales7d: row.sales7d, stockDays: row.stockDays, soldOut: row.soldOut,
      inventory: parts ? { available: parts.available, receiving: parts.receiving, working: parts.working, shipped: parts.shipped } : null }];
  }));
}

/**
 * 货件看板:每个货件(带 SKU 明细和这些 SKU 当前的库存)、每个 SKU 的未完成货件和对账、规则提醒。
 * 默认只带未完成的货件和最近 days 天里完成/取消的。
 */
export function shipmentsBoard({ days = 90, today = todayOf(), nowMs = Date.now() } = {}) {
  const span = Math.max(7, Math.min(730, Number(days) || 90));
  const since = shiftDay(today, -span);
  const inventory = inventoryBySku(today);
  const itemsBy = new Map();
  for (const row of db.prepare('SELECT * FROM pet_inbound_shipment_items ORDER BY sku').all()) {
    if (!itemsBy.has(row.shipment_id)) itemsBy.set(row.shipment_id, []);
    itemsBy.get(row.shipment_id).push(row);
  }
  // 已完成/取消的货件哪天结束:看到了状态变化就用变化的时间,否则(第一次同步时就已经结束)用名称里的创建日期
  const endDay = (row) => (row.status_changed_at !== row.first_seen_at ? pacificDay(row.status_changed_at) : row.created_day ?? pacificDay(row.first_seen_at));
  const shipments = db.prepare('SELECT * FROM pet_inbound_shipments').all()
    .filter((row) => isOpen(row.status) || endDay(row) >= since)
    .map((row) => {
      const info = statusInfo(row.status);
      const open = isOpen(row.status);
      const items = (itemsBy.get(row.shipment_id) ?? []).map((item) => {
        const stock = inventory.get(lower(item.sku));
        return { sku: item.sku, fnsku: item.fnsku, asin: stock?.asin ?? null, style: stock?.style ?? null, size: stock?.size ?? null, color: stock?.color ?? null,
          shipped: item.quantity_shipped, received: item.quantity_received, inCase: item.quantity_in_case,
          // 未完成的货件:还没收的件数(算在途);已完成的:少收的件数
          outstanding: open ? Math.max(0, item.quantity_shipped - item.quantity_received) : 0,
          shortfall: row.status === 'CLOSED' ? Math.max(0, item.quantity_shipped - item.quantity_received) : 0,
          stock: stock?.stock ?? null, stockDays: stock?.stockDays ?? null, soldOut: stock?.soldOut ?? false, speed7d: stock?.speed7d ?? 0 };
      });
      const sum = (key) => items.reduce((total, item) => total + item[key], 0);
      const statusAt = { working: row.first_seen_at, shipped: row.shipped_at, receiving: row.receiving_at, closed: row.closed_at }[info.bucket] ?? row.status_changed_at;
      return { shipmentId: row.shipment_id, name: row.name, status: row.status, statusLabel: info.label, bucket: info.bucket, open,
        destination: row.destination, shipFrom: row.ship_from, createdDay: row.created_day, needByDate: row.need_by_date,
        firstSeenAt: row.first_seen_at, shippedAt: row.shipped_at, receivingAt: row.receiving_at, closedAt: row.closed_at,
        statusChangedAt: row.status_changed_at, endDay: open ? null : endDay(row), daysInStatus: daysSince(statusAt, nowMs),
        // false:第一次同步时就已经是这个状态,实际天数比 daysInStatus 长
        statusObserved: info.bucket === 'working' || statusAt !== row.first_seen_at,
        ageDays: row.created_day ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.created_day}T00:00:00Z`)) / DAY_MS)) : daysSince(row.first_seen_at, nowMs),
        skuCount: items.length, shipped: sum('shipped'), received: sum('received'), outstanding: sum('outstanding'), shortfall: sum('shortfall'),
        itemsSyncedAt: row.items_synced_at, items };
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || statusInfo(a.status).order - statusInfo(b.status).order
      || String(b.createdDay ?? b.firstSeenAt).localeCompare(String(a.createdDay ?? a.firstSeenAt)));

  // 每个 SKU:未完成货件里还没收的件数,按库存接口的口径分三栏,和库存同步的拆分对账
  const skuMap = new Map();
  const skuOf = (code) => {
    const key = lower(code);
    if (!skuMap.has(key)) {
      const stock = inventory.get(key);
      skuMap.set(key, { sku: stock?.sku ?? code, asin: stock?.asin ?? null, style: stock?.style ?? null, size: stock?.size ?? null, color: stock?.color ?? null,
        stock: stock?.stock ?? null, transit: stock?.transit ?? null, speed7d: stock?.speed7d ?? 0, sales7d: stock?.sales7d ?? 0,
        stockDays: stock?.stockDays ?? null, soldOut: stock?.soldOut ?? false, inventory: stock?.inventory ?? null,
        fromShipments: { working: 0, shipped: 0, receiving: 0 }, shipments: [] });
    }
    return skuMap.get(key);
  };
  for (const shipment of shipments.filter((item) => item.open)) {
    for (const item of shipment.items) {
      const row = skuOf(item.sku);
      row.fromShipments[shipment.bucket] += item.outstanding;
      row.shipments.push({ shipmentId: shipment.shipmentId, status: shipment.status, statusLabel: shipment.statusLabel, bucket: shipment.bucket,
        shipped: item.shipped, received: item.received, outstanding: item.outstanding, daysInStatus: shipment.daysInStatus });
    }
  }
  // 有库存、有在途或最近有销量的 SKU 都列出来(快断货却没有货件的也要看得到)
  for (const stock of inventory.values()) {
    const parts = stock.inventory;
    if (stock.stock > 0 || stock.transit > 0 || stock.speed7d > 0 || (parts && (parts.working || parts.shipped || parts.receiving))) skuOf(stock.sku);
  }
  const skus = [...skuMap.values()].map((row) => {
    const parts = row.inventory;
    const shipmentTotal = row.fromShipments.working + row.fromShipments.shipped + row.fromShipments.receiving;
    const gaps = parts ? ['working', 'shipped', 'receiving'].filter((key) => parts[key] !== row.fromShipments[key]) : [];
    return { ...row, shipmentTotal, matched: parts ? !gaps.length : null, gaps,
      // 在库 + 货件里还没收的件数够卖多少天
      coverDays: row.speed7d > 0 ? Math.round(((row.stock ?? 0) + row.fromShipments.working + row.fromShipments.shipped) / row.speed7d) : null };
  }).sort((a, b) => (a.stockDays ?? Infinity) - (b.stockDays ?? Infinity) || b.shipmentTotal - a.shipmentTotal || a.sku.localeCompare(b.sku));

  const open = shipments.filter((item) => item.open);
  const units = (bucket) => open.filter((item) => item.bucket === bucket).reduce((total, item) => total + item.outstanding, 0);
  const closedRecent = shipments.filter((item) => item.status === 'CLOSED');
  const totals = { open: open.length, working: units('working'), shipped: units('shipped'), receiving: units('receiving'),
    workingShipments: open.filter((item) => item.bucket === 'working').length, shippedShipments: open.filter((item) => item.bucket === 'shipped').length,
    receivingShipments: open.filter((item) => item.bucket === 'receiving').length,
    closed: closedRecent.length, closedReceived: closedRecent.reduce((total, item) => total + item.received, 0),
    closedShortfall: closedRecent.reduce((total, item) => total + item.shortfall, 0) };

  return { today, days: span, since, totals, shipments, skus, findings: shipmentFindings({ shipments, skus, today }),
    labels: Object.fromEntries(Object.entries(STATUSES).map(([code, value]) => [code, value.label])),
    sync: shipmentsSyncStatus(), inventorySync: (({ lastSuccess }) => ({ at: lastSuccess?.completedAt ?? null }))(priceSyncStatus()),
    notes: [
      '货件数据来自亚马逊 FBA 入库货件接口，每 3 小时同步一次。亚马逊不给创建和发货时间：创建日期取自货件名称里的日期，已发货、接收中的天数从网站第一次看到这个状态算起（第一次同步时已在路上的货件会偏短）。',
      '对账：未完成货件里还没收的件数，处理中、待发货算「处理中」，已发货到已签到算「已发货」，接收中算「正在接收」，和库存同步里的同名数字比较。两边同步时间不同，刚变状态的货件会短暂对不上。',
    ] };
}

/** 规则提醒:每条 { level, title, detail, shipmentIds?, skus? } */
export function shipmentFindings({ shipments, skus, today }) {
  const findings = [];
  const ids = (list) => list.map((item) => item.shipmentId);
  const label = (item) => `${item.shipmentId}${item.destination ? `（${item.destination}）` : ''}`;
  const sinceDay = shiftDay(today, -SHORTFALL_LOOKBACK_DAYS);
  const short = shipments.filter((item) => item.status === 'CLOSED' && item.shortfall > 0 && item.endDay >= sinceDay);
  if (short.length) {
    findings.push({ level: 'high', title: `${short.length} 个已完成的货件少收了 ${short.reduce((total, item) => total + item.shortfall, 0)} 件`,
      detail: `${short.slice(0, 4).map((item) => `${label(item)} 发 ${item.shipped} 收 ${item.received}`).join('；')}。到卖家后台这个货件的「货件处理进度 / 对账」里申请调查，亚马逊核实后会补件或赔钱；超过期限就不能再申请。`,
      shipmentIds: ids(short) });
  }
  const receiving = shipments.filter((item) => item.bucket === 'receiving' && item.daysInStatus >= STUCK_RECEIVING_DAYS);
  if (receiving.length) {
    findings.push({ level: 'medium', title: `${receiving.length} 个货件接收中超过 ${STUCK_RECEIVING_DAYS} 天`,
      detail: `${receiving.slice(0, 4).map((item) => `${label(item)} 已收 ${item.received}/${item.shipped}，${item.daysInStatus} 天`).join('；')}。这部分货已到仓但前台还买不到，可以开 case 催上架。`,
      shipmentIds: ids(receiving) });
  }
  const lowNoInbound = skus.filter((row) => row.speed7d > 0 && (row.soldOut || (row.stockDays != null && row.stockDays < LOW_STOCK_DAYS)));
  const none = lowNoInbound.filter((row) => !row.shipments.length);
  if (none.length) {
    findings.push({ level: 'high', title: `${none.length} 个 SKU ${LOW_STOCK_DAYS} 天内卖完，没有在途货件`,
      detail: `${none.slice(0, 5).map((row) => `${nameOf(row)}（${row.sku}）${row.soldOut ? '已断货' : `剩 ${row.stock} 件约 ${row.stockDays} 天`}`).join('；')}。需要安排补货。`,
      skus: none.map((row) => row.sku) });
  }
  const notSent = lowNoInbound.filter((row) => row.shipments.length && row.shipments.every((item) => item.bucket === 'working'));
  if (notSent.length) {
    findings.push({ level: 'medium', title: `${notSent.length} 个快卖完的 SKU，货件还没发出`,
      detail: `${notSent.slice(0, 5).map((row) => `${nameOf(row)}（${row.sku}）${row.soldOut ? '已断货' : `约 ${row.stockDays} 天卖完`}，货件 ${row.shipments.map((item) => item.shipmentId).join('、')} 还在${row.shipments[0].statusLabel}`).join('；')}。`,
      skus: notSent.map((row) => row.sku), shipmentIds: [...new Set(notSent.flatMap((row) => row.shipments.map((item) => item.shipmentId)))] });
  }
  const shipped = shipments.filter((item) => item.bucket === 'shipped' && item.daysInStatus >= STUCK_SHIPPED_DAYS);
  if (shipped.length) {
    findings.push({ level: 'medium', title: `${shipped.length} 个货件发出超过 ${STUCK_SHIPPED_DAYS} 天还没开始接收`,
      detail: `${shipped.slice(0, 4).map((item) => `${label(item)} ${item.statusLabel} ${item.daysInStatus} 天`).join('；')}。核对物流轨迹，确认是否已送达仓库。`,
      shipmentIds: ids(shipped) });
  }
  const working = shipments.filter((item) => item.bucket === 'working' && (item.ageDays ?? 0) >= STUCK_WORKING_DAYS);
  if (working.length) {
    findings.push({ level: 'low', title: `${working.length} 个货件创建超过 ${STUCK_WORKING_DAYS} 天还没发货`,
      detail: `${working.slice(0, 4).map((item) => `${label(item)} ${item.outstanding} 件`).join('；')}。不发的草稿货件可以在卖家后台删掉，否则这些件数一直算在「在途」里，可售天数会偏乐观。`,
      shipmentIds: ids(working) });
  }
  const gaps = skus.filter((row) => row.matched === false);
  if (gaps.length) {
    const word = { working: '处理中', shipped: '已发货', receiving: '正在接收' };
    findings.push({ level: 'low', title: `${gaps.length} 个 SKU 货件件数和库存接口对不上`,
      detail: `${gaps.slice(0, 4).map((row) => `${row.sku} ${row.gaps.map((key) => `${word[key]} 货件 ${row.fromShipments[key]} / 库存 ${row.inventory[key]}`).join('，')}`).join('；')}。多数是两边同步时间不同，下次同步后还对不上再看。`,
      skus: gaps.map((row) => row.sku) });
  }
  const levels = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => levels[a.level] - levels[b.level]);
}

// ---------- 网站接口 ----------

export const shipmentsRouter = express.Router();
shipmentsRouter.use(requireLogin);
shipmentsRouter.use((req, res, next) => isPet ? next() : res.status(404).json({ error: '只有宠物版有货件' }));
shipmentsRouter.get('/', (req, res) => res.json(shipmentsBoard({ days: req.query.days })));
shipmentsRouter.get('/status', (req, res) => res.json(shipmentsSyncStatus()));
shipmentsRouter.post('/sync', (req, res) => {
  const status = shipmentsSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  if (status.running) return res.status(409).json({ error: '货件正在同步' });
  void syncShipments().catch((error) => console.error('[shipments-sync]', error.message));
  res.status(202).json({ accepted: true });
});
