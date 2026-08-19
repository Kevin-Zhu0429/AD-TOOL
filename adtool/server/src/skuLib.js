/**
 * SKU 库的口径定义 —— 前后端共用这一份,前端开页面时从 /api/sku 连数据一起拿走。
 *
 * 和否定词库不一样:SKU 库**每个账号各存各的**,谁传的谁看得见,互相不干扰,
 * 大家只传自己负责的品牌。模板列:
 *
 *   国家 | 品牌 | 型号 | 套组 | SKU | 在库库存 | 在途库存
 *
 * 开广告时(自动 / 手动都一样)在「投放 SKU」那里点「从 SKU 库选」,
 * 按当前站点 + 型号筛出 SKU 勾选填入。
 */
import { MARKETPLACES } from './libs.js';

export const SKU_COLS = [
  { key: 'country', label: '国家', required: true, width: 8, hint: '站点码,ES / DE / US…,写「西班牙」也认' },
  { key: 'brand', label: '品牌', width: 14, hint: '自己负责的品牌,挑 SKU 时可以按它筛' },
  { key: 'model', label: '型号', width: 14, hint: '填 301 即可,查的时候 301 和 301XL 归到一起' },
  { key: 'setGroup', label: '套组', width: 14, hint: '如 1黑 / 1黑1彩 / 2黑2彩,方便挑要投的那几个' },
  { key: 'sku', label: 'SKU', required: true, width: 28, hint: '后台实际 SKU,一行一个' },
  { key: 'stock', label: '在库库存', num: true, width: 10, hint: '选填,挑 SKU 时会显示,缺货一眼看得出' },
  { key: 'transit', label: '在途库存', num: true, width: 10, hint: '选填,在途 / 补货中数量' },
];

export const SKU_KEYS = SKU_COLS.map((c) => c.key);
export const SKU_MAX_LEN = 120;

/** 中文国家名 -> 站点码,粘贴过来的表经常写中文 */
const COUNTRY_ALIAS = {
  西班牙: 'ES', 德国: 'DE', 法国: 'FR', 意大利: 'IT',
  英国: 'UK', 英國: 'UK', GB: 'UK',
  美国: 'US', 美國: 'US', 加拿大: 'CA',
  澳洲: 'AU', 澳大利亚: 'AU', 澳州: 'AU',
};

export function cleanCell(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

/** 「ES 站」「西班牙」都归成 ES;认不出返回 null */
export function normCountry(raw) {
  const v = cleanCell(raw).replace(/\s*(站|site)$/i, '').trim();
  if (!v) return null;
  const up = v.toUpperCase();
  if (MARKETPLACES.includes(up)) return up;
  return COUNTRY_ALIAS[v] ?? COUNTRY_ALIAS[up] ?? null;
}

/** 库存单元格 -> 非负整数;空返回 null,写了但不是数字返回 undefined(算错误) */
export function normStock(raw) {
  const v = cleanCell(raw).replace(/,/g, '');
  if (!v || v === '-') return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
  return Math.round(Number(v));
}

/**
 * 型号比对键:301 / 301XL / 301 xl 归成同一个,PG-545 归到 545。
 * 和桌面版 model_key 一个口径,所以运营输 301 就能把 301XL 的 SKU 一起查出来。
 */
export function modelKey(value) {
  const loose = String(value ?? '').toLowerCase().replace(/[^0-9a-z]+/g, '');
  const noXl = loose.replace(/xl$/, '') || loose;
  const m = noXl.match(/\d.*$/);
  return m ? m[0] : noXl;
}

/** 校验并规整一行。返回 { row } 或 { error } */
export function normRow(input) {
  const country = normCountry(input?.country);
  if (!country) {
    const got = cleanCell(input?.country);
    return { error: got ? `国家「${got.slice(0, 12)}」不认识,填 ES / DE / US 这种站点码` : '国家不能为空' };
  }
  const sku = cleanCell(input?.sku);
  if (!sku) return { error: 'SKU 不能为空' };
  if (sku.length > SKU_MAX_LEN) return { error: `SKU 过长:${sku.slice(0, 20)}…` };

  const stock = normStock(input?.stock);
  if (stock === undefined) return { error: `在库库存要填数字:${cleanCell(input?.stock).slice(0, 12)}` };
  const transit = normStock(input?.transit);
  if (transit === undefined) return { error: `在途库存要填数字:${cleanCell(input?.transit).slice(0, 12)}` };

  const row = {
    country,
    brand: cleanCell(input?.brand).slice(0, SKU_MAX_LEN) || null,
    model: cleanCell(input?.model).slice(0, SKU_MAX_LEN) || null,
    setGroup: cleanCell(input?.setGroup ?? input?.set_group).slice(0, SKU_MAX_LEN) || null,
    sku,
    stock,
    transit,
  };
  return { row };
}

/** 判重键:同一个账号、同一个国家里,同一个 SKU 只留一条 */
export function dedupeKey(row) {
  return `${row.country}|${String(row.sku).toLowerCase()}`;
}
