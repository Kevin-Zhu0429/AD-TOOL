import { ABA_SKU_COLUMNS } from '../../../shared/abaSkuLibrary.js';
import { normRow } from '../skuLib.js';

function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
export function abaSkuStatus(db) {
  const state = db.prepare('SELECT * FROM aba_sku_library WHERE id=1').get();
  return { enabled: !!state?.enabled, updatedAt: state?.updated_at ?? null, filename: state?.filename ?? '',
    total: db.prepare('SELECT COUNT(*) n FROM aba_sku_items').get().n,
    countries: db.prepare('SELECT country, COUNT(*) count FROM aba_sku_items GROUP BY country ORDER BY country').all() };
}

export function prepareAbaSkus(db, input) {
  if (!Array.isArray(input) || !input.length || input.length > 50000) invalid('请选择包含 1–50,000 条记录的 SKU 表');
  const rows = [], seen = new Map(), errors = [];
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`第 ${i + 2} 行格式不正确`); return; }
    if (ABA_SKU_COLUMNS.some((c) => raw[c.key] != null && !['string', 'number'].includes(typeof raw[c.key]))) { errors.push(`第 ${i + 2} 行：字段只能填写文字或数字`); return; }
    if (ABA_SKU_COLUMNS.some((c) => String(raw[c.key] ?? '').trim().length > 120)) { errors.push(`第 ${i + 2} 行：字段长度不能超过 120 字符`); return; }
    const fields = Object.fromEntries(ABA_SKU_COLUMNS.map((c) => [c.key, raw[c.key]]));
    if (/^阿[联聯]酋(?:站)?$/.test(String(fields.country).trim())) fields.country = 'AE';
    const normalized = normRow(fields);
    if (normalized.error) { errors.push(`第 ${i + 2} 行：${normalized.error}`); return; }
    const r = normalized.row;
    if (!r.asin || !r.model || !r.brand) { errors.push(`第 ${i + 2} 行：品牌、ASIN 和墨盒型号都必须填写`); return; }
    const row = { country: r.country, brand: r.brand, brandKey: r.brand.toLowerCase(), sku: r.sku, skuKey: r.sku.toLowerCase(), asin: r.asin, model: r.model, setGroup: r.setGroup };
    const key = JSON.stringify([row.country, row.brandKey, row.skuKey]);
    const previous = seen.get(key);
    if (previous) {
      if (previous.asin !== row.asin || previous.model !== row.model || previous.setGroup !== row.setGroup)
        errors.push(`第 ${i + 2} 行：同国家、品牌、SKU 有冲突，请核对 ${row.country} / ${row.brand} / ${row.sku}`);
      return;
    }
    seen.set(key, row); rows.push(row);
  });
  if (errors.length) invalid(`整批未保存，共 ${errors.length} 处问题：${errors.slice(0, 20).join('；')}`);
  const existing = new Set(db.prepare('SELECT country, brand_key, sku_key FROM aba_sku_items').all().map((r) => JSON.stringify([r.country, r.brand_key, r.sku_key])));
  const updated = rows.filter((r) => existing.has(JSON.stringify([r.country, r.brandKey, r.skuKey]))).length;
  const countries = [...new Set(rows.map((r) => r.country))].sort();
  return { rows, summary: { added: rows.length - updated, updated, duplicates: input.length - rows.length,
    count: rows.length, countries, counts: countries.map((country) => ({ country, count: rows.filter((r) => r.country === country).length })) } };
}

export function importAbaSkus(db, { rows: input, userId, filename }) {
  return db.transaction(() => {
    const prepared = prepareAbaSkus(db, input);
    const save = db.prepare(`INSERT INTO aba_sku_items(country,brand,brand_key,sku,sku_key,asin,model,set_group)
      VALUES(@country,@brand,@brandKey,@sku,@skuKey,@asin,@model,@setGroup)
      ON CONFLICT(country,brand_key,sku_key) DO UPDATE SET brand=excluded.brand,sku=excluded.sku,
      asin=excluded.asin,model=excluded.model,set_group=excluded.set_group,updated_at=datetime('now')`);
    for (const row of prepared.rows) save.run(row);
    db.prepare(`INSERT INTO aba_sku_library(id,enabled,updated_at,filename,updated_by) VALUES(1,1,datetime('now'),?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=1,updated_at=excluded.updated_at,filename=excluded.filename,updated_by=excluded.updated_by`)
      .run(String(filename ?? '').slice(0, 255), userId);
    return { ...prepared.summary, library: abaSkuStatus(db) };
  })();
}
