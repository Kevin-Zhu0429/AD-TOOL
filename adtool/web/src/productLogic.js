export const PRODUCT_COLUMNS = [
  ['ASIN', 'asin', 'text'], ['SKU', 'sku', 'text'], ['品牌', 'brand', 'text'],
  ['型号', 'model', 'text'], ['颜色', 'color', 'text'], ['色组', 'color_grp', 'text'],
  ['页产量', 'yield', 'int'], ['商品标题', 'title', 'text'], ['价格', 'price', 'num'],
  ['币种', 'currency', 'text'],
  ['Prime价', 'prime_price', 'num'], ['Coupon', 'coupon', 'text'], ['评分', 'rating', 'num'],
  ['评分数', 'reviews', 'int'], ['月新增评分', 'reviews_new', 'int'],
  ['留评率', 'review_rate', 'num'], ['月销量', 'sales', 'int'],
  ['月销售额', 'revenue', 'num'], ['子体销量', 'child_sales', 'int'],
  ['子体销售额', 'child_revenue', 'num'], ['大类BSR', 'bsr_big', 'int'],
  ['小类BSR', 'bsr_small', 'int'], ['小类目', 'cat_small', 'text'],
  ['变体数', 'variants', 'int'], ['FBA', 'fba_fee', 'num'], ['毛利率', 'margin', 'num'],
  ['上架时间', 'listed', 'text'], ['上架天数', 'days', 'int'], ['配送方式', 'ship', 'text'],
  ['卖家数', 'sellers', 'int'], ['Buybox卖家', 'buybox', 'text'],
  ['卖家所属地', 'seller_country', 'text'], ['LQS', 'lqs', 'int'],
  ['A+页面', 'aplus', 'text'], ['视频介绍', 'video', 'text'], ['SP广告', 'sp_ad', 'text'],
  ['品牌故事', 'brand_story', 'text'], ['Best Seller标识', 'best_seller', 'text'],
  ["Amazon's Choice", 'ac', 'text'], ['AC关键词', 'ac_kw', 'text'], ['Q&A数', 'qa', 'int'],
  ['商品重量', 'weight', 'text'], ['商品尺寸', 'size', 'text'], ['父ASIN', 'parent', 'text'],
  ['商品主图', 'image', 'text'], ['商品详情页链接', 'url', 'text'],
  ['产品卖点', 'bullets', 'text'], ['详细参数', 'params', 'text'],
];

export const PRODUCT_FIELDS = PRODUCT_COLUMNS.map(([, field]) => field);
export const PRODUCT_LABELS = Object.fromEntries(PRODUCT_COLUMNS.map(([label, field]) => [field, label]));
export const NUMERIC_FIELDS = new Set(
  PRODUCT_COLUMNS.filter(([, , kind]) => kind === 'num' || kind === 'int').map(([, field]) => field)
);
export const COLOR_GROUPS = ['黑', '彩', '两黑', '两彩', '黑彩', '未知'];
export const EDIT_FIELDS = [
  'brand', 'model', 'color_grp', 'color', 'price', 'rating', 'reviews', 'reviews_new',
  'child_sales', 'sales', 'bsr_small', 'days', 'ship', 'title',
];

const BLACK = 'black|negro|negra|schwarz|noir|nero|preto|zwart|czarny';
const COLOR = 'colou?rs?|tricolou?r|tri-colou?r|multicolou?r|cyan|magenta|yellow|farbe|couleur|colori|kleur';
const COMBO = new RegExp(
  'negro\\s*(y|&|\\+)\\s*colou?r|black\\s*(and|&|\\+|,|\\s)\\s*colou?r|' +
  '\\d\\s*black\\s*\\d\\s*colou?r|\\d\\s*negro\\s*\\d\\s*color|schwarz\\s*(und|&)\\s*farbe', 'i'
);
const TWO_PREFIX = '(?:\\b2\\s*x?\\s*|\\bdos\\s+|\\bdoble\\s+|\\btwin\\s+|\\bpack\\s+of\\s+2\\s+|\\b2er\\s+)';
const TWO_BLACK = new RegExp(`${TWO_PREFIX}(?:${BLACK})`, 'i');
const TWO_COLOR = new RegExp(`${TWO_PREFIX}(?:colou?rs?|tricolou?r|farbe|couleur)`, 'i');
const CODE_SUFFIX = /\d{2,4}\s*xl\s*(bc|bk|b|c)(?![0-9a-z])/i;

const BRAND_STOPWORDS = new Set([
  'cartucho', 'cartuchos', 'cartridge', 'cartridges', 'tinta', 'tintas', 'ink', 'inkjet',
  'toner', 'kit', 'kits', 'pack', 'multipack', 'combo', 'compatible', 'compatibles',
  'remanufactured', 'remanufacturado', 'original', 'originales', 'para', 'for', 'juego',
  'set', 'lot', 'lote', 'xl', 'xxl', 'new', 'premium', 'high', 'upgraded', 'replacement',
  'recycled', 'refill', 'refilled', 'genuine', 'druckerpatronen', 'patronen', 'tinte',
  'encre', 'cartouche', 'cartouches', 'con', 'y', 'de', 'und', 'per', 'avec', 'the', 'a',
]);

export function colorGroup(color, title = '') {
  const blob = `${color ?? ''} ${title ?? ''}`.trim();
  if (!blob) return '未知';
  if (COMBO.test(blob)) return '黑彩';
  const twoBlack = TWO_BLACK.test(blob);
  const twoColor = TWO_COLOR.test(blob);
  if (twoBlack && !twoColor) return '两黑';
  if (twoColor && !twoBlack) return '两彩';
  const code = blob.match(CODE_SUFFIX);
  if (code) return { bc: '黑彩', bk: '黑', b: '黑', c: '彩' }[code[1].toLowerCase()];
  const hasBlack = new RegExp(BLACK, 'i').test(blob);
  const hasColor = new RegExp(COLOR, 'i').test(blob);
  if (hasBlack && hasColor) return '黑彩';
  if (hasBlack) return '黑';
  if (hasColor) return '彩';
  return '未知';
}

export function brandFromTitle(title) {
  const words = String(title ?? '').match(/[0-9A-Za-z.&'-]+/g) ?? [];
  for (const word of words.slice(0, 4)) {
    const clean = word.replace(/^[-.]+|[-.]+$/g, '');
    const low = clean.toLowerCase();
    if (!low || BRAND_STOPWORDS.has(low)) continue;
    if (/\d/.test(clean)) return '';
    if (new RegExp(`^(?:${BLACK}|${COLOR})$`, 'i').test(low)) return '';
    if (clean.length >= 2) return clean;
  }
  return '';
}

export function productNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  const text = String(value).replace(/,/g, '').replace(/[^0-9.-]/g, '');
  if (!text || ['-', '.', '-.'].includes(text)) return '';
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : '';
}

export function deriveProductFields(input) {
  const rec = { ...input };
  const params = String(rec.params ?? '');
  const grab = (label) => {
    const match = params.match(new RegExp(`${label}\\s*[:：]\\s*([^|]+)`, 'i'));
    return match ? match[1].replace(/\s+/g, ' ').trim() : '';
  };
  if (!String(rec.color ?? '').trim()) rec.color = grab('Ink Colou?r');
  if (rec.yield === '' || rec.yield === undefined) rec.yield = productNumber(grab('Page Yield'));
  if (!String(rec.color_grp ?? '').trim()) rec.color_grp = colorGroup(rec.color, rec.title);
  if (!String(rec.brand ?? '').trim()) rec.brand = brandFromTitle(rec.title);
  if (!String(rec.model ?? '').trim()) {
    const source = grab('Model Name') || String(rec.title ?? '');
    const match = source.match(/(\d{2,})\s*(xl)?/i);
    if (match) {
      const digits = match[1];
      let parts = [digits];
      if (digits.length >= 4 && digits.length % 2 === 0) {
        const half = digits.length / 2;
        const a = digits.slice(0, half);
        const b = digits.slice(half);
        if (Number(b) === Number(a) + 1) parts = [a, b];
      }
      rec.model = parts.map((part) => `${part}${match[2] ? 'XL' : ''}`).join('+');
    } else rec.model = '';
  }
  return rec;
}

export function cleanProduct(input) {
  const rec = {};
  for (const field of PRODUCT_FIELDS) {
    const value = input?.[field] ?? '';
    rec[field] = NUMERIC_FIELDS.has(field)
      ? productNumber(value)
      : String(value).replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(input?._manual)) rec._manual = input._manual;
  return deriveProductFields(rec);
}

export function modelKey(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[^0-9a-z]+/g, '');
  const firstDigit = normalized.search(/\d/);
  const core = firstDigit >= 0 ? normalized.slice(firstDigit) : normalized;
  return core.replace(/xl$/i, '') || core;
}

export function average(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

export function median(values) {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function priceStats(products) {
  const values = products.map((item) => item.price).filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!values.length) return null;
  return { min: values[0], max: values.at(-1), average: average(values), median: median(values), count: values.length };
}

export function priceGrade(value, stats) {
  if (typeof value !== 'number' || !stats) return { key: '—', label: '暂无价格', note: '缺少可比价格' };
  if (Math.abs(value - stats.min) < 0.005) return { key: 'D', label: '最低价', note: '价格很有优势' };
  const diff = (value - stats.average) / (stats.average || 1);
  if (diff > 0.05) return { key: 'A', label: '高于均价', note: `高出市场均价 ${(diff * 100).toFixed(0)}%` };
  if (Math.abs(diff) <= 0.05) return { key: 'B', label: '市场均价', note: '处于市场平均价带（±5%）' };
  return { key: 'C', label: '低于均价', note: `低于市场均价 ${Math.abs(diff * 100).toFixed(0)}%` };
}

export function opportunities(products, mine, minSales = 100) {
  if (typeof mine?.price !== 'number' || typeof mine?.rating !== 'number') return [];
  return products.filter((item) => item.asin !== mine.asin
    && typeof item.price === 'number' && item.price > mine.price
    && typeof item.rating === 'number' && item.rating < mine.rating
    && typeof item.child_sales === 'number' && item.child_sales > minSales)
    .sort((a, b) => (b.child_sales ?? 0) - (a.child_sales ?? 0));
}

const HEADER_ALIASES = {
  商品标题: 'title', 标题: 'title', title: 'title', 商品主图: 'image', 主图: 'image', 图片链接: 'image',
  商品详情页链接: 'url', 商品链接: 'url', 链接: 'url', '价格(€)': 'price', '价格($)': 'price', '价格(£)': 'price',
  价格: 'price', 售价: 'price', price: 'price', 墨盒系列: 'model', 颜色套组: 'color_grp',
  'prime价格(€)': 'prime_price', 'prime价格($)': 'prime_price', 'prime价格(£)': 'prime_price', prime价格: 'prime_price',
  '月销售额(€)': 'revenue', '月销售额($)': 'revenue', '月销售额(£)': 'revenue', 月销售额: 'revenue',
  子体销量: 'child_sales', '子体销售额(€)': 'child_revenue', 子体销售额: 'child_revenue',
  '子体销售额($)': 'child_revenue', '子体销售额(£)': 'child_revenue',
  'fba(€)': 'fba_fee', 'fba($)': 'fba_fee', 'fba(£)': 'fba_fee', fba: 'fba_fee', fba费用: 'fba_fee',
  评分数: 'reviews', 评论数: 'reviews', 评价数: 'reviews',
  月新增评分数: 'reviews_new', 月新增评论数: 'reviews_new', 父asin: 'parent', 大类bsr: 'bsr_big', 小类bsr: 'bsr_small',
  'a+页面': 'aplus', 'q&a数': 'qa', "amazon'schoice": 'ac', ac关键词: 'ac_kw', bestseller标识: 'best_seller',
  商品重量单位换算: 'weight', 商品尺寸单位换算: 'size',
};

export const HEADER_MAP = (() => {
  const map = { ...HEADER_ALIASES };
  for (const [label, field] of PRODUCT_COLUMNS) map[label.toLowerCase().replace(/\s/g, '')] = field;
  return map;
})();

export function headerField(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/\s/g, '').replace(/[（）]/g, (x) => x === '（' ? '(' : ')');
  return HEADER_MAP[key];
}

const MARKET_ALIASES = {
  ES: 'ES', 西班牙: 'ES', 西班牙站: 'ES',
  DE: 'DE', 德国: 'DE', 德国站: 'DE',
  FR: 'FR', 法国: 'FR', 法国站: 'FR',
  IT: 'IT', 意大利: 'IT', 意大利站: 'IT',
  UK: 'UK', GB: 'UK', 英国: 'UK', 英国站: 'UK',
  US: 'US', USA: 'US', 美国: 'US', 美国站: 'US',
  CA: 'CA', 加拿大: 'CA', 加拿大站: 'CA',
  AU: 'AU', 澳大利亚: 'AU', 澳大利亚站: 'AU', 澳洲: 'AU', 澳洲站: 'AU',
};

export function marketplaceFromCell(value) {
  return MARKET_ALIASES[String(value ?? '').trim().toUpperCase()] ?? '';
}

/**
 * 从上传文件名提取数据月份。优先识别完整年月；只有“8月”时按上传当年归档。
 * 返回统一的 YYYY-MM，避免同一月份因为文件名写法不同被拆成多份。
 */
export function dataMonthFromFilename(filename, now = new Date()) {
  const name = String(filename ?? '').split(/[\\/]/).at(-1) ?? '';
  const yearMonth = name.match(
    /(?:^|[^0-9])((?:19|20)\d{2})\s*(?:年\s*|[-_.]\s*)?(0?[1-9]|1[0-2])(?:\s*月)?(?=$|[^0-9])/,
  );
  if (yearMonth) return `${yearMonth[1]}-${String(Number(yearMonth[2])).padStart(2, '0')}`;

  const monthOnly = name.match(/(?:^|[^0-9])(0?[1-9]|1[0-2])\s*月(?:份)?(?=$|[^0-9])/);
  if (!monthOnly) return '';
  return `${now.getFullYear()}-${String(Number(monthOnly[1])).padStart(2, '0')}`;
}

export function formatDataMonth(value) {
  if (value === 'legacy') return '历史数据';
  const match = String(value ?? '').match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/);
  return match ? `${match[1]}年${Number(match[2])}月` : '未选择月份';
}

export function isMarketplaceHeader(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/\s/g, '');
  return ['国家', '国家代码', '站点', '站点码', 'marketplace', 'market', 'country'].includes(key);
}

export function currencyFromHeader(value) {
  const text = String(value ?? '');
  if (text.includes('$')) return 'USD';
  if (text.includes('£')) return 'GBP';
  if (text.includes('€')) return 'EUR';
  return '';
}

export function parseProductRows(rows, fallbackMarket = '') {
  const headerIndex = rows.findIndex((row) => row.some((cell) => headerField(cell) === 'asin'));
  if (headerIndex < 0) throw new Error('表格里找不到 ASIN 表头，请使用产品数据表');

  const positions = {};
  let marketplaceIndex = -1;
  rows[headerIndex].forEach((cell, index) => {
    const field = headerField(cell);
    if (field && positions[field] === undefined) positions[field] = index;
    if (marketplaceIndex < 0 && isMarketplaceHeader(cell)) marketplaceIndex = index;
  });
  const fallback = marketplaceFromCell(fallbackMarket);
  if (marketplaceIndex < 0 && !fallback) throw new Error('表格没有国家列，也无法确定当前站点');

  const priceCurrency = positions.price === undefined ? '' : currencyFromHeader(rows[headerIndex][positions.price]);
  const productsByMarketplace = {};
  const unknownMarkets = new Set();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const asin = positions.asin === undefined ? '' : String(row[positions.asin] ?? '').trim();
    if (!asin) continue;
    const marketplace = marketplaceIndex < 0 ? fallback : marketplaceFromCell(row[marketplaceIndex]);
    if (!marketplace) {
      unknownMarkets.add(String(row[marketplaceIndex] ?? '').trim() || '空白');
      skipped += 1;
      continue;
    }
    const raw = {};
    for (const [, field] of PRODUCT_COLUMNS) {
      raw[field] = positions[field] === undefined ? '' : row[positions[field]];
    }
    if (!raw.currency && priceCurrency) raw.currency = priceCurrency;
    (productsByMarketplace[marketplace] ??= []).push(cleanProduct(raw));
  }
  if (unknownMarkets.size) {
    throw new Error(`国家列存在无法识别的值：${[...unknownMarkets].slice(0, 8).join('、')}`);
  }
  const total = Object.values(productsByMarketplace).reduce((sum, products) => sum + products.length, 0);
  if (!total) throw new Error('没有读到有效产品；每行都需要有 ASIN 和可识别的国家');
  return { productsByMarketplace, total, skipped, headerIndex, hasMarketplaceColumn: marketplaceIndex >= 0 };
}

export function fmt(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function money(value, currency = 'EUR') {
  if (typeof value !== 'number') return '—';
  const symbol = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' }[currency] ?? `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}
