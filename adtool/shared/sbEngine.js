/**
 * 品牌推广(SB)批量表生成引擎
 *
 * 写的是亚马逊后台「品牌推广多个广告组广告活动」这一页(新版 SB 批量表),
 * 列名和实体层级照着后台下载的 SB 批量表抄,一条活动的结构:
 *   广告活动 → 按广告位调整竞价 ×4 → 广告组 → 广告(合集 / 视频)→ 关键词或商品定向 → 否定关键词
 *
 * 先支持后台最常用的三种:
 *   collAuto   集合 · 自动商品集(亚马逊按关键词自己挑商品,只要品牌名和徽标)
 *   collManual 集合 · 手动商品集(自己选 3–10 个 ASIN)
 *   video      视频 · 商品详情页(1 个 ASIN + 1 条视频)
 *
 * 瀑布流和 SP 自动广告同一个思路:一个溢价档位一条活动。
 * 这里全是纯函数,不碰 DOM。
 */
import { MIN_BID, KW_MAX_CHARS, parseLines } from './adEngine.js';
import { parseKeywordLines, formatKeyword, roundBid } from './manualEngine.js';

export const SB_SHEET = '品牌推广多个广告组广告活动';

export const SB_HEADERS = [
  '产品', '实体层级', '操作', '广告活动编号', '广告组合编号', '广告组编号', '广告编号', '关键词编号',
  '商品投放 ID', '广告活动名称', '广告组名称', '广告名称', '广告活动名称（仅供参考）', '广告组名称（仅供参考）',
  '广告组合名称（仅供参考）', '开始日期', '结束日期', '状态', '品牌实体编号', '广告活动状态（仅供参考）',
  '广告活动开展状态（仅供参考）', '广告活动投放状态详情（仅供参考）', '基于规则的预算正在处理（仅供参考）',
  '基于规则的预算名称（仅供参考）', '基于规则的预算值（仅供参考）', '基于规则的预算编号（仅供参考）',
  '广告组投放状态（仅供参考）', '广告组投放状态详情（仅供参考）', '预算类型', '预算', '竞价优化', '商品位置',
  '竞价', '广告位', '百分比', '受众编号', '购物者群体占比', '购物者群体类型', '站点名称（仅供参考）',
  '关键词文本', '匹配类型', '母语关键词', '母语区域', '拓展商品投放编号', '拓展商品投放名称（仅供参考）',
  '广告投放状态（仅供参考）', '广告投放状态详情（仅供参考）', '落地页 URL', '落地页 ASIN', '落地页类型',
  '品牌名称', '同意翻译', '品牌徽标素材编号', '品牌徽标 URL（仅供参考）', '品牌徽标裁剪', '自定义图片',
  '创意素材标题', '创意素材 ASIN', '视频素材编号', '原始视频素材编号（仅供参考）', '子页面', '商品排除项',
  '广告标题', '站点',
];
const W = SB_HEADERS.length;
const col = (name) => SB_HEADERS.indexOf(name);

/* 0-based 列号 */
export const S = {
  PROD: col('产品'), ENTITY: col('实体层级'), OP: col('操作'), CAMP: col('广告活动编号'),
  PORT: col('广告组合编号'), GROUP: col('广告组编号'), CAMPNAME: col('广告活动名称'),
  GROUPNAME: col('广告组名称'), ADNAME: col('广告名称'), DATE: col('开始日期'), STATUS: col('状态'),
  ENTITYID: col('品牌实体编号'), BUDGETTYPE: col('预算类型'), BUDGET: col('预算'), AUTOBID: col('竞价优化'),
  BID: col('竞价'), PLACEMENT: col('广告位'), PCT: col('百分比'), KWTEXT: col('关键词文本'),
  MATCH: col('匹配类型'), TARGET: col('拓展商品投放编号'), LANDURL: col('落地页 URL'),
  LANDTYPE: col('落地页类型'), BRAND: col('品牌名称'), CONSENT: col('同意翻译'), LOGO: col('品牌徽标素材编号'),
  LOGOCROP: col('品牌徽标裁剪'), ASINS: col('创意素材 ASIN'), VIDEO: col('视频素材编号'),
};

/* 广告格式:id → 写进「实体层级」的广告行名称 */
export const SB_FORMATS = [
  { id: 'collAuto', entity: '自动合集广告', label: '集合 · 自动', short: 'SBC',
    desc: '亚马逊按关键词从你的商品里自动挑,只要品牌名和徽标' },
  { id: 'collManual', entity: '手动合集广告', label: '集合 · 手动', short: 'SBC',
    desc: '自己挑 3–10 个 ASIN 展示,落地页是亚马逊自动生成的商品列表' },
  { id: 'video', entity: '视频广告', label: '视频 · 详情页', short: 'SBV',
    desc: '1 个 ASIN + 1 条视频,点进去是这个 ASIN 的详情页' },
];
export const sbFormatOf = (id) => SB_FORMATS.find((f) => f.id === id) ?? SB_FORMATS[0];

/*
 * 广告位:[界面 id, 写进表里的名称, 命名用的短写]。
 * 名称照抄后台下载的 SB 批量表,一条活动四行都要写(不调就写 0)。
 * 后台新建页面上的「搜索结果顶部」= 搜索结果首页首位。
 */
export const SB_PLACEMENTS = [
  ['TOS', '搜索结果首页首位', 'Tos'],
  ['ROS', '其他', 'Other'],
  ['HOME', '首页', 'Home'],
  ['PP', '商品详情页', 'PP'],
];
export const SB_PLACE_MIN = -99;
export const SB_PLACE_MAX = 900;

/* SB 只有这两种商品定向,没有 SP 的 ASIN 扩展 */
export const SB_TARGET_TYPES = [
  { id: 'asin', label: 'ASIN', hint: '打这个 ASIN 的商品页 / 搜索结果' },
  { id: 'category', label: '品类', hint: '填品类 ID(纯数字)' },
];

export const SB_TGT_ENTITY = '商品定向';
export const SB_NEG_ENTITY = '否定关键词';
export const SB_CAMP_NAME_MAX = 128;
export const SB_COLL_MIN_ASINS = 3;
export const SB_COLL_MAX_ASINS = 10;
/* 欧洲站 SB 最低出价大多是 0.10,美国更高 —— 只提醒不拦 */
export const SB_SOFT_MIN_BID = 0.1;

export const AMAZON_DOMAINS = {
  ES: 'amazon.es', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', UK: 'amazon.co.uk',
  US: 'amazon.com', CA: 'amazon.ca', AU: 'amazon.com.au', AE: 'amazon.ae',
  SE: 'amazon.se', BE: 'amazon.com.be', NL: 'amazon.nl', PL: 'amazon.pl',
};

const ASIN_RE = /^[A-Z0-9]{10}$/;
const TARGET_EXPR_RE = /^(asin|category)="[^"]+"$/;

/* ---------------- 小工具 ---------------- */

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

export const tiersOf = (text) =>
  [...new Set(String(text ?? '').split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n)))];

/**
 * 推广商品那一栏:每行可以是 ASIN,也可以是 SKU(去 SKU 库里找它的 ASIN)。
 * 返回 { asins, missing } —— missing 是 SKU 库里找不到 ASIN 的 SKU
 */
export function resolveAsins(text, skuItems = []) {
  const index = new Map();
  for (const it of skuItems ?? []) {
    const sku = String(it?.sku ?? '').trim().toLowerCase();
    if (sku) index.set(sku, String(it?.asin ?? '').trim().toUpperCase());
  }
  const asins = [];
  const missing = [];
  const seen = new Set();
  for (const line of parseLines(text)) {
    const up = line.toUpperCase();
    let asin = '';
    if (index.has(line.toLowerCase())) asin = index.get(line.toLowerCase());
    else if (ASIN_RE.test(up)) asin = up;
    if (!ASIN_RE.test(asin)) { missing.push(line); continue; }
    if (seen.has(asin)) continue;
    seen.add(asin);
    asins.push(asin);
  }
  return { asins, missing };
}

/** 读溢价框:{TOS: '20', ...} → {TOS: 20, ...},留空按 0 */
function readPlaces(raw, problems) {
  const out = {};
  for (const [key, label] of SB_PLACEMENTS) {
    const v = num(raw?.[key]);
    if (v === null) { out[key] = 0; continue; }
    if (isNaN(v)) { problems.push(`${label} 的调整比例必须是数字`); out[key] = 0; continue; }
    if (v < SB_PLACE_MIN || v > SB_PLACE_MAX) {
      problems.push(`${label} 的调整比例要在 ${SB_PLACE_MIN}% 到 ${SB_PLACE_MAX}% 之间(当前 ${v}%)`);
    }
    out[key] = v;
  }
  return out;
}

/* ---------------- 生成计划 ---------------- */

/**
 * 一个 SB 任务 = 一套设置,不开瀑布流时出 1 条活动,开了就一个档位一条。
 *
 * task: {
 *   camp, portfolio, date, budget, format, brandEntity, brandName, logoId, logoCrop, videoId,
 *   skus(推广商品,SKU 或 ASIN), autoBid, places: {TOS, ROS, HOME, PP},
 *   wf: { on, place, tiers }, bidMode: 'bid' | 'cpc', baseBid, rounding,
 *   mode: 'kw' | 'tgt', kw, kwTriple, kwShared, tgt, ...词库联动字段
 * }
 * negData: adEngine.buildNegatives() 的返回值 —— SB 只有广告组级否定,活动级的也写到组上
 * ctx: { market, skuItems }
 */
export function buildSbPlan(task, negData, ctx = {}) {
  const problems = [...(negData?.problems ?? [])];
  const warnings = [];
  const format = sbFormatOf(task.format);

  const camp = String(task.camp ?? '').trim();
  if (!camp) problems.push('广告活动名称不能为空');

  const start = String(task.date ?? '').trim();
  if (!/^\d{8}$/.test(start)) problems.push('开始日期要写成 8 位数字,例如 20261016');
  else if (!validDate(start)) problems.push(`开始日期 ${start} 不是有效日期`);

  const rawBudget = num(task.budget);
  if (rawBudget === null || isNaN(rawBudget)) problems.push('每日预算必须是数字');
  else if (rawBudget < 1) problems.push('SB 每日预算最低 1');
  const budget = rawBudget === null || isNaN(rawBudget) ? 0 : rawBudget;

  /* ---- 品牌和素材 ---- */
  const brandEntity = String(task.brandEntity ?? '').trim();
  const brandName = String(task.brandName ?? '').trim();
  const logoId = String(task.logoId ?? '').trim();
  const videoId = String(task.videoId ?? '').trim();
  if (!brandEntity) problems.push('还没选品牌(品牌实体编号),先上传一次后台下载的 SB 批量表');
  if (format.id !== 'video') {
    if (!brandName) problems.push('品牌名称不能为空');
    if (!logoId) problems.push('集合广告要选一个品牌徽标');
  } else if (!videoId) {
    problems.push('视频广告要选一条视频素材');
  }

  /* ---- 推广商品 ---- */
  const { asins, missing } = resolveAsins(task.skus, ctx.skuItems);
  if (missing.length) {
    problems.push(`这些 SKU 在 SKU 库里没有 ASIN,或者 ASIN 写错了:${missing.slice(0, 3).join('、')}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}`);
  }
  if (format.id === 'collManual') {
    if (asins.length < SB_COLL_MIN_ASINS || asins.length > SB_COLL_MAX_ASINS) {
      problems.push(`手动商品集要 ${SB_COLL_MIN_ASINS}–${SB_COLL_MAX_ASINS} 个 ASIN,现在是 ${asins.length} 个`);
    }
  } else if (format.id === 'video') {
    if (asins.length !== 1) problems.push(`视频广告只能放 1 个 ASIN,现在是 ${asins.length} 个`);
  }
  const domain = AMAZON_DOMAINS[String(ctx.market ?? '').toUpperCase()];
  if (format.id === 'video' && !domain) problems.push(`不认识站点 ${ctx.market},没法拼详情页落地链接`);

  /* ---- 广告位 / 瀑布流 ---- */
  const autoBid = !!task.autoBid;
  const basePlaces = autoBid ? {} : readPlaces(task.places, problems);
  const wfOn = !autoBid && !!task.wf?.on;
  const wfPlace = SB_PLACEMENTS.find(([k]) => k === task.wf?.place) ?? SB_PLACEMENTS[0];
  let variants;
  if (wfOn) {
    const tiers = tiersOf(task.wf?.tiers);
    if (!tiers.length) problems.push('瀑布流至少要填一个溢价档位,例如 20,50,100');
    for (const t of tiers) {
      if (t < SB_PLACE_MIN || t > SB_PLACE_MAX) problems.push(`瀑布流档位 ${t}% 超出 ${SB_PLACE_MIN}%–${SB_PLACE_MAX}%`);
    }
    variants = tiers.map((t) => ({
      name: `${camp}-${wfPlace[2]}${t}`,
      places: { ...basePlaces, [wfPlace[0]]: t },
    }));
  } else {
    variants = [{ name: camp, places: basePlaces }];
  }
  for (const v of variants) {
    if (v.name.length > SB_CAMP_NAME_MAX) {
      problems.push(`广告活动名称过长(${v.name.length} 字符,上限 ${SB_CAMP_NAME_MAX}):${v.name.slice(0, 30)}…`);
    }
  }

  /* ---- 出价 ---- */
  const bidMode = task.bidMode === 'cpc' ? 'cpc' : 'bid';
  const rounding = task.rounding === 'trunc' ? 'trunc' : 'round';
  // CPC 模式:按这条活动里最高的那个正向溢价折算,任何广告位的落地 CPC 都不超过目标
  const factorOf = (places) => {
    const top = Math.max(0, ...Object.values(places ?? {}).map((x) => Number(x) || 0));
    return Math.round((1 + top / 100) * 1000) / 1000;
  };
  const defaultRaw = num(task.baseBid);
  if (defaultRaw === null || isNaN(defaultRaw)) {
    problems.push(bidMode === 'cpc' ? '目标 CPC 必须是数字' : '默认出价必须是数字');
  }
  const unitRaw = (raw, name) => {
    const v = num(raw);
    if (v === null) return defaultRaw === null || isNaN(defaultRaw) ? MIN_BID : defaultRaw;
    if (isNaN(v)) { problems.push(`${name}的出价必须是数字`); return MIN_BID; }
    return v;
  };

  /* ---- 投放 ---- */
  const mode = task.mode === 'tgt' ? 'tgt' : 'kw';
  const units = [];
  let anyInput = false;
  if (mode === 'kw') {
    const seen = new Set();
    const shared = task.kwTriple ? parseKeywordLines(task.kwShared) : null;
    for (const mt of ['精准', '词组', '广泛']) {
      const cfg = task.kw?.[mt];
      if (!cfg?.on) continue;
      const words = shared ?? parseKeywordLines(cfg.text);
      if (!words.length) continue;
      anyInput = true;
      const items = [];
      for (const w of words) {
        const text = formatKeyword(w, mt);
        if (text.length > KW_MAX_CHARS) {
          problems.push(`关键词加匹配符后过长(${text.length} 字符 > ${KW_MAX_CHARS}):${text.slice(0, 40)}…`);
          continue;
        }
        const key = `${w.toLowerCase()}|${mt}`;
        if (seen.has(key)) { problems.push(`重复关键词:「${w}」(${mt})`); continue; }
        seen.add(key);
        items.push({ text, match: mt });
      }
      if (items.length) units.push({ key: mt, label: mt, raw: unitRaw(cfg.bid, mt), items });
    }
    if (!units.length && !anyInput) {
      problems.push(task.kwTriple ? '三合一要粘贴关键词,并至少勾一种匹配类型' : '至少勾一种匹配类型,并粘贴关键词');
    }
  } else {
    const seen = new Set();
    for (const tt of SB_TARGET_TYPES) {
      const cfg = task.tgt?.[tt.id];
      if (!cfg?.on) continue;
      const raws = parseLines(cfg.text);
      if (!raws.length) continue;
      anyInput = true;
      const items = [];
      for (const raw of raws) {
        let expr;
        if (raw.includes('=')) expr = raw;
        else if (tt.id === 'category') {
          if (!/^\d+$/.test(raw)) { problems.push(`品类 ID 应该是纯数字:${raw}`); continue; }
          expr = `category="${raw}"`;
        } else {
          if (!ASIN_RE.test(raw.toUpperCase())) { problems.push(`ASIN 应该是 10 位字母数字:${raw}`); continue; }
          expr = `asin="${raw.toUpperCase()}"`;
        }
        if (!TARGET_EXPR_RE.test(expr)) { problems.push(`投放表达式格式不对:${expr}`); continue; }
        const k = expr.toLowerCase();
        if (seen.has(k)) { problems.push(`重复投放:${expr}`); continue; }
        seen.add(k);
        items.push({ text: expr });
      }
      if (items.length) units.push({ key: tt.id, label: tt.label, raw: unitRaw(cfg.bid, tt.label), items });
    }
    if (!units.length && !anyInput) problems.push('至少勾一种定向类型,并粘贴 ASIN / 品类 ID');
  }

  // 每条活动各算各的出价(瀑布流每档溢价不同,CPC 模式下出价也跟着变)
  const campaigns = variants.map((v) => {
    const factor = bidMode === 'cpc' ? factorOf(v.places) : 1;
    const bids = {};
    for (const u of units) {
      const b = bidMode === 'cpc' ? roundBid(u.raw / factor, rounding) : u.raw;
      bids[u.key] = b;
    }
    return { ...v, factor, bids };
  });
  let lowBid = null;
  for (const c of campaigns) {
    for (const u of units) {
      const b = c.bids[u.key];
      if (!(b >= MIN_BID)) problems.push(`${c.name} 的${u.label}出价 ${b} 低于 ${MIN_BID}`);
      else if (b < SB_SOFT_MIN_BID && lowBid === null) lowBid = b;
    }
  }
  if (lowBid !== null) warnings.push(`有出价低于 ${SB_SOFT_MIN_BID}(比如 ${lowBid}),SB 最低出价一般比 SP 高,可能被拒`);

  /* ---- 否定 ---- */
  // SB 没有活动级否定,全写到广告组上;同一个词活动级、组级都有就只留一份
  const negSeen = new Set();
  const negs = [];
  for (const n of negData?.negs ?? []) {
    const k = `${n.match}|${n.text.toLowerCase()}`;
    if (negSeen.has(k)) continue;
    negSeen.add(k);
    negs.push({ text: n.text, match: n.match });
  }
  if ((negData?.asins ?? []).length) {
    warnings.push(`有 ${negData.asins.length} 个否定 ASIN(E 类词库 / 本任务否定 ASIN),SB 批量表暂不写否定 ASIN,需要的话上传后在后台补`);
  }

  const targets = units.reduce((a, u) => a + u.items.length, 0);
  const placeRows = autoBid ? 0 : SB_PLACEMENTS.length;
  const blockRows = 1 + placeRows + 1 + 1 + targets + negs.length;

  return {
    ok: problems.length === 0,
    camp, format: format.id, adEntity: format.entity,
    start, budget, autoBid,
    portfolio: String(task.portfolio ?? '').trim(),
    brandEntity, brandName, logoId, logoCrop: String(task.logoCrop ?? '').trim(), videoId,
    asins, domain, mode, units, negs, targets,
    bidMode, rounding,
    campaigns, blockRows, rows: campaigns.length * blockRows,
    wf: wfOn ? { place: wfPlace[0], label: wfPlace[1] } : null,
    problems, warnings,
  };
}

/* ---------------- 写表 ---------------- */

const blank = () => new Array(W).fill(null);

function mkRow(entity, cells) {
  const r = blank();
  r[S.PROD] = '品牌推广';
  r[S.ENTITY] = entity;
  r[S.OP] = 'Create';
  for (const k in cells) r[+k] = cells[k];
  return r;
}

function adRow(plan, name, group) {
  const cells = { [S.CAMP]: name, [S.GROUP]: group, [S.ADNAME]: name, [S.STATUS]: '已启用' };
  if (plan.format === 'video') {
    const asin = plan.asins[0];
    Object.assign(cells, {
      [S.LANDURL]: `https://www.${plan.domain}/dp/${asin}`, [S.LANDTYPE]: '商品详情页',
      [S.CONSENT]: 'False', [S.ASINS]: asin, [S.VIDEO]: plan.videoId,
    });
  } else {
    Object.assign(cells, {
      [S.LANDTYPE]: '商品列表', [S.BRAND]: plan.brandName, [S.LOGO]: plan.logoId,
    });
    if (plan.logoCrop) cells[S.LOGOCROP] = plan.logoCrop;
    if (plan.format === 'collManual') cells[S.ASINS] = plan.asins.join(', ');
  }
  return mkRow(plan.adEntity, cells);
}

/** 一条活动的所有行,写到 out 末尾 */
function writeCampaign(out, plan, c) {
  const name = c.name;
  const date = /^\d+$/.test(plan.start) ? parseInt(plan.start, 10) : plan.start;
  out.push(mkRow('广告活动', {
    [S.CAMP]: name, [S.PORT]: plan.portfolio || null, [S.CAMPNAME]: name, [S.DATE]: date,
    [S.STATUS]: '已启用', [S.ENTITYID]: plan.brandEntity, [S.BUDGETTYPE]: '每日',
    [S.BUDGET]: plan.budget, [S.AUTOBID]: plan.autoBid ? 'true' : 'false',
  }));
  if (!plan.autoBid) {
    for (const [key, label] of SB_PLACEMENTS) {
      out.push(mkRow('按广告位调整竞价', { [S.CAMP]: name, [S.PLACEMENT]: label, [S.PCT]: c.places[key] || 0 }));
    }
  }
  out.push(mkRow('广告组', { [S.CAMP]: name, [S.GROUP]: name, [S.GROUPNAME]: name, [S.STATUS]: '已启用' }));
  out.push(adRow(plan, name, name));
  for (const u of plan.units) {
    for (const it of u.items) {
      out.push(plan.mode === 'kw'
        ? mkRow('关键词', {
          [S.CAMP]: name, [S.GROUP]: name, [S.STATUS]: '已启用',
          [S.BID]: c.bids[u.key], [S.KWTEXT]: it.text, [S.MATCH]: it.match,
        })
        : mkRow(SB_TGT_ENTITY, {
          [S.CAMP]: name, [S.GROUP]: name, [S.STATUS]: '已启用',
          [S.BID]: c.bids[u.key], [S.TARGET]: it.text,
        }));
    }
  }
  for (const n of plan.negs) {
    out.push(mkRow(SB_NEG_ENTITY, {
      [S.CAMP]: name, [S.GROUP]: name, [S.STATUS]: '已启用', [S.KWTEXT]: n.text, [S.MATCH]: n.match,
    }));
  }
}

/**
 * 多个 SB 任务合成一页。
 * plans: [{ task, plan }] —— plan 来自 buildSbPlan
 * 返回 { aoa, placed, bad }
 */
export function buildSbWorkbookData(plans) {
  const out = [SB_HEADERS.slice()];
  const placed = [];
  for (const { plan } of plans) {
    if (!plan.ok) continue;
    for (const c of plan.campaigns) {
      const top = out.length;
      writeCampaign(out, plan, c);
      placed.push({ plan, c, top, end: out.length - 1 });
    }
  }
  if (!placed.length) return { aoa: out, placed, bad: ['没有可生成的品牌广告活动'] };
  return { aoa: out, placed, bad: sbSelfCheck(out, placed) };
}

/* ---------------- 自检 ---------------- */

function sbSelfCheck(out, placed) {
  const bad = [];
  const cell = (r, k) => out[r]?.[k];
  for (const { plan, c, top, end } of placed) {
    const name = c.name;
    if (cell(top, S.ENTITY) !== '广告活动') bad.push(`${name}: 第${top + 1}行不是广告活动行`);
    if (!cell(top, S.ENTITYID)) bad.push(`${name}: 缺品牌实体编号`);
    if (end - top + 1 !== plan.blockRows) bad.push(`${name}: 实写 ${end - top + 1} 行,与预估 ${plan.blockRows} 行不符`);
    const count = new Map();
    for (let r = top; r <= end; r++) {
      const e = cell(r, S.ENTITY);
      count.set(e, (count.get(e) ?? 0) + 1);
      if (cell(r, S.PROD) !== '品牌推广') bad.push(`${name}: 第${r + 1}行 A列不是品牌推广`);
      if (cell(r, S.CAMP) !== name) bad.push(`${name}: 第${r + 1}行 广告活动编号不一致`);
      if (['关键词', SB_TGT_ENTITY, SB_NEG_ENTITY, plan.adEntity].includes(e) && cell(r, S.GROUP) !== name) {
        bad.push(`${name}: 第${r + 1}行 缺广告组编号`);
      }
      if (e === '关键词') {
        const s = String(cell(r, S.KWTEXT) ?? '');
        const mt = cell(r, S.MATCH);
        if (!s) bad.push(`${name}: 第${r + 1}行 关键词为空`);
        if (mt === '精准' && !(s.startsWith('[') && s.endsWith(']'))) bad.push(`${name}: 第${r + 1}行 精准词没用方括号`);
        if (mt === '词组' && !(s.startsWith('"') && s.endsWith('"'))) bad.push(`${name}: 第${r + 1}行 词组没用双引号`);
      }
      if ((e === '关键词' || e === SB_TGT_ENTITY) && !(cell(r, S.BID) >= MIN_BID)) {
        bad.push(`${name}: 第${r + 1}行 竞价=${cell(r, S.BID)} 非法`);
      }
      if (e === SB_NEG_ENTITY && !['否定精准匹配', '否定词组'].includes(cell(r, S.MATCH))) {
        bad.push(`${name}: 第${r + 1}行 否定匹配类型非法`);
      }
    }
    const expect = [
      ['广告活动', 1], ['广告组', 1], [plan.adEntity, 1],
      ['按广告位调整竞价', plan.autoBid ? 0 : SB_PLACEMENTS.length],
      [plan.mode === 'kw' ? '关键词' : SB_TGT_ENTITY, plan.targets],
      [SB_NEG_ENTITY, plan.negs.length],
    ];
    for (const [e, exp] of expect) {
      if ((count.get(e) ?? 0) !== exp) bad.push(`${name}: ${e} 行数=${count.get(e) ?? 0} 应为 ${exp}`);
    }
  }
  const names = placed.map((p) => p.c.name);
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dup.length) bad.push(`品牌广告活动名称重复: ${dup.slice(0, 3).join('、')}`);
  return bad;
}

/* ---------------- 品牌素材:从后台下载的 SB 批量表里读 ---------------- */

const ASSET_SHEET = '品牌资产数据（只读）';
const KEEP_ASSETS = { 品牌徽标: 'logo', 视频: 'video' };

/**
 * 读后台下载的 SB 批量表,拿到品牌实体、徽标和视频素材。
 * 徽标裁剪参数只能从已有广告行里抄(资产页不带),抄到就一起存。
 * 返回 { brands: [{entityId, name}], logos: [...], videos: [...] } 或抛错
 */
export function parseSbAssets(buffer, XLSX) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[ASSET_SHEET];
  if (!ws) throw new Error(`没找到「${ASSET_SHEET}」这一页,请上传后台「批量操作」下载的、勾了品牌推广的批量表`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

  const brands = new Map();
  const logos = [];
  const videos = [];
  let mode = 'brand';
  for (const r of rows) {
    const a = String(r?.[0] ?? '').trim();
    if (!a) continue;
    if (a === '品牌实体编号') { mode = 'brand'; continue; }
    if (a === '素材类型') { mode = 'asset'; continue; }
    if (mode === 'brand') {
      const name = String(r?.[1] ?? '').trim();
      if (/^ENTITY/i.test(a)) brands.set(a, { entityId: a, name });
      continue;
    }
    const kind = KEEP_ASSETS[a];
    if (!kind) continue;
    const item = {
      assetId: String(r?.[2] ?? '').trim(),
      name: String(r?.[3] ?? '').trim(),
      url: String(r?.[4] ?? '').trim(),
      entityId: String(r?.[1] ?? '').trim(),
    };
    if (!item.assetId) continue;
    (kind === 'logo' ? logos : videos).push(item);
  }

  // 已有广告行里抄品牌名、徽标裁剪
  const crops = new Map();
  for (const name of [SB_SHEET, '品牌推广活动']) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
    const h = data[0] ?? [];
    const iLogo = h.indexOf('品牌徽标素材编号');
    const iCrop = h.indexOf('品牌徽标裁剪');
    const iBrand = h.indexOf('品牌名称');
    const iEntity = h.indexOf('品牌实体编号');
    for (const r of data.slice(1)) {
      const logo = iLogo >= 0 ? String(r[iLogo] ?? '').trim() : '';
      const crop = iCrop >= 0 ? String(r[iCrop] ?? '').trim() : '';
      if (logo && crop && !crops.has(logo)) crops.set(logo, crop);
      const ent = iEntity >= 0 ? String(r[iEntity] ?? '').trim() : '';
      const bn = iBrand >= 0 ? String(r[iBrand] ?? '').trim() : '';
      if (ent && bn && brands.has(ent) && !brands.get(ent).name) brands.get(ent).name = bn;
    }
  }
  for (const l of logos) if (crops.has(l.assetId)) l.crop = crops.get(l.assetId);

  if (!brands.size) throw new Error('批量表里没读到品牌实体编号');
  return { brands: [...brands.values()], logos, videos };
}
