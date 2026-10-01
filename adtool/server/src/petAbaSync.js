// 宠物版 ABA(品牌分析 · 搜索查询表现)ASIN 视图:从亚马逊 SP-API 按周拉取,写进和上传 CSV 相同的表。
// 亚马逊接口只有按 ASIN 的数据,没有卖家后台的品牌视图,品牌视图仍然上传 CSV。
import express from 'express';
import { db, audit } from './db.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { asinContentHash, saveAsinReports } from './abaAsin.js';
import { amazonGateway, pacificDay, petSpConfig, runReport, shiftDay } from './petAmazon.js';

const REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';
export const SOURCE_FILE = 'Amazon SP-API';
// reportOptions.asin 是空格分隔的 ASIN 列表,最长 200 个字符
const MAX_ASIN_CHARS = 200;
// 周报一般在周六结束后几天才出齐
const READY_LAG_DAYS = 3;
const MAX_WEEKS = 12;

const DAY_MS = 86400000;
const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

/** 亚马逊的周:周日到周六。返回已出齐的最近 count 周,新的在前 */
export function completeWeeks(today, count) {
  const ready = shiftDay(today, -READY_LAG_DAYS);
  const weekday = new Date(`${ready}T00:00:00Z`).getUTCDay();
  // 最近一个已经过完的周六(当天是周六也算过完)
  let end = shiftDay(ready, weekday === 6 ? 0 : -(weekday + 1));
  const weeks = [];
  for (let i = 0; i < count; i += 1) {
    weeks.push({ week_start: shiftDay(end, -6), week_end: end, week_number: weekNumber(end) });
    end = shiftDay(end, -7);
  }
  return weeks;
}

/** 卖家后台的周数:包含 1 月 1 日的那个周日开头的周是第 1 周 */
export function weekNumber(weekEnd) {
  const year = Number(weekEnd.slice(0, 4));
  const jan1 = Date.UTC(year, 0, 1);
  const firstSunday = jan1 - new Date(jan1).getUTCDay() * DAY_MS;
  return Math.floor((Date.parse(`${shiftDay(weekEnd, -6)}T00:00:00Z`) - firstSunday) / (7 * DAY_MS)) + 1;
}

/** ASIN 按 200 字符一组 */
export function asinBatches(asins) {
  const batches = [];
  let current = [];
  for (const asin of asins) {
    if (current.length && [...current, asin].join(' ').length > MAX_ASIN_CHARS) {
      batches.push(current);
      current = [];
    }
    current.push(asin);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** 报告 JSON → 每个 ASIN 一份周报,字段和上传的 ASIN 视图 CSV 一一对应 */
export function asinReportsFromJson(payload, week) {
  const byAsin = new Map();
  for (const entry of Array.isArray(payload?.dataByAsin) ? payload.dataByAsin : []) {
    const asin = String(entry?.asin ?? '').trim().toUpperCase();
    const query = String(entry?.searchQueryData?.searchQuery ?? '').trim();
    if (!/^[A-Z0-9]{10}$/.test(asin) || !query || query.length > 1000) continue;
    if (entry.endDate && entry.endDate !== week.week_end) continue;
    if (!byAsin.has(asin)) byAsin.set(asin, new Map());
    const rows = byAsin.get(asin);
    if (rows.has(query)) continue;
    rows.set(query, {
      query,
      query_volume: intOf(entry.searchQueryData?.searchQueryVolume),
      market_impressions: intOf(entry.impressionData?.totalQueryImpressionCount),
      market_clicks: intOf(entry.clickData?.totalClickCount),
      market_purchases: intOf(entry.purchaseData?.totalPurchaseCount),
      asin_impressions: intOf(entry.impressionData?.asinImpressionCount),
      asin_clicks: intOf(entry.clickData?.asinClickCount),
      asin_purchases: intOf(entry.purchaseData?.asinPurchaseCount),
    });
  }
  return [...byAsin].map(([asin, rows]) => {
    const report = { asin, ...week, source_file: SOURCE_FILE, rows: [...rows.values()] };
    return { ...report, content_hash: asinContentHash(report) };
  });
}

const state = (key) => {
  const value = db.prepare('SELECT value FROM pet_price_sync_state WHERE key=?').get(key)?.value;
  return value ? JSON.parse(value) : null;
};
const setState = (key, value) => db.prepare(`INSERT INTO pet_price_sync_state(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));

let running = false;

/**
 * 拉最近 weeks 周的 ASIN 视图。默认只补缺的 ASIN×周;refresh=true 时全部重拉(亚马逊偶尔回补数据)。
 * 某一周还没出数据(报告被取消)就跳过,下次再试。
 */
export async function syncAbaAsin({ weeks = 4, refresh = false } = {}, actorId = null, gateway = amazonGateway, env = process.env, today = pacificDay(new Date())) {
  if (!isPet) throw new Error('只支持宠物版');
  if (running) throw Object.assign(new Error('ABA 正在同步'), { status: 409 });
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证'), { status: 503 });
  const asins = db.prepare(`SELECT DISTINCT upper(asin) AS asin FROM sku_items
    WHERE user_id=? AND country='US' AND asin IS NOT NULL AND asin<>'' ORDER BY asin`).all(PET_SHOP_ID).map((row) => row.asin);
  if (!asins.length) throw Object.assign(new Error('SKU 库里还没有 ASIN，请先在 SKU 库「从亚马逊同步」'), { status: 400 });
  running = true;
  const startedAt = new Date().toISOString();
  setState('aba_last_attempt', { startedAt });
  const have = db.prepare(`SELECT 1 FROM aba_asin_reports WHERE user_id=? AND marketplace='US' AND asin=? AND week_end=?`);
  const summary = { weeks: [], added: 0, updated: 0, unchanged: 0, notReady: [], requested: 0 };
  try {
    for (const week of completeWeeks(today, Math.min(MAX_WEEKS, Math.max(1, Number(weeks) || 4)))) {
      const missing = refresh ? asins : asins.filter((asin) => !have.get(PET_SHOP_ID, asin, week.week_end));
      if (!missing.length) continue;
      const reports = [];
      let ready = true;
      for (const batch of asinBatches(missing)) {
        summary.requested += 1;
        const payload = await runReport(account, REPORT_TYPE, {
          start: new Date(`${week.week_start}T00:00:00Z`), end: new Date(`${week.week_end}T00:00:00Z`),
          options: { reportPeriod: 'WEEK', asin: batch.join(' ') }, parse: JSON.parse,
        }, gateway).catch((error) => {
          throw new Error(`${week.week_start}~${week.week_end}：${error.message}`);
        });
        if (payload === null) { ready = false; break; }
        reports.push(...asinReportsFromJson(payload, week));
      }
      if (!ready) { summary.notReady.push(week.week_end); continue; }
      const saved = db.transaction(() => saveAsinReports(PET_SHOP_ID, 'US', reports))();
      for (const item of saved) summary[item.status] += 1;
      summary.weeks.push({ week_end: week.week_end, asins: reports.length });
    }
    const result = { ...summary, startedAt, completedAt: new Date().toISOString() };
    db.transaction(() => {
      setState('aba_last_success', result);
      db.prepare("DELETE FROM pet_price_sync_state WHERE key='aba_last_error'").run();
    })();
    if (actorId) audit(actorId, 'US', 'sync', 'aba_asin_reports', null, summary);
    return result;
  } catch (error) {
    const message = String(error.message).slice(0, 300);
    setState('aba_last_error', { at: new Date().toISOString(), message });
    throw Object.assign(new Error(message), { status: error.status });
  } finally { running = false; }
}

export function abaSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  return { configured: !!account, issues, running,
    lastSuccess: state('aba_last_success'), lastAttempt: state('aba_last_attempt'), lastError: state('aba_last_error') };
}

/** 每小时检查一次,美西时间每天第一次检查时补最近 4 周缺的 ASIN 周报 */
export function startAbaSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = async () => {
    const status = abaSyncStatus();
    const today = pacificDay(new Date());
    if (!status.configured || running || (status.lastAttempt && pacificDay(status.lastAttempt.startedAt) === today)) return;
    try { await syncAbaAsin({ weeks: 4 }); } catch (error) { console.error('[aba-sync]', error.message); }
  };
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

// 挂在 /api/aba/asin/amazon,前面的 ABA 中间件已经校验登录和站点
export const petAbaRouter = express.Router();
petAbaRouter.use((req, res, next) => isPet && req.abaMarket === 'US' ? next() : res.status(404).json({ error: '只有宠物版美国站可以从亚马逊同步 ABA' }));
petAbaRouter.get('/status', (req, res) => res.json(abaSyncStatus()));
petAbaRouter.post('/sync', (req, res) => {
  const status = abaSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  if (status.running) return res.status(409).json({ error: 'ABA 正在同步' });
  const weeks = Math.min(MAX_WEEKS, Math.max(1, Number(req.body?.weeks) || 4));
  const hasAsin = db.prepare(`SELECT 1 FROM sku_items WHERE user_id=? AND country='US' AND asin IS NOT NULL AND asin<>'' LIMIT 1`).get(PET_SHOP_ID);
  if (!hasAsin) return res.status(400).json({ error: 'SKU 库里还没有 ASIN，请先在 SKU 库「从亚马逊同步」' });
  void syncAbaAsin({ weeks, refresh: !!req.body?.refresh }, req.session.user.id).catch((error) => console.error('[aba-sync]', error.message));
  res.status(202).json({ accepted: true, weeks });
});
