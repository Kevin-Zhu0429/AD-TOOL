import express from 'express';
import { createHash } from 'node:crypto';
import { db, audit } from './db.js';
import { requireLogin, canRead } from './auth.js';
import { MARKETPLACES, regionOf } from './libs.js';
import { ABA_COLUMNS, ABA_PAGE_SIZES, abaMatcher, aggregateAbaRows, parseAbaReport } from '../../shared/aba.js';

export const abaRouter = express.Router();
abaRouter.use(requireLogin);
abaRouter.use((req, res, next) => {
  const market = String(req.method === 'GET' ? req.query.marketplace ?? '' : req.body?.marketplace ?? '').toUpperCase();
  if (!MARKETPLACES.includes(market)) return res.status(400).json({ error: '请选择有效站点' });
  if (!canRead(req.session.user, market)) return res.status(403).json({ error: '无权访问这个站点' });
  req.abaMarket = market;
  next();
});

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
        return { ...report, content_hash: createHash('sha256').update(file.text).digest('hex') };
      } catch (err) { throw new Error(`${String(file?.name ?? '未命名文件').slice(0, 255)}：${err.message}`); }
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }
  const userId = req.session.user.id;
  const result = db.transaction(() => {
    const results = [];
    for (const report of reports) {
      const previous = db.prepare('SELECT id, content_hash FROM aba_reports WHERE user_id = ? AND marketplace = ? AND brand = ? AND week_end = ?')
        .get(userId, req.abaMarket, report.brand, report.week_end);
      if (previous?.content_hash === report.content_hash) {
        results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: 'unchanged', count: report.rows.length });
        continue;
      }
      db.prepare(`INSERT INTO aba_reports (user_id, marketplace, brand, week_start, week_end, week_number, source_file, content_hash)
        VALUES (@user_id, @marketplace, @brand, @week_start, @week_end, @week_number, @source_file, @content_hash)
        ON CONFLICT(user_id, marketplace, brand, week_end) DO UPDATE SET
        week_start=excluded.week_start, week_number=excluded.week_number, source_file=excluded.source_file,
        content_hash=excluded.content_hash, updated_at=datetime('now')`).run({ ...report, user_id: userId });
      const { id } = db.prepare('SELECT id FROM aba_reports WHERE user_id=? AND marketplace=? AND brand=? AND week_end=?')
        .get(userId, req.abaMarket, report.brand, report.week_end);
      db.prepare('DELETE FROM aba_queries WHERE report_id=?').run(id);
      const insert = db.prepare(`INSERT INTO aba_queries (report_id, query, query_volume, impressions, clicks, click_rate, click_price, purchases)
        VALUES (@report_id, @query, @query_volume, @impressions, @clicks, @click_rate, @click_price, @purchases)`);
      for (const row of report.rows) insert.run({ ...row, report_id: id });
      results.push({ source_file: report.source_file, brand: report.brand, week_end: report.week_end, status: previous ? 'updated' : 'added', count: report.rows.length });
    }
    audit(userId, req.abaMarket, 'import', 'aba_reports', null, { reports: results });
    return results;
  })();
  res.json({ reports: result });
});

abaRouter.get('/', (req, res) => {
  const userId = req.session.user.id;
  // No owner/scope override: every query starts with the current account.
  const reports = db.prepare(`SELECT r.id, r.brand, r.week_start, r.week_end, r.week_number, r.source_file, r.updated_at,
    (SELECT count(*) FROM aba_queries q WHERE q.report_id=r.id) AS row_count
    FROM aba_reports r WHERE r.user_id=? AND r.marketplace=? ORDER BY r.week_end DESC, r.brand`).all(userId, req.abaMarket);
  const brands = [...new Set(reports.map((r) => r.brand))];
  const requestedBrand = String(req.query.brand ?? '');
  const brand = brands.find((b) => b.toLowerCase() === requestedBrand.toLowerCase()) ?? (requestedBrand ? '' : brands[0] ?? '');
  const available = reports.filter((r) => r.brand === brand);
  const weeks = req.query.weeks === undefined ? available.slice(0, 1).map((r) => r.week_end) : String(req.query.weeks).split(',');
  const selected = available.filter((r) => weeks.includes(r.week_end));
  const q = String(req.query.q ?? '').trim().slice(0, 1000);
  const dRows = db.prepare("SELECT brand, term, series, printer FROM lib_items WHERE lib='D' AND scope=?").all(regionOf(req.abaMarket).id);
  const view = req.query.view === 'printers' ? 'printers' : 'queries';
  const wordType = ['printer', 'cartridge'].includes(req.query.wordType) ? req.query.wordType : 'all';
  const merged = req.query.merge !== '0' && selected.length > 1;
  const match = abaMatcher(q, dRows, req.query.models !== '0', wordType);
  const selectedIds = new Set(selected.map((r) => r.id));
  const selectedById = new Map(selected.map((r) => [r.id, r]));
  // Iterate on the server and return only one page; never send the account's entire history to the browser.
  const rows = [];
  if (selectedIds.size) {
    const raw = db.prepare(`SELECT q.* FROM aba_queries q JOIN aba_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace=? AND r.brand=? AND r.week_end>=? AND r.week_end<=?`)
      .iterate(userId, req.abaMarket, brand, selected.at(-1).week_end, selected[0].week_end);
    for (const row of raw) {
      if (!selectedIds.has(row.report_id)) continue;
      const matching = match(row.query);
      if (!matching.matches) continue;
      if (req.query.group && matching.group.key !== req.query.group) continue;
      const report = selectedById.get(row.report_id);
      rows.push({ ...row, week_start: report.week_start, week_end: report.week_end, week_number: report.week_number,
        linked: matching.linked, candidates: matching.candidates, group: matching.group });
    }
  }
  const items = view === 'printers' ? aggregateAbaRows(rows, 'printer') : merged ? aggregateAbaRows(rows) : rows;
  const priceSortable = items.every((row) => (row.record_count ?? 1) === 1);
  const allowedSort = [...ABA_COLUMNS.map((c) => c.key), ...(view === 'printers' ? ['query_count'] : [])];
  const sort = allowedSort.includes(req.query.sort) && (req.query.sort !== 'click_price' || priceSortable) ? req.query.sort : 'query_volume';
  const direction = req.query.direction === 'asc' ? 'asc' : 'desc';
  items.sort((a, b) => {
    if (a[sort] === null && b[sort] !== null) return 1;
    if (b[sort] === null && a[sort] !== null) return -1;
    const comparison = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh-CN') : (a[sort] ?? 0) - (b[sort] ?? 0);
    return (direction === 'asc' ? comparison : -comparison) || b.week_end.localeCompare(a.week_end) || a.query.localeCompare(b.query);
  });
  const pageSize = ABA_PAGE_SIZES.includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(req.query.page) || 1)));
  const trend = selected.toReversed().map((r) => ({ week_start: r.week_start, week_end: r.week_end, week_number: r.week_number, query_volume: 0, impressions: 0, clicks: 0, purchases: 0, count: 0 }));
  const byWeek = new Map(trend.map((r) => [r.week_end, r]));
  for (const row of rows) {
    const week = byWeek.get(row.week_end);
    for (const key of ['query_volume', 'impressions', 'clicks', 'purchases']) week[key] += row[key];
    week.count++;
  }
  for (const week of trend) week.click_rate = week.query_volume ? week.clicks / week.query_volume * 100 : null;
  res.json({ reports, brands, brand, selectedWeeks: selected.map((r) => r.week_end), items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length, recordCount: rows.length, queryCount: new Set(rows.map((r) => r.query)).size,
    linkedCount: items.filter((r) => r.linked).length, page, pageSize, pageCount, sort, direction, trend,
    view, wordType, merged, priceSortable, hasModelLibrary: !!dRows.length });
});
