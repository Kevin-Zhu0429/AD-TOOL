export const PRICE_FIELDS = [
  ['date', '日期', 'date'], ['marketplace', '站点'], ['asin', 'ASIN'], ['sku', 'SKU'],
  ['style', '款式'], ['size', '尺码'], ['color', '颜色'], ['fabric', '面料外观'],
  ['skc', 'SKC'], ['nameZh', '中文名称'], ['totalStock', '总库存数', 'integer'],
  ['availableStock', '船长可售库存', 'integer'], ['inboundStock', '船长在途库存', 'integer'],
  ['totalSales', '总销量', 'integer'], ['salesThroughLastMonth', '截止上月总销量', 'integer'],
  ['monthlySales', '本月销量', 'integer'], ['sales7d', '近7日销量汇总', 'integer'],
  ['monthlyOrders', '本月订单数', 'integer'], ['orders7d', '近7日订单数', 'integer'],
  ['adSales7d', '近7日广告销量', 'integer'], ['movement7d', '近7日动销', 'number'],
  ['adOrders7d', '近7日广告订单数', 'integer'],
  ['movementSpeed7d', '近7天动销速度', 'number'], ['clicks7d', '近7天点击数', 'integer'],
  ['conversion7d', '近7天转化率', 'percent'], ['price', '售价', 'money'],
  ['promoPrice', '活动价', 'money'], ['currentProfit', '当下利润', 'signedMoney'],
  ['monthlyMargin', '当月利润率', 'percent'], ['monthlyAdRatio', '本月费比', 'percent'],
  ['lastWeekComparison', '上周同比', 'percent'], ['weekOverWeek', '7天环比', 'percent'],
  ['turnoverWeeks', '周转周数', 'number'], ['estimatedSelloutDate', '预估售罄日', 'date'],
  ['movement3d', '近3日动销值', 'number'],
].map(([key, label, type = 'text']) => ({ key, label, type }));

export const DAILY_KEYS = Array.from({ length: 7 }, (_, index) => `day${index + 1}`);
export const PRICE_ALL_FIELDS = [...PRICE_FIELDS, ...DAILY_KEYS.map((key) => ({ key, label: key, type: 'integer' }))];

export function dailyIsoDates(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return [];
  const end = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== date) return [];
  return Array.from({ length: 7 }, (_, index) => {
    const value = new Date(end);
    value.setUTCDate(value.getUTCDate() - 6 + index);
    return value.toISOString().slice(0, 10);
  });
}
export function dailyDates(date) {
  return dailyIsoDates(date).map((day) => {
    const [, month, dayOfMonth] = day.split('-').map(Number);
    return `${month}/${dayOfMonth}`;
  });
}

export function normalizePriceRow(raw) {
  const row = { marketplace: 'US' };
  if (String(raw?.marketplace || 'US').trim().toUpperCase() !== 'US') throw new Error('宠物价格策略表只支持 US 站');
  for (const field of PRICE_ALL_FIELDS) {
    if (field.key === 'marketplace') continue;
    const value = raw?.[field.key];
    if (value === null || value === undefined || String(value).trim() === '') { row[field.key] = null; continue; }
    if (field.type === 'date') {
      const date = String(value).trim();
      if (!dailyDates(date).length) throw new Error(`${field.label}必须是 YYYY-MM-DD 格式的有效日期`);
      row[field.key] = date;
    } else if (['integer', 'number', 'percent', 'money', 'signedMoney'].includes(field.type)) {
      const number = Number(value);
      const signed = ['currentProfit', 'monthlyMargin', 'lastWeekComparison', 'weekOverWeek'].includes(field.key);
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)) || (!signed && number < 0)) throw new Error(`${field.label}必须是${field.type === 'integer' ? '非负整数' : '有效数字'}`);
      row[field.key] = number;
    } else row[field.key] = String(value).trim();
  }
  if (!row.date) throw new Error('日期不能为空');
  if (!row.sku) throw new Error('SKU 不能为空');
  if (row.sku.length > 200) throw new Error('SKU 最多 200 个字符');
  if (row.asin && !/^[A-Z0-9]{10}$/.test(row.asin.toUpperCase())) throw new Error('ASIN 必须是 10 位字母数字');
  if (row.asin) row.asin = row.asin.toUpperCase();
  return row;
}

export function priceTemplateHeaders(date) {
  const dates = dailyDates(date);
  return PRICE_ALL_FIELDS.map((field) => DAILY_KEYS.includes(field.key)
    ? `${dates[DAILY_KEYS.indexOf(field.key)]}销量` : field.label);
}

export function parsePriceSheet(sheet, snapshotDate) {
  if (!Array.isArray(sheet) || !sheet.length) throw new Error('表格没有表头');
  const headers = sheet[0].map((value) => String(value ?? '').trim());
  const days = dailyDates(snapshotDate);
  const positions = PRICE_ALL_FIELDS.map((field) => {
    const label = DAILY_KEYS.includes(field.key) ? `${days[DAILY_KEYS.indexOf(field.key)]}销量` : field.label;
    return headers.findIndex((header) => header === label || header === field.key);
  });
  if (positions[PRICE_ALL_FIELDS.findIndex((f) => f.key === 'sku')] < 0) throw new Error('缺少 SKU 列');
  const rows = [], seen = new Set();
  for (let i = 1; i < sheet.length; i++) {
    const cells = sheet[i];
    if (!Array.isArray(cells) || cells.every((v) => String(v ?? '').trim() === '')) continue;
    const raw = Object.fromEntries(PRICE_ALL_FIELDS.map((field, index) => [field.key, positions[index] >= 0 ? cells[positions[index]] : null]));
    raw.date ||= snapshotDate;
    let row;
    try { row = normalizePriceRow(raw); } catch (error) { throw new Error(`第 ${i + 1} 行：${error.message}`); }
    if (row.date !== snapshotDate) throw new Error(`第 ${i + 1} 行：日期与当前选择的快照日期不一致`);
    const key = `${row.date}\0${row.sku.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`第 ${i + 1} 行：同一日期的 SKU 重复`);
    seen.add(key); rows.push(row);
  }
  if (!rows.length) throw new Error('表格没有有效数据行');
  if (rows.length > 20000) throw new Error('一次最多导入 20000 行');
  return rows;
}
