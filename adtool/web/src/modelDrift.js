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
  return { rows, aliases: [...aliases.values()] };
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
  if (!context?.expectedRows?.size) return { drift: false, wrong: [], matched: [], findings: [] };
  const text = clean(searchTerm).toLowerCase();
  const matched = dIndex.aliases.filter((entry) => entry.re.test(text));
  const wrong = matched.filter((entry) => ![...entry.rows].some((row) => context.expectedRows.has(row)));
  const findings = wrong.map((entry) => {
    const row = dIndex.rows[[...entry.rows][0]] ?? {};
    const series = clean(row.term);
    const reason = entry.kind === 'printer'
      ? `${entry.label} 机型为 ${series} 系列的机型，本活动中未投放 ${series} 系列`
      : `本活动中未投放 ${entry.label} 系列`;
    return { token: entry.label, kind: entry.kind, series, reason };
  });
  return {
    drift: findings.length > 0,
    wrong: findings.map((x) => x.token),
    matched: matched.map((x) => x.label),
    findings,
  };
}
