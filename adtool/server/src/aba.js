import express from 'express';
import { createHash } from 'node:crypto';
import { db, audit } from './db.js';
import { requireLogin, canRead } from './auth.js';
import { MARKETPLACES } from './libs.js';
import { parseAbaReport } from '../../shared/aba.js';
import { runTask, dataGeneration } from './workers/pool.js';
import { viewKey } from './workers/tasks.js';
import { abaAsinRouter } from './abaAsin.js';

export const abaRouter = express.Router();
abaRouter.use(requireLogin);
abaRouter.use((req, res, next) => {
  const market = String(req.method === 'GET' ? req.query.marketplace ?? '' : req.body?.marketplace ?? '').toUpperCase();
  if (!MARKETPLACES.includes(market)) return res.status(400).json({ error: '请选择有效站点' });
  if (!canRead(req.session.user, market)) return res.status(403).json({ error: '无权访问这个站点' });
  req.abaMarket = market;
  next();
});

abaRouter.use('/asin', abaAsinRouter);

abaRouter.post('/import', (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) return res.status(400).json({ error: '每次请选择 1–10 份 CSV 报告' });
  if (files.reduce((sum, file) => sum + (typeof file?.text === 'string' ? Buffer.byteLength(file.text) : 0), 0) > 30 * 1024 * 1024) return res.status(400).json({ error: '每批文件合计不能超过 30 MB' });
  let reports;
  try {
    const seen = new Set();
    reports = files.map((file) => {
      try {
        const report = parseAbaReport(file?.text, file?.name, req.abaMarket);
        const key = `${report.brand.toLowerCase()}|${report.week_end}`;
        if (seen.has(key)) throw new Error('本次选择中包含同品牌同一周的两份报告，请只保留一份');
        seen.add(key);
        return { ...report, content_hash: createHash('sha256').update('brand-v2\n' + file.text).digest('hex') };
      } catch (err) { throw new Error(`${String(file?.name ?? '未命名文件').slice(0, 255)}：${err.message}`); }
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }
  const userId = req.session.user.id;
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
      const previous = findReport.get(userId, req.abaMarket, report.brand, report.week_end);
      if (previous?.content_hash === report.content_hash) {
        results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: 'unchanged', count: report.rows.length });
        continue;
      }
      const { id } = upsertReport.get({ ...report, user_id: userId, row_count: report.rows.length });
      clearQueries.run(id);
      for (const row of report.rows) insert.run({ ...row, report_id: id });
      results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: previous ? 'updated' : 'added', count: report.rows.length });
    }
    audit(userId, req.abaMarket, 'import', 'aba_reports', null, { reports: results });
    return results;
  })();
  res.json({ reports: result });
});

abaRouter.get('/', async (req, res) => {
  // 匹配、聚合、排序都在 worker 线程里做,主线程只转发结果
  const payload = { userId: req.session.user.id, market: req.abaMarket, query: { ...req.query }, generation: dataGeneration() };
  try {
    res.type('json').send(await runTask('abaView', payload, { key: viewKey('aba', payload) }));
  } catch (error) {
    if (!error.status) throw error;
    res.status(error.status).json({ error: error.message });
  }
});
