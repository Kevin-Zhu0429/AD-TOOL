// 宠物版 SKU 库的「成本与毛利」视图:列定义、金额格式和成本表导入的表头识别。

/** group 相同且相邻的列在表头合成一组;edit 表示这一列在 SKU 库里可以直接改 */
export const PROFIT_COLS = [
  { key: 'sku', label: 'SKU', group: '商品' },
  { key: 'style', label: '款式', group: '商品' },
  { key: 'size', label: '尺码', group: '商品' },
  { key: 'color', label: '颜色', group: '商品' },
  { key: 'stock', label: '在库', group: '商品', num: true },
  { key: 'fob', label: 'FOB', group: '成本', money: true, edit: true },
  { key: 'firstLeg', label: '头程', group: '成本', money: true, edit: true },
  { key: 'duty', label: '关税', group: '成本', money: true, edit: true },
  { key: 'landedCost', label: '落地成本', group: '成本', money: true, strong: true },
  { key: 'fbaFee', label: 'FBA 配送费', group: '亚马逊费用', money: true },
  { key: 'referralFee', label: '佣金', group: '亚马逊费用', money: true },
  { key: 'price', label: '售价', group: '毛利', money: true },
  { key: 'profit', label: '单件毛利', group: '毛利', money: true, strong: true },
  { key: 'margin', label: '毛利率', group: '毛利', pct: true, strong: true },
  { key: 'breakEven', label: '保本价', group: '毛利', money: true },
];

export const COST_KEYS = ['fob', 'firstLeg', 'duty'];

/** 表头分组:[{ label, span }] */
export function groupSpans(cols) {
  const spans = [];
  for (const col of cols) {
    const last = spans.at(-1);
    if (last && last.label === col.group) last.span += 1;
    else spans.push({ label: col.group, span: 1 });
  }
  return spans;
}

export function formatCell(col, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (col.money) return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
  if (col.pct) return `${Number(value).toFixed(1)}%`;
  return value;
}

/** 毛利颜色:亏钱红,毛利率低于 15% 黄 */
export function profitTone(item) {
  if (item.profit == null) return '';
  if (item.profit < 0) return 'loss';
  return item.margin < 15 ? 'thin' : 'ok';
}

export const PROFIT_FILTERS = [
  ['', '全部'],
  ['loss', '每件亏钱', (item) => item.profit != null && item.profit < 0],
  ['thin', '毛利率 < 15%', (item) => item.profit != null && item.margin < 15],
  ['noCost', '缺成本', (item) => item.landedCost == null],
  ['noFee', '缺 FBA 费', (item) => item.fbaFee == null],
];

const COST_HEADERS = {
  sku: /^(sku|seller ?sku|卖家 ?sku|商品 ?sku)$/i,
  fob: /fob|采购|出厂|货值/i,
  firstLeg: /头程|first.?leg|freight|运费/i,
  duty: /关税|duty|tariff/i,
};

/**
 * 成本表(Excel / CSV 第一行是表头)-> [{ sku, fob, firstLeg, duty }]。
 * 文件里没有的列不带,写进库时不会把已有的值清掉。认不出 SKU 列返回 error。
 */
export function mapCostSheet(sheet) {
  const head = (sheet[0] ?? []).map((cell) => String(cell ?? '').trim());
  const index = {};
  for (const [key, pattern] of Object.entries(COST_HEADERS)) {
    const at = head.findIndex((cell, i) => cell && pattern.test(cell) && !Object.values(index).includes(i));
    if (at >= 0) index[key] = at;
  }
  if (index.sku === undefined) return { error: '没找到 SKU 列,第一行要是表头(SKU / FOB / 头程 / 关税)' };
  if (!COST_KEYS.some((key) => index[key] !== undefined)) return { error: '没找到 FOB、头程、关税中的任何一列' };
  const rows = [];
  for (const line of sheet.slice(1)) {
    const sku = String(line[index.sku] ?? '').trim();
    if (!sku) continue;
    const row = { sku };
    for (const key of COST_KEYS) if (index[key] !== undefined) row[key] = String(line[index[key]] ?? '').trim();
    rows.push(row);
  }
  return { rows, columns: COST_KEYS.filter((key) => index[key] !== undefined) };
}
