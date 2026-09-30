// ABA ASIN 周报导入:解析、算内容指纹、在一个事务里写库。worker 线程里执行。
import { createHash } from 'node:crypto';
import { writeAudit } from '../dbConnect.js';
import { ASIN_COUNT_KEYS, parseAsinUpload } from '../../../shared/abaAsin.js';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function importAsinReports(db, userId, market, files) {
  if (Buffer.byteLength(JSON.stringify(files)) > 30 * 1024 * 1024) throw badRequest('每批解析数据合计不能超过 30 MB');
  let reports;
  try {
    const seen = new Set();
    reports = files.flatMap((f) => {
      try {
        return parseAsinUpload(f, market).map((report) => {
        const key = `${report.asin}|${report.week_end}`;
        if (seen.has(key)) throw new Error('同一批次同 ASIN 同周只能选择一份报告');
        seen.add(key);
        return { ...report, content_hash: createHash('sha256').update(JSON.stringify([report.asin, report.week_start, report.week_end, report.week_number, [...report.rows].sort((a, b) => a.query.localeCompare(b.query))])).digest('hex') };
        });
      } catch (e) { throw new Error(`${String(f?.name ?? '未命名文件').slice(0, 255)}：${e.message}`); }
    });
    if (reports.length > 500) throw new Error('每批最多导入 500 份 ASIN 周报');
  } catch (e) { throw badRequest(e.message); }
  const find = db.prepare('SELECT id, content_hash FROM aba_asin_reports WHERE user_id=? AND marketplace=? AND asin=? AND week_end=?');
  const upsertReport = db.prepare(`INSERT INTO aba_asin_reports (user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash, row_count)
    VALUES (@user_id, @marketplace, @asin, @week_start, @week_end, @week_number, @source_file, @content_hash, @row_count)
    ON CONFLICT(user_id, marketplace, asin, week_end) DO UPDATE SET
    week_start=excluded.week_start, week_number=excluded.week_number, source_file=excluded.source_file,
    content_hash=excluded.content_hash, row_count=excluded.row_count, updated_at=datetime('now') RETURNING id`);
  const clearQueries = db.prepare('DELETE FROM aba_asin_queries WHERE report_id=?');
  const insert = db.prepare(`INSERT INTO aba_asin_queries (report_id, query, ${ASIN_COUNT_KEYS.join(',')})
    VALUES (@report_id, @query, ${ASIN_COUNT_KEYS.map((k) => `@${k}`).join(',')})`);
  const result = db.transaction(() => {
    const result = [];
    for (const report of reports) {
      const previous = find.get(userId, market, report.asin, report.week_end);
      if (previous?.content_hash !== report.content_hash) {
        const { id } = upsertReport.get({ ...report, user_id: userId, row_count: report.rows.length });
        clearQueries.run(id);
        for (const row of report.rows) insert.run({ ...row, report_id: id });
      }
      result.push({ asin: report.asin, week_end: report.week_end, count: report.rows.length,
        status: previous?.content_hash === report.content_hash ? 'unchanged' : previous ? 'updated' : 'added' });
    }
    writeAudit(db, userId, market, 'import', 'aba_asin_reports', null, { reports: result });
    return result;
  })();
  return { reports: result };
}
