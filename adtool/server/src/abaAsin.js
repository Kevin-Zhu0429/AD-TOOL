import express from 'express';
import { createHash } from 'node:crypto';
import { db, audit } from './db.js';
import { regionOf } from './libs.js';
import { ABA_PAGE_SIZES, abaMatcher } from '../../shared/aba.js';
import { ASIN_COLUMNS, ASIN_COUNT_KEYS, parseAsinUpload, asinModelOptions, aggregateAsinView } from '../../shared/abaAsin.js';

// Mounted after the ABA account/market middleware.
export const abaAsinRouter = express.Router();
abaAsinRouter.post('/import', (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length || files.length > 10) return res.status(400).json({ error: '每次请选择 1–10 份 CSV / XLSX 文件' });
  if (Buffer.byteLength(JSON.stringify(files)) > 30 * 1024 * 1024) return res.status(400).json({ error: '每批解析数据合计不能超过 30 MB' });
  let reports;
  try {
    const seen = new Set();
    reports = files.flatMap((f) => {
      try {
        return parseAsinUpload(f, req.abaMarket).map((report) => {
        const key = `${report.asin}|${report.week_end}`;
        if (seen.has(key)) throw new Error('同一批次同 ASIN 同周只能选择一份报告');
        seen.add(key);
        return { ...report, content_hash: createHash('sha256').update(JSON.stringify([report.asin, report.week_start, report.week_end, report.week_number, [...report.rows].sort((a, b) => a.query.localeCompare(b.query))])).digest('hex') };
        });
      } catch (e) { throw new Error(`${String(f?.name ?? '未命名文件').slice(0, 255)}：${e.message}`); }
    });
    if (reports.length > 500) throw new Error('每批最多导入 500 份 ASIN 周报');
  } catch (e) { return res.status(400).json({ error: e.message }); }
  const userId = req.session.user.id;
  const result = db.transaction(() => {
    const result = [];
    const insert = db.prepare(`INSERT INTO aba_asin_queries (report_id, query, ${ASIN_COUNT_KEYS.join(',')})
      VALUES (@report_id, @query, ${ASIN_COUNT_KEYS.map((k) => `@${k}`).join(',')})`);
    for (const report of reports) {
      const find = db.prepare('SELECT id, content_hash FROM aba_asin_reports WHERE user_id=? AND marketplace=? AND asin=? AND week_end=?');
      const args = [userId, req.abaMarket, report.asin, report.week_end];
      const previous = find.get(...args);
      if (previous?.content_hash !== report.content_hash) {
        db.prepare(`INSERT INTO aba_asin_reports (user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash)
          VALUES (@user_id, @marketplace, @asin, @week_start, @week_end, @week_number, @source_file, @content_hash)
          ON CONFLICT(user_id, marketplace, asin, week_end) DO UPDATE SET
          week_start=excluded.week_start, week_number=excluded.week_number, source_file=excluded.source_file,
          content_hash=excluded.content_hash, updated_at=datetime('now')`).run({ ...report, user_id: userId });
        const { id } = find.get(...args);
        db.prepare('DELETE FROM aba_asin_queries WHERE report_id=?').run(id);
        for (const row of report.rows) insert.run({ ...row, report_id: id });
      }
      result.push({ asin: report.asin, week_end: report.week_end, count: report.rows.length,
        status: previous?.content_hash === report.content_hash ? 'unchanged' : previous ? 'updated' : 'added' });
    }
    audit(userId, req.abaMarket, 'import', 'aba_asin_reports', null, { reports: result });
    return result;
  })();
  res.json({ reports: result });
});

abaAsinRouter.get('/', (req, res) => {
  const userId = req.session.user.id;
  const reports = db.prepare(`SELECT r.id, r.asin, r.week_start, r.week_end, r.week_number, r.updated_at,
    (SELECT count(*) FROM aba_asin_queries q WHERE q.report_id=r.id) AS row_count
    FROM aba_asin_reports r WHERE r.user_id=? AND r.marketplace=? ORDER BY r.week_end DESC, r.asin`).all(userId, req.abaMarket);
  const skuItems = db.prepare(`SELECT id, asin, sku, brand, model, set_group AS setGroup FROM sku_items
    WHERE user_id=? AND country=? AND asin IS NOT NULL ORDER BY sku`).all(userId, req.abaMarket);
  const years = [...new Set(reports.map((r) => r.week_end.slice(0, 4)))];
  const year = req.query.year === undefined ? years[0] ?? '' : String(req.query.year);
  const inYear = reports.filter((r) => !year || r.week_end.startsWith(year + '-'));
  const months = [...new Set(inYear.map((r) => r.week_end.slice(5, 7)))].sort();
  const month = String(req.query.month ?? '');
  const dated = inYear.filter((r) => !month || r.week_end.slice(5, 7) === month);
  const modelOptions = asinModelOptions(skuItems, dated.map((r) => r.asin));
  const model = String(req.query.model ?? '');
  const selectedModel = modelOptions.find((m) => m.key === model) ?? null;
  const modelReports = dated.filter((r) => !model || selectedModel?.asins.includes(r.asin));
  const modelSkus = skuItems.filter((s) => modelReports.some((r) => r.asin === s.asin) && (!model || selectedModel?.skuIds.includes(s.id)));
  const brandKey = (s) => String(s.brand ?? '').trim().toLowerCase();
  const brands = [...new Map(modelSkus.map((s) => [brandKey(s) || '__unassigned__', { key: brandKey(s) || '__unassigned__', label: String(s.brand ?? '').trim() || '未填写品牌' }])).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  const brand = String(req.query.brand ?? '');
  const filteredSkus = modelSkus.filter((s) => !brand || (brandKey(s) || '__unassigned__') === brand);
  const brandAsins = new Set(filteredSkus.map((s) => s.asin));
  const brandReports = modelReports.filter((r) => !brand || brandAsins.has(r.asin));
  const asin = String(req.query.asin ?? '').toUpperCase();
  const skuId = String(req.query.skuId ?? '');
  const skuAsin = skuId ? filteredSkus.find((s) => String(s.id) === skuId)?.asin : null;
  const available = brandReports.filter((r) => (!asin || r.asin === asin) && (!skuId || r.asin === skuAsin));
  const weeks = [...new Map(available.map((r) => [r.week_end, { week_start: r.week_start, week_end: r.week_end, week_number: r.week_number }])).values()];
  const requestedWeeks = req.query.weeks === undefined ? weeks.slice(0, 1).map((w) => w.week_end) : String(req.query.weeks).split(',');
  const selectedWeeks = weeks.filter((w) => requestedWeeks.includes(w.week_end)).map((w) => w.week_end);
  const selected = new Map(available.filter((r) => selectedWeeks.includes(r.week_end)).map((r) => [r.id, r]));
  const dRows = db.prepare("SELECT brand, term, series, printer FROM lib_items WHERE lib='D' AND scope=?").all(regionOf(req.abaMarket).id);
  const wordType = ['printer', 'cartridge'].includes(req.query.wordType) ? req.query.wordType : 'all';
  const match = abaMatcher(String(req.query.q ?? '').slice(0, 1000), dRows, true, wordType === 'printer' ? 'printer' : 'all');
  const rows = [];
  if (selected.size) {
    const raw = db.prepare(`SELECT q.* FROM aba_asin_queries q JOIN aba_asin_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace=? AND r.week_end>=? AND r.week_end<=?`)
      .iterate(userId, req.abaMarket, selectedWeeks.at(-1), selectedWeeks[0]);
    for (const row of raw) {
      const report = selected.get(row.report_id);
      if (!report) continue;
      const matching = match(row.query);
      if (!matching.matches) continue;
      if (wordType === 'printer' && !matching.hasPrinter) continue;
      if (wordType === 'cartridge' && matching.hasPrinter) continue;
      if (req.query.group && matching.group.key !== req.query.group) continue;
      rows.push({ ...row, asin: report.asin, week_start: report.week_start, week_end: report.week_end,
        week_number: report.week_number, recognition: matching.group.kind === 'other' ? '墨盒 KW 词' : matching.group.label,
        candidates: matching.candidates, group: matching.group });
    }
  }
  const average = req.query.aggregation === 'average' && selectedWeeks.length > 1;
  const view = req.query.view === 'printers' ? 'printers' : 'queries';
  const merged = average || view === 'printers' || req.query.merge !== '0';
  const exportAll = req.query.export === '1' && view === 'printers';
  const items = aggregateAsinView(rows, { series: !!model, view, mergeWeeks: merged, average, modelLabel: selectedModel?.label, includeQueries: exportAll });
  const sort = ASIN_COLUMNS.some((c) => c.key === req.query.sort) || (view === 'printers' && req.query.sort === 'query_count') ? req.query.sort : 'market_impressions';
  const direction = req.query.direction === 'asc' ? 'asc' : 'desc';
  items.sort((a, b) => {
    if (a[sort] === null && b[sort] !== null) return 1;
    if (b[sort] === null && a[sort] !== null) return -1;
    const difference = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh-CN') : (a[sort] ?? 0) - (b[sort] ?? 0);
    return (direction === 'asc' ? difference : -difference) || a.key.localeCompare(b.key);
  });
  const pageSize = ABA_PAGE_SIZES.includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(req.query.page) || 1)));
  res.json({ reports, years, year, months, month, modelOptions, selectedModel, brands, brand, seriesMerged: !!model,
    unlinkedAsins: [...new Set(dated.filter((r) => !skuItems.some((s) => s.asin === r.asin && String(s.model ?? '').trim())).map((r) => r.asin))],
    asins: [...new Set(brandReports.map((r) => r.asin))], skuItems: filteredSkus, weeks, selectedWeeks,
    selectedReportCount: selected.size, hasModelLibrary: !!dRows.length, total: items.length, recordCount: rows.length,
    items: exportAll ? items : items.slice((page - 1) * pageSize, page * pageSize), sort, direction, page, pageSize, pageCount, merged, view, aggregation: average ? 'average' : 'sum' });
});
