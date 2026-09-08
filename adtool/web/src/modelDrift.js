import { modelKey } from './skuMatch.js';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

function split(value) {
  return clean(value).split(/[,，、;；/|]+/).map((part) => part.trim()).filter(Boolean);
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a model as a complete token. Thus 305 never matches 3050. */
function aliasRe(alias, allowXl = false) {
  const compact = clean(alias).toLowerCase().replace(/[^0-9a-z]+/g, '');
  if (!compact || !/[0-9]/.test(compact)) return null;
  const body = compact.split('').map(escapeRe).join('[^0-9a-z]*');
  const xl = allowXl && !compact.endsWith('xl') ? '(?:[^0-9a-z]*xl)?' : '';
  return new RegExp(`(^|[^0-9a-z])${body}${xl}(?![0-9a-z])`, 'i');
}

/** Build the reusable D-library index. Each alias remembers every row it belongs to. */
export function buildDModelIndex(libData) {
  const spec = (libData?.libs ?? []).find((lib) => lib.id === 'D' || lib.special === 'series');
  const rows = spec ? libData?.items?.[spec.id] ?? [] : [];
  const aliases = new Map();
  const printerNumbers = new Map();

  const addAlias = (label, kind, rowIndex) => {
    const re = aliasRe(label, kind === 'model');
    if (!re) return null;
    const key = `${kind}|${clean(label).toLowerCase()}`;
    const entry = aliases.get(key) ?? { label: clean(label), kind, re, rows: new Set() };
    entry.rows.add(rowIndex);
    aliases.set(key, entry);
    return entry;
  };
  const addPrinterNumber = (number, candidate) => {
    const list = printerNumbers.get(number) ?? [];
    if (!list.some((item) => item.label.toLowerCase() === candidate.label.toLowerCase() && item.rows.has([...candidate.rows][0]))) {
      list.push(candidate);
    }
    printerNumbers.set(number, list);
  };

  rows.forEach((row, rowIndex) => {
    split(row.term).forEach((label) => addAlias(label, 'model', rowIndex));
    split(row.printer).forEach((printer) => {
      const compact = printer.toLowerCase().replace(/[^0-9a-z]+/g, '');
      const full = compact.match(/^([a-z]+)(\d[0-9a-z]*)$/);
      if (full) {
        const entry = addAlias(printer, 'printer', rowIndex);
        if (entry) addPrinterNumber(full[2], { ...entry, prefix: full[1], number: full[2], rows: new Set([rowIndex]) });
        return;
      }
      const number = compact.match(/^\d[0-9a-z]*$/)?.[0];
      if (!number) return;
      // D 表经常把系列和数字分列存成 “MG | 3550”。组合后才是完整打印机机型。
      const series = clean(row.series).toLowerCase().match(/([a-z][0-9a-z]*)\s*$/)?.[1] ?? '';
      const label = series ? `${series.toUpperCase()}${clean(printer)}` : clean(printer);
      const entry = series ? addAlias(label, 'printer', rowIndex) : { label, kind: 'printer', rows: new Set([rowIndex]) };
      addPrinterNumber(number, { ...entry, prefix: series, number, rows: new Set([rowIndex]) });
    });
  });
  return { rows, aliases: [...aliases.values()], printerNumbers };
}

/** Resolve every advertised SKU in a campaign to its model in the account SKU library. */
export function campaignModelContext(campaign, skuItems, dIndex) {
  const bySku = new Map((skuItems ?? []).map((item) => [clean(item.sku).toLowerCase(), item]));
  const models = new Set();
  const expectedRows = new Set();
  const unknownSkus = [];
  (campaign?.ads ?? []).forEach((ad) => {
    const sku = clean(ad.sku);
    if (!sku) return;
    const item = bySku.get(sku.toLowerCase());
    const key = modelKey(item?.model);
    if (!key) { unknownSkus.push(sku); return; }
    models.add(clean(item.model));
    dIndex.rows.forEach((row, i) => {
      if (split(row.term).some((term) => modelKey(term) === key)) expectedRows.add(i);
    });
  });
  return { models: [...models], expectedRows, unknownSkus };
}

/**
 * Return only recognized D-library model tokens that do not belong to an advertised model.
 * Ordinary search terms (and campaigns whose SKU/model cannot be resolved) are never flagged.
 */
export function detectModelDrift(searchTerm, context, dIndex) {
  if (!context?.expectedRows?.size) return { drift: false, review: false, wrong: [], matched: [], findings: [] };
  const text = clean(searchTerm).toLowerCase();
  const matched = dIndex.aliases.filter((entry) => entry.re.test(text));
  const reviews = [];
  for (const [number, candidates] of dIndex.printerNumbers ?? []) {
    const numberRe = aliasRe(number);
    if (!numberRe?.test(text)) continue;
    const compactOf = (entry) => entry.label.toLowerCase().replace(/[^0-9a-z]+/g, '').replace(/xl$/, '');
    const exactPrinter = matched.some((entry) => entry.kind === 'printer' && compactOf(entry).endsWith(number));
    if (exactPrinter) continue;

    const relevantModels = matched.filter((entry) => entry.kind === 'model' && compactOf(entry) === number);
    const removeRelevantModels = () => relevantModels.forEach((entry) => {
      const i = matched.indexOf(entry); if (i >= 0) matched.splice(i, 1);
    });
    let possible = candidates;
    const prefixed = candidates.filter((entry) =>
      new RegExp(`(^|[^0-9a-z])${escapeRe(entry.prefix)}[^0-9a-z]*${escapeRe(number)}(?![0-9a-z])`, 'i').test(text)
    );
    const beforeNumber = text.slice(0, text.search(numberRe));
    if (prefixed.length) {
      removeRelevantModels();
      possible = prefixed;
    } else {
      const mentionedBrands = new Set();
      dIndex.rows.forEach((row) => {
        const brand = clean(row.brand).toLowerCase();
        if (brand && new RegExp(`(^|[^a-z])${escapeRe(brand)}([^a-z]|$)`, 'i').test(beforeNumber)) mentionedBrands.add(brand);
      });
      if (!mentionedBrands.size) {
        if (relevantModels.length && /(^|[^a-z])(ink|cartridge|cartucho|tinta|toner)([^a-z]|$)|\d[^0-9a-z]*xl(?![0-9a-z])/i.test(text)) continue;
        if (!relevantModels.length && candidates.length === 1 && candidates[0].rows.size === 1) {
          matched.push(candidates[0]);
          continue;
        }
        removeRelevantModels();
        reviews.push({
          token: number, kind: 'review', series: '',
          reason: relevantModels.length
            ? `数字 ${number} 既可能是墨盒型号，也可能对应 ${[...new Set(candidates.map((x) => x.label))].join('、')} 机型；搜索词没有明确的机型系列或品牌，需要自行判断`
            : `机型数字 ${number} 可对应 ${[...new Set(candidates.map((x) => x.label))].join('、')}；搜索词没有明确的机型系列或品牌，需要自行判断`,
        });
        continue;
      }
      const modelFitsBrand = relevantModels.some((entry) => [...entry.rows].some((rowIndex) =>
        mentionedBrands.has(clean(dIndex.rows[rowIndex]?.brand).toLowerCase())
      ));
      possible = candidates.filter((entry) => [...entry.rows].some((rowIndex) =>
        mentionedBrands.has(clean(dIndex.rows[rowIndex]?.brand).toLowerCase())
      ));
      // “HP 305” belongs to the HP ink row, not Canon's TS305 printer row.
      if (modelFitsBrand && !possible.length) continue;
      if (modelFitsBrand && possible.length) {
        removeRelevantModels();
        reviews.push({
          token: number, kind: 'review', series: '',
          reason: `品牌和数字 ${number} 同时命中墨盒型号及打印机机型，需要自行判断`,
        });
        continue;
      }
      if (!possible.length) continue;
      removeRelevantModels();
    }
    if (possible.length !== 1 || possible[0].rows.size > 1) {
      reviews.push({
        token: number, kind: 'review', series: '',
        reason: `机型数字 ${number} 可对应 ${[...new Set(possible.map((x) => x.label))].join('、')}；当前信息仍无法确定，需要自行判断`,
      });
      continue;
    }
    matched.push(possible[0]);
  }
  const wrong = matched.filter((entry) => ![...entry.rows].some((row) => context.expectedRows.has(row)));
  const driftFindings = wrong.map((entry) => {
    const row = dIndex.rows[[...entry.rows][0]] ?? {};
    const series = clean(row.term);
    const reason = entry.kind === 'printer'
      ? `${entry.label} 机型为 ${series} 系列的机型，本活动中未投放 ${series} 系列`
      : `本活动中未投放 ${entry.label} 系列`;
    return { token: entry.label, kind: entry.kind, series, reason };
  });
  const findings = [...driftFindings, ...reviews];
  return {
    drift: driftFindings.length > 0,
    review: reviews.length > 0,
    wrong: driftFindings.map((x) => x.token),
    matched: matched.map((x) => x.label),
    findings,
  };
}
