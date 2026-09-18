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

export function buildAsinGroupExport(data, params = {}) {
  const rows = (data.items ?? []).flatMap((group) => {
    const queryRows = group.query_rows?.length ? group.query_rows : [{ ...group, query: '' }];
    return queryRows.flatMap((queryRow) => identitiesForAsinRow(queryRow, data, params).map((identity) => (
      ASIN_GROUP_EXPORT_COLUMNS.map((column) => {
        if (column.key === 'sku') return identity.sku;
        if (column.key === 'recognition') return group.recognition;
        if (column.key === 'asin') return identity.asin;
        const value = queryRow[column.key];
        if (value === null || value === undefined) return '';
        return column.rate ? value / 100 : value;
      })
    )));
  });
  return { columns: ASIN_GROUP_EXPORT_COLUMNS, rows };
}
