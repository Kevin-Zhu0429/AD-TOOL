// Listing 编辑的纯函数:亚马逊属性(attributes)和页面表单之间互相转换,算出改了哪些属性。
// 亚马逊每个属性都是一组对象,文字类长这样:[{ value, language_tag, marketplace_id }]。

/** 站点默认语言,原值里没有 language_tag 时用 */
export const LANGUAGE_OF = {
  ES: 'es_ES', DE: 'de_DE', FR: 'fr_FR', IT: 'it_IT', UK: 'en_GB',
  US: 'en_US', CA: 'en_CA', AU: 'en_AU', AE: 'en_AE',
};

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

const dateOf = (value) => (value ? String(value).slice(0, 10) : '');

/** 促销价:purchasable_offer → discounted_price → schedule[0],带开始、结束日期 */
export function salePriceOf(attributes) {
  const offers = attributes?.purchasable_offer ?? [];
  const schedule = offers[consumerOfferIndex(offers)]?.discounted_price?.[0]?.schedule?.[0];
  return {
    value: schedule?.value_with_tax === undefined || schedule?.value_with_tax === null ? '' : String(schedule.value_with_tax),
    start: dateOf(schedule?.start_at),
    end: dateOf(schedule?.end_at),
  };
}

/**
 * 写回促销价。value 为空就去掉促销价;日期没改时保留亚马逊原来的时间点(带时区的那几个小时),
 * 改了就写成那天的 00:00 UTC。
 */
export function setSalePrice(attributes, { value, start, end }, { locale, currency }) {
  const next = { ...attributes };
  const offers = clone(attributes?.purchasable_offer ?? []);
  let index = consumerOfferIndex(offers);
  if (index < 0) {
    offers.push({ marketplace_id: locale.marketplace_id, currency, audience: 'ALL' });
    index = 0;
  }
  const offer = offers[index];
  if (String(value ?? '').trim() === '') {
    delete offer.discounted_price;
  } else {
    const before = offer.discounted_price?.[0]?.schedule?.[0] ?? {};
    const at = (date, old) => (!date ? undefined : dateOf(old) === date ? old : `${date}T00:00:00.000Z`);
    const schedule = { ...before, value_with_tax: Number(value) };
    for (const [key, date] of [['start_at', start], ['end_at', end]]) {
      const stamp = at(date, before[key]);
      if (stamp) schedule[key] = stamp;
      else delete schedule[key];
    }
    offer.discounted_price = [{ schedule: [schedule] }];
  }
  next.purchasable_offer = offers;
  return next;
}

/** 打印页数 page_yield:[{ value: 480, marketplace_id }] */
export function pageYieldOf(attributes) {
  const value = attributes?.page_yield?.[0]?.value;
  return value === undefined || value === null ? '' : String(value);
}

export function setPageYield(attributes, value, locale) {
  const next = { ...attributes };
  const text = String(value ?? '').trim();
  if (!text) {
    delete next.page_yield;
    return next;
  }
  const base = attributes?.page_yield?.[0] ?? {};
  next.page_yield = [{ ...base, value: Math.round(Number(text)), marketplace_id: base.marketplace_id ?? locale.marketplace_id }];
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
