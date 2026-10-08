import { createHash } from 'node:crypto';
import { ASIN_COUNT_KEYS } from '../../../shared/abaAsin.js';

export const REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 亚马逊周从周日开始；只使用北京时间的日期来选择上一完整周。 */
export function reportWeeks(now = Date.now(), count = 4) {
  const local = new Date(now + 8 * 3600000);
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const end = today - (local.getUTCDay() + 1) * DAY;
  return Array.from({ length: count }, (_, i) => ({
    week_start: iso(end - (i * 7 + 6) * DAY), week_end: iso(end - i * 7 * DAY),
  }));
}
export function nextTuesday(now = Date.now()) {
  const local = new Date(now + 8 * 3600000);
  let due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4)
    + ((2 - local.getUTCDay() + 7) % 7) * DAY;
  if (due <= now) due += 7 * DAY;
  return due;
}
export function asinBatches(asins) {
  const batches = [];
  for (const asin of [...new Set(asins)]) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('清单 ASIN 格式不正确');
    let batch = batches.at(-1);
    if (!batch || [...batch, asin].join(' ').length > 200) batches.push(batch = []);
    batch.push(asin);
  }
  return batches;
}
function count(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('报告数量字段缺失或无效：' + name);
  return value;
}
export function parsePublicReport(payload, task, marketplaceId) {
  const spec = payload?.reportSpecification;
  const requested = JSON.parse(task.asins_json);
  const specAsins = String(spec?.reportOptions?.asin ?? '').split(/\s+/).filter(Boolean).sort();
  if (spec?.reportType !== REPORT_TYPE || spec?.reportOptions?.reportPeriod !== 'WEEK'
    || spec?.dataStartTime?.slice(0, 10) !== task.week_start
    || spec?.dataEndTime?.slice(0, 10) !== task.week_end
    || spec?.marketplaceIds?.length !== 1 || spec.marketplaceIds[0] !== marketplaceId
    || JSON.stringify(specAsins) !== JSON.stringify([...requested].sort())
    || !Array.isArray(payload.dataByAsin) || payload.dataByAsin.length > 100000)
    throw new Error('报告的国家、ASIN 或日期与同步任务不一致');
  const reports = new Map(requested.map((asin) => [asin, { asin, rows: [] }]));
  const seen = new Set();
  for (const entry of payload.dataByAsin) {
    const report = reports.get(entry.asin);
    const query = entry.searchQueryData?.searchQuery;
    if (!report || entry.startDate?.slice(0, 10) !== task.week_start
      || entry.endDate?.slice(0, 10) !== task.week_end || typeof query !== 'string' || !query.trim())
      throw new Error('报告明细的 ASIN、日期或搜索词无效');
    const key = entry.asin + '\0' + query;
    if (seen.has(key)) throw new Error('报告包含重复 ASIN / 搜索词');
    seen.add(key);
    const raw = [
      entry.searchQueryData.searchQueryVolume,
      entry.impressionData?.totalQueryImpressionCount,
      entry.clickData?.totalClickCount,
      entry.purchaseData?.totalPurchaseCount,
      entry.impressionData?.asinImpressionCount,
      entry.clickData?.asinClickCount,
      entry.purchaseData?.asinPurchaseCount,
    ];
    report.rows.push({ query, ...Object.fromEntries(ASIN_COUNT_KEYS.map((k, i) => [k, count(raw[i], k)])) });
  }
  const end = Date.parse(task.week_end);
  const yearStart = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
  const weekNumber = Math.floor((end - yearStart) / DAY / 7) + 1;
  return [...reports.values()].map((r) => ({
    ...r, marketplace: task.marketplace, brand: task.brand, week_start: task.week_start,
    week_end: task.week_end, week_number: weekNumber,
    content_hash: createHash('sha256').update(JSON.stringify(r.rows.toSorted((a, b) => a.query.localeCompare(b.query)))).digest('hex'),
  }));
}
/** 整个 API 批次原子提交；重试替换同 ASIN/周，绝不累计重复数量。 */
export function savePublicReports(db, { payload, task, marketplaceId }) {
  const reports = parsePublicReport(payload, task, marketplaceId);
  const put = db.prepare('INSERT INTO aba_public_reports (marketplace, brand, asin, week_start, week_end, week_number, source_file, content_hash, row_count) VALUES (@marketplace, @brand, @asin, @week_start, @week_end, @week_number, @source_file, @content_hash, @row_count) ON CONFLICT(marketplace, asin, week_end) DO UPDATE SET brand=excluded.brand, week_start=excluded.week_start, week_number=excluded.week_number, source_file=excluded.source_file, content_hash=excluded.content_hash, row_count=excluded.row_count, updated_at=datetime(\'now\') RETURNING id');
  const clear = db.prepare('DELETE FROM aba_public_queries WHERE report_id=?');
  const insert = db.prepare('INSERT INTO aba_public_queries (report_id, query, ' + ASIN_COUNT_KEYS.join(',') + ') VALUES (@report_id, @query, ' + ASIN_COUNT_KEYS.map((k) => '@' + k).join(',') + ')');
  return db.transaction(() => {
    let rows = 0;
    for (const report of reports) {
      const { id } = put.get({ ...report, source_file: 'SP-API:' + task.report_id, row_count: report.rows.length });
      clear.run(id);
      for (const row of report.rows) insert.run({ ...row, report_id: id });
      rows += report.rows.length;
    }
    return { rows, reports: reports.length };
  })();
}
