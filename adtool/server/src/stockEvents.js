/**
 * 库存同步前后的库存对比 —— 找出这次同步「新断货」和「补货」的 SKU。
 *
 * 口径只看 SKU 库的在库数量（API 同步时包含可用、运营中心转运和正在接收）:
 *   新断货 = 同步前在库 > 0,同步后在库 = 0
 *   补货   = 同步前在库 = 0,同步后在库 > 0
 * 同步前在库是空的(从没填过库存)不算变动,第一次同步不会把所有 0 库存都当成新断货。
 *
 * 事件保留在库里,SKU 库和广告优化按「账号 + 国家 + SKU」取最近一条还成立的变动:
 * 新断货后又补上了、补货后又卖断了,旧的那条就不再提示。
 */
// 函数都接收 db 参数:主线程和 worker 线程各用自己的连接

/** 变动在 SKU 库和广告优化里提示多少天 */
export const STOCK_EVENT_DAYS = 30;

const skuKeyOf = (value) => String(value ?? '').trim().toLowerCase();
const isKnown = (value) => value !== null && value !== undefined;

/** 同步前先把这个账号的库存拍一份,同步后拿来对比 */
export function snapshotStock(db, userId) {
  const rows = db.prepare(
    'SELECT id, stock, transit FROM sku_items WHERE user_id = ?'
  ).all(userId);
  return new Map(rows.map((row) => [row.id, row]));
}

/** 单行的变动类型;不算变动返回 null */
export function stockChangeKind(prevStock, stock) {
  if (!isKnown(prevStock) || !isKnown(stock)) return null;
  if (prevStock > 0 && stock === 0) return 'out';
  if (prevStock === 0 && stock > 0) return 'restock';
  return null;
}

function eventOut(row) {
  return {
    id: row.id,
    syncId: row.sync_id,
    kind: row.kind,
    country: row.country,
    brand: row.brand,
    model: row.model,
    setGroup: row.set_group,
    sku: row.sku,
    asin: row.asin,
    prevStock: row.prev_stock,
    prevTransit: row.prev_transit,
    stock: row.stock,
    transit: row.transit,
    at: row.created_at,
  };
}

/**
 * 同步写完 SKU 库之后调用:对比 before,记一条同步记录和每个变动。
 * 没有变动也记一条同步记录,页面才能告诉用户「这次同步没有新断货 / 补货」。
 */
export function recordStockChanges(db, userId, before) {
  const after = db.prepare(
    `SELECT id, country, brand, model, set_group, sku, asin, stock, transit
       FROM sku_items WHERE user_id = ?`
  ).all(userId);

  const changes = [];
  for (const row of after) {
    const prev = before.get(row.id);
    if (!prev) continue;
    const kind = stockChangeKind(prev.stock, row.stock);
    if (kind) changes.push({ ...row, kind, prev_stock: prev.stock, prev_transit: prev.transit });
  }
  const outCount = changes.filter((row) => row.kind === 'out').length;
  const restockCount = changes.length - outCount;

  const syncId = db.transaction(() => {
    const id = db.prepare(
      'INSERT INTO sku_stock_syncs (user_id, out_count, restock_count) VALUES (?, ?, ?)'
    ).run(userId, outCount, restockCount).lastInsertRowid;
    const insert = db.prepare(
      `INSERT INTO sku_stock_events
         (sync_id, user_id, country, brand, model, set_group, sku, sku_key, asin,
          kind, prev_stock, prev_transit, stock, transit)
       VALUES (@syncId, @userId, @country, @brand, @model, @set_group, @sku, @skuKey, @asin,
               @kind, @prev_stock, @prev_transit, @stock, @transit)`
    );
    for (const row of changes) {
      insert.run({ ...row, syncId: id, userId, skuKey: skuKeyOf(row.sku) });
    }
    return Number(id);
  })();

  return latestSync(db, userId, syncId);
}

/** 某次(默认最近一次)同步的结果:数量 + 变动明细 */
export function latestSync(db, userId, syncId = null) {
  const sync = syncId
    ? db.prepare('SELECT * FROM sku_stock_syncs WHERE id = ? AND user_id = ?').get(syncId, userId)
    : db.prepare('SELECT * FROM sku_stock_syncs WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  if (!sync) return null;
  const events = db.prepare(
    `SELECT * FROM sku_stock_events WHERE sync_id = ?
      ORDER BY kind, country, brand COLLATE NOCASE, model COLLATE NOCASE, sku COLLATE NOCASE`
  ).all(sync.id).map(eventOut);
  return {
    id: sync.id,
    at: sync.created_at,
    outCount: sync.out_count,
    restockCount: sync.restock_count,
    outOfStock: events.filter((event) => event.kind === 'out'),
    restocked: events.filter((event) => event.kind === 'restock'),
  };
}

/**
 * 给 SKU 库的行挂上 stockEvent:最近 STOCK_EVENT_DAYS 天内这个 SKU 最新的一条变动,
 * 且现在的库存还和它一致(新断货仍是 0 / 补货后仍 > 0),否则不挂。
 */
export function attachStockEvents(db, items, userIds) {
  const ids = [...new Set(userIds)].filter((id) => Number.isInteger(id));
  if (!items.length || !ids.length) return items;
  const rows = db.prepare(
    `SELECT * FROM sku_stock_events
      WHERE user_id IN (${ids.map(() => '?').join(',')})
        AND created_at >= datetime('now', 'localtime', ?)
      ORDER BY id DESC`
  ).all(...ids, `-${STOCK_EVENT_DAYS} days`);
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.user_id}\u0000${row.country}\u0000${row.sku_key}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return items.map((item) => {
    const row = latest.get(`${item.user_id}\u0000${item.country}\u0000${skuKeyOf(item.sku)}`);
    const valid = row && isKnown(item.stock)
      && (row.kind === 'out' ? item.stock === 0 : item.stock > 0);
    return valid
      ? { ...item, stockEvent: { kind: row.kind, at: row.created_at, prevStock: row.prev_stock, syncId: row.sync_id } }
      : item;
  });
}
