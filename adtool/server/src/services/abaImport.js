// ABA 品牌报告导入:解析 CSV、算内容指纹、在一个事务里写库。worker 线程里执行。
import { createHash } from 'node:crypto';
import { writeAudit } from '../dbConnect.js';
import { parseAbaReport } from '../../../shared/aba.js';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function importAbaReports(db, userId, market, files) {
  let reports;
  try {
    const seen = new Set();
    reports = files.map((file) => {
      try {
        const report = parseAbaReport(file?.text, file?.name, market);
        const key = `${report.brand.toLowerCase()}|${report.week_end}`;
        if (seen.has(key)) throw new Error('本次选择中包含同品牌同一周的两份报告，请只保留一份');
        seen.add(key);
        return { ...report, content_hash: createHash('sha256').update('brand-v2\n' + file.text).digest('hex') };
      } catch (err) { throw new Error(`${String(file?.name ?? '未命名文件').slice(0, 255)}：${err.message}`); }
    });
  } catch (err) { throw badRequest(err.message); }
  const findReport = db.prepare('SELECT id, content_hash FROM aba_reports WHERE user_id = ? AND marketplace = ? AND brand = ? AND week_end = ?');
  const upsertReport = db.prepare(`INSERT INTO aba_reports (user_id, marketplace, brand, week_start, week_end, week_number, source_file, content_hash, row_count)
    VALUES (@user_id, @marketplace, @brand, @week_start, @week_end, @week_number, @source_file, @content_hash, @row_count)
    ON CONFLICT(user_id, marketplace, brand, week_end) DO UPDATE SET
    week_start=excluded.week_start, week_number=excluded.week_number, source_file=excluded.source_file,
    content_hash=excluded.content_hash, row_count=excluded.row_count, updated_at=datetime('now') RETURNING id`);
  const clearQueries = db.prepare('DELETE FROM aba_queries WHERE report_id=?');
  const insert = db.prepare(`INSERT INTO aba_queries (report_id, query, query_volume, impressions, clicks, click_rate, click_price, purchases, brand_impressions, brand_clicks, brand_purchases)
    VALUES (@report_id, @query, @query_volume, @impressions, @clicks, @click_rate, @click_price, @purchases, @brand_impressions, @brand_clicks, @brand_purchases)`);
  const result = db.transaction(() => {
    const results = [];
    for (const report of reports) {
      const previous = findReport.get(userId, market, report.brand, report.week_end);
      if (previous?.content_hash === report.content_hash) {
        results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: 'unchanged', count: report.rows.length });
        continue;
      }
      const { id } = upsertReport.get({ ...report, user_id: userId, row_count: report.rows.length });
      clearQueries.run(id);
      for (const row of report.rows) insert.run({ ...row, report_id: id });
      results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: previous ? 'updated' : 'added', count: report.rows.length });
    }
    writeAudit(db, userId, market, 'import', 'aba_reports', null, { reports: results });
    return results;
  })();
  return { reports: result };
}
