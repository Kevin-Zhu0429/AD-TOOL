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

export function buildAsinGroupExport(data, params = {}) {
  const rows = (data.items ?? []).flatMap((group) => (group.query_rows?.length ? group.query_rows : [{ ...group, query: '' }]).map((queryRow) => {
    const asins = (queryRow.asins ?? [queryRow.asin]).filter(Boolean);
    const skus = [...new Set(skusForAsinRow(queryRow, data, params).map((item) => item.sku).filter(Boolean))];
    return ASIN_GROUP_EXPORT_COLUMNS.map((column) => {
      if (column.key === 'sku') return skus.join('\n');
      if (column.key === 'recognition') return group.recognition;
      if (column.key === 'asin') return asins.join('\n');
      const value = queryRow[column.key];
      if (value === null || value === undefined) return '';
      return column.rate ? value / 100 : value;
    });
  }));
  return { columns: ASIN_GROUP_EXPORT_COLUMNS, rows };
}
