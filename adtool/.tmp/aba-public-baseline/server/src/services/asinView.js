// ABA ASIN 周报的查询、匹配、聚合、排序。只依赖传进来的 db,主线程和 worker 线程都能调用。
import { regionOf } from '../libs.js';
import { ABA_PAGE_SIZES, abaMatcher } from '../../../shared/aba.js';
import { ASIN_COLUMNS, asinModelOptions, aggregateAsinView } from '../../../shared/abaAsin.js';

/** 算出和页码无关的完整结果(排好序的全部行 + 筛选项);翻页只是在它上面切片 */
export function buildAsinView(db, userId, market, query) {
  const reports = db.prepare(`SELECT r.id, r.asin, r.week_start, r.week_end, r.week_number, r.updated_at, r.row_count
    FROM aba_asin_reports r WHERE r.user_id=? AND r.marketplace=? ORDER BY r.week_end DESC, r.asin`).all(userId, market);
  const skuItems = db.prepare(`SELECT id, asin, sku, brand, model, set_group AS setGroup FROM sku_items
    WHERE user_id=? AND country=? AND asin IS NOT NULL ORDER BY sku`).all(userId, market);
  const years = [...new Set(reports.map((r) => r.week_end.slice(0, 4)))];
  const year = query.year === undefined ? years[0] ?? '' : String(query.year);
  const inYear = reports.filter((r) => !year || r.week_end.startsWith(year + '-'));
  const months = [...new Set(inYear.map((r) => r.week_end.slice(5, 7)))].sort();
  const month = String(query.month ?? '');
  const dated = inYear.filter((r) => !month || r.week_end.slice(5, 7) === month);
  const modelOptions = asinModelOptions(skuItems, dated.map((r) => r.asin));
  const model = String(query.model ?? '');
  const selectedModel = modelOptions.find((m) => m.key === model) ?? null;
  const modelReports = dated.filter((r) => !model || selectedModel?.asins.includes(r.asin));
  const modelSkus = skuItems.filter((s) => modelReports.some((r) => r.asin === s.asin) && (!model || selectedModel?.skuIds.includes(s.id)));
  const brandKey = (s) => String(s.brand ?? '').trim().toLowerCase();
  const brands = [...new Map(modelSkus.map((s) => [brandKey(s) || '__unassigned__', { key: brandKey(s) || '__unassigned__', label: String(s.brand ?? '').trim() || '未填写品牌' }])).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  const brand = String(query.brand ?? '');
  const filteredSkus = modelSkus.filter((s) => !brand || (brandKey(s) || '__unassigned__') === brand);
  const brandAsins = new Set(filteredSkus.map((s) => s.asin));
  const brandReports = modelReports.filter((r) => !brand || brandAsins.has(r.asin));
  const asin = String(query.asin ?? '').toUpperCase();
  const skuId = String(query.skuId ?? '');
  const skuAsin = skuId ? filteredSkus.find((s) => String(s.id) === skuId)?.asin : null;
  const available = brandReports.filter((r) => (!asin || r.asin === asin) && (!skuId || r.asin === skuAsin));
  const weeks = [...new Map(available.map((r) => [r.week_end, { week_start: r.week_start, week_end: r.week_end, week_number: r.week_number }])).values()];
  const requestedWeeks = query.weeks === undefined ? weeks.slice(0, 1).map((w) => w.week_end) : String(query.weeks).split(',');
  const selectedWeeks = weeks.filter((w) => requestedWeeks.includes(w.week_end)).map((w) => w.week_end);
  const selected = new Map(available.filter((r) => selectedWeeks.includes(r.week_end)).map((r) => [r.id, r]));
  const dRows = db.prepare("SELECT brand, term, series, printer FROM lib_items WHERE lib='D' AND scope=?").all(regionOf(market).id);
  const wordType = ['printer', 'cartridge'].includes(query.wordType) ? query.wordType : 'all';
  const match = abaMatcher(String(query.q ?? '').slice(0, 1000), dRows, true, wordType === 'printer' ? 'printer' : 'all');
  const rows = [];
  if (selected.size) {
    const raw = db.prepare(`SELECT q.* FROM aba_asin_queries q JOIN aba_asin_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace=? AND r.week_end>=? AND r.week_end<=?`)
      .iterate(userId, market, selectedWeeks.at(-1), selectedWeeks[0]);
    for (const row of raw) {
      const report = selected.get(row.report_id);
      if (!report) continue;
      const matching = match(row.query);
      if (!matching.matches) continue;
      if (wordType === 'printer' && !matching.hasPrinter) continue;
      if (wordType === 'cartridge' && matching.hasPrinter) continue;
      if (query.group && matching.group.key !== query.group) continue;
      rows.push({ ...row, asin: report.asin, week_start: report.week_start, week_end: report.week_end,
        week_number: report.week_number, recognition: matching.group.kind === 'other' ? '墨盒 KW 词' : matching.group.label,
        candidates: matching.candidates, group: matching.group });
    }
  }
  const average = query.aggregation === 'average' && selectedWeeks.length > 1;
  const view = query.view === 'printers' ? 'printers' : 'queries';
  const merged = average || view === 'printers' || query.merge !== '0';
  const exportAll = query.export === '1' && view === 'printers';
  const items = aggregateAsinView(rows, { series: !!model, view, mergeWeeks: merged, average, modelLabel: selectedModel?.label, includeQueries: exportAll });
  const sort = ASIN_COLUMNS.some((c) => c.key === query.sort) || (view === 'printers' && query.sort === 'query_count') ? query.sort : 'market_impressions';
  const direction = query.direction === 'asc' ? 'asc' : 'desc';
  items.sort((a, b) => {
    if (a[sort] === null && b[sort] !== null) return 1;
    if (b[sort] === null && a[sort] !== null) return -1;
    const difference = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh-CN') : (a[sort] ?? 0) - (b[sort] ?? 0);
    return (direction === 'asc' ? difference : -difference) || a.key.localeCompare(b.key);
  });
  return { reports, years, year, months, month, modelOptions, selectedModel, brands, brand, seriesMerged: !!model,
    unlinkedAsins: [...new Set(dated.filter((r) => !skuItems.some((s) => s.asin === r.asin && String(s.model ?? '').trim())).map((r) => r.asin))],
    asins: [...new Set(brandReports.map((r) => r.asin))], skuItems: filteredSkus, weeks, selectedWeeks,
    selectedReportCount: selected.size, hasModelLibrary: !!dRows.length, total: items.length, recordCount: rows.length,
    items, exportAll, sort, direction, merged, view, aggregation: average ? 'average' : 'sum' };
}

/** 从完整结果里切出请求的那一页;打印机视图导出时整份返回 */
export function asinPage(full, query) {
  const { exportAll, ...rest } = full;
  const pageSize = ABA_PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(full.items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(query.page) || 1)));
  return { ...rest, items: exportAll ? full.items : full.items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, pageCount };
}
