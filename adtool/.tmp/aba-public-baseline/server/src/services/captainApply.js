// 库存同步:把从亚马逊拉回来的快照写库,再按分配关系回写 SKU 库存并记断货 / 补货。
// 调亚马逊 SP-API 是异步网络请求,留在主线程;这里的写库和汇总在 worker 线程里执行。
import { REGIONS } from '../libs.js';
import { recordStockChanges, snapshotStock } from '../stockEvents.js';

const EU_MARKETS = REGIONS.find((region) => region.id === 'EU')?.markets ?? [];
const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

const UPSERT_SNAPSHOT = (
  `INSERT INTO captain_inventory_snapshots
     (binding_id, sku_key, sku, asin, stock, transit, is_deleted)
   VALUES (@bindingId, @skuKey, @sku, @asin, @stock, @transit, @isDeleted)
   ON CONFLICT (binding_id, sku_key) DO UPDATE SET
     sku = excluded.sku, asin = COALESCE(excluded.asin, captain_inventory_snapshots.asin),
     stock = excluded.stock, transit = excluded.transit, is_deleted = excluded.is_deleted,
     updated_at = datetime('now', 'localtime')`
);

const UPDATE_SKU_COUNTRY = (
  `UPDATE sku_items SET
     stock = @stock, transit = @transit,
     asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
     updated_at = datetime('now', 'localtime')
   WHERE user_id = @userId AND country = @country
     AND lower(trim(COALESCE(brand, ''))) = @brandKey
     AND lower(trim(sku)) = @skuKey`
);

function applyAssignedSnapshots(db, userId = null) {
  const updateSkuCountry = db.prepare(UPDATE_SKU_COUNTRY);
  const assignments = db.prepare(
    `SELECT a.user_id, a.country, g.group_key, g.brand_key
       FROM captain_channel_assignments a
       JOIN captain_channel_groups g ON g.group_key = a.group_key
      WHERE a.enabled = 1 AND g.enabled = 1
        AND (? IS NULL OR a.user_id = ?)`
  ).all(userId, userId);
  const groupKeys = [...new Set(assignments.map((row) => row.group_key))];
  if (!groupKeys.length) return { updated: 0, unmatched: 0, inventorySkus: 0 };

  // 大陆欧洲的详细站点返回的是同一份共享 FBA 库存，不可把 DE/ES/FR/IT 再相加。
  // 每个店铺组、每个 SKU 只采用最近更新的一份快照；同秒更新时固定取较小 binding_id。
  const placeholders = groupKeys.map(() => '?').join(',');
  const snapshots = db.prepare(
    `SELECT g.group_key, g.brand_key, b.id AS binding_id,
            s.sku_key, s.asin, s.stock, s.transit, s.updated_at
       FROM captain_channel_groups g
       JOIN captain_channel_group_members m ON m.group_key = g.group_key
       JOIN captain_channel_bindings b ON b.open_channel_id = m.open_channel_id
       JOIN captain_inventory_snapshots s ON s.binding_id = b.id
      WHERE g.group_key IN (${placeholders}) AND b.enabled = 1
      ORDER BY s.updated_at DESC, b.id ASC`
  ).all(...groupKeys);
  const sharedSnapshots = new Map();
  for (const row of snapshots) {
    const key = `${row.group_key}\u0000${row.sku_key}`;
    if (!sharedSnapshots.has(key)) sharedSnapshots.set(key, row);
  }

  // 先按店铺组分好,每个分配只看自己组的快照(原来是每个分配都扫一遍全部快照)
  const snapshotsByGroup = new Map();
  for (const snapshot of sharedSnapshots.values()) {
    const list = snapshotsByGroup.get(snapshot.group_key) ?? [];
    list.push(snapshot);
    snapshotsByGroup.set(snapshot.group_key, list);
  }

  const totals = new Map();
  for (const assignment of assignments) {
    for (const snapshot of snapshotsByGroup.get(assignment.group_key) ?? []) {
      const key = `${assignment.user_id}\u0000${assignment.country}\u0000${assignment.group_key}\u0000${snapshot.sku_key}`;
      totals.set(key, {
        userId: assignment.user_id,
        country: assignment.country,
        brandKey: assignment.brand_key,
        skuKey: snapshot.sku_key,
        stock: intOf(snapshot.stock),
        transit: intOf(snapshot.transit),
        asin: snapshot.asin || null,
      });
    }
  }

  let updated = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const total of totals.values()) {
      const changes = updateSkuCountry.run({
        ...total,
        asin: total.asin,
      }).changes;
      updated += changes;
      if (!changes) unmatched += 1;
    }
  })();
  return { updated, unmatched, inventorySkus: totals.size };
}

function applyLegacySnapshots(db, userId) {
  const updateSkuCountry = db.prepare(UPDATE_SKU_COUNTRY);
  const snapshots = db.prepare(
    `SELECT b.id AS binding_id, b.brand_key, b.country,
            s.sku_key, s.asin, s.stock, s.transit, s.updated_at
       FROM captain_channel_bindings b
       JOIN captain_inventory_snapshots s ON s.binding_id = b.id
      WHERE b.user_id = ? AND b.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM captain_channel_group_members m
           WHERE m.open_channel_id = b.open_channel_id
        )
      ORDER BY s.updated_at DESC, b.id ASC`
  ).all(userId);
  const totals = new Map();
  for (const row of snapshots) {
    const scope = EU_MARKETS.includes(row.country) ? 'EU' : row.country;
    const key = `${row.brand_key}\u0000${scope}\u0000${row.sku_key}`;
    // 旧版绑定也可能保存了四个欧洲详细站点；它们是同一份共享库存，只取最近快照。
    if (scope === 'EU' && totals.has(key)) continue;
    const total = totals.get(key) ?? {
      brandKey: row.brand_key, scope, skuKey: row.sku_key, stock: 0, transit: 0, asins: new Set(),
    };
    total.stock = scope === 'EU' ? intOf(row.stock) : total.stock + intOf(row.stock);
    total.transit = scope === 'EU' ? intOf(row.transit) : total.transit + intOf(row.transit);
    if (row.asin) total.asins.add(row.asin);
    totals.set(key, total);
  }
  const updateEurope = db.prepare(
    `UPDATE sku_items SET stock = @stock, transit = @transit,
       asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
       updated_at = datetime('now', 'localtime')
     WHERE user_id = @userId
       AND country IN (${EU_MARKETS.map((country) => `'${country}'`).join(',')})
       AND lower(trim(COALESCE(brand, ''))) = @brandKey
       AND lower(trim(sku)) = @skuKey`
  );
  let updated = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const total of totals.values()) {
      const params = {
        userId, brandKey: total.brandKey, skuKey: total.skuKey,
        stock: total.stock, transit: total.transit,
        asin: total.asins.size === 1 ? [...total.asins][0] : null,
      };
      const changes = total.scope === 'EU'
        ? updateEurope.run(params).changes
        : updateSkuCountry.run({ ...params, country: total.scope }).changes;
      updated += changes;
      if (!changes) unmatched += 1;
    }
  })();
  return { updated, unmatched, inventorySkus: totals.size };
}

/** 写库存并记下这次同步的新断货 / 补货 */
export function applyAndTrackStock(db, userId) {
  const before = snapshotStock(db, userId);
  const applied = applyInventorySnapshots(db, userId);
  const stockSync = recordStockChanges(db, userId, before);
  return { ...applied, stockSync };
}

export function applyInventorySnapshots(db, userId) {
  const assigned = applyAssignedSnapshots(db, userId);
  const legacy = applyLegacySnapshots(db, userId);
  return {
    updated: assigned.updated + legacy.updated,
    unmatched: assigned.unmatched + legacy.unmatched,
    inventorySkus: assigned.inventorySkus + legacy.inventorySkus,
  };
}

/** 一个库存来源的快照 upsert + 同步状态,放在同一个事务里 */
export function saveSnapshots(db, { bindingId, items, now }) {
  const upsert = db.prepare(UPSERT_SNAPSHOT);
  const markOk = db.prepare(
    `UPDATE captain_channel_bindings SET last_sync_at = ?, last_sync_status = 'ok',
            last_sync_detail = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
  );
  db.transaction(() => {
    for (const item of items) upsert.run({ bindingId, ...item });
    markOk.run(now, `读取 ${items.length} 个 SKU`, bindingId);
  })();
}
