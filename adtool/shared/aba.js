import { buildDModelIndex, resolveSearchModels } from './modelDrift.js';
import { modelKey } from './skuMatch.js';

export const ABA_COLUMNS = [
  { key: 'query', label: '搜索查询' },
  { key: 'query_volume', label: '搜索查询量' },
  { key: 'impressions', label: '曝光：曝光总量' },
  { key: 'clicks', label: '点击量：总次数' },
  { key: 'click_rate', label: '点击量：点击率 %', kind: 'rate' },
  { key: 'click_price', label: '点击量：价格(中位数)', kind: 'price' },
  { key: 'purchases', label: '购买：下单总数' },
  { key: 'week_end', label: '时间' },
  { key: 'week_number', label: '周数' },
];
const normalize = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();
const headerKey = (v) => normalize(v).replace(/\s/g, '');

/** Metadata is separate because Amazon's first line is not CSV. */
export function readCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('CSV 引号格式不正确，请重新下载原始报告');
      cell += c;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合，请重新下载原始报告');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function metric(value, label, line, nullable = false, integer = false) {
  const raw = String(value ?? '').trim();
  if (nullable && (!raw || raw === '-' || raw === '—')) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$/.test(raw)) throw new Error(`第 ${line} 行「${label}」不是有效非负数字`);
  const number = Number(raw.replace(/[,％%]/g, ''));
  if (!Number.isFinite(number) || number > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(number))) throw new Error(`第 ${line} 行「${label}」数值不合法`);
  return number;
}

export function parseAbaReport(text, filename, marketplace) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error('单份 CSV 不能超过 10 MB');
  if (typeof filename !== 'string' || !/\.csv$/i.test(filename) || filename.length > 255) throw new Error('请上传 CSV 格式的品牌视图周报');
  const fileMarket = filename.match(/^([A-Z]{2})_/i)?.[1].toUpperCase();
  if (fileMarket && fileMarket !== marketplace) throw new Error(`文件属于 ${fileMarket} 站，请先切换站点`);
  const cleaned = text.replace(/^\uFEFF/, '');
  const end = cleaned.indexOf('\n');
  const meta = cleaned.slice(0, end).trim();
  if (end < 0 || !/报告范围=\["每周"\]/.test(meta) || /ASIN\s*=/i.test(meta)) throw new Error('仅支持品牌视图的每周报告，请保留原始表头和报告说明行');
  const brandPart = meta.match(/品牌=(\[.*?\])(?:,|$)/)?.[1];
  let brands;
  try { brands = JSON.parse(brandPart); } catch { throw new Error('报告说明行缺少有效品牌'); }
  if (!Array.isArray(brands) || brands.length !== 1 || typeof brands[0] !== 'string' || !brands[0].trim() || brands[0].length > 100) throw new Error('请上传单个品牌的报告');
  const period = meta.match(/周\s+(\d{1,2})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (!period) throw new Error('报告说明行缺少周数或起止日期');
  const [, week, start, finish] = period;
  if (!(Number(week) >= 1 && Number(week) <= 53) || dateValue(finish) - dateValue(start) !== 6 * 86400000) throw new Error('报告周期必须是有效的连续 7 天');
  const filenameDate = filename.match(/Week_(\d{4})_(\d{2})_(\d{2})/i);
  if (filenameDate && filenameDate.slice(1).join('-') !== finish) throw new Error('文件名日期与报告周期不一致');
  const csv = readCsv(cleaned.slice(end + 1));
  const header = csv.shift() ?? [];
  const keys = header.map(headerKey);
  const fields = ABA_COLUMNS.slice(0, 7);
  const positions = fields.map(({ label }) => keys.indexOf(headerKey(label)));
  const dateCol = keys.indexOf('报告日期');
  const missing = fields.filter((_, i) => positions[i] < 0).map((c) => c.label);
  if (dateCol < 0) missing.push('报告日期');
  if (missing.length) throw new Error(`缺少列：${missing.join('、')}。请上传原始品牌视图报告`);
  if (!csv.length || csv.length > 10000) throw new Error('报告须包含 1–10,000 条搜索查询');
  const seen = new Set();
  const rows = csv.map((values, i) => {
    const line = i + 3;
    if (values.length !== header.length) throw new Error(`第 ${line} 行列数与表头不一致`);
    if (values[dateCol].trim() !== finish) throw new Error(`第 ${line} 行报告日期与所选周不一致`);
    const query = values[positions[0]].trim();
    if (!query || query.length > 1000) throw new Error(`第 ${line} 行搜索查询为空或过长`);
    if (seen.has(query)) throw new Error(`第 ${line} 行搜索查询重复：${query}`);
    seen.add(query);
    const row = { query };
    fields.slice(1).forEach((field, index) => {
      row[field.key] = metric(values[positions[index + 1]], field.label, line, !!field.kind, !field.kind);
    });
    return row;
  });
  return { brand: brands[0].trim(), marketplace, week_start: start, week_end: finish, week_number: Number(week), source_file: filename, rows };
}

export const ABA_PAGE_SIZES = [25, 50, 100, 200, 500];
const sumFields = ['query_volume', 'impressions', 'clicks', 'purchases'];
const splitModels = (value) => String(value ?? '').split(/[,，、;；/|]+/).map((s) => s.trim()).filter(Boolean);
const compactModel = (value) => normalize(value).replace(/[^0-9a-z]/g, '');

/** ABA groups HP's e suffix with its numeric model, as in the supplied reference. */
function abaLibrary(rows) {
  return rows.map((row) => ({ ...row, printer: splitModels(row.printer).flatMap((printer) => {
    if (normalize(row.brand) !== 'hp') return [printer];
    const compact = compactModel(printer);
    if (/\d{4}e$/.test(compact)) return [printer, printer.replace(/[.\s-]*e$/i, '')];
    if (/\d{4}$/.test(compact)) return [printer, `${printer}e`];
    return [printer];
  }).join(', ') }));
}

function printerIdentity(entry, index) {
  const firstRow = index.rows[[...entry.rows][0]];
  let model = compactModel(entry.label);
  if (entry.brand === 'hp') model = model.replace(/(\d{4})e$/, '$1');
  const label = entry.brand === 'hp' ? entry.label.replace(/(\d{4})[.\s-]*e$/i, '$1') : entry.label;
  return { key: `${entry.brand}|${model}`, label: `${entry.brand.toUpperCase()} ${label}`.trim(),
    terms: [...new Set([...entry.rows].map((i) => index.rows[i].term))], brand: firstRow?.brand ?? '' };
}

/** Classify every term, including literal substring matches, before applying a type filter. */
export function abaMatcher(search, dRows, includeModels = true, wordType = 'all') {
  const q = normalize(search);
  const index = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: abaLibrary(dRows) } });
  const targetRows = new Set();
  if (q) {
    const mentions = resolveSearchModels(q, index);
    for (const mention of mentions) {
      if (mention.type !== 'model') continue;
      for (const entry of mention.entries) for (const row of entry.rows) targetRows.add(row);
    }
    if (/^(?:[a-z]+[-\s]*)?\d+(?:\s*xl)?$/i.test(q) && !mentions.length) {
      index.rows.forEach((row, i) => {
        if (splitModels(row.term).some((t) => modelKey(t) === modelKey(q))) targetRows.add(i);
      });
    }
  }
  const cache = new Map();
  return (query) => {
    if (cache.has(query)) return cache.get(query);
    const printers = new Map();
    let relatedPrinter = false, relatedCartridge = false, hasCartridge = false, uncertain = false;
    for (const mention of resolveSearchModels(query, index)) {
      if (mention.type === 'brand_conflict') { uncertain = true; continue; }
      if (mention.type === 'ambiguous') uncertain = true;
      for (const entry of mention.entries) {
        const related = [...entry.rows].some((i) => targetRows.has(i));
        if (entry.kind === 'model') { hasCartridge = true; relatedCartridge ||= related; continue; }
        relatedPrinter ||= related;
        const printer = printerIdentity(entry, index);
        const existing = printers.get(printer.key);
        if (existing) existing.terms = [...new Set([...existing.terms, ...printer.terms])];
        else printers.set(printer.key, printer);
      }
    }
    const identities = [...printers.values()].sort((a, b) => a.key.localeCompare(b.key));
    const hasPrinter = identities.length > 0;
    const literal = !q || normalize(query).includes(q);
    let matches = literal || (includeModels && relatedPrinter);
    if (wordType === 'printer') matches = hasPrinter && (targetRows.size ? relatedPrinter : literal);
    if (wordType === 'cartridge') matches = !hasPrinter && !uncertain && hasCartridge && (targetRows.size ? relatedCartridge : literal);
    const group = identities.length === 1 && !uncertain
      ? { key: identities[0].key, label: identities[0].label, kind: 'printer' }
      : hasPrinter ? { key: 'review:' + JSON.stringify(identities.map((p) => p.key)), label: '多机型 / 待核对', kind: 'review' }
        : { key: 'other', label: '未归类机型词', kind: 'other' };
    const result = { matches, linked: matches && !literal && relatedPrinter, candidates: identities.map((p) => `${p.label} → ${p.terms.join(' / ')}`),
      printers: identities, hasPrinter, hasCartridge, group };
    cache.set(query, result);
    return result;
  };
}

/** Only additive metrics are summed. A median cannot be recovered from weekly medians. */
export function aggregateAbaRows(rows, mode = 'query') {
  const buckets = new Map();
  for (const row of rows) {
    const key = mode === 'printer' ? row.group.key : row.query;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { ...row, key, query: mode === 'printer' ? row.group.label : row.query,
        query_volume: 0, impressions: 0, clicks: 0, purchases: 0, record_count: 0,
        candidates: [], linked: false, queries: new Set(), periodMap: new Map(), prices: [] };
      buckets.set(key, bucket);
    }
    sumFields.forEach((field) => { bucket[field] += row[field]; });
    bucket.record_count++;
    bucket.queries.add(row.query);
    bucket.linked ||= row.linked;
    bucket.candidates = [...new Set([...bucket.candidates, ...row.candidates])];
    bucket.periodMap.set(row.week_end, { week_start: row.week_start, week_end: row.week_end, week_number: row.week_number });
    if (mode === 'query') bucket.prices.push({ week_end: row.week_end, week_number: row.week_number, value: row.click_price });
  }
  return [...buckets.values()].map(({ queries, periodMap, ...row }) => {
    const periods = [...periodMap.values()].sort((a, b) => a.week_end.localeCompare(b.week_end));
    return { ...row, query_count: queries.size, periods, week_start: periods[0].week_start,
      week_end: periods.at(-1).week_end, week_number: periods.at(-1).week_number,
      click_rate: row.record_count === 1 ? row.click_rate : row.query_volume ? row.clicks / row.query_volume * 100 : null,
      click_price: row.record_count === 1 ? row.click_price : null,
      prices: row.prices.sort((a, b) => a.week_end.localeCompare(b.week_end)) };
  });
}
