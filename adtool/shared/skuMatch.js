/**
 * SKU 库的前端小工具:型号归一 + 搜索。
 * 口径和后端 skuLib.js / 桌面版 model_key 保持一致 —— 输 301 能把 301XL 一起查出来。
 */

/** 型号比对键:301 / 301XL / 301 xl 归成同一个,PG-545 归到 545 */
export function modelKey(value) {
  const loose = String(value ?? '').toLowerCase().replace(/[^0-9a-z]+/g, '');
  const noXl = loose.replace(/xl$/, '') || loose;
  const m = noXl.match(/\d.*$/);
  return m ? m[0] : noXl;
}

/**
 * 挑 SKU 时的搜索:
 * 先按型号归一键精确命中(301 → 301XL 也算),再退回品牌 / 型号 / 套组 / SKU 的普通包含匹配。
 */
export function searchSkus(items, query) {
  const q = String(query ?? '').trim();
  if (!q) return items;

  const key = modelKey(q);
  const byModel = key ? items.filter((it) => modelKey(it.model) === key) : [];
  if (byModel.length) return byModel;

  const f = q.toLowerCase();
  return items.filter((it) =>
    ['brand', 'model', 'setGroup', 'sku'].some((k) => String(it[k] ?? '').toLowerCase().includes(f))
  );
}

/** 库存接口明确返回在库为 0；空值表示尚未提供库存，不能当作 0。 */
export function isZeroStock(it) {
  const value = it?.stock;
  return value !== null && value !== undefined && value !== '' && Number(value) === 0;
}

/** 在库明确为 0，且在途也没有可用数量 = 已断货。 */
export function isOutOfStock(it) {
  return isZeroStock(it) && !Number(it?.transit);
}

/** 船长同步后仍然成立的「新断货」：在库从有货变成 0，且现在还是 0。 */
export function isNewlyOutOfStock(it) {
  return it?.stockEvent?.kind === 'out';
}

/** 船长同步后仍然成立的「补货」：在库从 0 变成有货，且现在还有货。 */
export function isRestocked(it) {
  return it?.stockEvent?.kind === 'restock';
}

/** 变动日期显示成 MM-DD；后端时间是 `YYYY-MM-DD HH:MM:SS`。 */
export function stockEventDate(it) {
  return String(it?.stockEvent?.at ?? '').slice(5, 10);
}

/** SKU 比对忽略首尾空格和大小写，和后端判重口径一致。 */
export function skuKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** 为广告优化矩阵建立当前站点的库存索引。 */
export function buildSkuInventoryIndex(items) {
  const index = Object.create(null);
  for (const item of items ?? []) {
    const key = skuKey(item?.sku);
    if (key) index[key] = item;
  }
  return index;
}

/**
 * 汇总一个广告矩阵项关联的 SKU 库库存。
 * `zeroStockCount` 只统计明确返回 0 的在库值；未填写库存会落在 unknownCount。
 * `newOutCount` / `restockedCount` 是船长同步带来的、现在仍成立的新断货 / 补货数。
 */
export function summarizeSkuInventory(index, skus) {
  const keys = [...new Set((skus ?? []).map(skuKey).filter(Boolean))];
  const matched = [];
  let missingCount = 0;
  let unknownCount = 0;
  let zeroStockCount = 0;
  let newOutCount = 0;
  let restockedCount = 0;
  let stock = 0;
  let transit = 0;

  for (const key of keys) {
    const item = index?.[key];
    if (!item) {
      missingCount++;
      continue;
    }
    matched.push(item);
    if (item.stock === null || item.stock === undefined || item.stock === '') unknownCount++;
    else {
      stock += Number(item.stock) || 0;
      if (isZeroStock(item)) zeroStockCount++;
    }
    if (isNewlyOutOfStock(item)) newOutCount++;
    if (isRestocked(item)) restockedCount++;
    transit += Number(item.transit) || 0;
  }

  return {
    totalCount: keys.length,
    matchedCount: matched.length,
    missingCount,
    unknownCount,
    zeroStockCount,
    newOutCount,
    restockedCount,
    stock,
    transit,
    matched,
  };
}

/** 把挑好的 SKU 合进文本框:追加时按大小写不敏感去重 */
export function mergeSkuText(current, picked, mode) {
  const cur = mode === 'replace'
    ? []
    : String(current ?? '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const have = new Set(cur.map((s) => s.toLowerCase()));
  const add = [];
  for (const s of picked) {
    const k = s.toLowerCase();
    if (have.has(k)) continue;
    have.add(k);
    add.push(s);
  }
  return { text: [...cur, ...add].join('\n'), addedCount: add.length };
}
