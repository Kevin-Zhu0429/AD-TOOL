/**
 * 待确认改动页用的纯函数:
 *   changeSheetRows —— 确认过的广告改动生成商品推广批量表(和手动广告页同一套中文表头),在广告 API 开通前人工上传
 *   wordDiff        —— 标题、后台词改前改后按单词对比,页面上标出增删
 */
import { HEADERS, C, SHEET } from './adEngine.js';

export { SHEET };

// adEngine 的 C 里没有的编号列
const COL = { ...C, AD: 6, KEYWORD: 7, TARGET_ID: 8 };
const ENTITY = { campaign: '广告活动', adGroup: '广告组', keyword: '关键词', productTarget: '商品定向', productAd: '商品广告' };
const ID_COL = { keyword: COL.KEYWORD, productTarget: COL.TARGET_ID, productAd: COL.AD };

/** 一条广告改动 -> 批量表的一行。编号保持文字,超过 15 位的编号写成数字会被 Excel 改掉末尾 */
export function changeSheetRow(item) {
  const { kind, target, after } = item;
  const row = new Array(HEADERS.length).fill('');
  row[COL.PROD] = '商品推广';
  row[COL.CAMP] = String(target.campaignId);
  if (kind === 'ad_negative') {
    row[COL.ENTITY] = after.matchType === 'asin' ? '否定商品定向' : target.level === 'campaign' ? '广告活动否定关键词' : '否定关键词';
    row[COL.OP] = '创建';
    if (target.level !== 'campaign') row[COL.GROUP] = String(target.adGroupId);
    row[COL.STATUS] = '已启用';
    if (after.matchType === 'asin') row[COL.TARGET] = `asin="${after.text}"`;
    else {
      row[COL.KWTEXT] = after.text;
      row[COL.MATCH] = after.matchType === 'exact' ? '否定精准匹配' : '否定词组';
    }
    return row;
  }
  if (!ENTITY[target.entity]) throw new Error(`不认识的广告实体：${target.entity}`);
  row[COL.ENTITY] = ENTITY[target.entity];
  row[COL.OP] = '更新';
  if (target.entity !== 'campaign') row[COL.GROUP] = String(target.adGroupId);
  if (ID_COL[target.entity] != null) row[ID_COL[target.entity]] = String(target.entityId);
  if (kind === 'ad_state') row[COL.STATUS] = after.state === 'paused' ? '已暂停' : '已启用';
  else if (kind === 'ad_bid') row[target.entity === 'adGroup' ? COL.DEFBID : COL.BID] = after.bid;
  else if (kind === 'ad_budget') row[COL.BUDGET] = after.budget;
  else throw new Error(`不认识的广告改动：${kind}`);
  return row;
}

/** 整张表:表头 + 每条改动一行(只收广告改动) */
export function changeSheetRows(items) {
  return [HEADERS.slice(), ...items.filter((item) => item.group === 'ad').map(changeSheetRow)];
}

const tokens = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * 按单词对比两段文字(最长公共子序列),返回 [{ text, type: same|add|del }]。
 * 大小写不同算改了。标题最多两百字符,几十个词,直接 O(n×m)。
 */
export function wordDiff(before, after) {
  const a = tokens(before), b = tokens(after);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ text: a[i], type: 'same' }); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ text: b[j], type: 'add' }); j += 1; }
    else { out.push({ text: a[i], type: 'del' }); i += 1; }
  }
  return out;
}

/** 后台词这种不讲顺序的:新增了哪些词、去掉了哪些词(不分大小写) */
export function termChanges(before, after) {
  const was = new Set(tokens(before).map((word) => word.toLowerCase()));
  const now = new Set(tokens(after).map((word) => word.toLowerCase()));
  return { added: [...now].filter((word) => !was.has(word)), removed: [...was].filter((word) => !now.has(word)) };
}

export const byteLength = (text) => new TextEncoder().encode(String(text ?? '')).length;
