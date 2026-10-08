/**
 * D 类「在售墨盒型号和相关打印机」当打印机库用的前端小工具:搜索 + 把挑中的行变成否定词。
 *
 * 搜索可以限定搜哪一列(见 SEARCH_FIELDS):305 既是墨盒型号也可能是别的系列的机型号,
 * 只想要 305 墨盒的行时就把搜索限定在墨盒型号这一列。
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
 * 搜哪一列 —— 305 这种数字既是墨盒型号也可能是别的系列的机型号,
 * 不分开搜就会把「墨盒是 302、机型叫 3050」这种行也捞出来。
 *  model   只搜墨盒型号
 *  printer 只搜打印机(系列名 + 机型号,搜 DeskJet 或 2540 都行)
 *  all     四列都搜,和以前一样
 */
export const SEARCH_FIELDS = [
  ['model', '墨盒型号'],
  ['printer', '打印机机型'],
  ['all', '全部'],
];

/** 这一行参与匹配的原文 */
function fieldTexts(row, field) {
  if (field === 'model') return [row.term];
  if (field === 'printer') return [row.series, row.printer];
  return [row.brand, row.term, row.series, row.printer];
}

/** 这一行参与「型号归一」比对的值(输 301XL 也能查到 301) */
function fieldModels(row, field) {
  if (field === 'model') return modelTerms(row);
  if (field === 'printer') return [row.printer];
  return [...modelTerms(row), row.printer];
}

/**
 * 一个词命不命中这一行:
 * 先按普通包含匹配(输 301 能查到 301XL、输 DeskJet 能查到整个系列),
 * 再按型号归一键比一次(输 301XL 也能查到 301、输 PG-545 能查到 545)。
 * field 决定拿这一行的哪几列去比。
 */
function hitsTerm(row, term, field) {
  const t = String(term ?? '').toLowerCase();
  if (!t) return true;
  const texts = fieldTexts(row, field).map((v) => String(v ?? '').toLowerCase());
  if (texts.some((f) => f.includes(t))) return true;
  const k = modelKey(t);
  return !!k && fieldModels(row, field).filter(Boolean).map(modelKey).includes(k);
}

/**
 * 搜索框怎么拆:**逗号 / 顿号 / 分号 / 换行分开的是「或」**,空格分开的是「并且」。
 * 「305, 304, 3720」= 一次搜三个型号;「hp deskjet」= 两个词都要命中。
 */
export function parseQuery(text) {
  return String(text ?? '')
    .split(/[,，、;；\n\r]+/)
    .map((g) => g.trim().toLowerCase().split(/\s+/).filter(Boolean))
    .filter((g) => g.length);
}

const facetOk = (row, facet) =>
  (!facet?.brand || row.brand === facet.brand) && (!facet?.series || row.series === facet.series);

/** 搜索:任意一组词全部命中就算命中。field 见 SEARCH_FIELDS,默认四列都搜 */
export function searchPrinters(rows, query, facet = {}, field = 'all') {
  const groups = parseQuery(query);
  return (rows || []).filter((r) => {
    if (!facetOk(r, facet)) return false;
    if (!groups.length) return true;
    return groups.some((g) => g.every((t) => hitsTerm(r, t, field)));
  });
}

/** 一次搜多个型号时,每个型号各命中几行 —— 用来提示哪几个型号库里根本没有 */
export function queryReport(rows, query, facet = {}, field = 'all') {
  const groups = parseQuery(query);
  return groups.map((g) => ({
    label: g.join(' '),
    count: (rows || []).filter(
      (r) => facetOk(r, facet) && g.every((t) => hitsTerm(r, t, field))
    ).length,
  }));
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

/* 复制到后台时用哪种分隔符 —— 亚马逊后台的否定词框一行一个,Excel 里习惯逗号 */
export const TERM_SEPS = [
  ['line', '每行一个', '\n'],
  ['comma', '逗号分隔', ', '],
  ['space', '空格分隔', ' '],
];

export function joinTerms(terms, sepId) {
  const sep = TERM_SEPS.find(([id]) => id === sepId)?.[2] ?? '\n';
  return (terms || []).join(sep);
}

/** 挑中的行里有哪些墨盒型号(去重,保持出现顺序) */
export function rowsModels(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    for (const m of modelTerms(r)) {
      const k = m.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}
