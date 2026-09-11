import { modelKey } from './skuMatch.js';

const clean = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const compact = (value) => clean(value).toLowerCase().replace(/[^0-9a-z]+/g, '');
const unique = (values) => [...new Set(values)];
const INK_WORD = /\b(?:ink|inks|cartridges?|cartouches?|encre|encres|cartuchos?|tinta|tintas|tinte|tintenpatronen?|druckerpatronen?|patronen?|cartucce|cartuccia|inchiostro|tinteiros?|toner)\b/i;
const PRINTER_WORD = /\b(?:printer|imprimante|impresora|drucker|stampante)\s*(?:(?:hp|canon|epson|brother)\s*)?$/i;
const PAIR_CONNECTOR = /^\s*(?:[/,&+]|et|and|und|y|e|ou|or|oder|o)\s*$/i;

function split(value) {
  return clean(value).split(/[,，、;；/|]+/).map((part) => part.trim()).filter(Boolean);
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Complete token boundaries: 305 must never match 3050 or a product-code suffix. */
function aliasRe(alias, allowXl = false) {
  const token = compact(alias);
  if (!token || !/[0-9]/.test(token)) return null;
  const body = token.split('').map(escapeRe).join('[^0-9a-z]*');
  const xl = allowXl && !token.endsWith('xl') ? '(?:[^0-9a-z]*xl)?' : '';
  return new RegExp(`(^|[^0-9a-z])(${body}${xl})(?![0-9a-z])`, 'i');
}

/** Keep brand and complete printer identity; repeated D rows are not separate printers. */
export function buildDModelIndex(libData) {
  const spec = (libData?.libs ?? []).find((lib) => lib.id === 'D' || lib.special === 'series');
  const rows = spec ? libData?.items?.[spec.id] ?? [] : [];
  const aliases = new Map();
  const printerNumbers = new Map();
  const brands = unique(['hp', 'canon', 'epson', 'brother', ...rows.map((row) => clean(row.brand).toLowerCase())]).filter(Boolean);
  const addAlias = (label, kind, rowIndex) => {
    const re = aliasRe(label, kind === 'model');
    if (!re) return null;
    const brand = clean(rows[rowIndex].brand).toLowerCase();
    const key = `${kind}|${brand}|${compact(label)}`;
    const entry = aliases.get(key) ?? { label: clean(label), kind, brand, re, rows: new Set() };
    entry.rows.add(rowIndex);
    aliases.set(key, entry);
    return entry;
  };
  rows.forEach((row, rowIndex) => {
    split(row.term).forEach((label) => addAlias(label, 'model', rowIndex));
    split(row.printer).forEach((printer) => {
      const token = compact(printer);
      const full = token.match(/^([a-z]+)(\d[0-9a-z]*)$/);
      const number = full?.[2] ?? token.match(/^\d[0-9a-z]*$/)?.[0];
      if (!number) return;
      const prefix = full?.[1] ?? clean(row.series).toLowerCase().match(/([a-z][0-9a-z]*)\s*$/)?.[1] ?? '';
      const label = full ? printer : prefix ? `${prefix.toUpperCase()}${clean(printer)}` : clean(printer);
      const entry = prefix ? addAlias(label, 'printer', rowIndex) : {
        label, kind: 'printer', brand: clean(row.brand).toLowerCase(), rows: new Set([rowIndex]),
      };
      const list = printerNumbers.get(number) ?? [];
      const existing = list.find((item) => item.brand === entry.brand && compact(item.label) === compact(label));
      if (existing) existing.rows.add(rowIndex);
      else list.push({ ...entry, prefix, number, rows: new Set([rowIndex]) });
      printerNumbers.set(number, list);
    });
  });
  const numberPatterns = [...printerNumbers].map(([number, entries]) => ({ re: aliasRe(number), entries }));
  return { rows, aliases: [...aliases.values()], printerNumbers, numberPatterns, brands, searchCache: new Map() };
}

/** SKU brand is the seller's brand, so it cannot be used as the OEM printer brand. */
export function campaignModelContext(campaign, skuItems, dIndex) {
  const bySku = new Map((skuItems ?? []).map((item) => [clean(item.sku).toLowerCase(), item]));
  const models = new Set();
  const expectedRows = new Set();
  const unknownSkus = new Set();
  const unmappedModels = new Set();
  let missingSku = false;
  (campaign?.ads ?? []).forEach((ad) => {
    const sku = clean(ad.sku);
    if (!sku) { missingSku = true; return; }
    const item = bySku.get(sku.toLowerCase());
    const key = modelKey(item?.model);
    if (!key) { unknownSkus.add(sku); return; }
    models.add(clean(item.model));
    const modelText = clean(item.model).toLowerCase();
    const explicitBrand = dIndex.brands.find((brand) => new RegExp(`^${escapeRe(brand)}(?:[^a-z]|$)`).test(modelText));
    const rowIds = dIndex.rows.flatMap((row, i) =>
      (!explicitBrand || !clean(row.brand) || clean(row.brand).toLowerCase() === explicitBrand) &&
      split(row.term).some((term) => modelKey(term) === key) ? [i] : []);
    // A bare SKU model shared by different OEM brands does not establish either mapping.
    const brands = unique(rowIds.map((i) => clean(dIndex.rows[i].brand).toLowerCase()).filter(Boolean));
    if (!rowIds.length || brands.length > 1) unmappedModels.add(clean(item.model));
    else rowIds.forEach((i) => expectedRows.add(i));
  });
  return {
    models: [...models], expectedRows, unknownSkus: [...unknownSkus], unmappedModels: [...unmappedModels],
    incomplete: missingSku || !campaign?.ads?.length || unknownSkus.size > 0 || unmappedModels.size > 0,
  };
}

function normalizeSearch(value, dIndex) {
  let text = clean(value).toLowerCase().replace(/[’‘`]/g, "'");
  // Split only known OEM brands. Never split TS305, F350, ASINs or arbitrary product codes.
  for (const brand of dIndex.brands) {
    text = text.replace(new RegExp(`(^|[^0-9a-z])(${escapeRe(brand)})(?=\\d)`, 'g'), '$1$2 ');
  }
  return text;
}

function occurrences(text, re) {
  if (!re.test(text)) return [];
  return [...text.matchAll(new RegExp(re.source, 'gi'))].map((match) => ({
    start: match.index + match[1].length, end: match.index + match[0].length,
  }));
}

/** A full printer wins only over the number inside that mention, not elsewhere in the query. */
function collectMentions(text, dIndex) {
  const groups = new Map();
  const add = (span, entry, explicit = false) => {
    const key = `${span.start}:${span.end}`;
    const group = groups.get(key) ?? { ...span, models: [], printers: [], explicit: false };
    const list = entry.kind === 'model' ? group.models : group.printers;
    if (!list.includes(entry)) list.push(entry);
    group.explicit ||= explicit;
    groups.set(key, group);
  };
  for (const entry of dIndex.aliases) {
    for (const span of occurrences(text, entry.re)) add(span, entry, entry.kind === 'printer');
  }
  for (const { re, entries } of dIndex.numberPatterns) {
    for (const span of occurrences(text, re)) entries.forEach((entry) => add(span, entry));
  }
  const selected = [];
  for (const group of [...groups.values()].sort((a, b) => (b.end - b.start) - (a.end - a.start) || Number(b.explicit) - Number(a.explicit))) {
    if (!selected.some((other) => group.start < other.end && group.end > other.start)) selected.push(group);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function localBrand(text, mention, next, dIndex) {
  const before = text.slice(Math.max(0, mention.start - 80), mention.start).split(/[;.!?]/).at(-1);
  const after = text.slice(mention.end, next?.start ?? text.length).split(/[;.!?]/)[0].slice(0, 30);
  const mentions = [];
  for (const brand of dIndex.brands) {
    const re = new RegExp(`(^|[^0-9a-z])(${escapeRe(brand)})(?![0-9a-z])`, 'gi');
    for (const match of before.matchAll(re)) mentions.push({ brand, at: match.index });
  }
  if (mentions.length) return mentions.sort((a, b) => b.at - a.at)[0].brand;
  return dIndex.brands.find((brand) => new RegExp(`^\\s*(?:xl\\s+)?${escapeRe(brand)}(?![0-9a-z])`, 'i').test(after)) ?? '';
}

function sharesCartridgeRow(a, b) {
  return a.models.some((x) => b.models.some((y) => modelKey(x.label) !== modelKey(y.label) && [...x.rows].some((row) => y.rows.has(row))));
}

/** Search interpretation deliberately has no campaign argument. */
export function resolveSearchModels(searchTerm, dIndex) {
  const text = normalizeSearch(searchTerm, dIndex);
  if (!/\d/.test(text)) return [];
  if (dIndex.searchCache.has(text)) return dIndex.searchCache.get(text);
  const mentions = collectMentions(text, dIndex);
  const resolved = mentions.map((mention, i) => {
    const previous = mentions[i - 1];
    const next = mentions[i + 1];
    const token = text.slice(mention.start, mention.end);
    const brand = localBrand(text, mention, next, dIndex);
    const fits = (entry) => !brand || !entry.brand || entry.brand === brand;
    const models = mention.models.filter(fits);
    const printers = mention.printers.filter(fits);
    const before = text.slice(previous?.end ?? Math.max(0, mention.start - 70), mention.start).split(/[;,.!?]/).at(-1);
    const after = text.slice(mention.end, next?.start ?? Math.min(text.length, mention.end + 40)).split(/[;,.!?]/)[0];
    const nearby = before + ' ' + after;
    const paired = (previous && PAIR_CONNECTOR.test(text.slice(previous.end, mention.start)) && sharesCartridgeRow(previous, mention)) ||
      (next && PAIR_CONNECTOR.test(text.slice(mention.end, next.start)) && sharesCartridgeRow(mention, next));
    const inkEvidence = /\d[^0-9a-z]*xl$/.test(token) || paired || (INK_WORD.test(nearby) && !PRINTER_WORD.test(before));
    const conflict = (entries) => ({ token, type: 'brand_conflict', brand, entries });
    if (mention.explicit) {
      const explicit = mention.printers.filter((entry) => entry.re?.test(token));
      const compatible = explicit.filter(fits);
      return compatible.length ? { token, type: 'printer', entries: compatible } : conflict(explicit);
    }
    if (mention.models.length && inkEvidence) {
      return models.length ? { token, type: 'model', entries: models } : conflict(mention.models);
    }
    if (models.length && (!printers.length || (!brand && modelKey(token) === '305'))) {
      return { token, type: 'model', entries: models };
    }
    if (printers.length && (!models.length || PRINTER_WORD.test(before))) {
      return { token, type: 'printer', entries: printers };
    }
    if (models.length && printers.length) return { token, type: 'ambiguous', entries: [...models, ...printers] };
    return conflict([...mention.models, ...mention.printers]);
  });
  // Interpretation alone is reusable across campaigns; never cache their coverage here.
  if (dIndex.searchCache.size >= 2000) dIndex.searchCache.delete(dIndex.searchCache.keys().next().value);
  dIndex.searchCache.set(text, resolved);
  return resolved;
}

function cartridgeGroups(entry, dIndex) {
  const groups = new Map();
  for (const i of entry.rows) {
    const term = clean(dIndex.rows[i]?.term);
    const key = unique(split(term).map(modelKey)).sort().join('|');
    const group = groups.get(key) ?? { term, rows: new Set() };
    group.rows.add(i);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Multiple cartridge groups are a confirmed compatibility set only when the
 * D-table gives the printer a complete, stable identity. Bare numbers or rows
 * with a missing/changing series stay conservative and require library review.
 */
function hasConfirmedPrinterIdentity(entry, dIndex) {
  if (entry.kind !== 'printer' || !entry.brand) return false;
  const label = compact(entry.label);
  if (!/[a-z]/.test(label) || !/\d/.test(label)) return false;
  const rows = [...entry.rows].map((i) => dIndex.rows[i]).filter(Boolean);
  const series = rows.map((row) => compact(row.series));
  return rows.length > 0 && series.every(Boolean) && unique(series).length === 1 &&
    rows.every((row) => clean(row.brand).toLowerCase() === entry.brand);
}

const covered = (rows, context) => [...rows].some((i) => context?.expectedRows?.has(i));

function candidateDetails(entries, context, dIndex) {
  return entries.map((entry) => {
    const groups = cartridgeGroups(entry, dIndex);
    const details = groups.map((group) => `${group.term} 墨盒，${covered(group.rows, context) ? '本活动已投放对应系列' : context?.incomplete || !context?.expectedRows?.size ? '已识别投放中未找到对应系列' : '本活动未投放对应系列'}`).join(' / ');
    return `${entry.label}${entry.kind === 'model' ? ' 墨盒' : ''}（${details}）`;
  }).join('；');
}

/** Shared status vocabulary for the search-term table and the analysis panel. */
export function driftPresentation(result) {
  const labels = {
    drift: '疑似跑偏', partial: '部分匹配', review: '需人工判断', brand_conflict: '需核对品牌',
    mapping_conflict: '需核对词库', insufficient: '资料不足', matched: '匹配', unrecognized: '未识别型号',
  };
  return { label: labels[result.status] ?? (result.drift ? labels.drift : labels.review), tone: result.drift ? 'bad' : result.status === 'matched' ? 'good' : 'warn' };
}

export function detectModelDrift(searchTerm, context, dIndex) {
  const resolved = resolveSearchModels(searchTerm, dIndex);
  const findings = [];
  const matched = [];
  const good = [];
  const wrong = [];
  const brandConflicts = new Map();
  const incomplete = context?.incomplete || !context?.expectedRows?.size;
  for (const mention of resolved) {
    const { token, entries, type } = mention;
    if (type === 'brand_conflict') {
      const brands = unique(entries.map((entry) => entry.brand).filter(Boolean)).sort().join('、').toUpperCase();
      const key = `${mention.brand}|${brands}`;
      const conflict = brandConflicts.get(key) ?? { brand: mention.brand.toUpperCase(), brands, labels: [] };
      conflict.labels.push(...entries.map((entry) => entry.label));
      brandConflicts.set(key, conflict);
      continue;
    }
    const mappingConflict = entries.some((entry) => entry.kind === 'printer' && cartridgeGroups(entry, dIndex).length > 1 &&
      !hasConfirmedPrinterIdentity(entry, dIndex));
    if (mappingConflict) {
      findings.push({ token, kind: 'mapping_conflict', series: '', reason: `词库存在同一机型的多组墨盒对应关系：${candidateDetails(entries, context, dIndex)}；尚未确认这些记录是否都兼容，请核对词库` });
      continue;
    }
    const supported = entries.filter((entry) => covered(entry.rows, context));
    if ((type === 'ambiguous' && supported.length !== entries.length) || (entries.length > 1 && supported.length > 0 && supported.length < entries.length)) {
      findings.push({ token, kind: 'review', series: '', reason: `搜索词 ${token} 可对应 ${candidateDetails(entries, context, dIndex)}；未明确${type === 'ambiguous' ? '墨盒或打印机型号' : type === 'model' ? '墨盒品牌' : '打印机系列'}，需要自行判断` });
      continue;
    }
    matched.push(...entries.map((entry) => entry.label));
    if (supported.length === entries.length) {
      good.push(...entries.map((entry) => entry.label));
      continue;
    }
    wrong.push(...entries.map((entry) => entry.label));
    if (entries.length > 1) {
      findings.push({ token, kind: type, series: '', reason: `搜索词 ${token} 可对应 ${candidateDetails(entries, context, dIndex)}；这些候选均未匹配到本活动已识别的投放系列` });
      continue;
    }
    const entry = entries[0];
    const groups = cartridgeGroups(entry, dIndex);
    const series = groups.map((group) => group.term).join(' / ');
    const absence = incomplete ? '本活动已识别投放中未找到' : '本活动中未投放';
    findings.push({ token: entry.label, kind: entry.kind, series,
      reason: entry.kind === 'printer'
        ? groups.length > 1
          ? `${entry.label} 机型兼容 ${series} 墨盒，${absence}上述兼容墨盒系列`
          : `${entry.label} 机型为 ${series} 系列的机型，${absence} ${series} 系列`
        : `${absence} ${entry.label} 系列`,
    });
  }
  for (const conflict of brandConflicts.values()) {
    const labels = unique(conflict.labels).join('、');
    findings.push({ token: labels, kind: 'brand_conflict', series: '', reason: `搜索词写的是 ${conflict.brand}，${labels} 在当前区域词库中归属 ${conflict.brands || '其他品牌'}；请核对品牌是否误写或词库是否缺失` });
  }
  let status = resolved.length ? 'matched' : 'unrecognized';
  if (wrong.length) status = good.length ? 'partial' : 'drift';
  if (good.length && wrong.length) findings.unshift({ token: '', kind: 'partial', series: '', reason: `搜索词部分匹配：${unique(good).join('、')} 已匹配投放系列，${unique(wrong).join('、')} 未匹配；请结合完整搜索需求判断` });
  for (const kind of ['review', 'mapping_conflict', 'brand_conflict']) {
    if (findings.some((finding) => finding.kind === kind)) status = kind;
  }
  if (incomplete && resolved.length) {
    status = 'insufficient';
    const missing = [
      context?.unknownSkus?.length ? `${context.unknownSkus.length} 个 SKU 未入库或未填写型号` : '',
      context?.unmappedModels?.length ? `型号 ${context.unmappedModels.join('、')} 在 D 类词库中缺失或归属不明确` : '',
    ].filter(Boolean).join('；');
    findings.unshift({ token: '', kind: 'insufficient', series: '', reason: `投放型号信息不完整${missing ? `：${missing}` : ''}；请补全投放 SKU 和型号映射后再判断跑偏` });
  }
  return {
    status, drift: status === 'drift', review: !['matched', 'unrecognized', 'drift'].includes(status),
    wrong: incomplete ? [] : unique(wrong), matched: unique(matched),
    findings: findings.filter((finding, i) => findings.findIndex((other) => other.reason === finding.reason) === i),
  };
}
