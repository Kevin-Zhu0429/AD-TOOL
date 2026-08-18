/**
 * 五类否定词库的口径定义 —— 前后端共用这一份。
 * 前端不重复写一遍,开页面时从 /api/neg 里连数据一起拿走。
 *
 *  A 无名词            每个站点各自一份     运营 / 国家管理员维护   零星补充
 *  B 非售品牌          只分欧洲 / 美洲      商品部维护             低频
 *  C 非售流量干扰墨盒  只分欧洲 / 美洲      商品部维护             月度
 *  D 在售墨盒型号和相关打印机  分欧洲/美洲/澳洲  商品部维护        月度
 *  E 原装竞品 ASIN     每个站点各自一份     商品部维护             数据格式待定
 *
 * 区域库只存一份:欧洲传德国、美洲传美国,同区其他站点自动跟着变。
 */

export const REGIONS = [
  { id: 'EU', name: '欧洲', anchor: 'DE', markets: ['DE', 'ES', 'FR', 'IT', 'UK'] },
  { id: 'NA', name: '美洲', anchor: 'US', markets: ['US', 'CA'] },
  { id: 'AU', name: '澳洲', anchor: 'AU', markets: ['AU'] },
];

/** 站点顺序沿用老版本(ES 在前),末尾补上澳洲 */
export const MARKETPLACES = ['ES', 'DE', 'FR', 'IT', 'UK', 'US', 'CA', 'AU'];

export function regionOf(marketplace) {
  const mk = String(marketplace ?? '').toUpperCase();
  return REGIONS.find((r) => r.markets.includes(mk)) ?? null;
}

/**
 * 词库定义。
 *  scope   market = 按站点存;region = 按区域存(同区共用一份)
 *  regions 该库开了哪几个区域,scope=region 时有效
 *  owner   goods = 商品部(和超级管理员)才能改;market = 该站点的运营 / 国家管理员能改
 *  cols    列定义,顺序就是表格列顺序、粘贴时的列顺序
 *  key     判重用哪几列(同一区域 / 站点内不允许重复)
 *  feed    这一类怎么变成否定行:kw 走否定关键词,asin 走否定商品定向
 *  special series = 不整库否定,只在「系列广告」里算出该否掉的型号
 */
export const LIBS = [
  {
    id: 'A',
    name: '无名词',
    scope: 'market',
    owner: 'market',
    ownerName: '运营 / 国家管理员',
    cadence: '零星补充',
    desc: '如 pad、cord 等非墨盒品名,但用户习惯用类似墨盒的数字去搜',
    cols: [{ key: 'term', label: '否定词', required: true, kw: true }],
    key: ['term'],
    feed: { kw: ['term'], asin: [] },
  },
  {
    id: 'B',
    name: '非售品牌',
    scope: 'region',
    regions: ['EU', 'NA'],
    owner: 'goods',
    ownerName: '商品部',
    cadence: '低频',
    desc: '店铺没有销售的墨盒品牌,如 epson、brother。文字各市场一致,只按欧洲 / 美洲分两份',
    cols: [{ key: 'term', label: '品牌', required: true, kw: true }],
    key: ['term'],
    feed: { kw: ['term'], asin: [] },
  },
  {
    id: 'C',
    name: '非售流量干扰墨盒',
    scope: 'region',
    regions: ['EU', 'NA'],
    owner: 'goods',
    ownerName: '商品部',
    cadence: '月度',
    desc: '不卖但会抢流量的墨盒型号(308/68、280、X85 这类数字)、其主力打印机型号,以及日销高的竞品 ASIN',
    cols: [
      { key: 'term', label: '墨盒型号', required: true, kw: true },
      { key: 'printer', label: '打印机型号', kw: true },
      { key: 'asin', label: '竞品ASIN', asin: true },
    ],
    key: ['term', 'printer', 'asin'],
    feed: { kw: ['term', 'printer'], asin: ['asin'] },
  },
  {
    id: 'D',
    name: '在售墨盒型号和相关打印机',
    scope: 'region',
    regions: ['EU', 'NA', 'AU'],
    owner: 'goods',
    ownerName: '商品部',
    cadence: '月度',
    desc: '本区所有在售墨盒及其相关打印机。开系列广告时用它反推:留下投放的系列,其余墨盒和打印机型号全部否掉',
    cols: [
      { key: 'brand', label: '墨盒原装品牌' },
      { key: 'term', label: '墨盒型号', required: true },
      { key: 'series', label: '打印机系列' },
      { key: 'printer', label: '打印机型号', required: true },
    ],
    key: ['term', 'series', 'printer'],
    feed: { kw: [], asin: [] },
    special: 'series',
  },
  {
    id: 'E',
    name: '原装竞品ASIN',
    scope: 'market',
    owner: 'goods',
    ownerName: '商品部',
    cadence: '待定',
    draft: true,
    desc: '各市场的原装竞品 ASIN 库。数据格式还没定,先按 ASIN + 品牌 + 对应墨盒型号存着',
    cols: [
      { key: 'asin', label: 'ASIN', required: true, asin: true },
      { key: 'brand', label: '品牌' },
      { key: 'term', label: '对应墨盒型号' },
    ],
    key: ['asin'],
    feed: { kw: [], asin: ['asin'] },
  },
];

export const LIB_IDS = LIBS.map((l) => l.id);
export const COL_KEYS = ['term', 'brand', 'series', 'printer', 'asin'];

export function libOf(id) {
  return LIBS.find((l) => l.id === String(id ?? '').toUpperCase()) ?? null;
}

/**
 * 这个站点看某一类词库时,实际读写的是哪个 scope。
 * 站点库返回站点码;区域库返回区域码;该区域没开这一类就返回 null。
 */
export function scopeFor(lib, marketplace) {
  const mk = String(marketplace ?? '').toUpperCase();
  if (lib.scope === 'market') return MARKETPLACES.includes(mk) ? mk : null;
  const region = regionOf(mk);
  if (!region) return null;
  return lib.regions.includes(region.id) ? region.id : null;
}

/** 一个 scope 影响到哪些站点,用来在界面上写清楚「传一次同步给谁」 */
export function marketsOfScope(lib, scope) {
  if (lib.scope === 'market') return [scope];
  return REGIONS.find((r) => r.id === scope)?.markets ?? [];
}

export const ASIN_RE = /^B0[0-9A-Z]{8}$/;
export const KW_MAX = 80;

/** 「575, 576」这种一格里塞多个型号的,拆成 ['575','576'] */
export function splitModels(text) {
  return String(text ?? '')
    .split(/[,，、;；/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 单元格清洗:去首尾空格、把连续空白压成一个 */
export function cleanCell(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 校验并规整一行。返回 { row } 或 { error }。
 * ASIN 列允许写成 asin="B0xxxxxxxx",存的时候统一成纯 ASIN。
 */
export function normRow(lib, input) {
  const row = {};
  for (const col of lib.cols) {
    let v = cleanCell(input?.[col.key]);
    if (col.asin && v) {
      const m = v.match(/^asin\s*=\s*"?([^"]+)"?$/i);
      v = (m ? m[1] : v).trim().toUpperCase();
      if (!ASIN_RE.test(v)) return { error: `ASIN 格式不对:${v.slice(0, 20)}` };
    }
    if (col.kw && v.length > KW_MAX) {
      return { error: `${col.label}超过 ${KW_MAX} 字符:${v.slice(0, 20)}…` };
    }
    if (col.required && !v) return { error: `${col.label}不能为空` };
    row[col.key] = v || null;
  }
  if (!lib.cols.some((c) => row[c.key])) return { error: '空行' };
  row.note = cleanCell(input?.note) || null;
  return { row };
}

/** 判重键:同 scope 内相同 key 列的行只留一条 */
export function dedupeKey(lib, row) {
  return JSON.stringify(lib.key.map((k) => String(row[k] ?? '').toLowerCase()));
}
