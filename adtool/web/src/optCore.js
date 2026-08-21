/**
 * 广告优化工作台 · 解析 / 指标 / 异常 / 变更 / 导出
 * 从单文件版「批量表工作台 V7」移植进来,逻辑保持一致,只是改成 ES 模块:
 * XLSX 直接用项目里的依赖,不再从全局拿。
 * 这里全是纯函数,不碰 DOM。日期 / 搜索词合并 / 工作表过滤这几个工具在文件末尾。
 */
import * as XLSX from 'xlsx';


/* ---------- 表头别名（中/英双语，兼容 ES/DE/US 下载的批量表） ---------- */
var H = {
  product:      ['产品', 'Product'],
  entity:       ['实体层级', 'Entity'],
  operation:    ['操作', 'Operation'],
  campaignId:   ['广告活动编号', 'Campaign ID', 'Campaign Id'],
  adGroupId:    ['广告组编号', 'Ad Group ID', 'Ad Group Id'],
  portfolioId:  ['广告组合编号', 'Portfolio ID', 'Portfolio Id'],
  adId:         ['广告编号', 'Ad ID', 'Ad Id'],
  keywordId:    ['关键词编号', 'Keyword ID', 'Keyword Id'],
  targetId:     ['商品投放 ID', '商品投放ID', 'Product Targeting ID', 'Product Targeting Id'],
  campaignName: ['广告活动名称', 'Campaign Name'],
  adGroupName:  ['广告组名称', 'Ad Group Name'],
  campaignNameInfo: ['广告活动名称（仅供参考）', 'Campaign Name (Informational only)'],
  adGroupNameInfo:  ['广告组名称（仅供参考）', 'Ad Group Name (Informational only)'],
  portfolioNameInfo:['广告组合名称（仅供参考）', 'Portfolio Name (Informational only)'],
  startDate:    ['开始日期', 'Start Date'],
  endDate:      ['结束日期', 'End Date'],
  targetingType:['投放类型', 'Targeting Type'],
  state:        ['状态', 'State'],
  campaignState:['广告活动状态（仅供参考）', 'Campaign State (Informational only)'],
  adGroupState: ['广告组状态（仅供参考）', 'Ad Group State (Informational only)'],
  dailyBudget:  ['每日预算', 'Daily Budget'],
  sku:          ['SKU'],
  asin:         ['ASIN（仅供参考）', 'ASIN (Informational only)'],
  eligibility:  ['资格状态（仅供参考）', 'Eligibility Status (Informational only)'],
  ineligReason: ['不符合条件的原因（仅供参考）', 'Reason for Ineligibility (Informational only)'],
  defaultBid:   ['广告组默认竞价', 'Ad Group Default Bid'],
  defaultBidInfo:['广告组默认竞价（仅供参考）', 'Ad Group Default Bid (Informational only)'],
  bid:          ['竞价', 'Bid'],
  keywordText:  ['关键词文本', 'Keyword Text'],
  matchType:    ['匹配类型', 'Match Type'],
  strategy:     ['竞价方案', 'Bidding Strategy'],
  placement:    ['广告位', 'Placement'],
  percentage:   ['百分比', 'Percentage'],
  targetExpr:   ['拓展商品投放编号', 'Product Targeting Expression'],
  targetExprInfo:['拓展商品投放名称（仅供参考）', 'Resolved Product Targeting Expression (Informational only)'],
  impressions:  ['展示量', 'Impressions'],
  clicks:       ['点击量', 'Clicks'],
  ctr:          ['点击率', 'Click-through Rate'],
  spend:        ['花费', 'Spend'],
  sales:        ['销量', 'Sales'],
  orders:       ['订单数量', 'Orders'],
  units:        ['商品数量', 'Units'],
  cvr:          ['转化率', 'Conversion Rate'],
  acos:         ['ACOS'],
  cpc:          ['CPC'],
  roas:         ['ROAS'],
  searchTerm:   ['顾客搜索词', 'Customer Search Term']
};

/* ---------- 实体层级别名 ---------- */
var ENT = {
  campaign:   ['广告活动', 'Campaign'],
  adGroup:    ['广告组', 'Ad Group'],
  productAd:  ['商品广告', 'Product Ad'],
  keyword:    ['关键词', 'Keyword'],
  target:     ['商品定向', 'Product Targeting'],
  negKeyword: ['否定关键词', 'Negative Keyword'],
  negTarget:  ['否定商品定向', 'Negative Product Targeting'],
  campNegKw:  ['广告活动否定关键词', 'Campaign Negative Keyword'],
  bidAdj:     ['竞价调整', 'Bidding Adjustment']
};

/* ---------- 写回值词表（导出时必须与原表语言一致） ---------- */
var VOCAB = {
  zh: {
    state: { enabled: '已启用', paused: '已暂停', archived: '已存档' },
    op:    { create: '创建', update: '更新', archive: '存档' },
    neg:   { phrase: '否定词组', exact: '否定精准匹配' },
    entity:{ negKeyword: '否定关键词', campNegKw: '广告活动否定关键词' },
    product: '商品推广'
  },
  en: {
    state: { enabled: 'enabled', paused: 'paused', archived: 'archived' },
    op:    { create: 'Create', update: 'Update', archive: 'Archive' },
    neg:   { phrase: 'negativePhrase', exact: 'negativeExact' },
    entity:{ negKeyword: 'Negative Keyword', campNegKw: 'Campaign Negative Keyword' },
    product: 'Sponsored Products'
  }
};

/* ---------- 状态归一化（把表里的原始值映射成 enabled/paused/archived） ---------- */
function normState(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).trim();
  if (s === '已启用' || /^enabled$/i.test(s)) return 'enabled';
  if (s === '已暂停' || /^paused$/i.test(s)) return 'paused';
  if (s === '已存档' || /^archived$/i.test(s)) return 'archived';
  return s;
}

function normPlacement(v) {
  var s = String(v || '');
  if (s.indexOf('首页首位') >= 0 || /placementTop|Top of Search/i.test(s)) return 'top';
  if (s.indexOf('其余位置') >= 0 || /placementRestOfSearch|Rest of Search/i.test(s)) return 'ros';
  if (s.indexOf('商品页面') >= 0 || /placementProductPage|Product Page/i.test(s)) return 'pp';
  if (s.indexOf('企业购') >= 0 || /AmazonBusiness|Amazon Business/i.test(s)) return 'biz';
  return 'other';
}
var PLACEMENT_LABEL = { top: '搜索首页首位', ros: '搜索其余位置', pp: '商品页面', biz: '企业购', other: '其他' };

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}

/* ---------- 列索引解析 ---------- */
function buildColIndex(headerRow) {
  var idx = {}, pos = {};
  headerRow.forEach(function (h, i) {
    if (h === null || h === undefined) return;
    pos[String(h).trim()] = i;
  });
  Object.keys(H).forEach(function (key) {
    var found = -1;
    H[key].some(function (alias) {
      if (pos[alias] !== undefined) { found = pos[alias]; return true; }
      return false;
    });
    idx[key] = found;
  });
  return idx;
}

function detectLang(headerRow) {
  var joined = headerRow.join('|');
  return /实体层级|广告活动编号|广告组名称/.test(joined) ? 'zh' : 'en';
}

function entityKindOf(v) {
  var s = String(v || '').trim();
  var found = '';
  Object.keys(ENT).some(function (k) {
    if (ENT[k].indexOf(s) >= 0) { found = k; return true; }
    return false;
  });
  return found;
}

/* ---------- 指标（一律用原始数重算，不采信报表口径） ---------- */
function metricsOf(imp, clk, spend, sales, orders, units) {
  return {
    imp: imp, clicks: clk, spend: spend, sales: sales, orders: orders, units: units,
    ctr:  imp > 0 ? clk / imp : 0,
    cpc:  clk > 0 ? spend / clk : 0,
    cvr:  clk > 0 ? orders / clk : 0,
    acos: sales > 0 ? spend / sales : (spend > 0 ? Infinity : 0),
    roas: spend > 0 ? sales / spend : 0
  };
}

function rowMetrics(row, c) {
  return metricsOf(
    num(row[c.impressions]), num(row[c.clicks]), num(row[c.spend]),
    num(row[c.sales]), num(row[c.orders]), num(row[c.units])
  );
}

function sumMetrics(list) {
  var t = { imp: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
  list.forEach(function (m) {
    t.imp += m.imp; t.clicks += m.clicks; t.spend += m.spend;
    t.sales += m.sales; t.orders += m.orders; t.units += m.units;
  });
  return metricsOf(t.imp, t.clicks, t.spend, t.sales, t.orders, t.units);
}

/* ---------- 默认异常规则（按 ES 小站环境设定，界面可改） ---------- */
var DEFAULT_CFG = {
  targetAcos: 0.25,      // 目标 ACOS
  zeroOrderSpend: 0.8,   // 零单花费红线（€）
  zeroOrderClicks: 8,    // 零单点击红线
  lowCtr: 0.0015,        // 低点击率阈值
  lowCvr: 0.10,          // 低转化率阈值（有订单但转化偏低）
  minSpendForAcos: 0.3,  // ACOS 判定所需最小花费
  skuCvrMin: 0.20,       // SKU 矩阵：转化率低于此值 + ACOS 超上限 → 标红
  skuAcosMax: 0.065,     // SKU 矩阵：ACOS 上限
  skuDeadClicks: 5       // SKU 矩阵：点击达到此数仍零转化 → 标蓝
};

// 小样本保护（内部固定，不暴露为设置项）：曝光不够不判点击率，点击不够不判转化率
var LOW_CTR_MIN_IMP = 1000;
var LOW_CVR_MIN_CLICKS = 10;

/* ---------- 异常规则引擎 ----------
   返回 [{level:'bad'|'warn', code, text}]  */
function flagsFor(kind, m, extra, cfg) {
  cfg = cfg || DEFAULT_CFG;
  extra = extra || {};
  var f = [];

  if (m.orders === 0 && (m.spend >= cfg.zeroOrderSpend || m.clicks >= cfg.zeroOrderClicks)) {
    f.push({ level: 'bad', code: 'zero-order', text: '花费 ' + m.spend.toFixed(2) + ' / ' + m.clicks + ' 点击 无订单' });
  }
  if (m.orders > 0 && m.spend >= cfg.minSpendForAcos && m.acos > cfg.targetAcos) {
    f.push({ level: 'bad', code: 'high-acos', text: 'ACOS ' + (m.acos * 100).toFixed(1) + '% 超目标' });
  }
  if (m.imp >= LOW_CTR_MIN_IMP && m.ctr < cfg.lowCtr) {
    f.push({ level: 'warn', code: 'low-ctr', text: '曝光 ' + m.imp + ' 但点击率 ' + (m.ctr * 100).toFixed(2) + '%' });
  }
  if (m.orders > 0 && m.clicks >= LOW_CVR_MIN_CLICKS && m.cvr < cfg.lowCvr) {
    f.push({ level: 'warn', code: 'low-cvr', text: m.clicks + '#' + m.orders + ' 转化率 ' + (m.cvr * 100).toFixed(1) + '% 偏低' });
  }
  if (extra.eligible === false) {
    f.push({ level: 'bad', code: 'ineligible', text: '不符合投放条件' });
  }
  return f;
}

function worstLevel(flags) {
  if (flags.some(function (x) { return x.level === 'bad'; })) return 'bad';
  if (flags.some(function (x) { return x.level === 'warn'; })) return 'warn';
  return 'ok';
}

/* ---------- 解析工作簿 ---------- */
function parse(arrayBuffer) {
  var wb = XLSX.read(arrayBuffer, { type: 'array' });
  var sheetName = null;
  ['商品推广活动', 'Sponsored Products Campaigns'].forEach(function (n) {
    if (!sheetName && wb.SheetNames.indexOf(n) >= 0) sheetName = n;
  });
  if (!sheetName) {
    // 兜底：找含「实体层级 / Entity」列的表
    wb.SheetNames.some(function (n) {
      var a = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, range: 0 });
      if (a.length && a[0] && a[0].join('|').match(/实体层级|Entity/)) { sheetName = n; return true; }
      return false;
    });
  }
  if (!sheetName) throw new Error('没找到「商品推广活动」工作表，请确认这是商品推广(SP)批量表。');

  var aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  var header = aoa[0] || [];
  var c = buildColIndex(header);
  var lang = detectLang(header);
  if (c.entity < 0) throw new Error('表头缺少「实体层级」列，无法解析。');

  var rows = [];
  for (var i = 1; i < aoa.length; i++) {
    var r = aoa[i];
    if (!r || r.every(function (v) { return v === null || v === ''; })) continue;
    while (r.length < header.length) r.push(null);
    rows.push({ i: rows.length, kind: entityKindOf(r[c.entity]), d: r });
  }

  /* 搜索词报告 */
  var stName = null;
  ['商品推广搜索词报告', 'SP Search Term Report', 'Sponsored Products Search Term Report'].forEach(function (n) {
    if (!stName && wb.SheetNames.indexOf(n) >= 0) stName = n;
  });
  var searchTerms = [];
  if (stName) {
    var sa = XLSX.utils.sheet_to_json(wb.Sheets[stName], { header: 1, defval: null, raw: true });
    if (sa.length > 1) {
      var sc = buildColIndex(sa[0] || []);
      for (var j = 1; j < sa.length; j++) {
        var sr = sa[j];
        if (!sr || sr.every(function (v) { return v === null || v === ''; })) continue;
        if (sc.searchTerm < 0 || !sr[sc.searchTerm]) continue;
        searchTerms.push({
          campaignId: String(sr[sc.campaignId] || ''),
          adGroupId: String(sr[sc.adGroupId] || ''),
          targetId: String(sr[sc.keywordId] || sr[sc.targetId] || ''),
          campaignName: String(sr[sc.campaignNameInfo] || ''),
          adGroupName: String(sr[sc.adGroupNameInfo] || ''),
          keywordText: sr[sc.keywordText] || sr[sc.targetExpr] || '',
          matchType: sr[sc.matchType] || '',
          term: String(sr[sc.searchTerm]),
          m: metricsOf(num(sr[sc.impressions]), num(sr[sc.clicks]), num(sr[sc.spend]),
                       num(sr[sc.sales]), num(sr[sc.orders]), num(sr[sc.units]))
        });
      }
    }
  }

  /* 币种：从广告组合表推断 */
  var currency = '';
  ['广告组合', 'Portfolios'].forEach(function (n) {
    if (currency || wb.SheetNames.indexOf(n) < 0) return;
    var pa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null });
    if (!pa.length) return;
    var ci = -1;
    (pa[0] || []).forEach(function (h, i) {
      if (h && /预算的货币代码|Budget Currency Code/i.test(String(h))) ci = i;
    });
    if (ci < 0) return;
    for (var k = 1; k < pa.length; k++) {
      if (pa[k] && pa[k][ci]) { currency = String(pa[k][ci]).trim(); break; }
    }
  });

  var model = buildModel(rows, c);
  model.currency = currency;
  model.header = header;
  model.colIdx = c;
  model.lang = lang;
  model.sheetName = sheetName;
  model.searchTerms = searchTerms;
  model.rows = rows;
  model.sheetNames = wb.SheetNames;
  // 后台只收前三列是「产品 / 实体层级 / 操作」的工作表,别的(搜索词报告等)导出时要摘掉
  model.dropSheets = nonBulkSheets(wb).filter(function (n) { return n !== sheetName; });
  return model;
}

/* ---------- 独立搜索词报告解析（后台 报告 → 搜索词 下载的 xlsx / csv） ---------- */
var RPT = {
  term:        [/客户搜索词|顾客搜索词|customer search term|search term/i],
  campaignId:  [/广告活动编号|campaign\s*id/i],
  adGroupId:   [/广告组编号|ad\s*group\s*id/i],
  keywordId:   [/关键词编号|keyword\s*id/i],
  targetId:    [/商品投放\s*id|product targeting id/i],
  campaignName:[/广告活动名称|campaign name/i],
  adGroupName: [/广告组名称|ad group name/i],
  targeting:   [/^投放$|关键词文本|拓展商品投放|targeting|keyword text/i],
  matchType:   [/匹配类型|match type/i],
  imp:         [/^展示量|^曝光|impressions/i],
  clicks:      [/^点击量|^点击数|^clicks$/i],
  spend:       [/^花费|^spend|^cost/i],
  sales:       [/销售额|^sales|total sales/i],
  orders:      [/订单数|订单量|orders/i],
  units:       [/销售量|商品数量|units/i],
  date:        [/^日期$|^date$|开始日期|start date/i]
};
function findCol(header, pats) {
  var found = -1;
  header.forEach(function (h, i) {
    if (found >= 0 || h === null || h === undefined) return;
    var t = String(h).trim();
    pats.some(function (p) { if (p.test(t)) { found = i; return true; } return false; });
  });
  return found;
}
function reportCols(header) {
  var o = {};
  Object.keys(RPT).forEach(function (k) { o[k] = findCol(header, RPT[k]); });
  return o;
}

function parseSearchTermReport(arrayBuffer, model) {
  var wb = XLSX.read(arrayBuffer, { type: 'array' });
  var best = null;
  wb.SheetNames.forEach(function (n) {
    if (best) return;
    var a = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true });
    for (var hr = 0; hr < Math.min(6, a.length); hr++) {
      var idx = reportCols(a[hr] || []);
      if (idx.term >= 0) { best = { sheet: n, idx: idx, rows: a.slice(hr + 1) }; return; }
    }
  });
  if (!best) throw new Error('这份文件里没找到「客户搜索词」列，请确认导出的是搜索词报告。');

  var byId = {}, byName = {};
  model.campaigns.forEach(function (cp) {
    byId[cp.id] = cp;
    if (cp.name) byName[String(cp.name).trim().toLowerCase()] = cp;
  });

  var idx = best.idx, terms = [], unmatched = 0;
  best.rows.forEach(function (r) {
    if (!r || idx.term < 0 || !r[idx.term]) return;
    var cp = byId[String(r[idx.campaignId >= 0 ? idx.campaignId : -1] || '')] ||
             byName[String(r[idx.campaignName >= 0 ? idx.campaignName : -1] || '').trim().toLowerCase()];
    if (!cp) { unmatched++; return; }

    var gName = idx.adGroupName >= 0 ? String(r[idx.adGroupName] || '').trim() : '';
    var gid = idx.adGroupId >= 0 ? String(r[idx.adGroupId] || '') : '';
    if (!gid && gName) {
      cp.adGroups.some(function (g) {
        if (String(g.name).trim().toLowerCase() === gName.toLowerCase()) { gid = g.id; return true; }
        return false;
      });
    }
    if (!gid && cp.adGroups.length === 1) gid = cp.adGroups[0].id;

    var tgtText = idx.targeting >= 0 ? String(r[idx.targeting] || '') : '';
    var tid = String((idx.keywordId >= 0 ? r[idx.keywordId] : '') || (idx.targetId >= 0 ? r[idx.targetId] : '') || '');
    if (!tid && tgtText) {
      cp.targets.some(function (t) {
        if (String(t.text).trim().toLowerCase() === tgtText.trim().toLowerCase()) {
          tid = t.id; if (!gid) gid = t.adGroupId; return true;
        }
        return false;
      });
    }
    if (!gName && gid) {
      cp.adGroups.some(function (g) { if (g.id === gid) { gName = g.name; return true; } return false; });
    }

    terms.push({
      campaignId: cp.id, adGroupId: gid, targetId: tid,
      campaignName: cp.name, adGroupName: gName,
      keywordText: tgtText, matchType: idx.matchType >= 0 ? (r[idx.matchType] || '') : '',
      term: String(r[idx.term]),
      date: idx.date >= 0 ? toDate(r[idx.date]) : '',
      m: metricsOf(num(idx.imp >= 0 ? r[idx.imp] : 0), num(idx.clicks >= 0 ? r[idx.clicks] : 0),
                   num(idx.spend >= 0 ? r[idx.spend] : 0), num(idx.sales >= 0 ? r[idx.sales] : 0),
                   num(idx.orders >= 0 ? r[idx.orders] : 0), num(idx.units >= 0 ? r[idx.units] : 0))
    });
  });
  var span = dateSpan(terms);
  return {
    terms: terms, matched: terms.length, unmatched: unmatched, sheet: best.sheet,
    start: span.start, end: span.end
  };
}

/* ---------- 建索引：活动 → 广告组 / 广告位 / SKU / 投放 / 否定 ---------- */
function buildModel(rows, c) {
  var campaigns = [], byCamp = {};

  function ensure(id) {
    if (!byCamp[id]) {
      byCamp[id] = {
        id: id, name: '', portfolio: '', state: '', targetingType: '', strategy: '',
        budget: null, startDate: '', row: null, m: metricsOf(0, 0, 0, 0, 0, 0),
        adGroups: [], placements: [], ads: [], targets: [], negatives: []
      };
      campaigns.push(byCamp[id]);
    }
    return byCamp[id];
  }

  rows.forEach(function (r) {
    var d = r.d, id = String(d[c.campaignId] || '');
    if (!id) return;
    var cp = ensure(id);
    var m = rowMetrics(d, c);

    if (r.kind === 'campaign') {
      cp.row = r; cp.name = d[c.campaignName] || d[c.campaignNameInfo] || '';
      cp.portfolio = d[c.portfolioNameInfo] || '';
      cp.state = normState(d[c.state]);
      cp.targetingType = d[c.targetingType] || '';
      cp.strategy = d[c.strategy] || '';
      cp.budget = d[c.dailyBudget];
      cp.startDate = d[c.startDate] || '';
      cp.m = m;
    } else if (r.kind === 'adGroup') {
      cp.adGroups.push({ row: r, id: String(d[c.adGroupId] || ''), name: d[c.adGroupName] || d[c.adGroupNameInfo] || '',
                         state: normState(d[c.state]), defaultBid: d[c.defaultBid], m: m });
    } else if (r.kind === 'bidAdj') {
      cp.placements.push({ row: r, key: normPlacement(d[c.placement]), label: PLACEMENT_LABEL[normPlacement(d[c.placement])],
                           raw: d[c.placement], pct: d[c.percentage], m: m });
    } else if (r.kind === 'productAd') {
      cp.ads.push({ row: r, id: String(d[c.adId] || ''), adGroupId: String(d[c.adGroupId] || ''),
                    adGroupName: d[c.adGroupNameInfo] || '', sku: d[c.sku] || '', asin: d[c.asin] || '',
                    state: normState(d[c.state]),
                    eligible: !(d[c.eligibility] && String(d[c.eligibility]).match(/不符合|ineligible/i)),
                    eligibilityText: d[c.eligibility] || '', m: m });
    } else if (r.kind === 'keyword' || r.kind === 'target') {
      cp.targets.push({
        row: r, kind: r.kind, id: String(d[c.keywordId] || d[c.targetId] || ''),
        adGroupId: String(d[c.adGroupId] || ''), adGroupName: d[c.adGroupNameInfo] || '',
        text: r.kind === 'keyword' ? (d[c.keywordText] || '') : (d[c.targetExprInfo] || d[c.targetExpr] || ''),
        matchType: d[c.matchType] || (r.kind === 'target' ? '商品投放' : ''),
        bid: d[c.bid], defaultBid: d[c.defaultBidInfo], state: normState(d[c.state]), m: m
      });
    } else if (r.kind === 'negKeyword' || r.kind === 'negTarget' || r.kind === 'campNegKw') {
      cp.negatives.push({
        row: r, kind: r.kind, id: String(d[c.keywordId] || d[c.targetId] || ''),
        adGroupId: String(d[c.adGroupId] || ''), adGroupName: d[c.adGroupNameInfo] || '',
        text: d[c.keywordText] || d[c.targetExprInfo] || d[c.targetExpr] || '',
        matchType: d[c.matchType] || '', state: normState(d[c.state]),
        scope: r.kind === 'campNegKw' ? 'campaign' : 'adgroup'
      });
    }
  });

  campaigns.forEach(function (cp) {
    // 活动行缺失时用广告组汇总兜底
    if (!cp.row && cp.adGroups.length) {
      cp.m = sumMetrics(cp.adGroups.map(function (g) { return g.m; }));
      cp.name = cp.name || cp.adGroups[0].name;
    }
  });

  return { campaigns: campaigns, byCamp: byCamp };
}

/* ---------- 全店汇总 ---------- */
function totals(model) {
  return sumMetrics(model.campaigns.map(function (cp) { return cp.m; }));
}

/* ===========================================================
   变更管理
   changes: { rowIndex: { colIdx: newValue, ... } }
   creates: [ {kind:'negKeyword'|'campNegKw', campaignId, adGroupId, text, match, campaignName, adGroupName} ]
   =========================================================== */
function ChangeSet() {
  this.edits = {};   // rowIndex -> {col: {from, to, field}}
  this.creates = [];
  this.seq = 0;
}
ChangeSet.prototype.set = function (rowIndex, col, from, to, field) {
  if (!this.edits[rowIndex]) this.edits[rowIndex] = {};
  if (String(from) === String(to)) { delete this.edits[rowIndex][col]; }
  else this.edits[rowIndex][col] = { from: from, to: to, field: field };
  if (!Object.keys(this.edits[rowIndex]).length) delete this.edits[rowIndex];
};
ChangeSet.prototype.get = function (rowIndex, col) {
  var e = this.edits[rowIndex];
  return e && e[col] ? e[col].to : undefined;
};
ChangeSet.prototype.clearRow = function (rowIndex) { delete this.edits[rowIndex]; };
ChangeSet.prototype.clearCell = function (rowIndex, col) {
  if (this.edits[rowIndex]) { delete this.edits[rowIndex][col];
    if (!Object.keys(this.edits[rowIndex]).length) delete this.edits[rowIndex]; }
};
ChangeSet.prototype.count = function () {
  var n = this.creates.length;
  for (var k in this.edits) n += Object.keys(this.edits[k]).length;
  return n;
};
ChangeSet.prototype.rowCount = function () {
  return Object.keys(this.edits).length + this.creates.length;
};
ChangeSet.prototype.addNegative = function (obj) {
  obj._id = ++this.seq;
  var dup = this.creates.some(function (x) {
    return x.campaignId === obj.campaignId && x.adGroupId === obj.adGroupId &&
           String(x.text).toLowerCase() === String(obj.text).toLowerCase() && x.match === obj.match;
  });
  if (dup) return false;
  this.creates.push(obj);
  return true;
};
ChangeSet.prototype.removeCreate = function (id) {
  this.creates = this.creates.filter(function (x) { return x._id !== id; });
};

/* ---------- 取当前值（含未导出的改动） ---------- */
function cur(model, changes, row, col) {
  var v = changes.get(row.i, col);
  return v === undefined ? row.d[col] : v;
}

/* ---------- 导出校验 ---------- */
function validate(model, changes) {
  var c = model.colIdx, issues = [];
  Object.keys(changes.edits).forEach(function (ri) {
    var row = model.rows[ri], e = changes.edits[ri];
    var name = row.d[c.campaignNameInfo] || row.d[c.campaignName] || '';
    Object.keys(e).forEach(function (col) {
      var ch = e[col], v = ch.to;
      if (+col === c.bid || +col === c.defaultBid) {
        var b = num(v);
        if (b < 0.02) issues.push({ level: 'error', text: name + ' 竞价 ' + v + ' 低于最低 0.02' });
        else if (b > 5) issues.push({ level: 'warn', text: name + ' 竞价 ' + v + ' 偏高，请确认' });
      }
      if (+col === c.dailyBudget) {
        var bg = num(v);
        if (bg < 1) issues.push({ level: 'error', text: name + ' 每日预算 ' + v + ' 低于最低 1' });
      }
      if (+col === c.percentage) {
        var p = num(v);
        if (p < 0 || p > 900) issues.push({ level: 'error', text: name + ' 溢价 ' + v + '% 超出 0–900 范围' });
        if (p !== Math.round(p)) issues.push({ level: 'error', text: name + ' 溢价必须是整数' });
      }
    });
  });
  changes.creates.forEach(function (n) {
    if (!String(n.text || '').trim()) issues.push({ level: 'error', text: '否定词为空' });
    if (String(n.text || '').split(/\s+/).length > 10) issues.push({ level: 'warn', text: '否定词「' + n.text + '」超过 10 个单词，亚马逊可能拒收' });
  });
  return issues;
}

/* ---------- 生成导出用的行数组 ---------- */
function buildExportRows(model, changes, opts) {
  opts = opts || {};
  var c = model.colIdx;
  var voc = VOCAB[opts.vocab || model.lang] || VOCAB.zh;
  var out = [];

  var indices = Object.keys(changes.edits).map(Number).sort(function (a, b) { return a - b; });
  indices.forEach(function (ri) {
    var row = model.rows[ri];
    var d = row.d.slice();
    var e = changes.edits[ri];
    Object.keys(e).forEach(function (col) { d[col] = e[col].to; });
    if (c.operation >= 0) d[c.operation] = voc.op.update;
    out.push(d);
  });

  changes.creates.forEach(function (n) {
    var d = new Array(model.header.length).fill(null);
    if (c.product >= 0) d[c.product] = voc.product;
    if (c.entity >= 0) d[c.entity] = n.kind === 'campNegKw' ? voc.entity.campNegKw : voc.entity.negKeyword;
    if (c.operation >= 0) d[c.operation] = voc.op.create;
    if (c.campaignId >= 0) d[c.campaignId] = n.campaignId;
    if (c.adGroupId >= 0 && n.kind !== 'campNegKw') d[c.adGroupId] = n.adGroupId;
    if (c.state >= 0) d[c.state] = voc.state.enabled;
    if (c.keywordText >= 0) d[c.keywordText] = n.text;
    if (c.matchType >= 0) d[c.matchType] = n.match === 'exact' ? voc.neg.exact : voc.neg.phrase;
    out.push(d);
  });

  return out;
}

/* ---------- 变更清单（给人看 / 导 CSV） ---------- */
var FIELD_LABEL = {
  state: '状态', bid: '竞价', defaultBid: '广告组默认竞价',
  dailyBudget: '每日预算', percentage: '广告位溢价'
};

function changeList(model, changes) {
  var c = model.colIdx, list = [];
  Object.keys(changes.edits).forEach(function (ri) {
    var row = model.rows[ri], e = changes.edits[ri];
    Object.keys(e).forEach(function (col) {
      var ch = e[col];
      list.push({
        rowIndex: +ri, col: +col,
        campaign: row.d[c.campaignNameInfo] || row.d[c.campaignName] || '',
        adGroup: row.d[c.adGroupNameInfo] || row.d[c.adGroupName] || '',
        entity: String(row.d[c.entity] || ''),
        object: row.d[c.keywordText] || row.d[c.targetExprInfo] || row.d[c.sku] ||
                row.d[c.placement] || row.d[c.adGroupName] || row.d[c.campaignName] || '',
        field: FIELD_LABEL[ch.field] || ch.field,
        from: ch.from, to: ch.to, type: 'edit'
      });
    });
  });
  changes.creates.forEach(function (n) {
    list.push({
      createId: n._id, campaign: n.campaignName, adGroup: n.kind === 'campNegKw' ? '(活动级)' : n.adGroupName,
      entity: n.kind === 'campNegKw' ? '广告活动否定关键词' : '否定关键词',
      object: n.text, field: '新增否定', from: '', to: n.match === 'exact' ? '否定精准匹配' : '否定词组', type: 'create'
    });
  });
  return list;
}


/* ===========================================================
   日期 / 周期名 / 搜索词合并
   =========================================================== */

/** Excel 序列号 / 2025-07-24 / 2025.7.24 / 20250724,统一成 yyyy-mm-dd;认不出给空串 */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return fmtDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number' && isFinite(v)) {
    // Excel 的日期是「1899-12-30 起的天数」
    if (v < 20000 || v > 80000) return '';
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return fmtDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const t = String(v).trim();
  let m = t.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return fmtDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return fmtDate(+m[1], +m[2], +m[3]);
  return '';
}

function fmtDate(y, mo, d) {
  if (!(y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

export function todayStr() {
  const d = new Date();
  return fmtDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 一批带 date 的行里最早和最晚的一天 */
export function dateSpan(rows) {
  let start = '', end = '';
  for (const r of rows || []) {
    const d = r.date;
    if (!d) continue;
    if (!start || d < start) start = d;
    if (!end || d > end) end = d;
  }
  return { start, end };
}

/**
 * 文件名里猜周期。认这几种写法:
 *   2025-07-24_2025-07-30 / 20250724-20250730 / 7.24-7.30(补当年)
 * 猜不出来返回两个空串,让用户自己填。
 */
export function parsePeriodFromName(name) {
  const t = String(name || '');
  let m = t.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})\D{1,3}(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
  if (m) return { start: fmtDate(+m[1], +m[2], +m[3]), end: fmtDate(+m[4], +m[5], +m[6]) };
  m = t.match(/(?:^|\D)(\d{1,2})[.\-/](\d{1,2})\s*[-~至]\s*(\d{1,2})[.\-/](\d{1,2})(?:\D|$)/);
  if (m) {
    const y = new Date().getFullYear();
    return { start: fmtDate(y, +m[1], +m[2]), end: fmtDate(y, +m[3], +m[4]) };
  }
  m = t.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
  if (m) return { start: fmtDate(+m[1], +m[2], +m[3]), end: fmtDate(+m[1], +m[2], +m[3]) };
  return { start: '', end: '' };
}

/** 一个周期的显示名:「7.24-7.30」这种,只用来给导出文件命名 */
export function periodLabel(start, end) {
  const short = (d) => (d ? d.slice(5).split('-').map((x) => String(+x)).join('.') : '');
  if (!start && !end) return '';
  if (start === end) return short(start);
  return short(start) + '-' + short(end);
}

/**
 * 搜索词合并:同一条活动 / 广告组 / 投放下的同一个词,指标相加。
 * 按天下载的报告一个词会有很多行,合成整期一行再上界面。
 */
export function mergeSearchTerms(list) {
  const map = new Map();
  for (const t of list || []) {
    const k = t.campaignId + '|' + t.adGroupId + '|' + t.targetId + '|' + String(t.term).toLowerCase();
    const cur = map.get(k);
    if (cur) cur.items.push(t);
    else map.set(k, { head: t, items: [t] });
  }
  const out = [];
  for (const { head, items } of map.values()) {
    out.push(
      items.length === 1
        ? head
        : { ...head, date: '', m: sumMetrics(items.map((x) => x.m)) }
    );
  }
  return out;
}

/* ===========================================================
   导出用的工作表过滤
   亚马逊只收前三列是「产品 / 实体层级 / 操作」的批量表工作表。
   下载批量表时勾了搜索词报告之类的报表,那些表会跟着留在文件里,
   原样传回后台会被判「标头无效」,整份文件退回、一行都不生效。
   =========================================================== */

/** 这一页是不是亚马逊收的批量表工作表 */
export function isBulkSheet(ws) {
  if (!ws || !ws['!ref']) return false;
  const r = XLSX.utils.decode_range(ws['!ref']);
  const head = [];
  for (let i = 0; i < 3; i++) {
    const cell = ws[XLSX.utils.encode_cell({ r: r.s.r, c: r.s.c + i })];
    head.push(cell ? String(cell.v === null || cell.v === undefined ? '' : cell.v).trim() : '');
  }
  return H.product.indexOf(head[0]) >= 0 && H.entity.indexOf(head[1]) >= 0 && H.operation.indexOf(head[2]) >= 0;
}

/** 传不上去的工作表名单(不改工作簿,只是列出来) */
export function nonBulkSheets(wb) {
  return (wb.SheetNames || []).filter((n) => !isBulkSheet(wb.Sheets[n]));
}

/** 把传不上去的工作表从工作簿里摘掉,返回摘掉的表名 */
export function stripNonBulkSheets(wb, keep) {
  const drop = nonBulkSheets(wb).filter((n) => n !== keep);
  if (!drop.length) return drop;
  wb.SheetNames = wb.SheetNames.filter((n) => drop.indexOf(n) < 0);
  drop.forEach((n) => { delete wb.Sheets[n]; });
  return drop;
}

export {
  H, ENT, VOCAB, DEFAULT_CFG, PLACEMENT_LABEL,
  parse, parseSearchTermReport, buildColIndex, detectLang, entityKindOf,
  metricsOf, rowMetrics, sumMetrics, totals,
  flagsFor, worstLevel, normState, normPlacement,
  num, ChangeSet, cur, validate, buildExportRows, changeList,
};
