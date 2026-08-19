/**
 * 亚马逊 SP 自动广告批量表生成引擎
 * 从「自动广告批量生成器 V3」移植,出价折算 / 命名 / 块结构 / 自检逻辑保持一致。
 * 这里全是纯函数,不碰 DOM,方便多任务合并成一张总表。
 */
import * as XLSX from 'xlsx';

export const SHEET = '商品推广活动';

export const HEADERS = [
  '产品', '实体层级', '操作', '广告活动编号', '广告组编号', '广告组合编号', '广告编号',
  '关键词编号', '商品投放 ID', '广告活动名称', '广告组名称', '开始日期', '结束日期',
  '投放类型', '状态', '每日预算', 'SKU', '广告组默认竞价', '竞价', '关键词文本',
  '母语关键词', '母语区域', '匹配类型', '竞价方案', '广告位', '百分比', '拓展商品投放编号',
];
const W = HEADERS.length;

/* 0-based 列号 */
export const C = {
  PROD: 0, ENTITY: 1, OP: 2, CAMP: 3, GROUP: 4, PORT: 5, CAMPNAME: 9, GROUPNAME: 10,
  DATE: 11, TARGETING: 13, STATUS: 14, BUDGET: 15, SKU: 16, DEFBID: 17, BID: 18,
  KWTEXT: 19, MATCH: 22, STRATEGY: 23, PLACEMENT: 24, PCT: 25, TARGET: 26,
};

/* 自动投放方式: [名称, AA列标识] —— 顺序即块内商品定向四行的顺序 */
export const AUTO_TYPES = [
  ['Close', 'close-match'],
  ['Loose', 'loose-match'],
  ['Substitutes', 'substitutes'],
  ['Complements', 'complements'],
];
export const AUTO_ZH = { Close: '紧密', Loose: '宽泛', Substitutes: '同类', Complements: '关联' };

/* 溢价位置: [名称, Y列写入值, 竞价调整行偏移, 默认提降系数] */
export const PLACEMENTS = [
  ['PP', '广告位：商品页面', 1, 1.5],
  ['ROS', '广告位：搜索结果的其余位置', 2, 1.5],
  ['TOS', '广告位：搜索结果首页首位', 3, 2],
];
export const PLACE_ROWS = [...PLACEMENTS].sort((a, b) => a[2] - b[2]);

export const STRATEGIES = [
  { id: 'down_zh', label: '仅降低', suffix: '仅降低', sheet: '动态竞价 - 仅降低', factor: false },
  { id: 'updown_zh', label: '提高和降低', suffix: '提降', sheet: '动态竞价 - 提高和降低', factor: true },
  { id: 'fixed_zh', label: '固定竞价', suffix: '固定竞价', sheet: '固定竞价', factor: false },
  { id: 'down_en', label: 'DOWN ONLY', suffix: 'DOWN ONLY', sheet: '动态竞价 - 仅降低', factor: false },
  { id: 'updown_en', label: 'DOWN UP', suffix: 'DOWN UP', sheet: '动态竞价 - 提高和降低', factor: true },
  { id: 'fixed_en', label: 'Fixed', suffix: 'Fixed', sheet: '固定竞价', factor: false },
];

export const ORDER = ['TOS', 'ROS', 'PP'];
export const HEAD_ROWS = 1 + PLACEMENTS.length + 1; // 活动 + 3广告位 + 广告组
export const TAIL_ROWS = AUTO_TYPES.length;
export const KW_MAX_CHARS = 80;
export const MIN_BID = 0.02;

export const NAME_TOKENS = [
  { id: 'auto', label: '自动投放方式' },
  { id: 'place', label: '溢价位置' },
  { id: 'pct', label: '溢价比例' },
  { id: 'strat', label: '竞价方案' },
  { id: 'bid', label: '出价' },
];

/* ---------------- 小工具 ---------------- */

export function parseLines(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').replace(/\r/g, '\n').split('\n')) {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function strategyOf(id) {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`未知竞价方案：${id}`);
  return s;
}

function coefFor(place, stratId, coefs) {
  if (!strategyOf(stratId).factor) return 1;
  const p = PLACEMENTS.find((x) => x[0] === place);
  if (!p) return 1;
  const v = Number(coefs?.[p[0]]);
  return isFinite(v) && v > 0 ? v : p[3];
}

export const activeOf = (prem) => ORDER.filter((k) => k in prem);

/**
 * 出价 = CPC基数 ÷ ((1+溢价) × 广告位系数)
 * 一条活动多个广告位时按最贵那个折算,保证任何位置的落地 CPC 都不超过基数。
 * 完全不加溢价时 = CPC 基数,不打任何系数。
 */
export function bidInfo(prem, stratId, params) {
  const base = Number(params.baseBid) || 0.36;
  let f = 1;
  let driver = null;
  for (const k of activeOf(prem)) {
    const v = (1 + prem[k] / 100) * coefFor(k, stratId, params.coefs);
    if (v > f) {
      f = v;
      driver = k;
    }
  }
  const raw = base / f;
  const bid =
    params.rounding === 'trunc'
      ? Math.floor(raw * 100) / 100
      : Math.round((raw + Number.EPSILON) * 100) / 100;
  return { factor: Math.round(f * 1000) / 1000, driver, bid };
}

function tokenValue(id, p, params) {
  if (id === 'auto') return params.autoLang === 'zh' ? AUTO_ZH[p.auto] || p.auto : p.auto;
  if (id === 'strat') return strategyOf(p.strat).suffix;
  if (id === 'place') return p.active.join('&').replace(/^TOS&ROS/, 'T&ROS');
  if (id === 'pct') {
    const v = p.active.map((k) => p.prem[k]);
    if (!v.length) return '';
    return v.every((x) => x === v[0]) ? `${v[0]}%` : v.map((x) => `${x}%`).join('&');
  }
  if (id === 'bid') return String(p.bid);
  return '';
}

export function campName(p, params) {
  const sep = params.sep || '_';
  const parts = [String(params.prefix || '').trim()];
  for (const t of params.tokens) {
    if (!t.on) continue;
    const v = tokenValue(t.id, p, params);
    if (v !== '') parts.push(v);
  }
  return parts.filter((x) => x !== '').join(sep);
}

/** 解析「TOS:100 ROS:50」这类溢价组合,一行一条活动 */
export function parseCombos(text) {
  const out = [];
  const problems = [];
  const seen = new Set();
  for (const line of parseLines(text)) {
    const prem = {};
    let found = 0;
    const re = /(TOS|ROS|PP)\s*[:=＝]?\s*(\d+)\s*%?/gi;
    let m;
    while ((m = re.exec(line))) {
      const k = m[1].toUpperCase();
      const v = parseInt(m[2], 10);
      found++;
      if (v > 900) {
        problems.push(`溢价超过 900%：${line.slice(0, 24)}`);
        continue;
      }
      prem[k] = v;
    }
    if (found && !Object.keys(prem).length) continue;
    if (!found) {
      problems.push(`这一行看不懂：${line.slice(0, 24)}`);
      continue;
    }
    const key = ORDER.filter((k) => k in prem).map((k) => k + prem[k]).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(prem);
  }
  return { out, problems };
}

/* ---------------- 否定投放 ---------------- */

/** 「575, 576」这种一格里塞多个型号的,拆成 ['575','576'] */
export function splitModels(text) {
  return String(text ?? '')
    .split(/[,，、;；/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const pairKey = (series, printer) => `${clean(series).toLowerCase()}|${clean(printer).toLowerCase()}`;

/** D 类词库里有哪些墨盒型号组,给界面做选择用(「575, 576」算一组) */
export function seriesGroups(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const label = clean(r.term);
    if (!label) continue;
    const cur = map.get(label.toLowerCase());
    if (cur) cur.count++;
    else map.set(label.toLowerCase(), { label, models: splitModels(label), count: 1, brand: clean(r.brand) });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
}

/**
 * 系列广告的联动否定:留下要投的那个系列,D 类词库里其余的墨盒型号和打印机型号全部否掉。
 *
 * 两个坑在这里处理掉:
 * 1) 「575, 576」是一组一起卖的,只要选中其中一个,同组的另一个也要留着,不能否;
 * 2) 同一个打印机数字会挂在不同墨盒下(比如 DeskJet 6120 和别的系列的 6120),
 *    这种重复数字不能光否数字,要带上打印机系列名,否则会误伤在投的机型。
 */
export function buildSeriesNegatives(rows, selectedModels) {
  const sel = new Set((selectedModels || []).map((m) => clean(m).toLowerCase()).filter(Boolean));
  const parsed = (rows || []).map((r) => {
    const models = splitModels(r.term);
    return {
      models,
      printer: clean(r.printer),
      series: clean(r.series),
      hit: models.some((m) => sel.has(m.toLowerCase())),
    };
  });

  const allModels = new Map();      // 小写 -> 原样,库里出现过的全部墨盒型号
  const keptModels = new Set();     // 投放系列的墨盒型号(含同组的兄弟型号)
  const keptPrinters = new Set();   // 投放系列的打印机型号
  const keptPairs = new Set();      // 系列+型号,精确到行
  const printerSeries = new Map();  // 打印机型号 -> 它出现过的系列集合

  for (const r of parsed) {
    for (const m of r.models) allModels.set(m.toLowerCase(), m);
    if (r.printer) {
      const pl = r.printer.toLowerCase();
      if (!printerSeries.has(pl)) printerSeries.set(pl, new Set());
      if (r.series) printerSeries.get(pl).add(r.series.toLowerCase());
    }
    if (!r.hit) continue;
    for (const m of r.models) keptModels.add(m.toLowerCase());
    if (r.printer) {
      keptPrinters.add(r.printer.toLowerCase());
      keptPairs.add(pairKey(r.series, r.printer));
    }
  }

  const models = [];
  for (const [lower, disp] of allModels) if (!keptModels.has(lower)) models.push(disp);
  models.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const printers = [];
  const qualified = [];   // 因为数字重复而带上了系列名的
  const seen = new Set();
  for (const r of parsed) {
    if (r.hit || !r.printer) continue;
    if (keptPairs.has(pairKey(r.series, r.printer))) continue; // 同系列同型号正在投,不能否
    const pl = r.printer.toLowerCase();
    const dup = keptPrinters.has(pl) || (printerSeries.get(pl)?.size ?? 0) > 1;
    const text = dup && r.series ? `${r.series} ${r.printer}` : r.printer;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    printers.push(text);
    if (dup && r.series) qualified.push(text);
  }

  const unknown = [...sel].filter((m) => !allModels.has(m));
  return { models, printers, qualified, unknown, keptModels: [...keptModels] };
}

/** 一条否定关键词行 */
function negRow(text, cfg) {
  const level = cfg?.level || 'camp';
  return {
    entity: level === 'camp' ? '广告活动否定关键词' : '否定关键词',
    match: cfg?.matchType || '否定词组',
    needGroup: level !== 'camp',
    text,
  };
}

/**
 * 把五类词库 + D 类系列联动 + 本次临时否定合并成待写入的否定行。
 *
 * lib  : { libs: [词库定义], items: {A: [...], …}, config: {A: {enabled, matchType, level}, …} }
 * task : { libUse: {A: true, …}, adType: 'mixed' | 'series', seriesModels: [...], extraNeg: {...} }
 */
export function buildNegatives(lib, task) {
  const problems = [];
  const negs = [];
  const asinSet = new Set();
  const asins = [];

  const pushAsin = (raw) => {
    const v = String(raw ?? '').trim().toUpperCase();
    if (!v) return;
    const full = `asin="${v}"`;
    if (asinSet.has(full)) return;
    asinSet.add(full);
    asins.push(full);
  };
  const pushKw = (raw, cfg, libName) => {
    const t = clean(raw);
    if (!t) return;
    if (t.length > KW_MAX_CHARS) {
      problems.push(`${libName}有词超 ${KW_MAX_CHARS} 字符:${t.slice(0, 30)}…`);
      return;
    }
    negs.push(negRow(t, cfg));
  };

  const specs = lib?.libs ?? [];
  let series = null;

  for (const spec of specs) {
    if (!task.libUse?.[spec.id]) continue;
    const cfg = lib?.config?.[spec.id];
    if (cfg && cfg.enabled === false) continue;
    const items = lib?.items?.[spec.id] ?? [];

    if (spec.special === 'series') {
      // D 类不整库否定 —— 混合广告什么都不否,系列广告才反推该否掉的型号
      if (task.adType !== 'series') continue;
      const picked = (task.seriesModels || []).filter(Boolean);
      if (!picked.length) {
        problems.push('选了系列广告,但还没选投放的墨盒型号,D 类联动否定没生效');
        continue;
      }
      if (!items.length) {
        problems.push(`「${spec.name}」这个区域还没有数据,系列广告没法反推要否掉的型号`);
        continue;
      }
      series = buildSeriesNegatives(items, picked);
      // 欧洲这种大库,墨盒 + 打印机一起否很容易顶到亚马逊每条活动 1000 个否定词的上限,
      // 所以留一个开关:可以只否墨盒型号,或者只否打印机型号
      const only = task.seriesScope ?? 'both';
      if (only !== 'printers') for (const t of series.models) pushKw(t, cfg, spec.name);
      if (only !== 'models') for (const t of series.printers) pushKw(t, cfg, spec.name);
      if (series.unknown.length) {
        problems.push(`这些墨盒型号在 D 类词库里没找到,先确认有没有写错:${series.unknown.join('、')}`);
      }
      continue;
    }

    for (const it of items) {
      for (const k of spec.feed?.kw ?? []) pushKw(it[k], cfg, spec.name);
      for (const k of spec.feed?.asin ?? []) pushAsin(it[k]);
    }
  }

  const EXTRA = [
    ['negExact', '否定关键词', '否定精准匹配', true],
    ['negPhrase', '否定关键词', '否定词组', true],
    ['cnegExact', '广告活动否定关键词', '否定精准匹配', false],
    ['cnegPhrase', '广告活动否定关键词', '否定词组', false],
  ];
  for (const [key, entity, match, needGroup] of EXTRA) {
    for (const w of parseLines(task.extraNeg?.[key])) {
      if (w.length > KW_MAX_CHARS) {
        problems.push(`否定词超 ${KW_MAX_CHARS} 字符:${w.slice(0, 30)}…`);
        continue;
      }
      negs.push({ entity, match, needGroup, text: w });
    }
  }

  // 同实体 + 同匹配类型内去重
  const seen = new Set();
  const keep = [];
  for (const n of negs) {
    const k = `${n.entity}|${n.match}|${n.text.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(n);
  }

  const ASIN_RE = /^B0[0-9A-Z]{8}$/;
  for (const w of parseLines(task.extraNeg?.negAsin)) {
    const m = w.match(/^asin\s*=\s*"?([^"]+)"?$/i);
    const code = (m ? m[1] : w).trim().toUpperCase();
    if (!ASIN_RE.test(code)) {
      problems.push(`ASIN 格式不对:${w.slice(0, 24)}`);
      continue;
    }
    pushAsin(code);
  }

  if (keep.length > 1000) {
    problems.push(
      `每条活动 ${keep.length} 个否定词,亚马逊上限一般是 1000。` +
      (series
        ? '系列广告可以把「联动否定」改成只否墨盒型号,或者拆成多个任务'
        : '先精简词库')
    );
  }

  return { negs: keep, asins, problems, series };
}

/* ---------------- 生成计划 ---------------- */

/**
 * 一个任务 = 一组 SKU + 一套组合设置,产出若干条广告活动。
 * 返回 { campaigns, blockRows, problems }  —— campaigns 还没有行号
 */
export function buildTaskPlan(task, negData) {
  const problems = [...(negData.problems || [])];
  const skus = parseLines(task.skus);
  const params = {
    prefix: task.prefix,
    sep: task.sep,
    tokens: task.tokens,
    autoLang: task.autoLang,
    baseBid: task.baseBid,
    rounding: task.rounding,
    coefs: task.coefs,
  };

  let premList = [];
  if (task.mode === 'wf') {
    const tiers = String(task.tiers ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    if (!task.places?.length) {
      premList = [{}];
    } else {
      for (const place of task.places) for (const pct of tiers) premList.push({ [place]: pct });
      if (!tiers.length) problems.push('溢价档位没填(不想加溢价就把广告位全部取消勾选)');
    }
  } else {
    const r = parseCombos(task.combos);
    premList = r.out;
    problems.push(...r.problems);
    if (!premList.length && !r.problems.length) problems.push('溢价组合还是空的');
  }

  const campaigns = [];
  const made = new Set();
  const dups = [];

  for (const strat of task.strategies || []) {
    for (const prem of premList) {
      for (const auto of task.autoTypes || []) {
        const info = bidInfo(prem, strat, params);
        const p = {
          auto,
          strat,
          prem,
          active: activeOf(prem),
          bid: info.bid,
          factor: info.factor,
          driver: info.driver,
        };
        p.name = campName(p, params);
        if (made.has(p.name)) {
          dups.push(p.name);
          continue;
        }
        made.add(p.name);
        campaigns.push(p);
      }
    }
  }

  const negRows = negData.negs.length + negData.asins.length;
  const blockRows = HEAD_ROWS + skus.length + TAIL_ROWS + negRows;

  if (!skus.length) problems.push('还没填 SKU');
  if (!task.autoTypes?.length) problems.push('至少勾一个自动广告类型');
  if (!task.strategies?.length) problems.push('至少勾一个竞价方案');
  if (dups.length) {
    problems.push(
      `命名规则撞名 ${dups.length} 条(如 ${dups[0]})——把「竞价方案 / 溢价位置」勾上,或改前缀`
    );
  }
  if (Number(task.defBid) < MIN_BID) problems.push(`默认竞价不能低于 ${MIN_BID}`);
  const low = campaigns.filter((p) => p.bid < MIN_BID);
  if (low.length) {
    problems.push(`${low.length} 条出价低于亚马逊最低 ${MIN_BID}(如 ${low[0].name} → ${low[0].bid})`);
  }
  if (skus.length !== new Set(skus.map((s) => s.toLowerCase())).size) {
    problems.push('SKU 有大小写重复');
  }

  return {
    campaigns, blockRows, skus, problems,
    negs: negData.negs, asins: negData.asins, series: negData.series,
  };
}

/* ---------------- 写表 ---------------- */

const blank = () => new Array(W).fill(null);

function mkRow(entity, cells) {
  const r = blank();
  r[C.PROD] = '商品推广';
  r[C.ENTITY] = entity;
  r[C.OP] = 'Create';
  for (const k in cells) r[+k] = cells[k];
  return r;
}

function writeBlock(out, top, p, task, plan) {
  const strat = strategyOf(p.strat).sheet;
  const dRaw = String(task.date ?? '').trim();
  const dVal = /^\d+$/.test(dRaw) ? parseInt(dRaw, 10) : dRaw;
  const name = p.name;
  let r = top;

  out[r++] = mkRow('广告活动', {
    [C.CAMP]: name, [C.PORT]: task.portfolio, [C.CAMPNAME]: name, [C.DATE]: dVal,
    [C.TARGETING]: '自动', [C.STATUS]: '已启用',
    [C.BUDGET]: Number(task.budget) || 1.2, [C.STRATEGY]: strat,
  });

  for (const [key, label] of PLACE_ROWS) {
    out[r++] = mkRow('竞价调整', {
      [C.CAMP]: name, [C.STRATEGY]: strat, [C.PLACEMENT]: label, [C.PCT]: p.prem[key] || 0,
    });
  }

  out[r++] = mkRow('广告组', {
    [C.CAMP]: name, [C.GROUP]: name, [C.GROUPNAME]: name,
    [C.STATUS]: '已启用', [C.DEFBID]: Number(task.defBid) || MIN_BID,
  });

  for (const sku of plan.skus) {
    out[r++] = mkRow('商品广告', {
      [C.CAMP]: name, [C.GROUP]: name, [C.STATUS]: '已启用', [C.SKU]: sku,
    });
  }

  const idle = Number(task.idleBid) || MIN_BID;
  for (const [auto, tag] of AUTO_TYPES) {
    const on = auto === p.auto;
    out[r++] = mkRow('商品定向', {
      [C.CAMP]: name, [C.GROUP]: name,
      [C.STATUS]: on ? '已启用' : '已暂停',
      [C.BID]: on ? p.bid : idle, [C.TARGET]: tag,
    });
  }

  // 活动级否定不写广告组编号,广告组级要写
  for (const n of plan.negs) {
    const cells = { [C.CAMP]: name, [C.STATUS]: '已启用', [C.KWTEXT]: n.text, [C.MATCH]: n.match };
    if (n.needGroup) cells[C.GROUP] = name;
    out[r++] = mkRow(n.entity, cells);
  }
  for (const a of plan.asins) {
    out[r++] = mkRow('否定商品定向', {
      [C.CAMP]: name, [C.GROUP]: name, [C.STATUS]: '已启用', [C.TARGET]: a,
    });
  }

  out[top + plan.blockRows] = blank(); // 块后空行
  return r;
}

/**
 * 多个任务合成一张总表。
 * plans: [{task, plan}] —— plan 来自 buildTaskPlan
 * 返回 { aoa, problems, campaignCount }
 */
export function buildWorkbookData(plans, existingNames = new Set()) {
  const out = [HEADERS.slice()];
  const placed = [];
  let row = 1;

  for (const { task, plan } of plans) {
    for (const p of plan.campaigns) {
      if (existingNames.has(p.name)) continue;
      placed.push({ task, plan, p, row });
      row += plan.blockRows + 1;
    }
  }

  if (!placed.length) return { aoa: out, placed, bad: ['没有可生成的广告活动'] };

  const need = placed[placed.length - 1].row + placed[placed.length - 1].plan.blockRows + 1;
  while (out.length < need) out.push(blank());

  for (const item of placed) writeBlock(out, item.row, item.p, item.task, item.plan);

  const bad = selfCheck(out, placed);
  return { aoa: out, placed, bad };
}

/* ---------------- 三道自检(照搬 V3) ---------------- */

function selfCheck(out, placed) {
  const bad = [];

  for (const { task, plan, p, row: t } of placed) {
    const strat = strategyOf(p.strat).sheet;
    if (out[t][C.ENTITY] !== '广告活动') bad.push(`${p.name} 首行不是广告活动`);
    if (out[t][C.CAMP] !== p.name) bad.push(`${p.name} D列`);
    if (out[t][C.CAMPNAME] !== p.name) bad.push(`${p.name} J列`);
    if (out[t][C.TARGETING] !== '自动') bad.push(`${p.name} 投放类型`);
    if (out[t][C.STRATEGY] !== strat) bad.push(`${p.name} X列`);

    for (const [key, label, off] of PLACEMENTS) {
      const rr = out[t + off];
      if (rr[C.ENTITY] !== '竞价调整') bad.push(`${p.name} 第${t + off + 1}行应为竞价调整`);
      if (rr[C.PLACEMENT] !== label) bad.push(`${p.name} 广告位标签`);
      if (rr[C.PCT] !== (p.prem[key] || 0)) bad.push(`${p.name} ${key}溢价`);
      if (rr[C.STRATEGY] !== strat) bad.push(`${p.name} 广告位行X列`);
    }

    const g = out[t + 1 + PLACEMENTS.length];
    if (g[C.ENTITY] !== '广告组' || g[C.GROUPNAME] !== p.name) bad.push(`${p.name} 广告组行`);

    for (let i = 0; i < plan.skus.length; i++) {
      const rr = out[t + HEAD_ROWS + i];
      if (rr[C.ENTITY] !== '商品广告' || rr[C.SKU] !== plan.skus[i]) {
        bad.push(`${p.name} SKU第${i + 1}行`);
      }
    }

    for (let i = 0; i < AUTO_TYPES.length; i++) {
      const rr = out[t + HEAD_ROWS + plan.skus.length + i];
      const [auto, tag] = AUTO_TYPES[i];
      if (rr[C.CAMP] !== p.name || rr[C.GROUP] !== p.name) bad.push(`${p.name} 商品定向父级关联`);
      if (rr[C.TARGET] !== tag) bad.push(`${p.name} AA列`);
      if (auto === p.auto) {
        if (rr[C.STATUS] !== '已启用') bad.push(`${p.name} 启用行状态`);
        if (rr[C.BID] !== p.bid) bad.push(`${p.name} 启用行出价 ${rr[C.BID]}≠${p.bid}`);
      } else if (rr[C.STATUS] !== '已暂停') bad.push(`${p.name} 暂停行状态`);
    }

    const nb = t + HEAD_ROWS + plan.skus.length + AUTO_TYPES.length;
    for (let i = 0; i < plan.negs.length; i++) {
      const rr = out[nb + i];
      const n = plan.negs[i];
      if (rr[C.ENTITY] !== n.entity) bad.push(`${p.name} 否定行实体 ${rr[C.ENTITY]}≠${n.entity}`);
      if (rr[C.KWTEXT] !== n.text) bad.push(`${p.name} 否定词文本`);
      if (rr[C.MATCH] !== n.match) bad.push(`${p.name} 否定匹配类型`);
      if (n.needGroup) {
        if (rr[C.GROUP] !== p.name) bad.push(`${p.name} 否定行缺广告组编号`);
      } else if (rr[C.GROUP] !== null && rr[C.GROUP] !== undefined) {
        bad.push(`${p.name} 活动级否定不该有广告组编号`);
      }
    }
    for (let i = 0; i < plan.asins.length; i++) {
      const rr = out[nb + plan.negs.length + i];
      if (rr[C.ENTITY] !== '否定商品定向') bad.push(`${p.name} 否定商品定向实体`);
      if (rr[C.TARGET] !== plan.asins[i]) bad.push(`${p.name} ASIN表达式 ${rr[C.TARGET]}`);
      if (rr[C.GROUP] !== p.name) bad.push(`${p.name} 否定商品定向缺广告组编号`);
    }
    for (let i = 0; i < plan.blockRows; i++) {
      if (out[t + i][C.CAMP] !== p.name) bad.push(`${p.name} 第${t + i + 1}行 D列不一致`);
    }
  }

  // 全表:已启用但竞价无效
  for (let i = 1; i < out.length; i++) {
    if (out[i][C.ENTITY] === '商品定向' && out[i][C.STATUS] === '已启用') {
      const b = out[i][C.BID];
      if (b === null || b === undefined || b === '' || !(b >= MIN_BID)) {
        bad.push(`第${i + 1}行 已启用但竞价无效 (${out[i][C.CAMP]})`);
      }
    }
  }

  // 活动名唯一
  const seen = new Set();
  for (let i = 1; i < out.length; i++) {
    if (out[i][C.ENTITY] === '广告活动') {
      if (seen.has(out[i][C.CAMP])) bad.push(`活动名重复: ${out[i][C.CAMP]}`);
      seen.add(out[i][C.CAMP]);
    }
  }

  return bad;
}

/* ---------------- 下载 ---------------- */

const COL_WIDTHS = [10, 12, 8, 34, 34, 18, 12, 12, 14, 34, 34, 12, 12, 10, 9, 10, 24, 14, 8, 30, 14, 12, 12, 20, 24, 8, 18];

export function downloadWorkbook(aoa, filename) {
  const ns = XLSX.utils.aoa_to_sheet(aoa);
  ns['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ns, SHEET);
  XLSX.writeFile(wb, filename, { bookType: 'xlsx' });
}

export function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
