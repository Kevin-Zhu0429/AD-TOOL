// 与 FBA 超龄仓储费计算器一致：每月 15 日快照、先进先出、区间均匀分布。
export const AGE_BUCKETS = ['0-30', '31-60', '61-90', '91-180', '181-270', '271-365', '366-455', '>456'];
export const FEE_BUCKETS = ['181-270', '271-365', '366-455', '456+'];
export const MARKET_RATES = {
  CA: [0.02, 0.08, 0.15, 0.15],
  EU: [0.03, 0.09, 0.23, 0.29],
  UK: [0.04, 0.11, 0.27, 0.33],
  US: [0.01, 0.12, 0.30, 0.35],
  AU: [0, 0.11, 0.23, 0.23],
  AE: [0, 0.05, 0.18, 0.18],
};
export const OUTPUT_COLUMNS = [
  '日期', '市场代码', '品牌', '市场', 'SKU', '至售罄日的套均仓储费', '至售罄日的仓储费总额',
  '统计日期的日销', '是否有特殊情况', '如有，修正值是？', '修正备注理由', '最终计算日销',
  '在库TTL', '据统计日实际日销下（修正后）的可售月', '当下是否有180+库存', ...AGE_BUCKETS,
];

const ALIASES = {
  market: ['市场代码', '店铺名称', '店铺', '市场编码'],
  sku: ['SKU'],
  sales7: ['7日均销量', '统计日期的近七天日销', '近七天日销', '7天日均销量', '近7天日销', '近7日均销量', '7日平均销量'],
  sales14: ['14日均销量', '统计日期的近十四天日销', '近十四天日销', '14天日均销量', '近14天日销', '近14日均销量', '14日平均销量', '近14天日均销量', '14天平均日销'],
};
const INTERVALS = [[0, 31], [31, 61], [61, 91], [91, 181], [181, 271], [271, 366], [366, 456], [456, Infinity]];
const normalize = (value) => String(value ?? '').replace(/\s+/g, '').trim().toLowerCase();
const round = (value, digits) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;

function findColumn(headers, names) {
  const found = names.map((name) => headers.find((header) => normalize(header) === normalize(name))).find(Boolean);
  if (!found) throw new Error(`输入表缺少必要列：${names.join(' / ')}`);
  return found;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(value, 0) : 0;
  const match = String(value ?? '').replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  return match ? Math.max(Number(match[0]), 0) : 0;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的统计日期。');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error('请选择有效的统计日期。');
  return date;
}

function firstSnapshot(base) {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + (base.getUTCDate() >= 15 ? 1 : 0), 15));
}

function makeCohorts(buckets, scenario) {
  if (!['uniform', 'youngest', 'oldest'].includes(scenario)) throw new Error('未知库龄场景。');
  return buckets.flatMap((quantity, index) => {
    if (quantity <= 0) return [];
    const [low, high] = INTERVALS[index];
    if (index === 7) return [{ low: 1_000_000, high: 1_000_000, quantity, point: true }];
    if (scenario === 'youngest') return [{ low, high: low, quantity, point: true }];
    if (scenario === 'oldest') return [{ low: high - 1, high: high - 1, quantity, point: true }];
    return [{ low, high, quantity, point: false }];
  }).sort((a, b) => b.high - a.high);
}

function removeFifo(cohorts, sold) {
  let remaining = Math.max(sold, 0);
  const survivors = [];
  for (const cohort of cohorts) {
    if (remaining >= cohort.quantity - 1e-12) { remaining -= cohort.quantity; continue; }
    if (remaining <= 1e-12) { survivors.push(cohort); continue; }
    const quantity = cohort.quantity - remaining;
    survivors.push({ ...cohort, quantity, high: cohort.point ? cohort.high : cohort.low + (cohort.high - cohort.low) * quantity / cohort.quantity });
    remaining = 0;
  }
  return survivors;
}

function overlap(cohort, offset, low, high) {
  if (cohort.point) return low <= cohort.low + offset && cohort.low + offset < high ? cohort.quantity : 0;
  const left = cohort.low + offset;
  const right = cohort.high + offset;
  return cohort.quantity * Math.max(0, Math.min(right, high) - Math.max(left, low)) / (right - left);
}

export function calculateSkuFee(buckets, dailySales, date, market, scenario = 'uniform') {
  const inventory = buckets.reduce((sum, value) => sum + value, 0);
  if (!inventory) return { average: 0, total: 0, months: 0 };
  if (!(dailySales > 0)) return { average: null, total: null, months: null };
  const base = parseDate(date);
  const rates = MARKET_RATES[market];
  if (!rates) throw new Error(`不支持市场 ${market}。`);
  const cohorts = makeCohorts(buckets, scenario);
  const selloutDays = inventory / dailySales;
  let snapshot = firstSnapshot(base);
  let total = 0;
  for (let index = 0; index < 1200; index += 1) {
    const offset = Math.round((snapshot - base) / 86400000);
    if (offset >= selloutDays - 1e-12) return { average: total / inventory, total, months: selloutDays / 30 };
    const survivors = removeFifo(cohorts, dailySales * offset);
    total += survivors.reduce((fee, cohort) => fee + rates.reduce((part, rate, bucket) => {
      const [low, high] = INTERVALS[bucket + 4];
      return part + overlap(cohort, offset, low, high) * rate;
    }, 0), 0);
    snapshot = new Date(Date.UTC(snapshot.getUTCFullYear(), snapshot.getUTCMonth() + 1, 15));
  }
  throw new Error('预计售罄周期超过100年，请检查日销数据。');
}

export function calculateInventory(sourceRows, date, scenario = 'uniform') {
  parseDate(date);
  if (!sourceRows.length) throw new Error('表格没有数据行。');
  const headers = [...new Set(sourceRows.flatMap(Object.keys))];
  const marketCol = findColumn(headers, ALIASES.market);
  const skuCol = findColumn(headers, ALIASES.sku);
  const sales7Col = findColumn(headers, ALIASES.sales7);
  const bucketCols = AGE_BUCKETS.map((bucket) => findColumn(headers, [bucket]));
  const sales14Col = headers.find((header) => ALIASES.sales14.some((alias) => normalize(header) === normalize(alias)));
  const errors = [];
  const result = [];
  sourceRows.forEach((source, index) => {
    const sku = String(source[skuCol] ?? '').trim();
    if (!sku) return;
    const marketCode = String(source[marketCol] ?? '').trim();
    const market = marketCode.toUpperCase().match(/([A-Z]{2})$/)?.[1] ?? '未识别';
    const hasRate = !!MARKET_RATES[market];
    const sales7 = toNumber(source[sales7Col]);
    if (hasRate && !sales7 && !sales14Col) { errors.push(`第${index + 2}行 SKU ${sku}：7天日销为0，但缺少14天日销列`); return; }
    const sales14 = sales14Col ? toNumber(source[sales14Col]) : 0;
    const dailySales = sales7 || sales14 || 0.14;
    const salesSource = sales7 ? '7天' : sales14 ? '14天' : '近14天无日销修正';
    const buckets = bucketCols.map((column) => toNumber(source[column]));
    const inventory = buckets.reduce((sum, value) => sum + value, 0);
    const brand = marketCode.includes('_') ? marketCode.slice(0, marketCode.lastIndexOf('_'))
      : marketCode.includes('-') ? marketCode.slice(0, marketCode.lastIndexOf('-')) : marketCode.slice(0, -2).replace(/[_\- ]+$/, '') || marketCode;
    result.push({ id: index, date, marketCode, brand, market, sku, dailySales, salesSource, buckets, inventory });
  });
  if (errors.length) throw new Error(`${errors.slice(0, 8).join('；')}${errors.length > 8 ? `；另有${errors.length - 8}行` : ''}。未生成结果。`);
  if (!result.length) throw new Error('表格中没有可计算的 SKU。');
  // 输入逐行独立，导入即展示；修正后的金额在行级计算，避免每次改动重算整张表。
  return result.map((row) => ({ ...row, fee: MARKET_RATES[row.market]
    ? calculateSkuFee(row.buckets, row.dailySales, date, row.market, scenario)
    : { average: null, total: null, months: null } }));
}

// 上传只保留计算所需的列，避免把库存原表中的其他字段一起发送到服务器。
export function compactInventoryRows(calculated) {
  return calculated.map((row) => ({
    市场代码: row.marketCode,
    SKU: row.sku,
    '7日均销量': row.salesSource === '7天' ? row.dailySales : 0,
    '14日均销量': row.salesSource === '14天' ? row.dailySales : 0,
    ...Object.fromEntries(AGE_BUCKETS.map((bucket, index) => [bucket, row.buckets[index]])),
  }));
}

export function resultForRow(row, correction = {}, scenario = 'uniform') {
  const special = correction.special === true;
  const revised = Number(correction.value);
  let valid = !special || (String(correction.value ?? '').trim() !== '' && Number.isFinite(revised) && revised > 0);
  let finalSales = valid ? (special ? revised : row.dailySales) : null;
  let fee = { average: null, total: null, months: null };
  if (valid) {
    try { fee = !MARKET_RATES[row.market] ? fee : special ? calculateSkuFee(row.buckets, finalSales, row.date, row.market, scenario) : row.fee; }
    catch { valid = false; finalSales = null; }
  }
  return { ...row, salesSource: row.salesSource === '手动固定' ? '近14天无日销修正' : row.salesSource,
    special, correctionValue: correction.value ?? '', reason: correction.reason ?? '', finalSales, fee, valid,
    originalFee: row.fee, dirty: correction.dirty === true };
}

export function exportRow(row) {
  const values = [row.date, row.marketCode, row.brand, row.market, row.sku,
    row.fee.average == null ? '' : round(row.fee.average, 2),
    row.fee.total == null ? '' : round(row.fee.total, 2),
    `${round(row.dailySales, 4)}（${row.salesSource}）`, row.special ? '是' : '否',
    row.special ? Number(row.correctionValue) : '', row.special ? row.reason : '',
    row.finalSales == null ? '' : round(row.finalSales, 4), round(row.inventory, 4),
    row.fee.months == null ? '' : round(row.fee.months, 2),
    row.buckets.slice(4).some((value) => value > 0) ? '是' : '否', ...row.buckets.map((value) => round(value, 4))];
  return values;
}

export function sortAgedFeeRows(rows, metric = '', direction = 'desc') {
  // Keep a row in its current sorted position while its correction is being edited.
  const editing = (row) => row.special && (row.dirty || !row.valid);
  const getValue = {
    average: (row) => editing(row) ? row.originalFee?.average : row.fee.average,
    total: (row) => editing(row) ? row.originalFee?.total : row.fee.total,
    sales: (row) => editing(row) ? row.dailySales : row.finalSales,
  }[metric];
  if (!getValue) return rows;
  const sign = direction === 'asc' ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = getValue(a.row);
    const right = getValue(b.row);
    if (left == null) return right == null ? a.index - b.index : 1;
    if (right == null) return -1;
    return sign * (left - right) || a.index - b.index;
  }).map(({ row }) => row);
}
