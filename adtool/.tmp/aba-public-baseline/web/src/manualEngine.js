/**
 * 手动广告(关键词投放 / 商品投放)批量表生成引擎
 *
 * 从桌面版「AMAZON 广告批量生成器 V13」的任务表模式移植:校验口径、写表顺序、
 * 自检逻辑都跟桌面版对齐,同一份表两边生成结果一致。
 *
 * 桌面版那一套参数库 / 产品库 / 打印机型号库不搬过来 —— 关键词和 ASIN 一律由
 * 运营自己粘贴。只有否定词继续联动站点的 A–E 否定词库(和自动广告页共用一套)。
 *
 * 这里全是纯函数,不碰 DOM。
 */
import {
  HEADERS, C, SHEET, PLACEMENTS, PLACE_ROWS, ORDER, MIN_BID, KW_MAX_CHARS, parseLines,
} from './adEngine.js';

const W = HEADERS.length;

/*
 * 竞价方案: 界面短名 -> 表格写入值(手动广告不参与命名,所以不带后缀)
 * factor = 亚马逊还会在广告位上自己往上加价,折算出价时要多除一个系数
 */
export const MANUAL_STRATEGIES = [
  { id: 'down', label: '仅降低', sheet: '动态竞价 - 仅降低', factor: false },
  { id: 'updown', label: '提高和降低', sheet: '动态竞价 - 提高和降低', factor: true },
  { id: 'fixed', label: '固定竞价', sheet: '固定竞价', factor: false },
];

/* 匹配类型: id 就是写进「匹配类型」列的值 */
export const MATCH_TYPES = [
  { id: '精准', label: '精准', hint: '写成 [关键词]' },
  { id: '词组', label: '词组', hint: '写成 "关键词"' },
  { id: '广泛', label: '广泛', hint: '不加任何标记' },
];

/* 商品投放: id 就是表达式前缀,写进「拓展商品投放编号」列 */
export const TARGET_TYPES = [
  { id: 'asin', label: 'ASIN 精准', hint: '只打这个 ASIN 的商品页' },
  { id: 'asin-expanded', label: 'ASIN 扩展', hint: '连带亚马逊判定的相似商品,覆盖更宽' },
  { id: 'category', label: '品类', hint: '填品类 ID(纯数字),如 34285014031' },
];

export const TGT_ENTITY = '商品定向';
export const NEG_TGT_ENTITY = '否定商品定向';
export const KW_MAX_WORDS = 10;
export const MIN_BUDGET = 1;
export const CAMP_NAME_MAX = 128;

const TARGET_EXPR_RE = /^(asin|asin-expanded|category|brand)="[^"]+"$/;
const AUTO_EXPR = ['close-match', 'loose-match', 'substitutes', 'complements'];

export function strategyOf(id) {
  return MANUAL_STRATEGIES.find((s) => s.id === id) ?? MANUAL_STRATEGIES[0];
}

/* ---------------- 出价 ↔ 落地 CPC ---------------- */

/** 广告位默认系数,和自动广告页同一份(PLACEMENTS 第四列) */
export const DEFAULT_COEFS = Object.fromEntries(PLACEMENTS.map(([k, , , c]) => [k, c]));

/** 「提高和降低」才打系数,仅降低 / 固定竞价一律 ×1 —— 和自动广告页口径一致 */
export function placeCoef(place, strategyId, coefs) {
  if (!strategyOf(strategyId).factor) return 1;
  const p = PLACEMENTS.find((x) => x[0] === place);
  if (!p) return 1;
  const v = Number(coefs?.[place]);
  return isFinite(v) && v > 0 ? v : p[3];
}

/**
 * 每个广告位把出价放大多少倍:(1 + 溢价) × 系数,按 TOS / ROS / PP 的顺序给。
 * 溢价填 0 的广告位不参与折算(系数按 ×1 算)—— 和自动广告页「不加溢价就不打系数」一个口径。
 */
export function placeFactors(places, strategyId, coefs) {
  return ORDER.map((key) => {
    const raw = Number(String(places?.[key] ?? '').trim());
    const pct = isFinite(raw) && raw > 0 ? raw : 0;
    const coef = pct > 0 ? placeCoef(key, strategyId, coefs) : 1;
    return { key, pct, coef, factor: Math.round((1 + pct / 100) * coef * 1000) / 1000 };
  });
}

/** 一条活动按最贵的那个广告位折算,保证任何位置的落地 CPC 都不超过目标 */
export function topFactor(rows) {
  let factor = 1;
  let driver = null;
  for (const r of rows || []) {
    if (r.factor > factor) {
      factor = r.factor;
      driver = r.key;
    }
  }
  return { factor: Math.round(factor * 1000) / 1000, driver };
}

export function roundBid(value, rounding) {
  const v = Number(value);
  if (!isFinite(v)) return 0;
  return rounding === 'trunc'
    ? Math.floor(v * 100) / 100
    : Math.round((v + Number.EPSILON) * 100) / 100;
}

/** 目标 CPC -> 出价 */
export function bidFromCpc(cpc, factor, rounding) {
  return roundBid((Number(cpc) || 0) / (factor || 1), rounding);
}

/** 出价 -> 各广告位的落地 CPC(实际会被扣到多少钱) */
export function landedCpc(bid, rows) {
  const b = Number(bid) || 0;
  return (rows || []).map((r) => ({ ...r, cpc: Math.round(b * r.factor * 1000) / 1000 }));
}

/* ---------------- 关键词 / 投放表达式 ---------------- */

/** 去掉关键词外层的精准 / 词组标记,避免重复加引号或方括号 */
export function stripMatchSyntax(word) {
  const w = String(word ?? '').trim().replace(/\s+/g, ' ');
  if (w.length >= 2) {
    const a = w[0];
    const b = w[w.length - 1];
    if ((a === '"' && b === '"') || (a === '[' && b === ']')) return w.slice(1, -1).trim();
  }
  return w;
}

/** 解析关键词框:去空、压空格、剥掉已有的 "" / [],再按小写去重 */
export function parseKeywordLines(text) {
  const out = [];
  const seen = new Set();
  for (const line of parseLines(text)) {
    const w = stripMatchSyntax(line);
    const key = w.toLowerCase();
    if (!w || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** 按匹配类型给关键词文本加标记 */
export function formatKeyword(word, matchType) {
  const w = stripMatchSyntax(word);
  if (matchType === '精准') return `[${w}]`;
  if (matchType === '词组') return `"${w}"`;
  return w;
}

/** B08XXXXXXX -> asin="B08XXXXXXX";已经写成表达式的原样返回 */
export function formatTarget(value, kind) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (v.includes('=') || AUTO_EXPR.includes(v)) return v;
  if (kind === 'category') return `category="${v}"`;
  return `${kind}="${v.toUpperCase()}"`;
}

/** 返回不合规原因,合规返回 null */
export function targetProblem(value, kind) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (v.includes('=')) return null;                       // 用户直接写了表达式,不拦
  if (kind === 'category') return /^\d+$/.test(v) ? null : `品类 ID 应该是纯数字:${v}`;
  return /^[A-Za-z0-9]{10}$/.test(v) ? null : `ASIN 应该是 10 位字母数字:${v}`;
}

/* ---------------- 生成计划 ---------------- */

function num(value) {
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const v = Number(s);
  return isFinite(v) ? v : NaN;
}

function validDate(s) {
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 一个任务 = 一条手动广告活动。
 *
 * task: {
 *   camp, group, portfolio, date, budget, defBid, strategy,
 *   places: { TOS, ROS, PP },
 *   skus, mode: 'kw' | 'tgt', splitGroup,
 *   kw:  { 精准: {on, bid, text}, 词组: {...}, 广泛: {...} },
 *   tgt: { asin: {on, bid, text}, 'asin-expanded': {...}, category: {...} },
 *   ...词库联动字段(libUse / adType / seriesModels / seriesScope / extraNeg)
 * }
 * negData: buildNegatives() 的返回值 —— 和自动广告页共用同一套否定词逻辑
 *
 * 返回的 plan 里 problems 是硬错误(拦住生成),warnings 只是提醒。
 */
export function buildManualPlan(task, negData) {
  const problems = [...(negData?.problems ?? [])];
  const warnings = [];

  const camp = String(task.camp ?? '').trim();
  if (!camp) problems.push('广告活动名称不能为空');
  else if (camp.length > CAMP_NAME_MAX) {
    problems.push(`广告活动名称过长(${camp.length} 字符,上限 ${CAMP_NAME_MAX})`);
  }
  const group = String(task.group ?? '').trim() || camp;

  const start = String(task.date ?? '').trim();
  if (!/^\d{8}$/.test(start)) problems.push('开始日期要写成 8 位数字,例如 20260730');
  else if (!validDate(start)) problems.push(`开始日期 ${start} 不是有效日期`);

  const rawBudget = num(task.budget);
  if (rawBudget === null || isNaN(rawBudget)) problems.push('每日预算必须是数字');
  else if (rawBudget < 0.01) problems.push('每日预算不能小于 0.01');
  else if (rawBudget < MIN_BUDGET) {
    warnings.push(`每日预算 ${rawBudget} 低于常见最低值 ${MIN_BUDGET},亚马逊可能拒绝`);
  }

  // 填得不对时后面的预览还要照常算,先给个兜底值(这时 problems 已经拦住生成了)
  const budget = rawBudget === null || isNaN(rawBudget) ? 0 : rawBudget;

  const places = {};
  for (const [key] of PLACEMENTS) {
    const v = num(task.places?.[key]);
    if (v === null) { places[key] = 0; continue; }          // 留空按 0 处理
    if (isNaN(v)) { problems.push(`${key} 溢价必须是数字`); places[key] = 0; continue; }
    if (v < 0) problems.push(`${key} 溢价不能是负数`);
    if (v > 900) warnings.push(`${key} 溢价 ${v}% 超过 900%`);
    places[key] = v;
  }

  // 出价:要么自己填,要么填目标 CPC 由溢价和系数反推(和自动广告页同一套折算)
  const bidMode = task.bidMode === 'cpc' ? 'cpc' : 'bid';
  const rounding = task.rounding === 'trunc' ? 'trunc' : 'round';
  const coefs = { ...DEFAULT_COEFS, ...(task.coefs ?? {}) };
  const factors = placeFactors(places, task.strategy, coefs);
  const { factor, driver } = topFactor(factors);

  let defBid;
  let baseCpc = null;
  if (bidMode === 'cpc') {
    const raw = num(task.baseBid);
    if (raw === null || isNaN(raw)) {
      problems.push('目标 CPC 必须是数字');
      defBid = MIN_BID;
    } else {
      baseCpc = raw;
      defBid = bidFromCpc(raw, factor, rounding);
      if (!(defBid >= MIN_BID)) {
        problems.push(
          `目标 CPC ${raw} 按 ÷${factor} 折算出来是 ${defBid},低于亚马逊最低出价 ${MIN_BID}`
        );
      }
    }
  } else {
    const raw = num(task.defBid);
    if (raw === null || isNaN(raw)) problems.push('广告组默认竞价必须是数字');
    else if (raw < MIN_BID) problems.push(`广告组默认竞价不能低于 ${MIN_BID}(当前 ${raw})`);
    defBid = raw === null || isNaN(raw) ? MIN_BID : raw;
  }

  const skus = parseLines(task.skus);
  if (!skus.length) problems.push('至少要填一个投放 SKU');

  // 留空 = 用广告组默认竞价;CPC 模式下填进来的数字也是目标 CPC,一样要折算
  const bidOf = (raw, name) => {
    const v = num(raw);
    if (v === null) return defBid;
    if (isNaN(v)) {
      problems.push(`${name}${bidMode === 'cpc' ? '的目标 CPC' : '出价'}必须是数字`);
      return defBid;
    }
    if (bidMode === 'cpc') {
      const b = bidFromCpc(v, factor, rounding);
      if (!(b >= MIN_BID)) {
        problems.push(`${name}的目标 CPC ${v} 折算成出价是 ${b},低于亚马逊最低出价 ${MIN_BID}`);
      }
      return b;
    }
    if (v < MIN_BID) problems.push(`${name}出价不能低于 ${MIN_BID}(当前 ${v})`);
    return v;
  };

  const mode = task.mode === 'tgt' ? 'tgt' : 'kw';
  const units = [];

  let anyInput = false;                                     // 勾了且粘贴了内容,哪怕后面被校验刷掉

  if (mode === 'kw') {
    const seen = new Set();
    for (const mt of MATCH_TYPES) {
      const cfg = task.kw?.[mt.id];
      if (!cfg?.on) continue;
      const words = parseKeywordLines(cfg.text);
      if (!words.length) continue;
      anyInput = true;
      const bid = bidOf(cfg.bid, mt.label);
      const items = [];
      for (const w of words) {
        const text = formatKeyword(w, mt.id);
        if (text.length > KW_MAX_CHARS) {
          problems.push(`关键词加匹配符后过长(${text.length} 字符 > ${KW_MAX_CHARS}):${text.slice(0, 40)}…`);
          continue;
        }
        if (w.split(' ').length > KW_MAX_WORDS) {
          warnings.push(`关键词超过 ${KW_MAX_WORDS} 个单词,可能被拒:${w.slice(0, 40)}`);
        }
        const key = `${w.toLowerCase()}|${mt.id}`;
        if (!task.splitGroup && seen.has(key)) {
          problems.push(`同一广告组内重复关键词:「${w}」(${mt.label})`);
          continue;
        }
        seen.add(key);
        items.push({ text, bare: w, match: mt.id });
      }
      if (items.length) units.push({ key: mt.id, label: mt.label, bid, items });
    }
    if (!units.length && !anyInput) problems.push('至少勾一种匹配类型,并粘贴关键词');
  } else {
    const seen = new Map();
    for (const tt of TARGET_TYPES) {
      const cfg = task.tgt?.[tt.id];
      if (!cfg?.on) continue;
      const raws = parseLines(cfg.text);
      if (!raws.length) continue;
      anyInput = true;
      const bid = bidOf(cfg.bid, tt.label);
      const items = [];
      for (const raw of raws) {
        const bad = targetProblem(raw, tt.id);
        if (bad) { problems.push(`${tt.label}:${bad}`); continue; }
        const expr = formatTarget(raw, tt.id);
        const k = expr.toLowerCase();
        if (seen.has(k)) {
          problems.push(`同一活动内重复投放:${expr}(${seen.get(k)} 和 ${tt.label} 都填了)`);
          continue;
        }
        seen.set(k, tt.label);
        items.push({ text: expr });
      }
      if (items.length) units.push({ key: tt.id, label: tt.label, bid, items });
    }
    if (!units.length && !anyInput) problems.push('至少勾一种定向类型,并粘贴 ASIN / 品类 ID');
  }

  // 亚马逊规定一个广告组要么打关键词、要么打商品定向,所以这里按投放方式拆组
  const groups = task.splitGroup
    ? units.map((u) => ({ name: `${group}_${u.key}`, units: [u] }))
    : [{ name: group, units }];

  const campNegs = (negData?.negs ?? []).filter((n) => !n.needGroup);
  const groupNegs = (negData?.negs ?? []).filter((n) => n.needGroup);
  const asins = negData?.asins ?? [];

  // 商品投放模式下,投放的 ASIN 又出现在否定商品定向里(E 类词库或本任务否定),
  // 生成出来两行会互相打架,先拦下来让运营取舍
  if (mode === 'tgt' && asins.length) {
    const codeOf = (expr) =>
      (String(expr).match(/^asin(?:-expanded)?="([^"]+)"$/i)?.[1] ?? '').toUpperCase();
    const negCodes = new Set(asins.map(codeOf).filter(Boolean));
    for (const u of units) {
      for (const it of u.items) {
        const code = codeOf(it.text);
        if (code && negCodes.has(code)) {
          problems.push(`${code} 既在投放里又在否定 ASIN 里,取消 E 类词库或删掉这条否定`);
        }
      }
    }
  }

  const groupRows = (g) =>
    1 + skus.length + g.units.reduce((a, u) => a + u.items.length, 0)
    + groupNegs.length + asins.length;
  const rows = 1 + PLACEMENTS.length + campNegs.length
    + groups.reduce((a, g) => a + groupRows(g), 0);

  const targets = units.reduce((a, u) => a + u.items.length, 0);

  return {
    ok: problems.length === 0,
    camp, group, mode, start, places, skus, units, groups,
    portfolio: String(task.portfolio ?? '').trim(),
    budget,
    defBid,
    strategy: strategyOf(task.strategy).sheet,
    // 出价折算:factor 是按最贵的广告位算的倍数,landing 是各位置的落地 CPC
    bidMode, baseCpc, factor, driver, rounding, coefs,
    factors,
    landing: landedCpc(defBid, factors),
    campNegs, groupNegs, asins, targets, rows,
    problems, warnings,
    series: negData?.series ?? null,
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

/** 一条活动的所有行。返回写完之后的下一行号 */
function writeBlock(out, top, plan) {
  const { camp, strategy } = plan;
  const date = /^\d+$/.test(plan.start) ? parseInt(plan.start, 10) : plan.start;
  let r = top;

  out[r++] = mkRow('广告活动', {
    [C.CAMP]: camp, [C.PORT]: plan.portfolio, [C.CAMPNAME]: camp, [C.DATE]: date,
    [C.TARGETING]: '手动', [C.STATUS]: '已启用',
    [C.BUDGET]: plan.budget, [C.STRATEGY]: strategy,
  });

  for (const [key, label] of PLACE_ROWS) {
    out[r++] = mkRow('竞价调整', {
      [C.CAMP]: camp, [C.STRATEGY]: strategy,
      [C.PLACEMENT]: label, [C.PCT]: plan.places[key] || 0,
    });
  }

  // 活动级否定只写一次,不带广告组编号
  for (const n of plan.campNegs) {
    out[r++] = mkRow(n.entity, {
      [C.CAMP]: camp, [C.STATUS]: '已启用', [C.KWTEXT]: n.text, [C.MATCH]: n.match,
    });
  }

  for (const g of plan.groups) {
    out[r++] = mkRow('广告组', {
      [C.CAMP]: camp, [C.GROUP]: g.name, [C.GROUPNAME]: g.name,
      [C.STATUS]: '已启用', [C.DEFBID]: plan.defBid,
    });
    for (const sku of plan.skus) {
      out[r++] = mkRow('商品广告', {
        [C.CAMP]: camp, [C.GROUP]: g.name, [C.STATUS]: '已启用', [C.SKU]: sku,
      });
    }
    for (const u of g.units) {
      for (const it of u.items) {
        out[r++] = plan.mode === 'kw'
          ? mkRow('关键词', {
            [C.CAMP]: camp, [C.GROUP]: g.name, [C.STATUS]: '已启用',
            [C.BID]: u.bid, [C.KWTEXT]: it.text, [C.MATCH]: u.key,
          })
          : mkRow(TGT_ENTITY, {
            [C.CAMP]: camp, [C.GROUP]: g.name, [C.STATUS]: '已启用',
            [C.BID]: u.bid, [C.TARGET]: it.text,
          });
      }
    }
    // 广告组级否定每个组都要写一遍
    for (const n of plan.groupNegs) {
      out[r++] = mkRow(n.entity, {
        [C.CAMP]: camp, [C.GROUP]: g.name, [C.STATUS]: '已启用',
        [C.KWTEXT]: n.text, [C.MATCH]: n.match,
      });
    }
    for (const a of plan.asins) {
      out[r++] = mkRow(NEG_TGT_ENTITY, {
        [C.CAMP]: camp, [C.GROUP]: g.name, [C.STATUS]: '已启用', [C.TARGET]: a,
      });
    }
  }

  return r;
}

/**
 * 多个任务合成一张总表。
 * plans: [{ task, plan }] —— plan 来自 buildManualPlan
 * 返回 { aoa, placed, bad }
 */
export function buildManualWorkbookData(plans) {
  const out = [HEADERS.slice()];
  const placed = [];
  let row = 1;

  for (const { plan } of plans) {
    if (!plan.ok) continue;
    placed.push({ plan, top: row, end: row + plan.rows - 1 });
    row += plan.rows + 1;                     // 活动之间空一行
  }

  if (!placed.length) return { aoa: out, placed, bad: ['没有可生成的广告活动'] };

  while (out.length < row) out.push(blank());
  for (const item of placed) writeBlock(out, item.top, item.plan);

  return { aoa: out, placed, bad: selfCheck(out, placed) };
}

/* ---------------- 自检(照搬桌面版 self_check) ---------------- */

function selfCheck(out, placed) {
  const bad = [];
  const cell = (r, c) => out[r]?.[c];

  for (const { plan, top, end } of placed) {
    const camp = plan.camp;

    if (cell(top, C.ENTITY) !== '广告活动') bad.push(`${camp}: 第${top + 1}行不是广告活动行`);
    for (const [col, exp, nm] of [
      [C.TARGETING, '手动', '投放类型'],
      [C.STATUS, '已启用', '状态'],
      [C.STRATEGY, plan.strategy, '竞价方案'],
      [C.BUDGET, plan.budget, '预算'],
      [C.CAMPNAME, camp, '活动名称'],
    ]) {
      if (cell(top, col) !== exp) bad.push(`${camp}: ${nm}=${cell(top, col)} 应为 ${exp}`);
    }

    const seenPlace = new Map();
    for (let i = 1; i <= PLACEMENTS.length; i++) {
      if (cell(top + i, C.ENTITY) !== '竞价调整') {
        bad.push(`${camp}: 第${top + i + 1}行应为竞价调整`);
        continue;
      }
      seenPlace.set(cell(top + i, C.PLACEMENT), cell(top + i, C.PCT));
    }
    for (const [key, label] of PLACEMENTS) {
      if (!seenPlace.has(label)) bad.push(`${camp}: 缺广告位 ${label}`);
      else if (seenPlace.get(label) !== (plan.places[key] || 0)) {
        bad.push(`${camp}: ${key} 溢价=${seenPlace.get(label)} 应为 ${plan.places[key] || 0}`);
      }
    }

    const count = new Map();
    const dupSeen = new Set();
    const perGroup = new Map();
    for (let r = top; r <= end; r++) {
      const e = cell(r, C.ENTITY);
      count.set(e, (count.get(e) ?? 0) + 1);
      if (cell(r, C.PROD) !== '商品推广') bad.push(`${camp}: 第${r + 1}行 A列不是商品推广`);
      if (cell(r, C.OP) !== 'Create') bad.push(`${camp}: 第${r + 1}行 操作不是 Create`);
      if (cell(r, C.CAMP) !== camp) bad.push(`${camp}: 第${r + 1}行 广告活动编号不一致`);

      const g = cell(r, C.GROUP);
      if (['广告组', '商品广告', '关键词', '否定关键词', TGT_ENTITY, NEG_TGT_ENTITY].includes(e) && !g) {
        bad.push(`${camp}: 第${r + 1}行 缺广告组编号`);
      }
      if (e === '广告活动否定关键词' && g) {
        bad.push(`${camp}: 第${r + 1}行 活动级否定不该写广告组编号`);
      }

      if (e === '关键词') {
        const txt = cell(r, C.KWTEXT);
        const mt = cell(r, C.MATCH);
        const bid = cell(r, C.BID);
        if (!txt) bad.push(`${camp}: 第${r + 1}行 关键词文本为空`);
        if (!['精准', '词组', '广泛'].includes(mt)) bad.push(`${camp}: 第${r + 1}行 匹配类型=${mt} 非法`);
        const s = String(txt ?? '');
        const quoted = s.length >= 2 && s.startsWith('"') && s.endsWith('"');
        const bracketed = s.length >= 2 && s.startsWith('[') && s.endsWith(']');
        if (mt === '精准' && !bracketed) bad.push(`${camp}: 第${r + 1}行 精准关键词未用方括号包裹`);
        if (mt === '词组' && !quoted) bad.push(`${camp}: 第${r + 1}行 词组关键词未用英文双引号包裹`);
        if (mt === '广泛' && (quoted || bracketed)) {
          bad.push(`${camp}: 第${r + 1}行 广泛关键词不应带精准/词组标记`);
        }
        if (typeof bid !== 'number' || !(bid >= MIN_BID)) bad.push(`${camp}: 第${r + 1}行 竞价=${bid} 非法`);
        const key = `${g}|${stripMatchSyntax(s).toLowerCase()}|${mt}`;
        if (dupSeen.has(key)) bad.push(`${camp}: 关键词「${txt}」(${mt}) 在同组内重复`);
        dupSeen.add(key);
      }

      if (e === TGT_ENTITY || e === NEG_TGT_ENTITY) {
        const expr = cell(r, C.TARGET);
        if (!expr) bad.push(`${camp}: 第${r + 1}行 拓展商品投放编号为空`);
        else if (!TARGET_EXPR_RE.test(String(expr)) && !AUTO_EXPR.includes(String(expr))) {
          bad.push(`${camp}: 第${r + 1}行 投放表达式格式不对:${expr}`);
        }
        if (cell(r, C.KWTEXT)) bad.push(`${camp}: 第${r + 1}行 商品定向不该写关键词文本`);
        const b = cell(r, C.BID);
        if (e === TGT_ENTITY) {
          if (typeof b !== 'number' || !(b >= MIN_BID)) bad.push(`${camp}: 第${r + 1}行 商品定向竞价=${b} 非法`);
          const key = `${g}|${String(expr).toLowerCase()}`;
          if (dupSeen.has(key)) bad.push(`${camp}: 投放「${expr}」在同组内重复`);
          dupSeen.add(key);
        } else if (b !== null && b !== undefined && b !== '') {
          bad.push(`${camp}: 第${r + 1}行 否定商品定向不该写竞价`);
        }
      }

      if ((e === '否定关键词' || e === '广告活动否定关键词')
        && !['否定精准匹配', '否定词组'].includes(cell(r, C.MATCH))) {
        bad.push(`${camp}: 第${r + 1}行 否定匹配类型非法`);
      }
      if (e === '商品广告' && !cell(r, C.SKU)) bad.push(`${camp}: 第${r + 1}行 SKU 为空`);
      if (e === '广告组') {
        const b = cell(r, C.DEFBID);
        if (typeof b !== 'number' || !(b >= MIN_BID)) bad.push(`${camp}: 第${r + 1}行 默认竞价=${b} 非法`);
      }
      if (e === '关键词' || e === TGT_ENTITY) {
        if (!perGroup.has(g)) perGroup.set(g, new Set());
        perGroup.get(g).add(e);
      }
    }

    const ngrp = plan.groups.length;
    const expect = [
      ['广告活动', 1],
      ['竞价调整', PLACEMENTS.length],
      ['广告组', ngrp],
      ['商品广告', plan.skus.length * ngrp],
      [plan.mode === 'kw' ? '关键词' : TGT_ENTITY, plan.targets],
      ['否定关键词', plan.groupNegs.filter((n) => n.entity === '否定关键词').length * ngrp],
      ['广告活动否定关键词', plan.campNegs.length],
      [NEG_TGT_ENTITY, plan.asins.length * ngrp],
    ];
    for (const [e, exp] of expect) {
      if ((count.get(e) ?? 0) !== exp) bad.push(`${camp}: ${e} 行数=${count.get(e) ?? 0} 应为 ${exp}`);
    }

    // 亚马逊不允许一个广告组既打关键词又打商品定向
    for (const [gname, kinds] of perGroup) {
      if (kinds.size > 1) bad.push(`${camp}: 广告组「${gname}」同时有关键词和商品定向,亚马逊不允许混投`);
    }
    if (end - top + 1 !== plan.rows) {
      bad.push(`${camp}: 实写 ${end - top + 1} 行,与预估 ${plan.rows} 行不符`);
    }
  }

  const names = [];
  for (let r = 1; r < out.length; r++) {
    if (out[r][C.ENTITY] === '广告活动') names.push(out[r][C.CAMP]);
  }
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dup.length) bad.push(`广告活动名称重复: ${dup.slice(0, 3).join('、')}`);

  return bad;
}

export { SHEET };
