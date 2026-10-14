// Listing 属性的通用处理:亚马逊商品类型定义(每个属性叫什么、能填什么)、属性值的整理和比较。
// 「Listing」板块和待确认改动队列共用。商品类型定义按类型缓存在库里,一天刷新一次。
import { db } from './db.js';
import { amazonGateway, US_MARKETPLACE } from './petAmazon.js';

// 这些属性不在通用编辑里改:报价用售价/促销价改,变体关系和商品编码改错了会拆掉父子体或建出新商品
export const READ_ONLY_ATTRS = {
  purchasable_offer: '售价和促销价请用上面的「售价」「促销价」改',
  fulfillment_availability: 'FBA 库存由亚马逊仓库决定',
  externally_assigned_product_identifier: 'UPC/EAN 改错会被当成另一个商品，请在卖家后台改',
  merchant_suggested_asin: 'ASIN 匹配请在卖家后台改',
  child_parent_sku_relationship: '父子体关系请在卖家后台「变体」里改',
  parentage_level: '父子体关系请在卖家后台「变体」里改',
  variation_theme: '变体主题请在卖家后台「变体」里改',
};
// 有专门改动类型的属性:走标题 / 五点 / 后台搜索词那套检查
export const DEDICATED_ATTRS = { item_name: 'listing_title', bullet_point: 'listing_bullets', generic_keyword: 'listing_search_terms' };
export const MAX_ATTR_BYTES = 20_000;
const SCHEMA_TTL_HOURS = 24;

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const forUs = (entry) => !isObject(entry) || !entry.marketplace_id || entry.marketplace_id === US_MARKETPLACE;

/** 某个属性在美国站的值(亚马逊返回的原样条目) */
export const usEntries = (attributes, name) => (Array.isArray(attributes?.[name]) ? attributes[name] : []).filter(forUs);

// 亚马逊说过会拒的医疗类说法(之前 relieve arthritis pain 这类报过错)
const MEDICAL = /\b(arthritis|joint pain|pain relief|relieve[sd]?\s+(?:\w+\s+)?pain|anxiety relief|relieve[sd]? anxiety|cure[sd]?|heal(?:s|ing)?|therapeutic|prevent(?:s)? (?:disease|infection)|anti[- ]?bacterial|antimicrobial|vet(?:erinarian)?[- ]recommended)\b/i;
/** 文字里有医疗/治疗类说法就给出提醒 */
export function medicalWarning(texts) {
  for (const text of [].concat(texts)) {
    const hit = MEDICAL.exec(String(text ?? ''));
    if (hit) return `含「${hit[0]}」这类医疗/治疗说法，亚马逊可能报错或下架（之前 relieve arthritis pain 被拒过），建议换成舒适、支撑之类的描述`;
  }
  return null;
}

// ---------- 商品类型定义 ----------

function valueShape(node = {}) {
  const variants = [node, ...(node.anyOf ?? []), ...(node.oneOf ?? [])];
  const type = variants.map((item) => item.type).find(Boolean) ?? null;
  const options = [];
  for (const item of variants) {
    (item.enum ?? []).forEach((value, index) => options.push({ value, label: item.enumNames?.[index] ?? String(value) }));
  }
  const maxLength = variants.map((item) => item.maxLength).find((value) => value != null) ?? null;
  return { type: Array.isArray(type) ? type[0] : type, options: options.slice(0, 300), maxLength };
}

/**
 * 亚马逊的 JSON Schema 太大(几 MB),只留页面和连接器要用的:标题、说明、是否必填、
 * 是不是「一个值」的简单属性(可以直接填文字/数字/下拉),简单属性带上可选值和长度上限。
 */
export function simplifySchema(schema) {
  const required = new Set(schema?.required ?? []);
  const groups = {};
  for (const [key, group] of Object.entries(schema?.propertyGroups ?? {})) {
    for (const name of group.propertyNames ?? []) groups[name] ??= { key, title: group.title ?? key };
  }
  const attributes = {};
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    const items = prop?.items ?? {};
    const fields = Object.keys(items.properties ?? {});
    const extra = fields.filter((field) => !['value', 'language_tag', 'marketplace_id'].includes(field));
    const value = items.properties?.value;
    const shape = value ? valueShape(value) : null;
    const simple = !!value && !extra.length && ['string', 'number', 'integer', 'boolean'].includes(shape?.type);
    attributes[name] = {
      title: prop?.title ?? name, description: String(prop?.description ?? '').slice(0, 400), required: required.has(name),
      group: groups[name]?.title ?? null, maxItems: prop?.maxItems ?? null,
      languageTag: fields.includes('language_tag'), marketplaceId: fields.includes('marketplace_id'),
      simple, ...(simple ? { valueType: shape.type, options: shape.options, maxLength: shape.maxLength } : { fields }),
    };
  }
  return { attributes };
}

const schemaFetch = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`下载商品类型定义失败 (${response.status})`);
  return response.json();
};

/** 商品类型定义(简化后的),先看库里缓存;拿不到返回 null,不影响读写属性 */
export async function productTypeSchema(account, productType, { gateway = amazonGateway, download = gateway.downloadSchema ?? schemaFetch, refresh = false } = {}) {
  if (!productType) return null;
  const cached = db.prepare(`SELECT schema_json, version, (julianday('now','localtime') - julianday(fetched_at)) * 24 AS age
    FROM pet_product_type_schemas WHERE product_type=?`).get(productType);
  if (cached && !refresh && cached.age < SCHEMA_TTL_HOURS) return { productType, version: cached.version, ...JSON.parse(cached.schema_json) };
  try {
    const definition = await gateway.request(account, account.region, 'GET', `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
      query: { marketplaceIds: US_MARKETPLACE, requirements: 'LISTING', locale: 'en_US' } });
    const link = definition?.schema?.link?.resource;
    if (!link) throw new Error('亚马逊没有返回商品类型定义的下载地址');
    const simplified = simplifySchema(await download(link));
    const version = definition?.productTypeVersion?.version ?? null;
    db.prepare(`INSERT INTO pet_product_type_schemas (product_type, version, schema_json, fetched_at) VALUES (?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(product_type) DO UPDATE SET version=excluded.version, schema_json=excluded.schema_json, fetched_at=excluded.fetched_at`)
      .run(productType, version, JSON.stringify(simplified));
    return { productType, version, ...simplified };
  } catch (error) {
    // 过期的缓存也比没有强
    if (cached) return { productType, version: cached.version, stale: true, ...JSON.parse(cached.schema_json) };
    return { productType, error: error.message, attributes: {} };
  }
}

export const cachedSchema = (productType) => {
  const row = productType ? db.prepare('SELECT schema_json FROM pet_product_type_schemas WHERE product_type=?').get(productType) : null;
  return row ? JSON.parse(row.schema_json) : null;
};

// ---------- 属性值 ----------

/**
 * 把提交的新值整理成亚马逊的条目数组:
 * 文字 / 数字 / 文字数组 → [{ value }];对象数组原样。缺的 marketplace_id、language_tag 按商品类型定义或现在的条目补上。
 */
export function normalizeEntries(raw, { before = [], info = null } = {}) {
  let list;
  if (Array.isArray(raw) && raw.every(isObject)) list = raw.map((entry) => structuredClone(entry));
  else if (Array.isArray(raw)) list = raw.map((value) => (typeof value === 'string' ? value.trim() : value)).filter((value) => value !== '' && value != null).map((value) => ({ value }));
  else if (isObject(raw)) list = [structuredClone(raw)];
  else if (raw == null || (typeof raw === 'string' && !raw.trim())) list = [];
  else list = [{ value: typeof raw === 'string' ? raw.trim() : raw }];
  const template = before.find(isObject) ?? {};
  const wantsMarket = info ? info.marketplaceId : 'marketplace_id' in template || !before.length;
  const wantsLanguage = info ? info.languageTag : 'language_tag' in template;
  return list.map((entry) => ({
    ...entry,
    ...(wantsLanguage && !entry.language_tag ? { language_tag: template.language_tag ?? 'en_US' } : {}),
    ...(wantsMarket && !entry.marketplace_id ? { marketplace_id: US_MARKETPLACE } : {}),
  }));
}

const leafText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value));

/** a 里每个字段在 b 里都一样(b 可以多出亚马逊自己加的字段) */
function covers(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => covers(item, b[index]));
  if (isObject(a)) return isObject(b) && Object.entries(a).every(([key, value]) => covers(value, b[key]));
  return b != null && leafText(a) === leafText(b);
}

/** 两组属性条目是否一样。loose:核对执行结果时只要新值里写的字段亚马逊上都一样就算生效 */
export function sameEntries(a, b, { loose = false } = {}) {
  const left = Array.isArray(a) ? a : [], right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return loose ? covers(left, right) : covers(left, right) && covers(right, left);
}

/** 条目里给人看的值:简单属性就是 value,复杂的拼成「字段: 值」 */
export function entryText(entry) {
  if (!isObject(entry)) return String(entry ?? '');
  if ('value' in entry && Object.keys(entry).every((key) => ['value', 'language_tag', 'marketplace_id'].includes(key))) return leafText(entry.value);
  const parts = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'language_tag' || key === 'marketplace_id') continue;
    parts.push(`${key}: ${isObject(value) || Array.isArray(value) ? JSON.stringify(value) : leafText(value)}`);
  }
  return parts.join(', ');
}

/** 检查通用属性的新值:返回 { value, errors, warnings } */
export function checkAttributeValue(attribute, raw, before, { info = null } = {}) {
  const errors = [], warnings = [];
  if (!/^[a-z0-9_]{1,80}$/.test(String(attribute ?? ''))) return { errors: ['属性名不对（要用亚马逊的属性名，如 product_description、material）'], warnings };
  if (READ_ONLY_ATTRS[attribute]) return { errors: [`${attribute} 不能在这里改：${READ_ONLY_ATTRS[attribute]}`], warnings };
  if (DEDICATED_ATTRS[attribute]) return { errors: [`${attribute} 请用专门的字段改（标题 title、五点 bullets、后台搜索词 search_terms）`], warnings };
  const value = normalizeEntries(raw, { before: before ?? [], info });
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > MAX_ATTR_BYTES) errors.push(`新值太大（${size} 字节）`);
  if (!value.length && !(before ?? []).length) errors.push('新值是空的');
  if (info?.maxItems != null && value.length > info.maxItems) errors.push(`${info.title ?? attribute} 最多 ${info.maxItems} 个值，这里有 ${value.length} 个`);
  if (info?.simple) {
    for (const entry of value) {
      const item = entry.value;
      if (item == null || item === '') { errors.push('有空值'); break; }
      if (['number', 'integer'].includes(info.valueType) && !Number.isFinite(Number(item))) { errors.push(`${info.title ?? attribute} 要填数字`); break; }
      if (info.maxLength && String(item).length > info.maxLength) errors.push(`「${String(item).slice(0, 30)}…」${String(item).length} 个字符，超过上限 ${info.maxLength}`);
      if (info.options?.length && !info.options.some((option) => String(option.value) === String(item))) warnings.push(`「${item}」不在亚马逊给的可选值里，预检可能不通过`);
    }
  }
  if (!value.length && (before ?? []).length) warnings.push('新值是空的，会把这个属性从 Listing 上删掉');
  if (info?.required && !value.length) errors.push(`${info.title ?? attribute} 是必填属性，不能删掉`);
  const medical = medicalWarning(value.map(entryText));
  if (medical) warnings.push(medical);
  if (!errors.length && sameEntries(value, before ?? [])) errors.push('和亚马逊上现在的一样，不用改');
  return { value, errors, warnings };
}

// ---------- 单件包装尺寸和重量 ----------
// 亚马逊判定标准件 / 大件看的是每个 ASIN 自己的单件包装尺寸。卖家在 Listing 里填的(item_package_dimensions)
// 可能被亚马逊目录里的值(常常是 FBA 仓库实测)覆盖,所以三套放在一起对照。

const INCH = { inches: 1, inch: 1, in: 1, centimeters: 1 / 2.54, centimetres: 1 / 2.54, cm: 1 / 2.54, millimeters: 1 / 25.4, mm: 1 / 25.4, feet: 12, ft: 12, meters: 39.3701, m: 39.3701 };
const POUND = { pounds: 1, pound: 1, lb: 1, lbs: 1, ounces: 1 / 16, ounce: 1 / 16, oz: 1 / 16, kilograms: 2.20462, kilogram: 2.20462, kg: 2.20462, grams: 0.00220462, gram: 0.00220462, g: 0.00220462 };
const round2 = (value) => Math.round(value * 100) / 100;
const convert = (table) => (value, unit) => {
  const factor = table[String(unit ?? '').trim().toLowerCase()];
  const number = Number(value);
  return factor && Number.isFinite(number) ? round2(number * factor) : null;
};
export const toInches = convert(INCH);
export const toPounds = convert(POUND);
// 大号标准件上限(美国站):最长边 18、次长边 14、最短边 8 英寸,20 磅
export const LARGE_STANDARD = { longest: 18, median: 14, shortest: 8, weight: 20 };

/** 三边从长到短排好,判定是不是标准件,超了的写清楚哪条边 */
export function packageVerdict(sides, weight) {
  const sorted = (sides ?? []).filter((value) => value != null).sort((a, b) => b - a);
  if (sorted.length < 3) return { sides: sorted, weight: weight ?? null, standard: null, over: [] };
  const [longest, median, shortest] = sorted;
  const over = [];
  if (longest > LARGE_STANDARD.longest) over.push(`最长边 ${longest} > ${LARGE_STANDARD.longest} 英寸`);
  if (median > LARGE_STANDARD.median) over.push(`次长边 ${median} > ${LARGE_STANDARD.median} 英寸`);
  if (shortest > LARGE_STANDARD.shortest) over.push(`最短边 ${shortest} > ${LARGE_STANDARD.shortest} 英寸`);
  if (weight != null && weight > LARGE_STANDARD.weight) over.push(`重量 ${weight} > ${LARGE_STANDARD.weight} 磅`);
  return { sides: sorted, weight: weight ?? null, standard: !over.length, over };
}

/** 卖家在 Listing 里填的单件包装(item_package_dimensions / item_package_weight) */
export function sellerPackage(attributes) {
  const dims = usEntries(attributes, 'item_package_dimensions')[0];
  const weight = usEntries(attributes, 'item_package_weight')[0];
  if (!dims && !weight) return null;
  const side = (part) => (part ? toInches(part.value, part.unit) : null);
  return { source: 'seller', ...packageVerdict([side(dims?.length), side(dims?.width), side(dims?.height)], weight ? toPounds(weight.value, weight.unit) : null) };
}

/** 亚马逊目录(Catalog Items API dimensions.package)里在用的单件包装 */
export function catalogPackage(dimensions) {
  const entry = (dimensions ?? []).find((item) => item.marketplaceId === US_MARKETPLACE) ?? dimensions?.[0];
  const pkg = entry?.package;
  if (!pkg) return null;
  const side = (part) => (part ? toInches(part.value, part.unit) : null);
  return { source: 'catalog', ...packageVerdict([side(pkg.length), side(pkg.width), side(pkg.height)], pkg.weight ? toPounds(pkg.weight.value, pkg.weight.unit) : null) };
}

/** FBA 预估费用报告里的实测值和尺寸分段 */
export function measuredPackage(measured, sizeTier) {
  if (!measured && !sizeTier) return null;
  const side = (value) => (value == null ? null : toInches(value, measured?.dimensionUnit || 'inches'));
  return { source: 'fba', sizeTier: sizeTier ?? null,
    ...packageVerdict([side(measured?.longest), side(measured?.median), side(measured?.shortest)],
      measured?.weight == null ? null : toPounds(measured.weight, measured.weightUnit || 'pounds')) };
}

/** 卖家填的是标准件、亚马逊在用的却是大件:多半是测量有误,要开 case 申请复测 */
export function packageMismatch(seller, amazon) {
  if (!seller || !amazon || seller.standard == null || amazon.standard == null) return null;
  if (seller.standard && !amazon.standard) {
    return `卖家填的包装是标准件，亚马逊在用的尺寸是大件（${amazon.over.join('，')}）。改 Listing 里的包装尺寸不会生效，要在卖家后台开 case 申请复测，附实测照片。`;
  }
  return null;
}
