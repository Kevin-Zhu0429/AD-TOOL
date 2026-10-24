// 宠物版仓储费板块:三份亚马逊报告
//   GET_FBA_INVENTORY_PLANNING_DATA                  库存规划(库存健康):每个 SKU 的库龄分段、下次超龄附加费预估、下月仓储费预估、动销
//   GET_FBA_STORAGE_FEE_CHARGES_DATA                 月度仓储费:按月、按 ASIN/FNSKU、按仓库的实际仓储费(没有 SKU,用 FNSKU 对回)
//   GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA  已收的超龄库存附加费:每月 15 号前后按库龄收
// 在库 / 在途沿用全站口径(SKU 库同步的数):在库 = 可用 + FC 转运 + 正在接收,在途 = 处理中 + 已发货。
// 报告列名亚马逊改过好几次,解析时统一成小写、连字符,超龄段、库龄段按列名规律识别,不写死。
import express from 'express';
import { db } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, pacificMidnight, petSpConfig, runReport, shiftDay } from './petAmazon.js';

const PLANNING_REPORT = 'GET_FBA_INVENTORY_PLANNING_DATA';
const FEES_REPORT = 'GET_FBA_STORAGE_FEE_CHARGES_DATA';
const AGED_REPORT = 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA';
// 第一次回填几个月的仓储费和超龄附加费;之后每次重拉最近 REFRESH_MONTHS 个月(上月仓储费要到本月中旬才出)
export const BACKFILL_MONTHS = 6;
const REFRESH_MONTHS = 2;
// 自动同步:库存规划报告亚马逊每天更新一次,上次成功超过 24 小时就再拉;失败后 6 小时再试
const REFRESH_EVERY_MS = 24 * 60 * 60_000;
const RETRY_AFTER_ERROR_MS = 6 * 60 * 60_000;
// 91~180 天的货按近 30 天卖速多少天卖不完就提醒(再过这么久会进 181 天)
const AGING_WARN_DAYS = 90;

const clean = (value) => String(value ?? '').trim();
const lower = (value) => clean(value).toLowerCase();
const num = (value) => {
  const text = clean(value).replace(/[$,]/g, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};
const int = (value) => Math.max(0, Math.round(num(value) ?? 0));
const money = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

/** 报告行的列名统一成小写连字符:month_of_charge / Month Of Charge -> month-of-charge */
export function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [lower(key).replace(/[\s_]+/g, '-'), clean(value)]));
}

// ---------- 月份 ----------

export const monthOf = (day) => clean(day).slice(0, 7);
export function shiftMonth(month, by) {
  const [year, mon] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}
const monthStart = (month) => `${month}-01`;
const monthEnd = (month) => shiftDay(monthStart(shiftMonth(month, 1)), -1);

// ---------- 库存规划报告 ----------

/** 库龄列 inv-age-0-to-90-days / inv-age-365-plus-days -> { from, to } */
function ageColumns(row) {
  const columns = [];
  for (const [key, value] of Object.entries(row)) {
    const match = /^inv-age-(\d+)-(?:to-(\d+)|plus)-days$/.exec(key);
    if (match) columns.push({ from: Number(match[1]), to: match[2] ? Number(match[2]) : null, quantity: int(value) });
  }
  return columns;
}

/**
 * 库龄归成四段:0–90、91–180、181–365、365 天以上。
 * 报告里新旧两套分段同时存在(0-90 和 0-30/31-60/61-90,181-270 和 181-330 等),每段挑能正好拼满的那组列。
 */
export function ageBuckets(row) {
  const columns = ageColumns(row);
  const pick = (from, to) => {
    // 先找正好覆盖这段的单列,再找能首尾相接拼满的几列
    const exact = columns.find((column) => column.from === from && column.to === to);
    if (exact) return exact.quantity;
    let total = 0, at = from, guard = 0;
    while (at <= to && guard++ < 20) {
      const next = columns.filter((column) => column.from === at && column.to != null && column.to <= to).sort((a, b) => b.to - a.to)[0];
      if (!next) return null;
      total += next.quantity; at = next.to + 1;
    }
    return total;
  };
  const plus = columns.find((column) => column.from === 365 && column.to == null) ?? columns.find((column) => column.from === 366 && column.to == null);
  return {
    d0_90: pick(0, 90) ?? 0,
    d91_180: pick(91, 180) ?? 0,
    d181_365: pick(181, 365) ?? ((pick(181, 270) ?? 0) + (pick(271, 365) ?? 0)),
    d365plus: plus?.quantity ?? 0,
  };
}

/** 超龄附加费分段:quantity-to-be-charged-ais-181-210-days + estimated-ais-181-210-days */
export function aisTiers(row) {
  const tiers = new Map();
  for (const [key, value] of Object.entries(row)) {
    const match = /^(quantity-to-be-charged|estimated)-ais-(\d+)-(\d+|plus)-days$/.exec(key);
    if (!match) continue;
    const tier = `${match[2]}-${match[3]}`;
    const item = tiers.get(tier) ?? { tier, from: Number(match[2]), label: match[3] === 'plus' ? `${match[2]} 天以上` : `${match[2]}–${match[3]} 天`, quantity: 0, fee: 0 };
    if (match[1] === 'estimated') item.fee = money(num(value) ?? 0);
    else item.quantity = int(value);
    tiers.set(tier, item);
  }
  return [...tiers.values()].filter((item) => item.quantity || item.fee).sort((a, b) => a.from - b.from)
    .map(({ from, ...rest }) => rest);
}

/** 库存规划报告一行 -> 存库的对象 */
export function planningFromReport(raw) {
  const row = normalizeRow(raw);
  const sku = clean(row.sku);
  if (!sku) return null;
  const tiers = aisTiers(row);
  // 老版报告没有分段,只有 estimated-ltsf-next-charge
  const aisFee = tiers.length ? tiers.reduce((sum, item) => sum + item.fee, 0) : num(row['estimated-ltsf-next-charge']) ?? 0;
  const pick = (...keys) => keys.map((key) => row[key]).find((value) => clean(value) !== '');
  return {
    sku, asin: clean(row.asin).toUpperCase() || null, fnsku: clean(row.fnsku) || null,
    snapshotDate: clean(row['snapshot-date']).slice(0, 10) || null, productName: clean(row['product-name']) || null,
    available: int(row.available), reserved: int(pick('total-reserved-quantity', 'reserved-quantity')),
    unfulfillable: int(row['unfulfillable-quantity']), pendingRemoval: int(row['pending-removal-quantity']),
    inbound: int(row['inbound-quantity']),
    ages: ageBuckets(row), aisTiers: tiers, aisFee: money(aisFee),
    aisUnits: tiers.reduce((sum, item) => sum + item.quantity, 0),
    storageNextMonth: money(num(row['estimated-storage-cost-next-month'])),
    shipped7: int(row['units-shipped-t7']), shipped30: int(row['units-shipped-t30']), shipped90: int(row['units-shipped-t90']),
    daysOfSupply: num(pick('days-of-supply', 'total-days-of-supply-(including-units-from-open-shipments)')),
    sellThrough: num(row['sell-through']),
    excess: int(row['estimated-excess-quantity']),
    health: clean(row['fba-inventory-level-health-status']) || null,
    alert: clean(row.alert) || null,
    recommendedAction: clean(row['recommended-action']) || null,
    recommendedRemoval: int(row['recommended-removal-quantity']),
    itemVolume: num(row['item-volume']), volumeUnit: clean(row['volume-unit-measure']) || null,
    storageType: clean(row['storage-type']) || null, storageVolume: num(row['storage-volume']),
    price: num(pick('your-price', 'sales-price')),
  };
}

// ---------- 月度仓储费报告 ----------

export function storageFeeFromReport(raw) {
  const row = normalizeRow(raw);
  const asin = clean(row.asin).toUpperCase();
  const fnsku = clean(row.fnsku);
  if (!asin && !fnsku) return null;
  const country = clean(row['country-code']).toUpperCase();
  if (country && country !== 'US') return null;
  const month = /^\d{4}-\d{2}/.exec(clean(row['month-of-charge']))?.[0] ?? null;
  return { month, asin: asin || null, fnsku: fnsku || null, fulfillmentCenter: clean(row['fulfillment-center']) || null,
    sizeTier: clean(row['product-size-tier']) || null, avgQuantity: num(row['average-quantity-on-hand']) ?? 0,
    itemVolume: num(row['item-volume']), volumeUnits: clean(row['volume-units']) || null,
    totalVolume: num(row['estimated-total-item-volume']), baseRate: num(row['base-rate']),
    surchargeRate: num(row['utilization-surcharge-rate']), utilizationRatio: num(row['storage-utilization-ratio']),
    fee: num(row['estimated-monthly-storage-fee']) ?? 0, incentiveFee: num(row['total-incentive-fee-amount']) };
}

// ---------- 已收超龄附加费报告 ----------

export function agedChargeFromReport(raw) {
  const row = normalizeRow(raw);
  const sku = clean(row.sku);
  const fnsku = clean(row.fnsku);
  if (!sku && !fnsku) return null;
  const country = clean(row.country).toUpperCase();
  if (country && country !== 'US') return null;
  // 新版一行一个库龄段(qty-charged / amount-charged / surcharge-age-tier);老版是 6 个月 / 12 个月两组列
  const sumOf = (pattern) => Object.entries(row).filter(([key]) => pattern.test(key)).reduce((sum, [, value]) => sum + (num(value) ?? 0), 0);
  const quantity = row['qty-charged'] != null ? int(row['qty-charged']) : Math.round(sumOf(/^qty-charged-.*storage-fee$/));
  const amount = row['amount-charged'] != null ? num(row['amount-charged']) ?? 0 : sumOf(/^amount-charged-.*storage-fee$/);
  const snapshotDate = clean(row['snapshot-date']).slice(0, 10) || null;
  return { snapshotDate, sku: sku || null, fnsku: fnsku || null, asin: clean(row.asin).toUpperCase() || null,
    quantity, amount: money(amount) ?? 0, ageTier: clean(row['surcharge-age-tier']) || null,
    rate: num(row['rate-surcharge']), volume: num(row['per-unit-volume']) };
}

// ---------- 同步 ----------

const state = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));

/** 这次要拉的月份(新的在前):最近 REFRESH_MONTHS 个月,加上回填范围里还没拉成功过的月份 */
export function monthsToFetch(firstMonth, done = [], backfill = BACKFILL_MONTHS) {
  const months = [];
  for (let index = 0; index < backfill; index += 1) {
    const month = shiftMonth(firstMonth, -index);
    if (index < REFRESH_MONTHS || !done.includes(month)) months.push(month);
  }
  return months;
}

function savePlanning(rows) {
  const insert = db.prepare(`INSERT OR REPLACE INTO pet_storage_inventory (sku, asin, fnsku, snapshot_date, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`);
  db.transaction(() => {
    db.prepare('DELETE FROM pet_storage_inventory').run();
    for (const row of rows) insert.run(row.sku, row.asin, row.fnsku, row.snapshotDate, JSON.stringify(row));
  })();
  return rows.length;
}

function saveFees(month, rows) {
  const insert = db.prepare(`INSERT INTO pet_storage_fees (month, asin, fnsku, fulfillment_center, size_tier, avg_quantity, item_volume, volume_units,
    total_volume, base_rate, surcharge_rate, utilization_ratio, fee, incentive_fee) VALUES (@month, @asin, @fnsku, @fulfillmentCenter, @sizeTier,
    @avgQuantity, @itemVolume, @volumeUnits, @totalVolume, @baseRate, @surchargeRate, @utilizationRatio, @fee, @incentiveFee)`);
  let saved = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM pet_storage_fees WHERE month=?').run(month);
    for (const row of rows) {
      // 报告按时间段取,month-of-charge 是哪个月就记哪个月;没有这列的记到申请的月份
      const target = row.month ?? month;
      if (target !== month) continue;
      insert.run({ ...row, month });
      saved += 1;
    }
  })();
  return saved;
}

function saveAged(month, rows) {
  const insert = db.prepare(`INSERT INTO pet_storage_aged_charges (month, snapshot_date, sku, fnsku, asin, quantity, amount, age_tier, rate, volume)
    VALUES (@month, @snapshotDate, @sku, @fnsku, @asin, @quantity, @amount, @ageTier, @rate, @volume)`);
  let saved = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM pet_storage_aged_charges WHERE month=?').run(month);
    for (const row of rows) {
      if (row.snapshotDate && monthOf(row.snapshotDate) !== month) continue;
      if (!row.quantity && !row.amount) continue;
      insert.run({ ...row, month });
      saved += 1;
    }
  })();
  return saved;
}

function friendly(error) {
  if (error?.upstreamStatus === 403) {
    return '亚马逊拒绝了这份报告（403）：SP-API 应用需要「亚马逊物流」(Amazon Fulfillment) 角色，加上后要重新授权换新的 refresh token';
  }
  return String(error?.message ?? error);
}

let running = false;
let progress = null;

/**
 * 拉一轮:库存规划报告(当前快照)→ 月度仓储费(最近几个月)→ 已收超龄附加费(最近几个月)。
 * 三部分各自出错不影响其它部分;有出错的记到 lastError,页面上显示。
 */
export async function syncStorage({ backfill = BACKFILL_MONTHS } = {}, gateway = amazonGateway, env = process.env, today = todayOf(), now = new Date()) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('仓储费报告正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  running = true;
  const startedAt = new Date().toISOString();
  setState('storage_last_attempt', { startedAt });
  const span = Math.max(REFRESH_MONTHS, Math.min(18, Number(backfill) || BACKFILL_MONTHS));
  const thisMonth = monthOf(today);
  // 仓储费:本月的还没出,从上个月往前;超龄附加费:本月 15 号收过就有,从本月往前
  const feeMonths = monthsToFetch(shiftMonth(thisMonth, -1), state('storage_fee_months') ?? [], span);
  const agedMonths = monthsToFetch(thisMonth, state('storage_aged_months') ?? [], span);
  progress = { total: 1 + feeMonths.length + agedMonths.length, done: 0, step: null, stage: 'starting', retryAt: null };
  const onProgress = ({ stage, retryAt = null }) => Object.assign(progress, { stage, retryAt });
  const errors = [];
  const result = { planning: null, fees: {}, aged: {} };
  const windowOf = (month) => {
    const end = monthEnd(month) >= today ? new Date(now.getTime() - 5 * 60_000) : new Date(pacificMidnight(shiftDay(monthEnd(month), 1)).getTime() - 1000);
    return { start: pacificMidnight(monthStart(month)), end };
  };
  try {
    progress.step = '库存规划（库龄、超龄附加费预估）';
    try {
      const rows = await runReport(account, PLANNING_REPORT, { onProgress }, gateway);
      progress.stage = 'saving';
      result.planning = savePlanning(rows.map(planningFromReport).filter(Boolean));
    } catch (error) { errors.push(`库存规划报告：${friendly(error)}`); }
    progress.done += 1;

    const doneFees = new Set(state('storage_fee_months') ?? []);
    for (const month of feeMonths) {
      progress.step = `${month} 月度仓储费`;
      try {
        const rows = await runReport(account, FEES_REPORT, { ...windowOf(month), onProgress }, gateway);
        progress.stage = 'saving';
        result.fees[month] = saveFees(month, rows.map(storageFeeFromReport).filter(Boolean));
        doneFees.add(month);
      } catch (error) { errors.push(`${month} 月度仓储费：${friendly(error)}`); }
      progress.done += 1;
    }
    setState('storage_fee_months', [...doneFees].sort().slice(-24));

    const doneAged = new Set(state('storage_aged_months') ?? []);
    for (const month of agedMonths) {
      progress.step = `${month} 超龄附加费`;
      try {
        const rows = await runReport(account, AGED_REPORT, { ...windowOf(month), onProgress }, gateway);
        progress.stage = 'saving';
        result.aged[month] = saveAged(month, rows.map(agedChargeFromReport).filter(Boolean));
        // 本月 15 号之前还没收,不算拉完
        if (month < thisMonth || today.slice(8) > '16') doneAged.add(month);
      } catch (error) { errors.push(`${month} 超龄附加费：${friendly(error)}`); }
      progress.done += 1;
    }
    setState('storage_aged_months', [...doneAged].sort().slice(-24));

    const summary = { ...result, errors, startedAt, completedAt: new Date().toISOString() };
    db.transaction(() => {
      if (result.planning != null || Object.keys(result.fees).length || Object.keys(result.aged).length) setState('storage_last_success', summary);
      if (errors.length) setState('storage_last_error', { at: summary.completedAt, message: errors.join('；').slice(0, 600) });
      else db.prepare("DELETE FROM pet_price_sync_state WHERE key='storage_last_error'").run();
    })();
    if (errors.length && result.planning == null && !Object.keys(result.fees).length && !Object.keys(result.aged).length) {
      throw new Error(errors[0]);
    }
    return summary;
  } catch (error) {
    const message = String(error.message).slice(0, 600);
    setState('storage_last_error', { at: new Date().toISOString(), message });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; progress = null; }
}

export function storageSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  return { configured: !!account, issues, running, progress,
    lastSuccess: state('storage_last_success'), lastAttempt: state('storage_last_attempt'), lastError: state('storage_last_error') };
}

/** 每小时看一次:24 小时没成功同步过就拉一轮;失败后 6 小时内不自动重试 */
export function startStorageSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = storageSyncStatus();
    if (!status.configured || running) return;
    const failedAt = status.lastError ? Date.parse(status.lastError.at) : 0;
    const okAt = status.lastSuccess ? Date.parse(status.lastSuccess.completedAt) : 0;
    if (failedAt > okAt && Date.now() - failedAt < RETRY_AFTER_ERROR_MS) return;
    if (Date.now() - okAt < REFRESH_EVERY_MS) return;
    try { await syncStorage(); } catch (error) { console.error('[storage-sync]', error.message); }
  };
  setTimeout(run, 15 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

// ---------- 看板 ----------

const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' ') || row.sku;
const sumBy = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
const HEALTH = { Healthy: '健康', Excess: '冗余', 'Low stock': '库存不足', 'Out of stock': '断货', Aging: '库龄偏长' };
const ACTION = {
  'No action required': '无需处理', 'Create removal order': '建议移除', 'Create a sale': '建议做促销', 'Reduce price': '建议降价',
  'Restock': '建议补货', 'Create Removal Order': '建议移除', 'Create Sale': '建议做促销', 'Reduce Price': '建议降价',
};
const actionLabel = (value) => (value ? ACTION[value] ?? value : null);
const healthLabel = (value) => (value ? HEALTH[value] ?? value : null);

/** 规则提醒:每条 { level, title, detail, sku? } */
export function storageFindings(rows, totals, today) {
  const findings = [];
  const ais = rows.filter((row) => row.aisFee > 0 || row.aged181 > 0).sort((a, b) => b.aisFee - a.aisFee || b.aged181 - a.aged181);
  if (ais.length) {
    findings.push({ level: 'high', title: `${ais.length} 个 SKU 有超过 180 天的库存，共 ${totals.aged181} 件，下次预计收超龄附加费 $${totals.aisFee.toFixed(2)}`,
      detail: '亚马逊每月 15 号前后按当天库龄收一次，库龄越长单价越高。按金额从大到小：'
        + ais.slice(0, 6).map((row) => `${nameOf(row)}（${row.aged181} 件，$${(row.aisFee ?? 0).toFixed(2)}，近 30 天卖 ${row.sold30} 件）`).join('、')
        + '。处理办法：降价/做促销、站外清货，卖不动的提移除或弃置（移除费通常比连续几个月的附加费便宜）。' });
  }
  // 91–180 天的货按现在的卖速卖不完,再过几个月就进超龄
  const aging = rows.filter((row) => row.aged91 > 0 && (row.sold30 === 0 || row.aged91 / (row.sold30 / 30) > AGING_WARN_DAYS))
    .sort((a, b) => b.aged91 - a.aged91);
  if (aging.length) {
    findings.push({ level: 'medium', title: `${aging.length} 个 SKU 有 91–180 天的库存按现在的卖速 3 个月内卖不完，共 ${sumBy(aging, 'aged91')} 件`,
      detail: aging.slice(0, 6).map((row) => `${nameOf(row)} ${row.aged91} 件（近 30 天卖 ${row.sold30} 件）`).join('、')
        + '。这些货会陆续超过 180 天开始收超龄附加费：先停补这些 SKU，加点广告或做促销把老库存先卖掉。' });
  }
  const excess = rows.filter((row) => row.excess > 0).sort((a, b) => b.excess - a.excess);
  if (excess.length) {
    findings.push({ level: 'medium', title: `亚马逊判定 ${excess.length} 个 SKU 库存冗余，共 ${sumBy(excess, 'excess')} 件`,
      detail: excess.slice(0, 6).map((row) => `${nameOf(row)} ${row.excess} 件`).join('、') + '。冗余库存会占库容上限，补货时这些 SKU 先少发或不发。' });
  }
  // 卖得少、仓储费摊到每件上很贵的
  const costly = rows.filter((row) => row.lastMonthFee >= 5 && row.feePerSold != null && row.feePerSold >= 2).sort((a, b) => b.feePerSold - a.feePerSold);
  if (costly.length) {
    findings.push({ level: 'low', title: `${costly.length} 个 SKU 上月仓储费摊到每件卖出超过 $2`,
      detail: costly.slice(0, 6).map((row) => `${nameOf(row)} $${row.feePerSold.toFixed(2)}/件（上月 $${row.lastMonthFee.toFixed(2)}）`).join('、')
        + '。货多卖得慢、体积大的 SKU 仓储费吃掉的毛利多，补货量按近 30 天卖速算，别一次发太多。' });
  }
  const month = Number(today.slice(5, 7));
  if (month >= 10 && month <= 12) {
    findings.push({ level: 'info', title: '10–12 月是旺季仓储费',
      detail: '这三个月的月度仓储费单价大约是 1–9 月的 2.5～3 倍，「下月仓储费预估」已经按旺季算。卖不动的大件这段时间少放在亚马逊仓库。' });
  }
  const levels = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.sort((a, b) => levels[a.level] - levels[b.level]);
}

/**
 * 仓储费看板:每个 SKU 的在库/在途、库龄分段、下次超龄附加费预估、下月仓储费预估、上月实际仓储费、近几个月已收超龄附加费;
 * 按款式汇总、按月汇总,并给出规则提醒。style / sku 只看这些。
 */
export function storageBoard({ style, sku, months = 6, today = todayOf() } = {}) {
  const span = Math.max(1, Math.min(18, Number(months) || 6));
  const planning = db.prepare('SELECT data_json FROM pet_storage_inventory').all().map((row) => JSON.parse(row.data_json));
  const planBySku = new Map(planning.map((row) => [lower(row.sku), row]));
  const directory = db.prepare("SELECT sku, asin, style, size, color, stock, transit FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID);
  const dirBySku = new Map(directory.map((row) => [lower(row.sku), row]));
  const detail = new Map(db.prepare('SELECT * FROM pet_inventory_detail').all().map((row) => [lower(row.sku), row]));

  // 仓储费报告没有 SKU:FNSKU 对回 SKU,没有 FNSKU 的用 ASIN(一个 ASIN 只有一个 SKU 时)
  const skuByFnsku = new Map(planning.filter((row) => row.fnsku).map((row) => [lower(row.fnsku), row.sku]));
  const asinSkus = new Map();
  for (const row of [...planning, ...directory]) {
    if (!row.asin) continue;
    const set = asinSkus.get(row.asin.toUpperCase()) ?? new Set();
    set.add(lower(row.sku)); asinSkus.set(row.asin.toUpperCase(), set);
  }
  const skuOfFee = (row) => {
    const byFnsku = row.fnsku && skuByFnsku.get(lower(row.fnsku));
    if (byFnsku) return lower(byFnsku);
    const set = row.asin ? asinSkus.get(row.asin.toUpperCase()) : null;
    return set?.size === 1 ? [...set][0] : null;
  };

  const thisMonth = monthOf(today);
  const firstMonth = shiftMonth(thisMonth, -(span - 1));
  const feeRows = db.prepare('SELECT * FROM pet_storage_fees WHERE month>=? ORDER BY month').all(shiftMonth(firstMonth, -1));
  const feeMonthsAvailable = [...new Set(feeRows.map((row) => row.month))].sort();
  const lastFeeMonth = feeMonthsAvailable.at(-1) ?? null;
  const agedRows = db.prepare('SELECT * FROM pet_storage_aged_charges WHERE month>=? ORDER BY month').all(firstMonth);

  const feeBySku = new Map(); // 上个有数据的月
  const unmatchedFee = { fee: 0, rows: 0 };
  for (const row of feeRows.filter((item) => item.month === lastFeeMonth)) {
    const key = skuOfFee(row);
    if (!key) { unmatchedFee.fee += row.fee; unmatchedFee.rows += 1; continue; }
    const item = feeBySku.get(key) ?? { fee: 0, avgQuantity: 0, sizeTier: row.size_tier, itemVolume: row.item_volume, volumeUnits: row.volume_units, baseRate: row.base_rate };
    item.fee += row.fee; item.avgQuantity += row.avg_quantity;
    feeBySku.set(key, item);
  }
  const agedBySku = new Map();
  for (const row of agedRows) {
    const key = row.sku ? lower(row.sku) : skuOfFee(row);
    if (!key) continue;
    const item = agedBySku.get(key) ?? { amount: 0, quantity: 0, months: new Set() };
    item.amount += row.amount; item.quantity += row.quantity; item.months.add(row.month);
    agedBySku.set(key, item);
  }

  // 近 30 天销量(订单报告口径,和全站一致);规划报告的 shipped30 作备用
  const salesFrom = shiftDay(today, -29);
  const sold30 = new Map(db.prepare('SELECT sku, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY lower(sku)')
    .all(salesFrom, today).map((row) => [lower(row.sku), row.units]));
  const soldLastFeeMonth = lastFeeMonth ? new Map(db.prepare('SELECT sku, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY lower(sku)')
    .all(monthStart(lastFeeMonth), monthEnd(lastFeeMonth)).map((row) => [lower(row.sku), row.units])) : new Map();
  const hasSales = db.prepare('SELECT 1 FROM pet_daily_sales WHERE day>=? LIMIT 1').get(salesFrom);

  const keys = new Set([...planBySku.keys(), ...directory.filter((row) => (row.stock ?? 0) > 0 || (row.transit ?? 0) > 0).map((row) => lower(row.sku)), ...feeBySku.keys(), ...agedBySku.keys()]);
  const wanted = (key) => {
    const item = dirBySku.get(key);
    return (!sku || key === lower(sku)) && (!style || lower(item?.style) === lower(style));
  };
  const rows = [...keys].filter(wanted).map((key) => {
    const plan = planBySku.get(key), dir = dirBySku.get(key), parts = detail.get(key), fee = feeBySku.get(key), aged = agedBySku.get(key);
    const ages = plan?.ages ?? { d0_90: 0, d91_180: 0, d181_365: 0, d365plus: 0 };
    const units30 = hasSales ? (sold30.get(key) ?? 0) : (plan?.shipped30 ?? 0);
    // 在库/在途用 SKU 库的数(全站同一口径);SKU 库里没有的用规划报告的可售 + 入库
    const stock = dir?.stock ?? (plan ? plan.available : 0);
    const transit = dir?.transit ?? (plan ? plan.inbound : 0);
    const soldInFeeMonth = soldLastFeeMonth.get(key) ?? 0;
    return {
      sku: dir?.sku ?? plan?.sku ?? key, asin: dir?.asin ?? plan?.asin ?? null, fnsku: plan?.fnsku ?? null,
      style: dir?.style ?? null, size: dir?.size ?? null, color: dir?.color ?? null, productName: plan?.productName ?? null,
      stock, transit, available: parts?.available ?? plan?.available ?? null, unfulfillable: plan?.unfulfillable ?? 0,
      ages, aged91: ages.d91_180, aged181: ages.d181_365 + ages.d365plus,
      aisTiers: plan?.aisTiers ?? [], aisFee: plan?.aisFee ?? 0, storageNextMonth: plan?.storageNextMonth ?? null,
      lastMonthFee: fee ? money(fee.fee) : null, lastMonthAvgQty: fee ? Math.round(fee.avgQuantity * 10) / 10 : null,
      feePerUnit: fee && fee.avgQuantity > 0 ? money(fee.fee / fee.avgQuantity) : null,
      feePerSold: fee && soldInFeeMonth > 0 ? money(fee.fee / soldInFeeMonth) : null,
      sizeTier: fee?.sizeTier ?? null, itemVolume: plan?.itemVolume ?? fee?.itemVolume ?? null, volumeUnit: plan?.volumeUnit ?? fee?.volumeUnits ?? null,
      agedCharged: aged ? money(aged.amount) : 0, agedChargedUnits: aged?.quantity ?? 0,
      sold30: units30, shipped90: plan?.shipped90 ?? null,
      stockDays: units30 > 0 ? Math.round(stock / (units30 / 30)) : null,
      excess: plan?.excess ?? 0, health: healthLabel(plan?.health), recommendedAction: actionLabel(plan?.recommendedAction),
      recommendedRemoval: plan?.recommendedRemoval ?? 0, inReport: !!plan,
    };
  }).sort((a, b) => b.aisFee - a.aisFee || b.aged181 - a.aged181 || (b.storageNextMonth ?? 0) - (a.storageNextMonth ?? 0) || b.stock - a.stock);

  const totals = {
    skus: rows.length, stock: sumBy(rows, 'stock'), transit: sumBy(rows, 'transit'),
    aged0: sumBy(rows.map((row) => row.ages), 'd0_90'), aged91: sumBy(rows, 'aged91'), aged181: sumBy(rows, 'aged181'),
    aged365: sumBy(rows.map((row) => row.ages), 'd365plus'),
    aisFee: money(sumBy(rows, 'aisFee')) ?? 0, aisSkus: rows.filter((row) => row.aisFee > 0 || row.aged181 > 0).length,
    storageNextMonth: money(sumBy(rows, 'storageNextMonth')) ?? 0,
    lastMonthFee: money(sumBy(rows, 'lastMonthFee') + (sku || style ? 0 : unmatchedFee.fee)) ?? 0, lastFeeMonth,
    agedCharged: money(sumBy(rows, 'agedCharged')) ?? 0, excess: sumBy(rows, 'excess'),
  };

  // 按款式
  const styleMap = new Map();
  for (const row of rows) {
    const name = row.style ?? '(SKU 库里没有款式)';
    const item = styleMap.get(name) ?? { style: name, skus: 0, stock: 0, transit: 0, aged91: 0, aged181: 0, aisFee: 0, storageNextMonth: 0, lastMonthFee: 0, agedCharged: 0, sold30: 0, sizes: [] };
    item.skus += 1; item.stock += row.stock; item.transit += row.transit; item.aged91 += row.aged91; item.aged181 += row.aged181;
    item.aisFee += row.aisFee; item.storageNextMonth += row.storageNextMonth ?? 0; item.lastMonthFee += row.lastMonthFee ?? 0;
    item.agedCharged += row.agedCharged; item.sold30 += row.sold30;
    if (row.aged181 > 0) item.sizes.push(`${[row.size, row.color].filter(Boolean).join(' ') || row.sku} ${row.aged181}`);
    styleMap.set(name, item);
  }
  const styles = [...styleMap.values()].map((item) => ({ ...item, aisFee: money(item.aisFee), storageNextMonth: money(item.storageNextMonth),
    lastMonthFee: money(item.lastMonthFee), agedCharged: money(item.agedCharged),
    stockDays: item.sold30 > 0 ? Math.round(item.stock / (item.sold30 / 30)) : null }))
    .sort((a, b) => b.aisFee - a.aisFee || b.storageNextMonth - a.storageNextMonth || b.stock - a.stock);

  // 按月:仓储费 + 已收超龄附加费 + 当月卖出件数
  const monthly = [];
  const filtered = !!(sku || style);
  const keyOfCharge = (row) => (row.sku ? lower(row.sku) : skuOfFee(row));
  const agedDone = state('storage_aged_months') ?? [];
  for (let month = firstMonth; month <= thisMonth; month = shiftMonth(month, 1)) {
    const inMonth = (row) => row.month === month && (!filtered || wanted(keyOfCharge(row) ?? ''));
    const storage = feeRows.filter(inMonth);
    const agedMonth = agedRows.filter(inMonth);
    const units = filtered ? null : db.prepare('SELECT SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=?').get(monthStart(month), monthEnd(month))?.units ?? 0;
    monthly.push({ month, storageFee: feeMonthsAvailable.includes(month) ? money(sumBy(storage, 'fee')) : null,
      avgQuantity: storage.length ? Math.round(sumBy(storage, 'avg_quantity')) : null,
      agedCharged: agedMonth.length || agedDone.includes(month) ? money(sumBy(agedMonth, 'amount')) : null,
      agedUnits: sumBy(agedMonth, 'quantity'), sold: units });
  }

  const snapshotDate = planning.map((row) => row.snapshotDate).filter(Boolean).sort().at(-1) ?? null;
  const notes = [];
  if (!planning.length) notes.push('还没有库存规划数据：网站每天自动拉一次亚马逊库存规划报告和仓储费报告，也可以点「立即同步」。');
  if (unmatchedFee.rows && !sku && !style) notes.push(`上月仓储费里有 ${unmatchedFee.rows} 行（$${unmatchedFee.fee.toFixed(2)}）对不上 SKU，只算进了合计。`);
  return { today, snapshotDate, lastFeeMonth, months: span, totals, findings: storageFindings(rows, totals, today), styles, monthly, skus: rows,
    sync: storageSyncStatus(),
    notes: [...notes,
      '在库 = 可用 + FC 转运 + 正在接收，在途 = 处理中 + 已发货（和 SKU 库、价格策略表一样）。库龄、超龄附加费预估、下月仓储费预估来自亚马逊库存规划报告，每天更新一次。',
      '超龄附加费每月 15 号前后按当天库龄收，超过 180 天才收；「上月仓储费」是月度仓储费报告的实际数，一般下个月 7–15 号出。'] };
}

// ---------- 网站接口 ----------

export const storageRouter = express.Router();
storageRouter.use(requireLogin);
storageRouter.use((req, res, next) => isPet ? next() : res.status(404).json({ error: '只有宠物版有仓储费板块' }));
storageRouter.get('/', (req, res) => res.json(storageBoard({ months: req.query.months, style: clean(req.query.style) || undefined })));
storageRouter.get('/status', (req, res) => res.json(storageSyncStatus()));
storageRouter.post('/sync', (req, res) => {
  const status = storageSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  if (status.running) return res.status(409).json({ error: '仓储费报告正在同步' });
  void syncStorage().catch((error) => console.error('[storage-sync]', error.message));
  res.status(202).json({ accepted: true });
});
