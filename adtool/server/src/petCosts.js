// 宠物版 SKU 成本、亚马逊费用和单件毛利。
// 成本人工维护(导入或逐行改),FBA 配送费和佣金来自 Fee Preview 报告,售价来自 Listing。
import { db, audit } from './db.js';

// 亚马逊佣金每件最低 0.30 美元
const MIN_REFERRAL = 0.3;
export const COST_FIELDS = [['fob', 'fob', 'FOB'], ['firstLeg', 'first_leg', '头程'], ['duty', 'duty', '关税']];

const round = (value) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(2)));
const lower = (value) => String(value ?? '').trim().toLowerCase();

/** 单元格 -> 非负金额:空返回 null,不是数字返回 undefined(算错误)。认 $ 和千分位逗号 */
export function moneyCell(raw) {
  const text = String(raw ?? '').trim().replace(/[$,\s]/g, '');
  if (!text || text === '-') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(Number(text).toFixed(4));
}

/**
 * 单件毛利 = 售价 − 落地成本(FOB + 头程 + 关税) − FBA 配送费 − 佣金。
 * 佣金按报告里的费率乘当前售价;缺哪一项就在 missing 里写哪一项,毛利留空。
 */
export function unitProfit({ price, fob, firstLeg, duty, fbaFee, referralFee, referralRate }) {
  const parts = [fob, firstLeg, duty];
  const landedCost = parts.every((part) => part == null) ? null : round(parts.reduce((sum, part) => sum + (part ?? 0), 0));
  const referral = price && referralRate != null ? Math.max(MIN_REFERRAL, price * referralRate) : referralFee ?? null;
  const missing = [];
  if (landedCost == null) missing.push('成本');
  if (fbaFee == null) missing.push('FBA 费');
  if (referral == null) missing.push('佣金');
  if (!price) missing.push('售价');
  const profit = missing.length ? null : round(price - landedCost - fbaFee - referral);
  // 保本价:售价刚好覆盖成本、FBA 费和按费率算的佣金
  const rate = referralRate ?? (referralFee != null && price ? referralFee / price : null);
  const breakEven = landedCost != null && fbaFee != null && rate != null && rate < 1
    ? round(Math.max((landedCost + fbaFee) / (1 - rate), landedCost + fbaFee + MIN_REFERRAL)) : null;
  return { landedCost, referralFee: round(referral), profit, margin: profit != null ? round(profit / price * 100) : null, breakEven, missing };
}

/** 给 SKU 行挂上成本、费用、售价和毛利。rows 至少要有 sku */
export function withProfit(rows) {
  const costs = new Map(db.prepare('SELECT * FROM pet_sku_costs').all().map((row) => [lower(row.sku), row]));
  const fees = new Map(db.prepare('SELECT * FROM pet_sku_fees').all().map((row) => [lower(row.sku), row]));
  const prices = new Map(db.prepare('SELECT sku, price FROM pet_listing_cache').all().map((row) => [lower(row.sku), row.price]));
  return rows.map((row) => {
    const key = lower(row.sku);
    const cost = costs.get(key) ?? {};
    const fee = fees.get(key) ?? {};
    const price = row.price ?? prices.get(key) ?? null;
    const input = { price, fob: cost.fob ?? null, firstLeg: cost.first_leg ?? null, duty: cost.duty ?? null,
      fbaFee: fee.fba_fee ?? null, referralFee: fee.referral_fee ?? null, referralRate: fee.referral_rate ?? null };
    return { ...row, ...input, ...unitProfit(input), feeUpdatedAt: fee.updated_at ?? null, costUpdatedAt: cost.updated_at ?? null };
  });
}

/** Fee Preview 结果写库:报告里有的 SKU 覆盖,没有的保留上次的值 */
export function saveFees(fees) {
  const upsert = db.prepare(`INSERT INTO pet_sku_fees(sku,asin,fba_fee,referral_fee,referral_rate,fee_price,size_tier)
    VALUES(@sku,@asin,@fbaFee,@referralFee,@referralRate,@price,@sizeTier)
    ON CONFLICT(sku) DO UPDATE SET asin=excluded.asin, fba_fee=excluded.fba_fee, referral_fee=excluded.referral_fee,
      referral_rate=excluded.referral_rate, fee_price=excluded.fee_price, size_tier=excluded.size_tier,
      updated_at=datetime('now','localtime')`);
  db.transaction(() => { for (const fee of fees) upsert.run(fee); })();
  return fees.length;
}

/**
 * 批量写成本。每行 { sku, fob?, firstLeg?, duty? }:没带的字段不动,带了空值就清空。
 * 有一行不合法整批不写,返回前 20 条错误。
 */
export function saveCosts(actorId, rows) {
  const errors = [];
  const ok = new Map();
  rows.forEach((raw, index) => {
    const sku = String(raw?.sku ?? '').trim();
    const given = COST_FIELDS.filter(([key]) => Object.hasOwn(raw ?? {}, key));
    if (!sku && given.every(([key]) => !String(raw[key] ?? '').trim())) return;
    if (!sku) return errors.push(`第 ${index + 1} 行:SKU 不能为空`);
    const values = {};
    for (const [key, , label] of given) {
      const value = moneyCell(raw[key]);
      if (value === undefined) return errors.push(`第 ${index + 1} 行(${sku}):${label}「${String(raw[key]).slice(0, 12)}」不是有效金额`);
      values[key] = value;
    }
    ok.set(sku.toLowerCase(), { sku, values });
  });
  if (errors.length) return { saved: 0, unknown: [], errors: errors.slice(0, 20), errorCount: errors.length };

  const library = new Set(db.prepare("SELECT lower(sku) AS sku FROM sku_items WHERE country='US'").all().map((row) => row.sku));
  const current = db.prepare('SELECT * FROM pet_sku_costs WHERE sku=?');
  const upsert = db.prepare(`INSERT INTO pet_sku_costs(sku,fob,first_leg,duty,updated_by) VALUES(@sku,@fob,@first_leg,@duty,@actor)
    ON CONFLICT(sku) DO UPDATE SET fob=excluded.fob, first_leg=excluded.first_leg, duty=excluded.duty,
      updated_by=excluded.updated_by, updated_at=datetime('now','localtime')`);
  db.transaction(() => {
    for (const { sku, values } of ok.values()) {
      const before = current.get(sku) ?? {};
      const next = { sku: before.sku ?? sku, actor: actorId };
      for (const [key, column] of COST_FIELDS) next[column] = Object.hasOwn(values, key) ? values[key] : before[column] ?? null;
      upsert.run(next);
    }
  })();
  const unknown = [...ok.values()].filter(({ sku }) => !library.has(sku.toLowerCase())).map(({ sku }) => sku);
  if (ok.size) audit(actorId, 'US', 'import', 'pet_sku_costs', null, { saved: ok.size, unknown: unknown.length });
  return { saved: ok.size, unknown, errors: [], errorCount: 0 };
}
