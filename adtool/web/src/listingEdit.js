// Listing 板块的编辑逻辑:亚马逊属性条目 ↔ 页面上编辑的样子,算出改了哪些要上传。

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
export const US = 'ATVPDKIKX0DER';

/** 只留美国站的条目,去掉 marketplace_id、language_tag(上传时服务器按属性定义补回来) */
export function stripEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !isObject(entry) || !entry.marketplace_id || entry.marketplace_id === US)
    .map((entry) => {
      if (!isObject(entry)) return entry;
      const { marketplace_id: _m, language_tag: _l, ...rest } = entry;
      return rest;
    });
}

/** 所有属性 → { 属性名: 去掉站点和语言的条目 } */
export function draftFrom(attributes) {
  return Object.fromEntries(Object.entries(attributes ?? {}).map(([name, entries]) => [name, stripEntries(entries)]));
}

// 比较时字段顺序不算
const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value);
export const sameEntries = (a, b) => JSON.stringify(canonical(a ?? [])) === JSON.stringify(canonical(b ?? []));

/** 简单属性的值列表(每个条目的 value) */
export const valuesOf = (entries) => (entries ?? []).map((entry) => (isObject(entry) ? entry.value ?? '' : entry));
/** 值列表 → 条目;空的去掉 */
export const entriesOf = (values) => values.map((value) => (typeof value === 'string' ? value.trim() : value))
  .filter((value) => value !== '' && value != null).map((value) => ({ value }));

/** 一个属性是不是能用「一个值一个输入框」编辑 */
export function isSimple(name, info, entries) {
  if (info) return !!info.simple;
  return (entries ?? []).every((entry) => isObject(entry) && Object.keys(entry).every((key) => key === 'value') && typeof entry.value !== 'object');
}

/** 编辑中的条目整理成要上传的:文字去掉首尾空格,空的简单值去掉 */
export const cleanEntries = (entries) => (entries ?? []).map((entry) => (isObject(entry) && typeof entry.value === 'string' ? { ...entry, value: entry.value.trim() } : entry))
  .filter((entry) => !(isObject(entry) && Object.keys(entry).length === 1 && 'value' in entry && (entry.value === '' || entry.value == null)));

/** 改过的属性,按页面上的顺序:{ attribute, value } 列表 */
export function changedAttributes(original, draft) {
  const names = [...new Set([...Object.keys(original ?? {}), ...Object.keys(draft ?? {})])];
  return names.filter((name) => draft[name] !== undefined && !sameEntries(original[name] ?? [], cleanEntries(draft[name])))
    .map((name) => ({ attribute: name, value: cleanEntries(draft[name]) }));
}

/** 原价、促销价有没有改:返回要上传的修改 */
export function priceChanges({ price, sale }, form) {
  const out = [];
  const nextPrice = form.price === '' ? null : Number(form.price);
  if (nextPrice != null && Number.isFinite(nextPrice) && (price == null || Math.abs(nextPrice - price) >= 0.005)) out.push({ field: 'price', value: nextPrice });
  const salePrice = form.salePrice === '' ? 0 : Number(form.salePrice);
  const sameSale = sale ? Math.abs(salePrice - sale.price) < 0.005 && form.saleStart === (sale.start ?? '') && form.saleEnd === (sale.end ?? '') : salePrice === 0;
  if (!sameSale && Number.isFinite(salePrice)) out.push({ field: 'sale_price', value: salePrice, saleStart: form.saleStart || undefined, saleEnd: form.saleEnd || undefined });
  return out;
}

/** 条目给人看的文字 */
export function entryText(entry) {
  if (!isObject(entry)) return String(entry ?? '');
  if (Object.keys(entry).every((key) => key === 'value')) return String(entry.value ?? '');
  return Object.entries(entry).map(([key, value]) => `${key}: ${isObject(value) || Array.isArray(value) ? JSON.stringify(value) : value}`).join(', ');
}

export const byteLength = (text) => new TextEncoder().encode(String(text ?? '')).length;

/** 复杂属性在文本框里编辑 JSON;解析失败返回 { error } */
export function parseJsonEntries(text) {
  if (!String(text).trim()) return { value: [] };
  try {
    const value = JSON.parse(text);
    const list = Array.isArray(value) ? value : [value];
    if (!list.every(isObject)) return { error: '每个值要是 { … } 对象' };
    return { value: list };
  } catch (error) {
    return { error: `JSON 格式不对：${error.message}` };
  }
}
