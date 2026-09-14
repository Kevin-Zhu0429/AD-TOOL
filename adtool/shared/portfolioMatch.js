import { modelKey } from './skuMatch.js';

const clean = (value) => String(value ?? '').trim();

export function portfolioSeriesKey(name) {
  const text = clean(name);
  const match = text.match(/([a-z]*-?\d+[a-z]*)\s*(?:series\b|系列)/i);
  return match ? modelKey(match[1]) : '';
}

export function isMixedPortfolio(name) {
  return /混投|mixed/i.test(clean(name));
}

export function resolvePortfolio(skusText, skuItems = [], portfolios = []) {
  const skus = clean(skusText)
    .replace(/\r/g, '\n')
    .split('\n')
    .map(clean)
    .filter(Boolean);
  if (!skus.length) {
    return { status: 'empty', portfolioId: '', message: '填写投放 SKU 后自动匹配广告组合。', series: [] };
  }

  const skuIndex = new Map(skuItems.map((item) => [clean(item.sku).toLowerCase(), item]));
  const missing = [];
  const noModel = [];
  const series = new Set();
  for (const sku of skus) {
    const item = skuIndex.get(sku.toLowerCase());
    if (!item) {
      missing.push(sku);
      continue;
    }
    const key = modelKey(item.model);
    if (!key) noModel.push(sku);
    else series.add(key);
  }

  if (missing.length) {
    return {
      status: 'missing-sku', portfolioId: '', series: [...series],
      message: `${missing.slice(0, 3).join('、')}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}未在当前站点 SKU 库中，无法确认广告组合。`,
    };
  }
  if (noModel.length) {
    return {
      status: 'missing-model', portfolioId: '', series: [...series],
      message: `${noModel.slice(0, 3).join('、')}${noModel.length > 3 ? ` 等 ${noModel.length} 个` : ''}未填写型号，请先补全 SKU 库。`,
    };
  }

  const keys = [...series].sort();
  const missingSeries = keys.filter((key) => !portfolios.some((item) => portfolioSeriesKey(item.name) === key));
  if (missingSeries.length) {
    const labels = missingSeries.map((key) => `${key} Series`).join('、');
    return {
      status: 'missing-portfolio', portfolioId: '', series: keys,
      message: `广告组合库里没有“${labels}”对应组合，请先补充或手动选择。`,
    };
  }
  const candidates = keys.length > 1
    ? portfolios.filter((item) => isMixedPortfolio(item.name))
    : portfolios.filter((item) => portfolioSeriesKey(item.name) === keys[0]);
  const target = keys.length > 1 ? '混投' : `${keys[0]} Series`;
  if (!candidates.length) {
    return {
      status: 'missing-portfolio', portfolioId: '', series: keys,
      message: `广告组合库里没有“${target}”对应组合，请先补充或手动选择。`,
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous', portfolioId: '', series: keys,
      message: `广告组合库里有 ${candidates.length} 个“${target}”候选，请手动选择。`,
    };
  }
  return {
    status: 'matched', portfolioId: clean(candidates[0].portfolioId), portfolio: candidates[0], series: keys,
    message: `${keys.length > 1 ? `识别到 ${keys.join('、')} 多个系列` : `识别为 ${target}`}，已自动选择 ${candidates[0].name}。`,
  };
}
