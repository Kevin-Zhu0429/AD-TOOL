import { db, audit } from './db.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { saveFees } from './petCosts.js';
import { recordStockChanges, snapshotStock } from './stockEvents.js';
import {
  amazonGateway, fetchCatalogAttributes, fetchFeePreview, fetchInventory, fetchListings, fetchOrderLines,
  pacificDay, pacificMidnight, petSpConfig, shiftDay,
} from './petAmazon.js';

// 订单报告晚于下单几分钟才完整,当天的区间截到现在之前
const REPORT_LAG_MS = 5 * 60_000;
// 订单报告单份最多 30 天
const WINDOW_DAYS = 30;
// 每次同步重拉最近几天:待付款转发货、取消都会改动最近的订单
const REFRESH_DAYS = 9;
// FBA 费用很少变,自动同步每天拉一次;手动点同步时总是重拉
const FEE_EVERY_MS = 20 * 60 * 60_000;
const savedState = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const stateUpsert = db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

/** 第一次同步回填到今年 1 月 1 日(至少 3 个月),之后只从上次同步到的日子往前重拉几天 */
export function orderSyncStart(today, coverage) {
  const backfill = [`${today.slice(0, 4)}-01-01`, shiftDay(today, -92)].sort()[0];
  if (!coverage?.to) return backfill;
  return [shiftDay(today, -REFRESH_DAYS), shiftDay(coverage.to, -2)].sort()[0];
}

/** 订单行按太平洋日期 + SKU 汇总。待付款订单还没有金额,按 Listing 售价估算 */
export function aggregateDailySales(lines, priceBySku = new Map()) {
  const rows = new Map();
  for (const line of lines) {
    const key = `${line.day}\0${line.sku.toLowerCase()}`;
    if (!rows.has(key)) rows.set(key, { day: line.day, sku: line.sku, asin: null, units: 0, orders: new Set(), sales: 0, estimatedSales: 0 });
    const row = rows.get(key);
    row.asin ||= line.asin || null;
    row.units += line.quantity;
    row.orders.add(line.orderId);
    if (line.amount != null) row.sales += line.amount;
    else {
      const estimate = (priceBySku.get(line.sku.toLowerCase()) ?? 0) * line.quantity;
      row.sales += estimate;
      row.estimatedSales += estimate;
    }
  }
  return [...rows.values()].map((row) => ({ ...row, orders: row.orders.size,
    sales: Number(row.sales.toFixed(2)), estimatedSales: Number(row.estimatedSales.toFixed(2)) }));
}

/** 把 [fromDay, toDay) 这几天的销量整天替换 */
function replaceDailySales(fromDay, toDay, rows) {
  const insert = db.prepare(`INSERT INTO pet_daily_sales(day,sku,asin,units,orders,sales,estimated_sales)
    VALUES(@day,@sku,@asin,@units,@orders,@sales,@estimatedSales)`);
  db.transaction(() => {
    db.prepare('DELETE FROM pet_daily_sales WHERE day>=? AND day<?').run(fromDay, toDay);
    for (const row of rows) insert.run(row);
  })();
}

function saveListings(listings) {
  const insert = db.prepare('INSERT OR REPLACE INTO pet_listing_cache(sku,asin,price,status) VALUES(?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM pet_listing_cache').run();
    for (const listing of listings) insert.run(listing.sku, listing.asin, listing.price, listing.status || null);
  })();
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

/**
 * 读 Fee Preview 报告更新 FBA 配送费和佣金。失败不影响库存和销量同步,只记下错误,下次再试。
 * 返回更新了几个 SKU;这次不需要拉返回 null。
 */
const feesDue = (now, force) => {
  const last = savedState('fees_attempt');
  return force || !last?.at || now().getTime() - Date.parse(last.at) >= FEE_EVERY_MS;
};

async function syncFees(account, gateway, now, onProgress) {
  stateUpsert.run('fees_attempt', JSON.stringify({ at: now().toISOString() }));
  try {
    const count = saveFees(await fetchFeePreview(account, now(), gateway, onProgress));
    db.transaction(() => {
      stateUpsert.run('fees_success', JSON.stringify({ at: now().toISOString(), skus: count }));
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='fees_error'").run();
    })();
    return count;
  } catch (error) {
    stateUpsert.run('fees_error', JSON.stringify({ at: now().toISOString(), message: `读取 FBA 费用：${String(error.message)}`.slice(0, 300) }));
    console.error('[fee-sync]', error.message);
    return null;
  }
}

let running = false;
/**
 * 后台同步进度,前端轮询 /status 拿去画进度条:
 * total / done 是总步数和已完成步数,step 是当前步骤,stage / retryAt 是报告步骤里正在等什么(同 ABA)。
 */
let progress = null;
/** 同步一次:Listing → FBA 库存 → 尺码颜色 → SKU 库 → 订单(按 30 天一段写入每日销量)→ FBA 费用 */
export async function syncAmazonData(actorId = null, gateway = amazonGateway, env = process.env, now = () => new Date()) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('亚马逊数据正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  running = true;
  const startedAt = now().toISOString();
  const today = pacificDay(now());
  stateUpsert.run('last_attempt', JSON.stringify({ today, startedAt }));
  let stage = '读取 Listing';
  const from = orderSyncStart(today, savedState('sales_coverage'));
  let segments = 0;
  for (let day = from; day <= today; day = [shiftDay(day, WINDOW_DAYS), shiftDay(today, 1)].sort()[0]) segments += 1;
  const withFees = feesDue(now, !!actorId);
  progress = { total: 4 + segments + (withFees ? 1 : 0), done: 0, step: stage, stage: 'starting', retryAt: null };
  // 进入下一步:上一步算完成
  const advance = (name, report = false) => {
    stage = name;
    if (progress.step !== name) progress.done += 1;
    Object.assign(progress, { step: name, stage: report ? 'creating' : 'working', retryAt: null });
  };
  const onReport = ({ stage: reportStage, retryAt = null }) => Object.assign(progress, { stage: reportStage, retryAt });
  try {
    progress.stage = 'creating';
    const listings = await fetchListings(account, gateway, onReport);
    saveListings(listings);
    advance('读取 FBA 库存');
    const inventory = await fetchInventory(account, gateway);
    advance('读取商品尺码颜色');
    const known = new Map(db.prepare("SELECT lower(sku) AS sku, size, color FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID)
      .map((row) => [row.sku, row]));
    const needAttributes = [...listings, ...inventory].filter((item) => {
      const current = known.get(item.sku.toLowerCase());
      return item.asin && (!current || !current.size || !current.color);
    }).map((item) => item.asin);
    const attributes = await fetchCatalogAttributes(account, needAttributes, gateway);
    advance('更新 SKU 库');
    // 写库存前后对比在库,记下这次的新断货 / 补货
    const before = snapshotStock(PET_SHOP_ID);
    const library = applySkuLibrary({ listings, inventory, attributes, brand: account.brand });
    const stockSync = recordStockChanges(PET_SHOP_ID, before);

    const priceBySku = new Map(listings.filter((item) => item.price).map((item) => [item.sku.toLowerCase(), item.price]));
    const coverage = savedState('sales_coverage');
    let orderLines = 0;
    let segment = 0;
    for (let day = from; day <= today;) {
      const next = [shiftDay(day, WINDOW_DAYS), shiftDay(today, 1)].sort()[0];
      segment += 1;
      advance(`读取订单报告 ${segment}/${segments}（${day} 起）`, true);
      const end = new Date(Math.min(pacificMidnight(next).getTime(), now().getTime() - REPORT_LAG_MS));
      // 只留落在这一段日期里的行,和相邻一段的整天替换互不干扰
      const lines = (await fetchOrderLines(account, pacificMidnight(day), end, gateway, onReport))
        .filter((line) => line.day >= day && line.day < next);
      replaceDailySales(day, next, aggregateDailySales(lines, priceBySku));
      orderLines += lines.length;
      // 每段写完就记下覆盖范围,回填中途失败下次从断点继续
      const covered = { from: coverage?.from && coverage.from < from ? coverage.from : from, to: shiftDay(next, -1) };
      stateUpsert.run('sales_coverage', JSON.stringify(covered));
      day = next;
    }
    let fees = null;
    if (withFees) {
      advance('读取 FBA 费用', true);
      fees = await syncFees(account, gateway, now, onReport);
    }
    const result = { today, from, listings: listings.length, inventorySkus: inventory.length, orderLines,
      skuAdded: library.added, skuUpdated: library.updated, feeSkus: fees,
      newOutOfStock: stockSync?.outCount ?? 0, restocked: stockSync?.restockCount ?? 0 };
    db.transaction(() => {
      stateUpsert.run('last_success', JSON.stringify({ ...result, startedAt, completedAt: now().toISOString() }));
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='last_error'").run();
    })();
    if (actorId) audit(actorId, 'US', 'sync', 'pet_price_strategy', null, result);
    return result;
  } catch (error) {
    const message = `${stage}：${String(error.message)}`.slice(0, 300);
    stateUpsert.run('last_error', JSON.stringify({ today, at: now().toISOString(), stage, message }));
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; progress = null; }
}

export function priceSyncStatus(env = process.env) {
  const states = Object.fromEntries(db.prepare('SELECT key,value FROM pet_price_sync_state').all().map(({ key, value }) => [key, JSON.parse(value)]));
  const { account, issues } = petSpConfig(env);
  return { source: 'amazon', configured: !!account, issues, running, progress, today: pacificDay(new Date()),
    coverage: states.sales_coverage ?? null,
    lastSuccess: states.last_success?.completedAt ? states.last_success : null,
    lastAttempt: states.last_attempt ?? null, lastError: states.last_error ?? null,
    fees: { lastSuccess: states.fees_success ?? null, lastError: states.fees_error ?? null } };
}

const SYNC_EVERY_MS = 3 * 60 * 60_000;
/** 每 30 分钟检查一次:距上次成功满 3 小时就再同步,失败后 1 小时内不重试 */
export function startPriceSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = priceSyncStatus();
    const ago = (time) => (time ? Date.now() - Date.parse(time) : Infinity);
    if (!status.configured || running || ago(status.lastSuccess?.completedAt) < SYNC_EVERY_MS
      || ago(status.lastAttempt?.startedAt) < 60 * 60_000) return;
    try { await syncAmazonData(); } catch (error) { console.error('[price-sync]', error.message); }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
