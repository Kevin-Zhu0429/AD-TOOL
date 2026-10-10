// Listing 编辑的纯函数:亚马逊属性(attributes)和页面表单之间互相转换,算出改了哪些属性。
// 亚马逊每个属性都是一组对象,文字类长这样:[{ value, language_tag, marketplace_id }]。

/** 站点默认语言,原值里没有 language_tag 时用 */
export const LANGUAGE_OF = {
  ES: 'es_ES', DE: 'de_DE', FR: 'fr_FR', IT: 'it_IT', UK: 'en_GB',
  US: 'en_US', CA: 'en_CA', AU: 'en_AU', AE: 'en_AE',
};

export const IMAGE_KEYS = [
  'main_product_image_locator',
  ...Array.from({ length: 8 }, (_, i) => `other_product_image_locator_${i + 1}`),
  'swatch_product_image_locator',
];

/** 表单里单独做了输入框的属性;其余属性在「其他属性」里按 JSON 改 */
export const FORM_KEYS = new Set([
  'item_name', 'bullet_point', 'product_description', 'generic_keyword',
  'purchasable_offer', 'fulfillment_availability', ...IMAGE_KEYS,
]);

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 一个文字属性的所有值,如五点 → ['第一点', '第二点', …] */
export function textValues(attributes, name) {
  return (attributes?.[name] ?? []).map((entry) => String(entry?.value ?? ''));
}

/** 这个 Listing 用的站点和语言:先看标题,没有就按站点默认 */
export function localeOf(attributes, { marketplaceId, country }) {
  const sample = (attributes?.item_name ?? []).find((entry) => entry?.language_tag)
    ?? Object.values(attributes ?? {}).flat().find((entry) => entry?.language_tag);
  return {
    marketplace_id: sample?.marketplace_id ?? marketplaceId,
    language_tag: sample?.language_tag ?? LANGUAGE_OF[country] ?? 'en_US',
  };
}

/**
 * 写回文字属性。空白的条目去掉;一个都不剩就删掉这个属性。
 * 每个值沿用原来同位置的 language_tag / marketplace_id,新加的用 locale。
 */
export function setTextValues(attributes, name, values, locale) {
  const next = { ...attributes };
  const before = attributes?.[name] ?? [];
  // 输入过程中不去掉空格,不然打不出词与词之间的空格;整条是空白才算删掉
  const kept = values.map((value) => String(value ?? '')).filter((value) => value.trim());
  if (!kept.length) {
    delete next[name];
    return next;
  }
  next[name] = kept.map((value, index) => {
    const base = before[index] ?? before[0] ?? {};
    return {
      ...(base.language_tag || locale.language_tag ? { language_tag: base.language_tag ?? locale.language_tag } : {}),
      value,
      marketplace_id: base.marketplace_id ?? locale.marketplace_id,
    };
  });
  return next;
}

/** 面向所有买家的那条报价(B2B 报价的 audience 是 B2B) */
function consumerOfferIndex(offers) {
  const index = offers.findIndex((offer) => !offer?.audience || offer.audience === 'ALL');
  return index >= 0 ? index : (offers.length ? 0 : -1);
}

/** 售价:purchasable_offer → our_price → schedule[0].value_with_tax */
export function priceOf(attributes) {
  const offers = attributes?.purchasable_offer ?? [];
  const offer = offers[consumerOfferIndex(offers)];
  const value = offer?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  return { value: value === undefined || value === null ? '' : String(value), currency: offer?.currency ?? '' };
}

export function setPrice(attributes, value, { locale, currency }) {
  const next = { ...attributes };
  const offers = clone(attributes?.purchasable_offer ?? []);
  const number = Number(value);
  let index = consumerOfferIndex(offers);
  if (index < 0) {
    offers.push({ marketplace_id: locale.marketplace_id, currency, audience: 'ALL' });
    index = 0;
  }
  const offer = offers[index];
  offer.our_price = [{ schedule: [{ ...(offer.our_price?.[0]?.schedule?.[0] ?? {}), value_with_tax: number }] }];
  next.purchasable_offer = offers;
  return next;
}

/** 自发货(DEFAULT)库存;FBA 的库存由亚马逊仓库决定,改不了,返回 null */
export function merchantQuantity(attributes) {
  const row = (attributes?.fulfillment_availability ?? []).find((entry) => entry?.fulfillment_channel_code === 'DEFAULT');
  return row ? String(row.quantity ?? '') : null;
}

export function setMerchantQuantity(attributes, quantity) {
  const next = { ...attributes };
  next.fulfillment_availability = (attributes?.fulfillment_availability ?? []).map((entry) => (
    entry?.fulfillment_channel_code === 'DEFAULT' ? { ...entry, quantity: Math.max(0, Math.round(Number(quantity) || 0)) } : entry
  ));
  return next;
}

export function imageUrl(attributes, key) {
  return String(attributes?.[key]?.[0]?.media_location ?? '');
}

export function setImageUrl(attributes, key, url, locale) {
  const next = { ...attributes };
  const value = String(url ?? '').trim();
  if (!value) {
    delete next[key];
    return next;
  }
  const base = attributes?.[key]?.[0] ?? {};
  next[key] = [{ ...base, media_location: value, marketplace_id: base.marketplace_id ?? locale.marketplace_id }];
  return next;
}

/** 改了的属性:{ 属性名: 新值 },删掉的属性是 null。按 JSON 内容比较,顺序变了也算改 */
export function diffAttributes(original = {}, edited = {}) {
  const changes = {};
  for (const name of new Set([...Object.keys(original), ...Object.keys(edited)])) {
    const before = original[name];
    const after = edited[name];
    if (after === undefined) {
      if (before !== undefined) changes[name] = null;
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes[name] = after;
    }
  }
  return changes;
}

/** 列表里一个属性值的简短说明,给「其他属性」表格用 */
export function attributePreview(value) {
  const parts = (Array.isArray(value) ? value : [value]).map((entry) => {
    if (entry && typeof entry === 'object') {
      if ('value' in entry && typeof entry.value !== 'object') return String(entry.value) + (entry.unit ? ` ${entry.unit}` : '');
      return JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'marketplace_id' && key !== 'language_tag')));
    }
    return String(entry);
  });
  const text = parts.join(' | ');
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
