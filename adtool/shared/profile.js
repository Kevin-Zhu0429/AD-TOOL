export function getProfile(id = 'ink') {
  if (!['ink', 'pet'].includes(id)) throw new Error(`未知品类配置：${id}`);
  const pet = id === 'pet';
  return Object.freeze({ id, name: pet ? '宠物广告工作台' : '广告工作台',
    markets: pet ? ['US'] : ['ES', 'DE', 'FR', 'IT', 'UK', 'US', 'CA', 'AU'],
    defaultMarket: pet ? 'US' : 'ES', currency: pet ? 'USD' : null,
    negativeLibrary: !pet, modelRecognition: !pet, automaticPortfolio: !pet });
}

export const PET_SKU_FIELDS = [
  { key: 'sku', label: 'SKU', required: true, width: 28, hint: '美国站卖家 SKU，一行一个' },
  { key: 'style', label: '款式', width: 18, hint: '如雨衣 A 款，保留完整款式名称' },
  { key: 'size', label: '尺码', width: 10, hint: '如 S、M、L、XL；不同尺码分别保存' },
  { key: 'color', label: '颜色', width: 12, hint: '商品实际颜色' },
  { key: 'fabric', label: '面料外观', width: 22, hint: '如防水涂层 / 纯色，暂用一个文本字段' },
  { key: 'stock', label: '在库库存', num: true, width: 12, hint: '非负整数；空白表示未知' },
  { key: 'transit', label: '在途库存', num: true, width: 12, hint: '非负整数；空白表示未知' },
  { key: 'brand', label: '品牌', width: 14, hint: '用于筛选及库存店铺绑定' },
  { key: 'asin', label: 'ASIN', width: 16, hint: '选填，10 位字母数字，用于关联 ABA 报告' },
];

export function searchPetSkus(items, query, facets = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  return items.filter((item) => Object.entries(facets).every(([key, value]) => !value || item[key] === value)
    && (!q || PET_SKU_FIELDS.some(({ key, num }) => !num && String(item[key] ?? '').toLowerCase().includes(q))));
}
