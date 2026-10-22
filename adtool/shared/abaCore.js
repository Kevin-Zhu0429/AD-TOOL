import { modelKey } from './skuMatch.js';

const clean = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[‐‑–—]/g, '-');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ASIN-only classification. Core names describe OEM demand, never the seller SKU brand. */
export function abaCoreMatcher(dRows = []) {
  const brandNames = new Set(['hp', 'canon', 'epson', 'brother', ...dRows.map((r) => clean(r.brand).trim()).filter(Boolean)]);
  const knownModels = new Map();
  for (const row of dRows) {
    const brand = clean(row.brand).trim();
    if (!knownModels.has(brand)) knownModels.set(brand, new Set());
    for (const term of String(row.term ?? '').split(/[,，、;；/|]+/)) {
      const model = modelKey(term);
      if (/^\d{2,3}$/.test(model)) knownModels.get(brand).add(model);
    }
  }
  const cache = new Map();
  return (query) => {
    if (cache.has(query)) return cache.get(query);
    const text = clean(query).replace(/\bhewlett[ -]*packard\b/g, 'hp')
      .replace(/\bcanon(?=(?:pg|cl)[ -]?\d)/g, 'canon ')
      .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/(\d\s*xl)(?=[a-z])/g, '$1 ');
    const numbers = text.match(/\d+/g) ?? [];
    const printerNumbers = [...new Set(numbers.filter((n) => n.length === 4))].sort();
    const brands = [...brandNames].filter((brand) => new RegExp(`(^|[^a-z])${escape(brand)}(?=$|[^a-z])`, 'i').test(text));
    const candidates = [...new Set(numbers.filter((n) => /^\d{2,3}$/.test(n)))].sort((a, b) => Number(a) - Number(b));
    let core = { key: 'core:unrecognized', label: '未识别核心词', kind: 'core' };
    if (numbers.every((n) => n.length < 2)) core = { key: 'core:generic', label: '超大词', kind: 'core' };
    if (!printerNumbers.length && brands.length <= 1 && candidates.length) {
      // A bare model is enough. Resolve its OEM only from the model library,
      // never from the report's seller brand, ASIN or SKU.
      const known = candidates.filter((n) => brands.length
        ? knownModels.get(brands[0])?.has(n)
        : [...knownModels.values()].some((models) => models.has(n)));
      const models = known.length ? known : candidates;
      const inferredBrands = [...knownModels].filter(([, terms]) => models.every((model) => terms.has(model))).map(([brand]) => brand);
      const brand = brands[0] ?? (inferredBrands.length === 1 ? inferredBrands[0] : '');
      core = { key: `core:model:${brand}|${models.join('/')}`,
        label: [brand.toUpperCase(), models.join(' / ')].filter(Boolean).join(' '), kind: 'core' };
    }
    if (!printerNumbers.length && brands.length > 1 && candidates.length)
      core = { key: 'core:review', label: '多品牌 / 待核对', kind: 'core' };
    const result = { core, printerNumbers,
      printerGroup: { key: `unmapped-printer:${printerNumbers.join('/')}`, label: `待识别机型 ${printerNumbers.join(' / ')}`, kind: 'review' } };
    if (cache.size >= 2000) cache.clear();
    cache.set(query, result);
    return result;
  };
}
