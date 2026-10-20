// AI 每日分析:Claude 每天美国太平洋时间凌晨 2 点分析前一天的全店数据,通过连接器把日报、改动复盘和经验写进网站。
// 网站只存和展示,不自己调模型:「AI 日报」页看每天的结论,「改动日志」页把待确认队列里每条改动从提议到复盘串起来。
import express from 'express';
import { db } from './db.js';
import { requireLogin, requireRole } from './auth.js';
import { isPet } from './profile.js';
import { pacificDay, shiftDay } from './petAmazon.js';
import { ACTION_LABEL, KINDS, STATUS_LABEL, targetLabel } from './petChanges.js';
import { trafficCoverage, trafficTotals } from './petTraffic.js';
import { changeImpact } from './petImpact.js';

export const AREAS = { inventory: '库存', listing: 'Listing', search: '搜索词', rank: '排名与权重', ads: '广告', returns: '退货', competitors: '竞品', other: '其它' };
export const SECTION_STATUS = { good: '正常', watch: '留意', bad: '有问题' };
export const LEVELS = ['high', 'medium', 'low'];
export const ACTION_TYPES = { proposal: '已提改动', todo: '要你去做', watch: '继续观察' };
export const REVIEW_VERDICTS = { works: '有效', no_effect: '没变化', hurts: '变差', too_early: '数据还不够', unclear: '有干扰，看不清' };
export const LESSON_VERDICTS = { works: '有效做法', no_effect: '没用的做法', hurts: '要避免', rule: '规则' };
export const CONFIDENCE = { low: '低', medium: '中', high: '高' };
// 同一个 SKU 的 Listing 改动执行后这么多天内不再提新改动,否则前后对比分不清是哪条起的作用
export const COOLDOWN_DAYS = 14;
// 执行后第几天复盘
export const REVIEW_MILESTONES = [7, 14, 28];
export const SCHEDULE = { hour: 2, timeZone: 'America/Los_Angeles', label: '每天美国太平洋时间凌晨 2:00' };

const DONE = ['submitted', 'applied', 'not_applied'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const lower = (value) => String(value ?? '').trim().toLowerCase();
const round1 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
const pct = (now, base) => (base > 0 && now != null ? round1((now - base) / base * 100) : null);
const parseJson = (text, fallback = null) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** 库里的时间是服务器本地时间,换成太平洋时间的日期 */
function pacificDayOfLocal(local) {
  if (!local) return null;
  const seconds = db.prepare("SELECT CAST(strftime('%s', ?, 'utc') AS INTEGER) AS s").get(local)?.s;
  return seconds ? pacificDay(new Date(seconds * 1000)) : null;
}

// ---------- 网站自己算的当天指标(订单报告、业务报告) ----------

/** 某天全店销量、订单、销售额,和前 7 天日均比 */
export function salesKpis(day) {
  const one = db.prepare('SELECT SUM(units) AS units, SUM(orders) AS orders, SUM(sales) AS sales FROM pet_daily_sales WHERE day=?').get(day);
  const week = db.prepare('SELECT SUM(units) AS units, SUM(orders) AS orders, SUM(sales) AS sales FROM pet_daily_sales WHERE day>=? AND day<=?')
    .get(shiftDay(day, -7), shiftDay(day, -1));
  const avg = (key) => round1((week?.[key] ?? 0) / 7);
  const value = (key) => (key === 'sales' ? Number((one?.[key] ?? 0).toFixed(2)) : one?.[key] ?? 0);
  return Object.fromEntries(['units', 'orders', 'sales'].map((key) => [key, { value: value(key), avg7: avg(key), changePct: pct(value(key), avg(key)) }]));
}

/** 业务报告一般晚 2 天出数:取不晚于 day 的最近一天的访问量和转化率,和它前 7 天比 */
export function trafficKpis(day) {
  // 中间某天没拉到时不能拿它当最近一天,取实际拉到过的最近一天
  const latest = db.prepare('SELECT MAX(day) AS day FROM pet_traffic_days WHERE day<=?').get(day)?.day;
  if (!latest) return null;
  const one = trafficTotals(db.prepare('SELECT * FROM pet_traffic_daily WHERE day=?').all(latest));
  const prior = db.prepare('SELECT * FROM pet_traffic_daily WHERE day>=? AND day<=?').all(shiftDay(latest, -7), shiftDay(latest, -1));
  const week = trafficTotals(prior);
  const sessionsAvg = round1(week.sessions / 7);
  return { day: latest, lagDays: daysBetween(latest, day),
    sessions: { value: one.sessions, avg7: sessionsAvg, changePct: pct(one.sessions, sessionsAvg) },
    conversion: { value: one.conversion, avg7: week.conversion, changePoints: one.conversion != null && week.conversion != null ? round1(one.conversion - week.conversion) : null } };
}

// ---------- 日报 ----------

function shapeReport(row) {
  if (!row) return null;
  const report = parseJson(row.report_json, {});
  return { id: row.id, day: row.day, status: row.status, headline: row.headline, ...report, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * Claude 写入某天的日报。销量和访问量网站自己算;广告指标来自 Miguelpet,由 Claude 填。
 * reviews 同时写进改动复盘表,lessonsUsed 给经验计使用次数。
 */
export function saveDailyReport(input, { userId = null, source = 'claude', today = todayOf() } = {}) {
  const day = input.day ?? shiftDay(today, -1);
  if (!DAY_RE.test(day)) throw fail('day 要写成 YYYY-MM-DD');
  if (day >= today) throw fail('只能写今天之前的日报（分析的是已经过完的一天）');
  const headline = String(input.headline ?? '').trim();
  if (!headline) throw fail('headline 不能为空');
  const reviews = (input.reviews ?? []).map((review) => ({ ...review, changeId: Number(review.changeId) }));
  const known = new Set(reviews.length ? db.prepare(`SELECT id FROM pet_change_proposals WHERE id IN (${reviews.map(() => '?').join(',')})`)
    .all(...reviews.map((review) => review.changeId)).map((row) => row.id) : []);
  const missing = reviews.filter((review) => !known.has(review.changeId)).map((review) => review.changeId);
  if (missing.length) throw fail(`没有这些改动编号：${missing.join('、')}`);
  const lessonsUsed = [...new Set((input.lessonsUsed ?? []).map(Number).filter(Number.isInteger))];
  const proposalIds = [...new Set((input.actions ?? []).flatMap((action) => action.proposalIds ?? []).map(Number))];
  const report = {
    kpis: { sales: salesKpis(day), traffic: trafficKpis(day), ads: input.ads ?? null },
    sections: input.sections ?? [], actions: input.actions ?? [], reviews, lessonsUsed, dataGaps: input.dataGaps ?? [], proposalIds,
  };
  const save = db.transaction(() => {
    // 同一天重跑:先撤掉上一版的复盘和经验使用次数,再写新的,重试也不会重复计数
    const previous = parseJson(db.prepare('SELECT report_json FROM pet_agent_reports WHERE day=?').get(day)?.report_json, null);
    const previousUsed = previous?.lessonsUsed ?? [];
    if (previousUsed.length) {
      db.prepare(`UPDATE pet_agent_lessons SET times_used=MAX(0, times_used-1) WHERE id IN (${previousUsed.map(() => '?').join(',')})`).run(...previousUsed);
    }
    db.prepare('DELETE FROM pet_change_reviews WHERE day=?').run(day);
    db.prepare(`INSERT INTO pet_agent_reports (day, status, headline, report_json, source, created_by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET status=excluded.status, headline=excluded.headline, report_json=excluded.report_json,
      source=excluded.source, updated_at=datetime('now','localtime')`).run(day, input.status === 'partial' ? 'partial' : 'done', headline,
      JSON.stringify(report), source, userId);
    const upsert = db.prepare(`INSERT INTO pet_change_reviews (proposal_id, day, days_after, verdict, text, metrics_json, lesson_id) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id, day) DO UPDATE SET days_after=excluded.days_after, verdict=excluded.verdict, text=excluded.text,
      metrics_json=excluded.metrics_json, lesson_id=excluded.lesson_id`);
    for (const review of reviews) {
      const executed = pacificDayOfLocal(db.prepare('SELECT executed_at FROM pet_change_proposals WHERE id=?').get(review.changeId)?.executed_at);
      upsert.run(review.changeId, day, executed ? daysBetween(executed, day) : null, review.verdict, review.text ?? '',
        review.metrics ? JSON.stringify(review.metrics) : null, review.lessonId ?? null);
    }
    if (lessonsUsed.length) db.prepare(`UPDATE pet_agent_lessons SET times_used=times_used+1 WHERE id IN (${lessonsUsed.map(() => '?').join(',')})`).run(...lessonsUsed);
  });
  save();
  return { day, saved: true, reviews: reviews.length, url: '/#agent' };
}

export function reportList({ limit = 30 } = {}) {
  return db.prepare('SELECT day, status, headline, updated_at FROM pet_agent_reports ORDER BY day DESC LIMIT ?').all(limit)
    .map((row) => ({ day: row.day, status: row.status, headline: row.headline, updatedAt: row.updated_at }));
}

export function getReport(day) {
  const row = day ? db.prepare('SELECT * FROM pet_agent_reports WHERE day=?').get(day) : db.prepare('SELECT * FROM pet_agent_reports ORDER BY day DESC LIMIT 1').get();
  const report = shapeReport(row);
  if (!report) return null;
  // 日报里提到的改动,带上现在的状态(提议时是待确认,之后可能已经确认、生效)
  const ids = [...new Set([...report.proposalIds ?? [], ...(report.reviews ?? []).map((review) => review.changeId)])];
  const changes = ids.length ? db.prepare(`SELECT id, kind, status, target_json FROM pet_change_proposals WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  report.changes = Object.fromEntries(changes.map((row) => [row.id, { id: row.id, kindLabel: KINDS[row.kind]?.label ?? row.kind, status: row.status,
    statusLabel: STATUS_LABEL[row.status] ?? row.status, target: targetLabel(row.kind, parseJson(row.target_json, {})) }]));
  const used = report.lessonsUsed ?? [];
  report.lessons = used.length ? db.prepare(`SELECT id, title, verdict FROM pet_agent_lessons WHERE id IN (${used.map(() => '?').join(',')})`).all(...used) : [];
  return report;
}

/** 最近几天每天有没有跑:有日报的天和缺的天(按太平洋时间,不含今天) */
export function runCalendar({ days = 14, today = todayOf() } = {}) {
  const have = new Map(db.prepare('SELECT day, status FROM pet_agent_reports WHERE day>=?').all(shiftDay(today, -days)).map((row) => [row.day, row.status]));
  return Array.from({ length: days }, (_, index) => shiftDay(today, -1 - index)).map((day) => ({ day, status: have.get(day) ?? 'missing' }));
}

// ---------- 周报 ----------

export const WEEKLY_LIMITS = { headline: 300, markdown: 60000, kpis: 8 };
const KPI_TONES = ['good', 'bad', 'neutral'];
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** 最近一个已经过完的周:上周一到上周日(太平洋时间) */
export function lastFullWeek(today = todayOf()) {
  const start = shiftDay(today, -((weekdayOf(today) + 6) % 7) - 7);
  return { weekStart: start, weekEnd: shiftDay(start, 6) };
}

function shapeWeekly(row, { full = true } = {}) {
  if (!row) return null;
  return { weekStart: row.week_start, weekEnd: row.week_end, headline: row.headline, kpis: parseJson(row.kpis_json, []),
    ...(full ? { markdown: row.markdown } : {}), source: row.source, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Claude 写入一周的周报(周一到周日);同一周再写会覆盖 */
export function saveWeeklyReport(input, { userId = null, source = 'claude', today = todayOf() } = {}) {
  const weekStart = String(input.weekStart ?? lastFullWeek(today).weekStart);
  if (!DAY_RE.test(weekStart) || Number.isNaN(Date.parse(`${weekStart}T00:00:00Z`))) throw fail('weekStart 要写成 YYYY-MM-DD');
  if (weekdayOf(weekStart) !== 1) throw fail('weekStart 要是周一（周报按周一到周日算）');
  const weekEnd = shiftDay(weekStart, 6);
  if (input.weekEnd != null && input.weekEnd !== weekEnd) throw fail(`weekEnd 应该是 ${weekEnd}（周日）`);
  if (weekEnd >= today) throw fail('只能写已经过完的一周');
  const headline = String(input.headline ?? '').trim();
  if (!headline) throw fail('headline 不能为空');
  if (headline.length > WEEKLY_LIMITS.headline) throw fail(`headline 不能超过 ${WEEKLY_LIMITS.headline} 字`);
  const markdown = String(input.markdown ?? '').replace(/\r\n/g, '\n').trim();
  if (!markdown) throw fail('markdown 不能为空');
  if (markdown.length > WEEKLY_LIMITS.markdown) throw fail(`周报正文不能超过 ${WEEKLY_LIMITS.markdown} 字`);
  const kpis = (input.kpis ?? []).slice(0, WEEKLY_LIMITS.kpis).map((kpi) => {
    const label = String(kpi?.label ?? '').trim().slice(0, 30), value = String(kpi?.value ?? '').trim().slice(0, 40);
    if (!label || !value) throw fail('kpis 每项都要有 label 和 value');
    return { label, value, prev: kpi.prev == null ? null : String(kpi.prev).trim().slice(0, 40) || null,
      change: kpi.change == null ? null : String(kpi.change).trim().slice(0, 30) || null, tone: KPI_TONES.includes(kpi.tone) ? kpi.tone : 'neutral' };
  });
  db.prepare(`INSERT INTO pet_agent_weekly (week_start, week_end, headline, markdown, kpis_json, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(week_start) DO UPDATE SET week_end=excluded.week_end, headline=excluded.headline, markdown=excluded.markdown,
    kpis_json=excluded.kpis_json, source=excluded.source, updated_at=datetime('now','localtime')`)
    .run(weekStart, weekEnd, headline, markdown, JSON.stringify(kpis), source, userId);
  return { weekStart, weekEnd, saved: true, url: '/#agent' };
}

export function weeklyList({ limit = 60 } = {}) {
  return db.prepare('SELECT * FROM pet_agent_weekly ORDER BY week_start DESC LIMIT ?').all(limit).map((row) => shapeWeekly(row, { full: false }));
}

export function getWeekly(weekStart) {
  const row = weekStart ? db.prepare('SELECT * FROM pet_agent_weekly WHERE week_start=?').get(weekStart)
    : db.prepare('SELECT * FROM pet_agent_weekly ORDER BY week_start DESC LIMIT 1').get();
  return shapeWeekly(row);
}

// ---------- 经验库 ----------

function shapeLesson(row) {
  return { id: row.id, title: row.title, body: row.body, area: row.area, areaLabel: AREAS[row.area] ?? row.area, changeKind: row.change_kind,
    changeKindLabel: row.change_kind ? KINDS[row.change_kind]?.label ?? row.change_kind : null, style: row.style,
    verdict: row.verdict, verdictLabel: LESSON_VERDICTS[row.verdict] ?? row.verdict, confidence: row.confidence, confidenceLabel: CONFIDENCE[row.confidence],
    evidence: row.evidence, changeIds: parseJson(row.change_ids_json, []), status: row.status, retiredReason: row.retired_reason,
    timesUsed: row.times_used, fromDay: row.from_day, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listLessons({ status = 'active', area } = {}) {
  const where = [], params = [];
  if (status !== 'all') { where.push('status=?'); params.push(status === 'retired' ? 'retired' : 'active'); }
  if (area && AREAS[area]) { where.push('area=?'); params.push(area); }
  return db.prepare(`SELECT * FROM pet_agent_lessons ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, times_used DESC, id DESC`).all(...params).map(shapeLesson);
}

/** 新增或更新一条经验;id 填了就是更新(Claude 有新证据时改结论或可信度) */
export function saveLesson(input, { source = 'claude', today = todayOf() } = {}) {
  const changeIds = [...new Set((input.changeIds ?? []).map(Number).filter(Number.isInteger))];
  const fields = { title: input.title, body: input.body, area: AREAS[input.area] ? input.area : 'other', change_kind: KINDS[input.changeKind] ? input.changeKind : null,
    style: input.style ?? null, verdict: LESSON_VERDICTS[input.verdict] ? input.verdict : 'works', confidence: CONFIDENCE[input.confidence] ? input.confidence : 'low',
    evidence: input.evidence ?? null, change_ids_json: JSON.stringify(changeIds) };
  if (input.id) {
    const row = db.prepare('SELECT * FROM pet_agent_lessons WHERE id=?').get(Number(input.id));
    if (!row) throw fail(`没有第 ${input.id} 条经验`, 404);
    const merged = { ...fields, title: input.title ?? row.title, body: input.body ?? row.body,
      change_ids_json: JSON.stringify([...new Set([...parseJson(row.change_ids_json, []), ...changeIds])]) };
    for (const key of ['area', 'change_kind', 'style', 'verdict', 'confidence', 'evidence']) {
      const inputKey = { change_kind: 'changeKind' }[key] ?? key;
      if (input[inputKey] === undefined) merged[key] = row[key];
    }
    const status = input.status === 'retired' ? 'retired' : input.status === 'active' ? 'active' : row.status;
    db.prepare(`UPDATE pet_agent_lessons SET title=?, body=?, area=?, change_kind=?, style=?, verdict=?, confidence=?, evidence=?, change_ids_json=?,
      status=?, retired_reason=?, updated_at=datetime('now','localtime') WHERE id=?`).run(merged.title, merged.body, merged.area, merged.change_kind,
      merged.style, merged.verdict, merged.confidence, merged.evidence, merged.change_ids_json, status,
      status === 'retired' ? input.retiredReason ?? row.retired_reason : null, row.id);
    return shapeLesson(db.prepare('SELECT * FROM pet_agent_lessons WHERE id=?').get(row.id));
  }
  if (!fields.title?.trim() || !fields.body?.trim()) throw fail('经验要有标题和内容');
  const id = db.prepare(`INSERT INTO pet_agent_lessons (title, body, area, change_kind, style, verdict, confidence, evidence, change_ids_json, from_day, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fields.title.trim(), fields.body.trim(), fields.area, fields.change_kind, fields.style, fields.verdict,
    fields.confidence, fields.evidence, fields.change_ids_json, shiftDay(today, -1), source).lastInsertRowid;
  return shapeLesson(db.prepare('SELECT * FROM pet_agent_lessons WHERE id=?').get(id));
}

/** 店主在网站上停用(写错了、过时了)或恢复一条经验 */
export function setLessonStatus(id, status, reason) {
  const row = db.prepare('SELECT id FROM pet_agent_lessons WHERE id=?').get(Number(id));
  if (!row) throw fail('这条经验找不到了，请刷新页面', 404);
  const next = status === 'retired' ? 'retired' : 'active';
  db.prepare("UPDATE pet_agent_lessons SET status=?, retired_reason=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(next, next === 'retired' ? String(reason || '店主停用').slice(0, 300) : null, row.id);
  return shapeLesson(db.prepare('SELECT * FROM pet_agent_lessons WHERE id=?').get(row.id));
}

// ---------- 改动日志 ----------

function reviewsByChange(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT r.*, l.title AS lesson_title FROM pet_change_reviews r LEFT JOIN pet_agent_lessons l ON l.id=r.lesson_id
    WHERE r.proposal_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.day`).all(...ids);
  for (const row of rows) {
    if (!map.has(row.proposal_id)) map.set(row.proposal_id, []);
    map.get(row.proposal_id).push({ day: row.day, daysAfter: row.days_after, verdict: row.verdict, verdictLabel: REVIEW_VERDICTS[row.verdict] ?? row.verdict,
      text: row.text, metrics: parseJson(row.metrics_json), lessonId: row.lesson_id, lessonTitle: row.lesson_title });
  }
  return map;
}

/** 改动走到哪一步:提议 → 确认 → 执行 → 生效 → 复盘。state:done 完成 / now 正在这步 / fail 停在这步(拒绝、失败、未生效) / todo 还没到 */
export function changeSteps(row, reviews = []) {
  const status = row.status;
  const ad = KINDS[row.kind]?.group === 'ad';
  const step = (key, label, state, at = null, note = null) => ({ key, label, state, at, note });
  const decided = !['pending', 'superseded'].includes(status);
  const executed = !!row.executed_at || ['exported', 'applied', 'not_applied'].includes(status);
  const latest = reviews.at(-1);
  return [
    step('proposed', '提议', 'done', row.created_at, row.source === 'claude' ? 'Claude' : row.source),
    status === 'rejected' ? step('decided', '确认', 'fail', row.decided_at, '已拒绝')
      : status === 'superseded' ? step('decided', '确认', 'fail', row.updated_at, '被新提议替代')
        : step('decided', '确认', decided ? 'done' : 'now', row.decided_at, !decided ? '等你确认' : parseJson(row.result_json)?.recordedOnly ? '在 Claude 里确认' : null),
    status === 'failed' ? step('executed', '执行', 'fail', row.updated_at, '失败')
      : step('executed', '执行', executed ? 'done' : ['queued', 'running', 'export', 'agent', 'agent_running'].includes(status) ? 'now' : 'todo', row.executed_at,
        status === 'export' ? '待导出批量表' : status === 'exported' ? '已导出待上传' : status === 'agent' ? '等 Claude 执行'
          : status === 'agent_running' ? 'Claude 执行中' : ad && executed ? (row.channel === 'miguelpet' ? 'Miguelpet' : row.channel === 'ads_api' ? '广告 API' : '批量表') : null),
    status === 'not_applied' ? step('applied', '生效', 'fail', row.verified_at ?? row.updated_at, '未生效')
      : step('applied', '生效', status === 'applied' ? 'done' : ['submitted', 'exported'].includes(status) ? 'now' : 'todo', row.verified_at,
        status === 'submitted' ? '等亚马逊生效' : status === 'exported' ? '等上传' : null),
    step('reviewed', '复盘', !latest ? (status === 'applied' ? 'now' : 'todo') : latest.verdict === 'too_early' ? 'now' : latest.verdict === 'hurts' ? 'fail' : 'done',
      latest?.day ?? null, latest ? latest.verdictLabel : status === 'applied' ? '等 7 天后复盘' : null),
  ];
}

const VERDICT_RANK = { hurts: 0, works: 1, no_effect: 2, unclear: 3, too_early: 4 };

/** 改动日志页:最近 days 天提议的改动,每条带步骤、复盘、前后对比的几个数 */
export function changeTimeline({ days = 60, today = todayOf() } = {}) {
  const span = Math.max(7, Math.min(365, Number(days) || 60));
  const since = db.prepare("SELECT datetime(?, '-' || ? || ' days') AS t").get(`${today} 23:59:59`, span).t;
  const rows = db.prepare(`SELECT p.*, b.title AS batch_title, du.display_name AS decided_name FROM pet_change_proposals p
    LEFT JOIN pet_change_batches b ON b.id=p.batch_id LEFT JOIN users du ON du.id=p.decided_by
    WHERE p.created_at>=? OR p.executed_at>=? ORDER BY p.created_at DESC, p.id DESC LIMIT 1000`).all(since, since);
  const reviews = reviewsByChange(rows.map((row) => row.id));
  // 执行过的 Listing 改动算一下前后各 14 天的对比
  const impacts = new Map();
  for (const row of rows.filter((item) => DONE.includes(item.status) && item.kind.startsWith('listing_') && item.executed_at).slice(0, 60)) {
    try {
      const item = changeImpact({ id: row.id, days: 14 }, { today }).items[0];
      if (item) impacts.set(row.id, { unitsPerDayPct: item.sales.unitsPerDayChangePct, unitsBefore: item.sales.before?.unitsPerDay ?? null,
        unitsAfter: item.sales.after?.unitsPerDay ?? null, sessionsPct: item.traffic.sessionsPerDayChangePct, conversionPoints: item.traffic.conversionChangePoints,
        afterDays: item.sales.after?.days ?? 0, caution: item.caution, otherChanges: item.otherChangesNearby.length, stockEvents: item.stockEvents.length });
    } catch { /* 对比算不出来就不显示 */ }
  }
  const items = rows.map((row) => {
    const target = parseJson(row.target_json, {});
    const list = reviews.get(row.id) ?? [];
    return { id: row.id, kind: row.kind, kindLabel: KINDS[row.kind]?.label ?? row.kind, group: KINDS[row.kind]?.group ?? 'ad',
      status: row.status, statusLabel: STATUS_LABEL[row.status] ?? row.status, target, targetLabel: targetLabel(row.kind, target), sku: target.sku ?? null,
      style: target.style ?? null, batch: row.batch_title, source: row.source, reason: row.reason, before: parseJson(row.before_json), after: parseJson(row.after_json),
      error: row.error, createdAt: row.created_at, createdDay: pacificDayOfLocal(row.created_at), decidedAt: row.decided_at, decidedBy: row.decided_name,
      executedAt: row.executed_at, executedDay: pacificDayOfLocal(row.executed_at), verifiedAt: row.verified_at,
      steps: changeSteps(row, list), reviews: list, verdict: list.at(-1)?.verdict ?? null, verdictLabel: list.at(-1)?.verdictLabel ?? null,
      impact: impacts.get(row.id) ?? null };
  });
  const count = (fn) => items.filter(fn).length;
  const reviewed = items.filter((item) => item.verdict && item.verdict !== 'too_early');
  const stats = {
    proposed: items.length, pending: count((item) => item.status === 'pending'),
    inFlight: count((item) => ['queued', 'running', 'submitted', 'agent', 'agent_running', 'export', 'exported'].includes(item.status)),
    applied: count((item) => item.status === 'applied'), failed: count((item) => ['failed', 'not_applied'].includes(item.status)),
    rejected: count((item) => item.status === 'rejected'),
    reviewed: reviewed.length, works: count((item) => item.verdict === 'works'), hurts: count((item) => item.verdict === 'hurts'),
    awaitingReview: count((item) => item.status === 'applied' && (!item.verdict || item.verdict === 'too_early')),
  };
  // 每天提议和生效的条数,画小柱状图
  const daily = Array.from({ length: Math.min(span, 30) }, (_, index) => shiftDay(today, -index)).reverse().map((day) => ({ day,
    proposed: count((item) => item.createdDay === day), executed: count((item) => item.executedDay === day) }));
  items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id);
  return { today, days: span, stats, daily, items, verdictOrder: VERDICT_RANK };
}

/** 一条改动的完整记录:每一步的操作日志 */
export function changeEvents(id) {
  return db.prepare(`SELECT l.*, u.display_name AS user_name FROM pet_change_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.proposal_id=? ORDER BY l.id`)
    .all(Number(id)).map((row) => ({ id: row.id, at: row.at, actor: row.actor, userName: row.user_name, action: row.action,
      actionLabel: ACTION_LABEL[row.action] ?? row.action, detail: parseJson(row.detail_json) }));
}

// ---------- 给 Claude 的分析上下文 ----------

function weeklyContext(today) {
  const week = lastFullWeek(today);
  const latest = getWeekly();
  return { lastWeekStart: week.weekStart, lastWeekEnd: week.weekEnd, due: !db.prepare('SELECT 1 FROM pet_agent_weekly WHERE week_start=?').get(week.weekStart),
    latest: latest && { weekStart: latest.weekStart, weekEnd: latest.weekEnd, headline: latest.headline, kpis: latest.kpis } };
}

/**
 * 每次分析前先读:最近几天的日报结论、生效中的经验、该复盘的改动、冷却期内的 SKU、数据新鲜度。
 * 这样每天的分析能接上前一天,不会重复提同样的改动。
 */
export function agentContext({ today = todayOf() } = {}) {
  const day = shiftDay(today, -1);
  const recent = db.prepare('SELECT * FROM pet_agent_reports ORDER BY day DESC LIMIT 3').all().map(shapeReport)
    .map((report) => ({ day: report.day, headline: report.headline, actions: report.actions ?? [] }));
  const executed = db.prepare(`SELECT * FROM pet_change_proposals WHERE status IN (${DONE.map(() => '?').join(',')}) AND executed_at IS NOT NULL
    ORDER BY executed_at DESC LIMIT 200`).all(...DONE);
  const reviews = reviewsByChange(executed.map((row) => row.id));
  const toReview = [], cooldown = new Map();
  for (const row of executed) {
    const target = parseJson(row.target_json, {});
    const executedDay = pacificDayOfLocal(row.executed_at);
    const age = daysBetween(executedDay, day);
    const done = reviews.get(row.id) ?? [];
    const reviewedAt = done.filter((review) => review.verdict !== 'too_early').map((review) => review.daysAfter ?? 0);
    const due = REVIEW_MILESTONES.filter((mark) => age >= mark && !reviewedAt.some((value) => value >= mark));
    if (due.length && age <= REVIEW_MILESTONES.at(-1) + 14) {
      toReview.push({ id: row.id, kind: KINDS[row.kind]?.label ?? row.kind, target: targetLabel(row.kind, target), sku: target.sku ?? null,
        executedDay, daysSince: age, dueMilestone: due.at(-1), lastVerdict: done.at(-1)?.verdict ?? null, reason: row.reason });
    }
    if (row.kind.startsWith('listing_') && target.sku && age < COOLDOWN_DAYS) {
      const key = lower(target.sku);
      if (!cooldown.has(key)) cooldown.set(key, { sku: target.sku, lastChangeDay: executedDay, until: shiftDay(executedDay, COOLDOWN_DAYS), kinds: [] });
      cooldown.get(key).kinds.push(KINDS[row.kind]?.label ?? row.kind);
    }
  }
  const pending = db.prepare("SELECT COUNT(*) AS n FROM pet_change_proposals WHERE status='pending'").get().n;
  const adsToExecute = db.prepare("SELECT COUNT(*) AS n FROM pet_change_proposals WHERE status='agent'").get().n;
  const sales = parseJson(db.prepare("SELECT value FROM pet_price_sync_state WHERE key='sales_coverage'").get()?.value);
  return {
    today, reportDay: day, schedule: SCHEDULE.label,
    alreadyReported: !!db.prepare('SELECT 1 FROM pet_agent_reports WHERE day=?').get(day),
    recentReports: recent,
    weekly: weeklyContext(today),
    lessons: listLessons({ status: 'active' }).map(({ id, title, body, areaLabel, changeKindLabel, style, verdictLabel, confidence, evidence, changeIds, timesUsed }) =>
      ({ id, title, body, area: areaLabel, changeKind: changeKindLabel, style, verdict: verdictLabel, confidence, evidence, changeIds, timesUsed })),
    changesToReview: toReview, cooldownSkus: [...cooldown.values()], pendingProposals: pending, confirmedAdChangesWaiting: adsToExecute,
    dataFreshness: { salesCoverage: sales, trafficCoverage: trafficCoverage() },
    rules: [
      `先读 lessons:和当前情况相符的经验要遵守,用到的把 id 写进 save_daily_report 的 lessonsUsed。`,
      `changesToReview 里的改动逐条用 get_change_impact 看前后对比,结论写进 reviews(执行后不满 7 天写 too_early;同期有断货补货、其它改动、促销时写 unclear)。`,
      `cooldownSkus 里的 SKU 在冷却期(Listing 改动执行后 ${COOLDOWN_DAYS} 天)内不要再提 Listing 改动,否则分不清效果;库存和广告不受限。`,
      'pendingProposals 很多时先别加新的,在日报里提醒店主先处理待确认。',
      '同一个结论在 2 条以上改动上得到验证才把 confidence 提到 medium,3 条以上且没有反例才 high;和已有经验矛盾时更新那条(带 id),不要新开一条。',
      '业务报告(访问量、转化率)一般晚 2 天,ABA 按周;单天波动不下结论,看 7 天。',
      '广告改动只提议(propose_ad_changes,编号来自 Miguelpet query_ads),不要在分析时直接改;店主确认后由执行任务用 claim_confirmed_ad_changes 领取再执行。',
      'weekly.due 为 true 时(上周的周报还没写),写完日报再写上周(周一到周日)的周报,用 save_weekly_report 存进网站;weekly.latest 是上一份周报的结论和「下周要做的事」可参照。',
    ],
  };
}

// ---------- 网站接口 ----------

export function createAgentRouter() {
  const router = express.Router();
  router.use((req, res, next) => (isPet ? next() : res.status(404).json({ error: '只有宠物版有 AI 日报' })));
  router.use(requireLogin);
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (error) { res.status(error.status ?? 400).json({ error: error.message }); }
  };
  router.get('/reports', handle(() => ({ schedule: SCHEDULE, calendar: runCalendar(), reports: reportList({ limit: 60 }) })));
  router.get('/reports/latest', handle(() => ({ report: getReport() })));
  router.get('/reports/:day', handle((req) => {
    if (!DAY_RE.test(req.params.day)) throw fail('日期格式不对');
    return { report: getReport(req.params.day) };
  }));
  router.get('/weekly', handle(() => ({ reports: weeklyList() })));
  router.get('/weekly/:weekStart', handle((req) => {
    if (!DAY_RE.test(req.params.weekStart)) throw fail('日期格式不对');
    return { report: getWeekly(req.params.weekStart) };
  }));
  router.get('/lessons', handle((req) => ({ lessons: listLessons({ status: ['active', 'retired', 'all'].includes(req.query.status) ? req.query.status : 'active', area: req.query.area }) })));
  router.post('/lessons/:id/status', requireRole('owner'), handle((req) => ({ lesson: setLessonStatus(req.params.id, req.body?.status, req.body?.reason) })));
  router.get('/changelog', requireRole('owner'), handle((req) => changeTimeline({ days: req.query.days })));
  router.get('/changelog/:id/events', requireRole('owner'), handle((req) => ({ events: changeEvents(req.params.id) })));
  return router;
}
