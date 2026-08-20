/**
 * D 类「在售墨盒型号和相关打印机」当打印机库用的前端小工具:搜索 + 把挑中的行变成否定词。
 *
 * 和系列广告的联动否定(adEngine.buildSeriesNegatives)是两回事:
 * 那边是「留下要投的系列,其余全否」,整库反推;这里是运营自己搜某个型号 / 机型,
 * 手动挑几条加进本任务的否定词框。判重复数字的口径两边保持一致 ——
 * 同一个打印机数字在别的系列里也出现过时,否定词要带上系列名,不然会误伤在投的机型。
 */
import { splitModels } from './adEngine.js';
import { modelKey } from './skuMatch.js';

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** 从词库数据里取出 D 类的定义、行和本站点读的是哪个区域库 */
export function printerLib(lib) {
  const spec = (lib?.libs ?? []).find((l) => l.special === 'series') ?? null;
  return {
    spec,
    items: spec ? lib?.items?.[spec.id] ?? [] : [],
    scope: spec ? lib?.scopes?.[spec.id] ?? null : null,
  };
}

/** 品牌 / 打印机系列两个下拉的选项 */
export function printerFacets(rows) {
  const brands = new Set();
  const series = new Set();
  for (const r of rows || []) {
    if (r.brand) brands.add(r.brand);
    if (r.series) series.add(r.series);
  }
  return {
    brands: [...brands].sort(),
    series: [...series].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  };
}

/** 打印机型号 -> 它挂过哪几个系列。挂过两个以上的,否定时要带系列名 */
export function printerSeriesMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const p = clean(r.printer).toLowerCase();
    if (!p) continue;
    if (!map.has(p)) map.set(p, new Set());
    const s = clean(r.series);
    if (s) map.get(p).add(s.toLowerCase());
  }
  return map;
}

/** 这一行的打印机写成否定词长什么样:数字在别的系列里也有就带上系列名 */
export function printerTerm(row, seriesMap) {
  const printer = clean(row?.printer);
  if (!printer) return '';
  const series = clean(row?.series);
  const dup = (seriesMap?.get(printer.toLowerCase())?.size ?? 0) > 1;
  return dup && series ? `${series} ${printer}` : printer;
}

/** 这一行的墨盒型号:「575, 576」这种一格塞多个的拆开 */
export function modelTerms(row) {
  return splitModels(row?.term);
}

/**
 * 搜索:空格分开的关键词要全部命中。
 * 每个词先按普通包含匹配(输 301 能查到 301XL、输 DeskJet 能查到整个系列),
 * 再按型号归一键比一次(输 301XL 也能查到 301、输 PG-545 能查到 545)。
 */
export function searchPrinters(rows, query, facet = {}) {
  const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (rows || []).filter((r) => {
    if (facet.brand && r.brand !== facet.brand) return false;
    if (facet.series && r.series !== facet.series) return false;
    if (!tokens.length) return true;
    const fields = [r.brand, r.term, r.series, r.printer].map((v) => String(v ?? '').toLowerCase());
    const keys = [...modelTerms(r), r.printer].filter(Boolean).map(modelKey);
    return tokens.every((t) => {
      if (fields.some((f) => f.includes(t))) return true;
      const k = modelKey(t);
      return !!k && keys.includes(k);
    });
  });
}

/** 系列广告选中的墨盒型号集合,用来给「正在投」的行打标 */
export function targetedModels(seriesModels) {
  return new Set((seriesModels || []).map((m) => clean(m).toLowerCase()).filter(Boolean));
}

/** 这一行的墨盒型号是不是正在投 —— 正在投的默认不勾,免得把自己否掉 */
export function isTargeted(row, picked) {
  if (!picked?.size) return false;
  return modelTerms(row).some((m) => picked.has(m.toLowerCase()));
}

/**
 * 挑好的行 -> 待写进否定词框的词,顺序保持行的顺序,大小写不敏感去重。
 * pick: 'printer' 只要打印机型号 / 'model' 只要墨盒型号 / 'both' 两个都要
 */
export function pickedTerms(rows, pick, seriesMap) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const v = clean(raw);
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const r of rows || []) {
    if (pick !== 'printer') for (const m of modelTerms(r)) push(m);
    if (pick !== 'model') push(printerTerm(r, seriesMap));
  }
  return out;
}

/** 追加进否定词文本框:按大小写不敏感去重,返回新文本、真加进去几个、几个本来就有 */
export function appendTerms(current, terms) {
  const cur = String(current ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const have = new Set(cur.map((s) => s.toLowerCase()));
  const add = [];
  for (const t of terms) {
    const k = t.toLowerCase();
    if (have.has(k)) continue;
    have.add(k);
    add.push(t);
  }
  return { text: [...cur, ...add].join('\n'), added: add.length, dup: terms.length - add.length };
}
