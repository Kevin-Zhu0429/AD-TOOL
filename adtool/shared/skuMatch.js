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

/** 在库 + 在途都没有 = 缺货 */
export function isOutOfStock(it) {
  return !Number(it.stock) && !Number(it.transit);
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
