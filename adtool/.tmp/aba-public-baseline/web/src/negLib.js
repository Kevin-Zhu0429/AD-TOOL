/**
 * 否定词库 → 广告优化里的批量否定。
 *
 * 开广告那边是 adEngine.buildNegatives:整库套进新生成的每一条活动。
 * 这里是同一份词库的另一种用法:挑几类、挑几个词,加到已经在跑的活动上。
 * 出词口径两边保持一致 ——
 *  · 关键词类(A/B/C)按 feed.kw 出词,一格里是什么就否什么
 *  · ASIN 类(C/E)按 feed.asin 出否定商品定向
 *  · D 类不整库出词,得先说清楚「这些活动在投哪几个墨盒型号」,再反推其余该否掉的型号
 */
import { buildSeriesNegatives, seriesGroups } from './adEngine.js';

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const ASIN_RE = /B0[0-9A-Z]{8}/;

/** /api/neg 给的套用设置是一张表,整理成引擎和工作台都认的形状 */
export function normLibData(raw) {
  const config = {};
  for (const c of raw?.config ?? []) {
    config[c.lib] = { enabled: c.enabled !== 0, matchType: c.match_type, level: c.level };
  }
  return {
    marketplace: raw?.marketplace ?? '',
    libs: raw?.libs ?? [],
    items: raw?.items ?? {},
    scopes: raw?.scopes ?? {},
    config,
  };
}

/** 词库里设的「匹配方式」→ 工作台用的写法 */
export function cfgMatch(cfg) {
  return /精准|exact/i.test(String(cfg?.matchType ?? '')) ? 'exact' : 'phrase';
}

/** 词库里设的「否定层级」→ 工作台用的写法 */
export function cfgScope(cfg) {
  return String(cfg?.level ?? 'camp') === 'group' ? 'adgroup' : 'campaign';
}

/** 取 ASIN:库里存的是纯码,批量表里写的是 asin="B0…",两种都认 */
export function asinCode(v) {
  const m = String(v ?? '').toUpperCase().match(ASIN_RE);
  return m ? m[0] : '';
}

/** 否定商品定向在批量表里的写法 */
export function asinExpr(code) {
  return `asin="${String(code ?? '').toUpperCase()}"`;
}

/** 一类词库能出的词:kw 走否定关键词,asin 走否定商品定向。D 类见 seriesPlan */
function termsOf(spec, items) {
  const kw = [];
  const asin = [];
  const seenKw = new Set();
  const seenAsin = new Set();
  if (spec?.special === 'series') return { kw, asin };
  for (const it of items ?? []) {
    for (const k of spec?.feed?.kw ?? []) {
      const t = clean(it[k]);
      if (!t) continue;
      const low = t.toLowerCase();
      if (seenKw.has(low)) continue;
      seenKw.add(low);
      kw.push(t);
    }
    for (const k of spec?.feed?.asin ?? []) {
      const code = asinCode(it[k]);
      if (!code || seenAsin.has(code)) continue;
      seenAsin.add(code);
      asin.push(code);
    }
  }
  return { kw, asin };
}

/** 五类词库在这个站点的可用情况 + 各自能出的词,界面直接拿去用 */
export function libCatalog(libData) {
  return (libData?.libs ?? []).map((spec) => {
    const items = libData?.items?.[spec.id] ?? [];
    const cfg = libData?.config?.[spec.id] ?? {};
    const { kw, asin } = termsOf(spec, items);
    return {
      id: spec.id,
      name: spec.name,
      special: spec.special ?? '',
      scope: libData?.scopes?.[spec.id] ?? null,
      rows: items.length,
      enabled: cfg.enabled !== false,
      match: cfgMatch(cfg),
      level: cfgScope(cfg),
      kw,
      asin,
    };
  });
}

/** D 类的墨盒型号组,给「这些活动在投哪几个型号」的选择用(「575, 576」算一组) */
export function seriesModelGroups(libData) {
  const spec = (libData?.libs ?? []).find((l) => l.special === 'series');
  return spec ? seriesGroups(libData?.items?.[spec.id] ?? []) : [];
}

/**
 * D 类联动否定:留下在投的型号,库里其余的墨盒和打印机型号全否掉。
 * only: both | models | printers —— 欧洲那种大库一次全否容易顶到每条活动 1000 个否定词的上限
 */
export function seriesPlan(libData, models, only) {
  const spec = (libData?.libs ?? []).find((l) => l.special === 'series');
  const items = spec ? libData?.items?.[spec.id] ?? [] : [];
  const picked = (models ?? []).filter(Boolean);
  if (!spec || !items.length || !picked.length) return null;
  const series = buildSeriesNegatives(items, picked);
  const terms = [
    ...(only === 'printers' ? [] : series.models),
    ...(only === 'models' ? [] : series.printers),
  ];
  return { series, terms };
}

/**
 * 选中的几类词库 → 待否定的词条 [{ lib, text, asin, match, scope }]。
 *
 * sel: { on:{A:true,…}, follow, match, scope, models, only }
 *   follow 为 true 时每一类按词库里设的匹配方式 / 层级走,false 时统一用 sel.match / sel.scope。
 * 后台没有活动级的否定商品定向,所以 ASIN 一律走广告组级。
 */
export function libEntries(libData, sel) {
  const out = [];
  const seen = new Set();
  const push = (lib, text, isAsin, match, scope) => {
    const t = clean(text);
    if (!t) return;
    const key = `${isAsin ? 'a' : 'k'}|${t.toLowerCase()}|${match}|${scope}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ lib, text: t, asin: isAsin, match, scope });
  };

  for (const cat of libCatalog(libData)) {
    if (!sel?.on?.[cat.id]) continue;
    const match = sel.follow === false ? sel.match || 'phrase' : cat.match;
    const scope = sel.follow === false ? sel.scope || 'campaign' : cat.level;
    if (cat.special === 'series') {
      const plan = seriesPlan(libData, sel.models, sel.only);
      for (const t of plan?.terms ?? []) push(cat.id, t, false, match, scope);
      continue;
    }
    for (const t of cat.kw) push(cat.id, t, false, match, scope);
    for (const a of cat.asin) push(cat.id, a, true, '', 'adgroup');
  }
  return out;
}

/** 词条在界面上的勾选键 —— 同一个词在不同类里各算各的 */
export function entryKey(en) {
  return `${en.lib}|${en.asin ? 'a' : 'k'}|${String(en.text).toLowerCase()}`;
}
