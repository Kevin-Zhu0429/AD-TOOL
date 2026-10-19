export const ABA_SKU_COLUMNS = [
  { key: 'country', label: '国家', required: true },
  { key: 'brand', label: '品牌', required: true },
  { key: 'sku', label: 'SKU', required: true },
  { key: 'asin', label: 'ASIN', required: true },
  { key: 'model', label: '墨盒型号', required: true },
  { key: 'setGroup', label: '颜色 / 套组' },
];
const aliases = {
  country: ['国家', '站点', '市场', 'country', 'marketplace', 'market'],
  brand: ['品牌', 'brand'], sku: ['sku', '卖家sku', '商品sku', 'sellersku'],
  asin: ['asin', '子asin', '商品asin'], model: ['墨盒型号', '型号', 'model', '墨盒系列'],
  setGroup: ['颜色/套组', '套组', '颜色', '颜色套组', '套装', 'setgroup', 'set_group', 'pack'],
};
const clean = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');

/** All worksheets use named columns; never infer an ASIN or country from filenames. */
export function parseAbaSkuSheets(sheets) {
  const rows = [];
  for (const sheet of sheets) {
    const nonempty = sheet.rows.filter((r) => r.some((v) => String(v ?? '').trim()));
    if (!nonempty.length || sheet.name === '填写说明') continue;
    const header = nonempty[0].map(clean);
    const positions = {};
    for (const column of ABA_SKU_COLUMNS) {
      const matches = header.flatMap((h, i) => aliases[column.key].includes(h) ? [i] : []);
      if (matches.length > 1) throw new Error(`工作表“${sheet.name}”的“${column.label}”列重复`);
      if (column.required && !matches.length) throw new Error(`工作表“${sheet.name}”缺少“${column.label}”列，请使用模板`);
      if (matches.length) positions[column.key] = matches[0];
    }
    for (const values of nonempty.slice(1)) rows.push(Object.fromEntries(ABA_SKU_COLUMNS.map((c) => [c.key, values[positions[c.key]] ?? ''])));
    if (rows.length > 50000) throw new Error('一次最多上传 50,000 条 SKU 记录');
  }
  if (!rows.length) throw new Error('文件没有 SKU 数据，请填写模板后上传');
  return rows;
}
