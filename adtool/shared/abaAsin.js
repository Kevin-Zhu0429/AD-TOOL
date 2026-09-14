import { readCsv, dateValue, metric } from './aba.js';
import { modelKey } from './skuMatch.js';

const fields = [
  ['query_volume', '搜索查询量'],
  ['market_impressions', '曝光：曝光总量'],
  ['market_clicks', '点击量：总次数'],
  ['market_purchases', '购买：下单总数'],
  ['asin_impressions', '曝光量：ASIN 计数'],
  ['asin_clicks', '点击量：ASIN 数量'],
  ['asin_purchases', '下单成交：ASIN 数量'],
];
export const ASIN_COUNT_KEYS = fields.map(([key]) => key);
export const ASIN_COLUMNS = [
  { key: 'recognition', label: '机型识别', text: true },
  { key: 'query', label: '搜索查询', text: true },
  { key: 'market_impressions', label: '市场 IMP' },
  { key: 'market_clicks', label: '市场点击 TT' },
  { key: 'market_purchases', label: '市场购买 TT' },
  { key: 'market_cvr', label: '市场 CVR', rate: true },
  { key: 'asin_impressions', label: 'ASIN IMP' },
  { key: 'asin_clicks', label: 'ASIN 点击' },
  { key: 'asin_purchases', label: 'ASIN 购买' },
  { key: 'asin_cvr', label: 'ASIN CVR', rate: true },
  { key: 'brand_share', label: '品牌占有率', rate: true },
];
const headerKey = (value) => String(value).normalize('NFKC').replace(/\s/g, '').toLowerCase();

export function asinRates(row) {
  const ratio = (numerator, denominator) => numerator != null && denominator > 0 ? numerator / denominator * 100 : null;
  return { ...row, market_cvr: ratio(row.market_purchases, row.market_clicks),
    asin_cvr: ratio(row.asin_purchases, row.asin_clicks), brand_share: ratio(row.asin_purchases, row.market_purchases) };
}

export function asinModelOptions(skuItems, reportAsins) {
  const available = new Set(reportAsins);
  const models = new Map();
  for (const sku of skuItems) {
    if (!available.has(sku.asin) || !String(sku.model ?? '').trim()) continue;
    const model = modelKey(sku.model);
    if (!model) continue;
    const key = model;
    if (!models.has(key)) models.set(key, { key, model, label: model, asins: new Set(), skuIds: [] });
    models.get(key).asins.add(sku.asin);
    models.get(key).skuIds.push(sku.id);
  }
  return [...models.values()].map((r) => ({ ...r, asins: [...r.asins].sort() })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
}

/** Across a cartridge series, market totals are unique per exact query/week, not per ASIN. */
export function aggregateAsinSeries(rows, { view = 'queries', mergeWeeks = true, modelLabel = '' } = {}) {
  const marketKeys = ['query_volume', 'market_impressions', 'market_clicks', 'market_purchases'];
  const labels = { query_volume: '搜索查询量', market_impressions: '市场 IMP', market_clicks: '市场点击 TT', market_purchases: '市场购买 TT' };
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([view === 'printers' ? row.group.key : row.query, view === 'printers' || mergeWeeks ? '' : row.week_end]);
    if (!groups.has(key)) groups.set(key, { ...row, key, asin: '', series_model: modelLabel,
      query: view === 'printers' ? row.recognition : row.query, asins: new Set(), periods: new Map(), candidates: new Set(), queries: new Set(), market: new Map(),
      ...Object.fromEntries(ASIN_COUNT_KEYS.map((k) => [k, 0])) });
    const group = groups.get(key);
    group.asins.add(row.asin); group.queries.add(row.query);
    row.candidates.forEach((c) => group.candidates.add(c));
    group.periods.set(row.week_end, { week_start: row.week_start, week_end: row.week_end, week_number: row.week_number });
    ['asin_impressions', 'asin_clicks', 'asin_purchases'].forEach((k) => { group[k] += row[k]; });
    const marketKey = JSON.stringify([row.query, row.week_end]);
    if (!group.market.has(marketKey)) group.market.set(marketKey, { query: row.query, week_end: row.week_end, values: [] });
    group.market.get(marketKey).values.push(row);
  }
  return [...groups.values()].map(({ market, periods, candidates, queries, asins, ...row }) => {
    const conflicts = [];
    for (const record of market.values()) {
      for (const field of marketKeys) {
        const distinct = new Set(record.values.map((r) => r[field]));
        if (distinct.size > 1) {
          row[field] = null;
          conflicts.push({ query: record.query, week_end: record.week_end, field, label: labels[field], values: record.values.map((r) => ({ asin: r.asin, value: r[field] })) });
        } else if (row[field] !== null) row[field] += record.values[0][field];
      }
    }
    return { ...row, asins: [...asins].sort(), query_count: queries.size,
      periods: [...periods.values()].sort((a, b) => b.week_end.localeCompare(a.week_end)), candidates: [...candidates],
      conflict_count: conflicts.length, market_conflicts: conflicts.slice(0, 20) };
  });
}

/** Average each query over its observed weeks; grouped values sum those query averages. */
export function aggregateAsinView(rows, { series = false, view = 'queries', mergeWeeks = true, average = false, modelLabel = '', includeQueries = false } = {}) {
  const queries = series ? aggregateAsinSeries(rows, { mergeWeeks: mergeWeeks || average, modelLabel })
    : mergeWeeks || average ? mergeAsinRows(rows)
      : rows.map((r) => ({ ...r, key: `${r.report_id}:${r.query}`, periods: [{ week_start: r.week_start, week_end: r.week_end, week_number: r.week_number }] }));
  if (average) for (const row of queries) {
    row.average_weeks = row.periods.length;
    for (const key of ASIN_COUNT_KEYS) if (row[key] != null) row[key] /= row.average_weeks;
  }
  if (view !== 'printers') return queries.map(asinRates);
  const groupKey = (row) => JSON.stringify([series ? '' : row.asin, row.group.key]);
  const groups = series ? aggregateAsinSeries(rows, { view, modelLabel }) : groupAsinRows(rows);
  if (average) {
    const totals = new Map();
    for (const row of queries) {
      const key = groupKey(row);
      if (!totals.has(key)) totals.set(key, Object.fromEntries(ASIN_COUNT_KEYS.map((k) => [k, 0])));
      const total = totals.get(key);
      for (const k of ASIN_COUNT_KEYS) total[k] = total[k] == null || row[k] == null ? null : total[k] + row[k];
    }
    for (const group of groups) Object.assign(group, totals.get(groupKey(group)), { averaged_queries: true });
  }
  if (includeQueries) {
    const queryRows = new Map();
    for (const row of queries.map(asinRates)) {
      const key = groupKey(row);
      if (!queryRows.has(key)) queryRows.set(key, []);
      queryRows.get(key).push(row);
    }
    for (const group of groups) group.query_rows = (queryRows.get(groupKey(group)) ?? [])
      .sort((a, b) => a.query.localeCompare(b.query, 'zh-CN', { numeric: true }));
  }
  return groups.map(asinRates);
}

/** A1 and C1 are the sole identity/period sources; filenames are display-only. */
export function parseAsinReport(text, filename, marketplace) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error('单份 CSV 不能超过 10 MB');
  if (typeof filename !== 'string' || !/\.csv$/i.test(filename) || filename.length > 255) throw new Error('请上传 CSV 格式的 ASIN 视图周报');
  const cleaned = text.replace(/^\uFEFF/, '');
  const end = cleaned.indexOf('\n');
  const meta = end >= 0 ? cleaned.slice(0, end).trim() : '';
  const cells = meta.match(/^ASIN=(\[.*?\]),报告范围=(\[.*?\]),选择周=(\[.*?\])$/i);
  if (!cells) throw new Error('请保留原始首行：A1 为 ASIN，B1 为报告范围，C1 为选择周');
  let asins, scope, periods;
  try { [asins, scope, periods] = cells.slice(1).map((part) => JSON.parse(part)); }
  catch { throw new Error('首行 ASIN 或报告周期格式不正确'); }
  if (!Array.isArray(asins) || asins.length !== 1 || typeof asins[0] !== 'string' || !/^[A-Z0-9]{10}$/i.test(asins[0])) throw new Error('A1 须包含一个有效的 10 位 ASIN');
  if (!Array.isArray(scope) || scope.length !== 1 || scope[0] !== '每周') throw new Error('仅支持 ASIN 视图每周报告');
  const period = Array.isArray(periods) && periods.length === 1 && typeof periods[0] === 'string'
    ? periods[0].match(/^周\s+(\d{1,2})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})(?:\s+\d{4})?$/) : null;
  if (!period) throw new Error('C1 缺少有效报告周数和日期范围');
  const [, week, start, finish] = period;
  if (!(Number(week) >= 1 && Number(week) <= 53) || dateValue(finish) - dateValue(start) !== 6 * 86400000) throw new Error('C1 报告周期必须是有效的连续 7 天');
  const csv = readCsv(cleaned.slice(end + 1));
  const header = csv.shift() ?? [];
  const keys = header.map(headerKey);
  const required = ['搜索查询', ...fields.map(([, label]) => label), '报告日期'];
  for (const label of required) {
    const positions = keys.filter((key) => key === headerKey(label));
    if (positions.length !== 1) throw new Error(`缺少列或列名重复：${label}。请上传原始 ASIN 视图报告`);
  }
  if (csv.length > 10000) throw new Error('单份报告最多支持 10,000 条搜索查询');
  const at = (values, label) => values[keys.indexOf(headerKey(label))];
  const seen = new Set();
  const rows = csv.map((values, i) => {
    const line = i + 3;
    if (values.length !== header.length) throw new Error(`第 ${line} 行列数与表头不一致`);
    if (at(values, '报告日期').trim() !== finish) throw new Error(`第 ${line} 行报告日期与 C1 不一致`);
    const query = at(values, '搜索查询').trim();
    if (!query || query.length > 1000) throw new Error(`第 ${line} 行搜索查询为空或过长`);
    if (seen.has(query)) throw new Error(`第 ${line} 行搜索查询重复：${query}`);
    seen.add(query);
    return { query, ...Object.fromEntries(fields.map(([key, label]) => [key, metric(at(values, label), label, line, false, true)])) };
  });
  return { asin: asins[0].toUpperCase(), marketplace, week_start: start, week_end: finish,
    week_number: Number(week), source_file: filename, rows };
}

/** Aggregate only within one ASIN: market values overlap across ASIN reports. */
export function mergeAsinRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.asin, row.query]);
    let item = grouped.get(key);
    if (!item) {
      item = { ...row, key, periods: [], ...Object.fromEntries(ASIN_COUNT_KEYS.map((k) => [k, 0])) };
      grouped.set(key, item);
    }
    for (const k of ASIN_COUNT_KEYS) item[k] += row[k];
    item.periods.push({ week_start: row.week_start, week_end: row.week_end, week_number: row.week_number });
  }
  return [...grouped.values()].map((row) => ({ ...row, periods: row.periods.sort((a, b) => b.week_end.localeCompare(a.week_end)) }));
}

/** Merged workbooks carry identity in AI/AJ on every data row. Sheet names are irrelevant. */
export function parseMergedAsinWorkbook(sheets, filename, marketplace) {
  if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || filename.length > 255) throw new Error('合并表请使用 XLSX 格式');
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 50) throw new Error('工作簿须包含 1–50 张数据表');
  if (new TextEncoder().encode(JSON.stringify(sheets)).byteLength > 30 * 1024 * 1024) throw new Error('解压后的表格数据不能超过 30 MB');
  const groups = new Map();
  let total = 0;
  const labels = ['搜索查询', ...fields.map(([, label]) => label), '报告日期'];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    if (!Array.isArray(sheet?.rows)) throw new Error('工作表数据格式不正确');
    if (!sheet.rows.length) continue;
    const [head, ...body] = sheet.rows;
    if (!Array.isArray(head)) throw new Error('工作表缺少表头');
    const keys = head.map(headerKey);
    if (keys[34] !== 'asin' || keys[35] !== '时间范围') throw new Error(`第 ${sheetIndex + 1} 张表须在 AI 列填写 ASIN、AJ 列填写时间范围`);
    const positions = labels.map((label) => {
      const key = headerKey(label);
      if (keys.filter((v) => v === key).length !== 1) throw new Error(`缺少列或列名重复：${label}`);
      return keys.indexOf(key);
    });
    for (const [index, row] of body.entries()) {
      const location = `第 ${sheetIndex + 1} 张表第 ${index + 2} 行`;
      if (!Array.isArray(row) || row.some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) throw new Error(`${location}包含无效单元格`);
      if (!row.some((v) => String(v ?? '').trim())) continue;
      if (++total > 100000) throw new Error('合并表最多支持 100,000 条搜索词记录');
      const asin = String(row[34] ?? '').trim().toUpperCase();
      const period = String(row[35] ?? '').trim();
      if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`${location} AI 列缺少有效 ASIN`);
      if (!/^周\s+\d{1,2}\s*\|\s*\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}(?:\s+\d{4})?$/.test(period)) throw new Error(`${location} AJ 列缺少有效周数和日期范围`);
      const key = `${asin}|${period}`;
      if (!groups.has(key)) groups.set(key, { asin, period, values: [], location });
      groups.get(key).values.push(positions.map((i) => row[i] ?? ''));
    }
  }
  if (!total) throw new Error('合并表没有搜索词数据；空周报请使用原始 CSV');
  if (groups.size > 5000) throw new Error('一份合并表最多包含 5,000 份 ASIN 周报');
  const csvLine = (values) => values.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',');
  const seen = new Set();
  return [...groups.values()].map(({ asin, period, values, location }) => {
    try {
      const csv = `ASIN=${JSON.stringify([asin])},报告范围=["每周"],选择周=${JSON.stringify([period])}\n`
        + [labels, ...values].map(csvLine).join('\n');
      const report = parseAsinReport(csv, 'merged.csv', marketplace);
      const key = `${report.asin}|${report.week_end}`;
      if (seen.has(key)) throw new Error('同 ASIN 同一周存在不一致的 AJ 周期说明');
      seen.add(key);
      return { ...report, source_file: filename };
    } catch (e) { throw new Error(`${location}起的 ${asin} / ${period}：${e.message}`); }
  });
}

export function parseAsinUpload(file, marketplace) {
  return /\.xlsx$/i.test(file?.name ?? '') ? parseMergedAsinWorkbook(file.sheets, file.name, marketplace)
    : [parseAsinReport(file?.text, file?.name, marketplace)];
}

export function groupAsinRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.asin, row.group.key]);
    if (!groups.has(key)) groups.set(key, { ...row, key, query: row.recognition, periods: new Map(), queries: new Set(), candidates: new Set(),
      ...Object.fromEntries(ASIN_COUNT_KEYS.map((k) => [k, 0])) });
    const group = groups.get(key);
    group.queries.add(row.query);
    row.candidates.forEach((v) => group.candidates.add(v));
    group.periods.set(row.week_end, { week_start: row.week_start, week_end: row.week_end, week_number: row.week_number });
    ASIN_COUNT_KEYS.forEach((k) => { group[k] += row[k]; });
  }
  return [...groups.values()].map(({ queries, periods, candidates, ...row }) => ({ ...row, query_count: queries.size,
    periods: [...periods.values()].sort((a, b) => b.week_end.localeCompare(a.week_end)), candidates: [...candidates] }));
}
