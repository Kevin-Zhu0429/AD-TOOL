export const PET_PRODUCT_COLUMNS = [
  { key: 'asin', label: 'ASIN', required: true },
  { key: 'brand', label: '品牌' }, { key: 'title', label: '标题' },
  { key: 'product_type', label: '产品类型' }, { key: 'style', label: '款式' },
  { key: 'size', label: '尺码' }, { key: 'color', label: '颜色' }, { key: 'fabric', label: '面料外观' },
  { key: 'comparison_group', label: '对比组' }, { key: 'is_own', label: '自家产品', bool: true },
  { key: 'price', label: '价格 USD', num: true }, { key: 'coupon', label: '优惠说明' },
  { key: 'rating', label: '评分', num: true }, { key: 'reviews', label: '评论数', num: true, int: true },
  { key: 'sales', label: '销量', num: true, int: true }, { key: 'bsr_small', label: '类目排名', num: true, int: true },
  { key: 'parent', label: '父 ASIN' },
];
export const PET_MANUAL_FIELDS = ['brand', 'product_type', 'style', 'size', 'color', 'fabric', 'comparison_group', 'is_own'];

export function normalizePetProduct(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('产品数据必须是一行记录');
  if (input.country && !/^(US|美国|美国站)$/i.test(String(input.country).trim())) throw new Error('宠物版仅支持美国站 US');
  const result = {};
  for (const column of PET_PRODUCT_COLUMNS) {
    const raw = input[column.key];
    const text = raw == null ? '' : String(raw).trim();
    if (column.bool) {
      if (!text || /^(false|0|否|no)$/i.test(text)) result[column.key] = false;
      else if (/^(true|1|是|yes)$/i.test(text)) result[column.key] = true;
      else throw new Error(`${column.label}请填写“是”或“否”`);
    } else if (column.num) {
      if (!text || text === '—' || text === '-') { result[column.key] = null; continue; }
      const numeric = text.replace(/[$,\s]/g, '');
      if (!/^\d+(\.\d+)?$/.test(numeric)) throw new Error(`${column.label}须为非负数`);
      const value = Number(numeric);
      if (!Number.isFinite(value) || (column.int && !Number.isSafeInteger(value))) throw new Error(`${column.label}须为非负整数`);
      if (column.key === 'rating' && value > 5) throw new Error('评分不能超过 5');
      result[column.key] = value;
    } else result[column.key] = text.replace(/\s+/g, ' ').slice(0, column.key === 'title' ? 5000 : 500);
  }
  result.asin = result.asin.toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(result.asin)) throw new Error('ASIN 须为 10 位字母或数字');
  result.parent = result.parent.toUpperCase();
  if (result.parent && !/^[A-Z0-9]{10}$/.test(result.parent)) throw new Error('父 ASIN 须为 10 位字母或数字');
  result.currency = 'USD';
  result.country = 'US';
  result.model = ''; result.color_grp = '';
  result._manual = Array.isArray(input._manual) ? input._manual.filter((key) => PET_MANUAL_FIELDS.includes(key)) : [];
  return result;
}

const aliases = {
  asin: /^(asin|子asin|商品asin)$/i, parent: /^(父asin|parent\s*asin)$/i,
  brand: /^(品牌|brand)$/i, title: /^(标题|产品标题|商品标题|title|product title)$/i,
  product_type: /^(产品类型|品类|product_type|product type)$/i, style: /^(款式|style)$/i,
  size: /^(尺码|size)$/i, color: /^(颜色|colou?r)$/i, fabric: /^(面料外观|面料|fabric)$/i,
  price: /^(价格(\s*USD|\(\$\))?|price(\s*USD)?)$/i, coupon: /^(优惠说明|优惠|coupon)$/i,
  rating: /^(评分|rating)$/i, reviews: /^(评论数|评价数|reviews)$/i,
  sales: /^(销量|月销量|sales)$/i, bsr_small: /^(类目排名|小类排名|bsr)$/i,
};
export function petHeaderMap(headers) {
  return Object.fromEntries(PET_PRODUCT_COLUMNS.map((c) => [c.key, headers.findIndex((h) => String(h).trim() === c.label || aliases[c.key]?.test(String(h).trim()))]));
}
export function parsePetProductSheet(sheet, mapping) {
  if (mapping.asin == null || Number(mapping.asin) < 0) throw new Error('请指定 ASIN 对应列');
  const columns = Object.values(mapping).filter((i) => Number(i) >= 0).map(Number);
  if (new Set(columns).size !== columns.length) throw new Error('同一原始列不能映射到多个字段');
  const countryIndex = (sheet[0] ?? []).findIndex((h) => /^(国家|站点|country|marketplace)$/i.test(String(h).trim()));
  const products = [], seen = new Set();
  for (let i = 1; i < sheet.length; i++) {
    const row = sheet[i];
    if (!row.some((value) => String(value ?? '').trim())) continue;
    const raw = Object.fromEntries(PET_PRODUCT_COLUMNS.map((c) => [c.key, Number(mapping[c.key]) >= 0 ? row[Number(mapping[c.key])] ?? '' : '']));
    if (countryIndex >= 0) raw.country = row[countryIndex];
    try {
      const product = normalizePetProduct(raw);
      if (seen.has(product.asin)) throw new Error(`ASIN ${product.asin} 在文件中重复，请先合并或移除重复行`);
      seen.add(product.asin); products.push(product);
    } catch (e) { throw new Error(`第 ${i + 1} 行：${e.message}`); }
  }
  if (!products.length) throw new Error('未找到产品数据行');
  if (products.length > 20000) throw new Error('一次最多导入 20000 行');
  return products;
}
