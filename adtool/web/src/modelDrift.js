import { modelKey } from './skuMatch.js';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

function split(value) {
  return clean(value).split(/[,，、;；/|]+/).map((part) => part.trim()).filter(Boolean);
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a model as a complete token. Thus 305 never matches 3050. */
function aliasRe(alias) {
  const compact = clean(alias).toLowerCase().replace(/[^0-9a-z]+/g, '');
  if (!compact || !/[0-9]/.test(compact)) return null;
  const body = compact.split('').map(escapeRe).join('[^0-9a-z]*');
  return new RegExp(`(^|[^0-9a-z])${body}(?![0-9a-z])`, 'i');
}

/** Build the reusable D-library index. Each alias remembers every row it belongs to. */
export function buildDModelIndex(libData) {
  const spec = (libData?.libs ?? []).find((lib) => lib.id === 'D' || lib.special === 'series');
  const rows = spec ? libData?.items?.[spec.id] ?? [] : [];
  const aliases = new Map();
  rows.forEach((row, rowIndex) => {
    const values = [
      ...split(row.term).map((label) => ({ label, kind: 'model' })),
      ...split(row.printer).map((label) => ({ label, kind: 'printer' })),
    ];
    values.forEach(({ label, kind }) => {
      const re = aliasRe(label);
      if (!re) return;
      const key = clean(label).toLowerCase();
      const entry = aliases.get(`${kind}|${key}`) ?? { label: clean(label), kind, re, rows: new Set() };
      entry.rows.add(rowIndex);
      aliases.set(`${kind}|${key}`, entry);
    });
  });
  const printerNumbers = new Map();
  [...aliases.values()].filter((entry) => entry.kind === 'printer').forEach((entry) => {
    const part = entry.label.toLowerCase().replace(/[^0-9a-z]+/g, '').match(/([a-z]+)(\d[0-9a-z]*)$/);
    if (!part) return;
    const candidate = { ...entry, prefix: part[1], number: part[2] };
    const list = printerNumbers.get(part[2]) ?? [];
    list.push(candidate);
    printerNumbers.set(part[2], list);
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
    if (!numberRe?.test(text) || matched.some((entry) => entry.kind === 'printer' && entry.re.test(text))) continue;
    let possible = candidates;
    const prefixed = candidates.filter((entry) =>
      new RegExp(`(^|[^0-9a-z])${escapeRe(entry.prefix)}[^0-9a-z]*${escapeRe(number)}(?![0-9a-z])`, 'i').test(text)
    );
    if (prefixed.length) possible = prefixed;
    if (possible.length !== 1 || possible[0].rows.size > 1) {
      const beforeNumber = text.slice(0, text.search(numberRe));
      const brandedRows = new Set();
      possible.forEach((entry) => entry.rows.forEach((rowIndex) => {
        const brand = clean(dIndex.rows[rowIndex]?.brand).toLowerCase();
        if (brand && new RegExp(`(^|[^a-z])${escapeRe(brand)}([^a-z]|$)`, 'i').test(beforeNumber)) brandedRows.add(rowIndex);
      }));
      if (brandedRows.size === 1) {
        const rowIndex = [...brandedRows][0];
        const picked = possible.find((entry) => entry.rows.has(rowIndex));
        matched.push({ ...picked, rows: new Set([rowIndex]) });
        continue;
      }
      reviews.push({
        token: number,
        kind: 'review',
        series: '',
        reason: `机型数字 ${number} 可对应 ${[...new Set(possible.map((x) => x.label))].join('、')}；缺少明确的机型系列或 HP/Canon 品牌，需要自行判断`,
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
