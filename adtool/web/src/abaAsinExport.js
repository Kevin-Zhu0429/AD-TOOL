import { ASIN_COLUMNS } from '../../shared/abaAsin.js';

export const ASIN_GROUP_EXPORT_COLUMNS = [
  { key: 'sku', label: 'SKU', text: true },
  { key: 'recognition', label: '机型分类', text: true },
  { key: 'query', label: '搜索词', text: true },
  { key: 'asin', label: 'ASIN', text: true },
  ...ASIN_COLUMNS.slice(2),
];

export function skusForAsinRow(row, data, params = {}) {
  const asins = row.asins ?? [row.asin];
  return (data.skuItems ?? []).filter((sku) => asins.includes(sku.asin)
    && (!params.skuId || String(sku.id) === String(params.skuId))
    && (!data.selectedModel || data.selectedModel.skuIds.includes(sku.id)));
}

function identitiesForAsinRow(row, data, params) {
  const asins = [...new Set((row.asins ?? [row.asin]).filter(Boolean))];
  if (!asins.length) return [{ asin: '', sku: '' }];

  const linkedSkus = skusForAsinRow(row, data, params);
  return asins.flatMap((asin) => {
    const skus = [...new Set(linkedSkus
      .filter((item) => item.asin === asin)
      .map((item) => item.sku)
      .filter(Boolean))];
    return skus.length
      ? skus.map((sku) => ({ asin, sku }))
      : [{ asin, sku: '' }];
  });
}

// Market totals repeat on every SKU row of a search term, so exports split each
// week's totals across the SKU rows whose ASIN has a report for that week.
const SHARED_MARKET_KEYS = ['market_impressions', 'market_clicks', 'market_purchases'];

// Rows without per-week data carry one already-aggregated total.
const marketWeeks = (row) => row.market_weeks?.length ? row.market_weeks
  : [{ week_end: '', ...Object.fromEntries(SHARED_MARKET_KEYS.map((key) => [key, row[key]])) }];

function splitMarketTotals(entries, average) {
  const terms = new Map();
  for (const entry of entries) {
    if (!terms.has(entry.termKey)) terms.set(entry.termKey, new Map());
    const weekCounts = terms.get(entry.termKey);
    for (const week of marketWeeks(entry.queryRow)) weekCounts.set(week.week_end, (weekCounts.get(week.week_end) ?? 0) + 1);
  }
  return entries.map(({ queryRow, termKey }) => {
    const weekCounts = terms.get(termKey);
    const averageWeeks = average && queryRow.market_weeks?.length ? weekCounts.size : 1;
    return Object.fromEntries(SHARED_MARKET_KEYS.map((key) => {
      let total = 0;
      for (const week of marketWeeks(queryRow)) {
        if (week[key] === null || week[key] === undefined) return [key, null];
        total += week[key] / weekCounts.get(week.week_end);
      }
      return [key, total / averageWeeks];
    }));
  });
}

export function buildAsinGroupExport(data, params = {}) {
  const entries = (data.items ?? []).flatMap((group) => {
    const queryRows = group.query_rows?.length ? group.query_rows : [{ ...group, query: '' }];
    return queryRows.flatMap((queryRow) => identitiesForAsinRow(queryRow, data, params)
      .map((identity) => ({ group, queryRow, identity, termKey: JSON.stringify([group.recognition, queryRow.query]) })));
  });
  const markets = splitMarketTotals(entries, data.aggregation === 'average');
  const rows = entries.map(({ group, queryRow, identity }, index) => ASIN_GROUP_EXPORT_COLUMNS.map((column) => {
    if (column.key === 'sku') return identity.sku;
    if (column.key === 'recognition') return group.recognition;
    if (column.key === 'asin') return identity.asin;
    const value = column.key in markets[index] ? markets[index][column.key] : queryRow[column.key];
    if (value === null || value === undefined) return '';
    return column.rate ? value / 100 : value;
  }));
  return { columns: ASIN_GROUP_EXPORT_COLUMNS, rows };
}
