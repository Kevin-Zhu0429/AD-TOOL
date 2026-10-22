import { abaSkuStatus } from './abaSkuLibrary.js';
// ABA ASIN 周报的查询、匹配、聚合、排序。只依赖传进来的 db,主线程和 worker 线程都能调用。
import { regionOf } from '../libs.js';
import { ABA_PAGE_SIZES, abaMatcher } from '../../../shared/aba.js';
import { ASIN_COLUMNS, asinModelOptions, aggregateAsinView, asinQueryAlignment } from '../../../shared/abaAsin.js';
import { abaCoreMatcher } from '../../../shared/abaCore.js';

/** 算出和页码无关的完整结果(排好序的全部行 + 筛选项);翻页只是在它上面切片 */
export function buildAsinView(db, userId, market, query, scope = 'private') {
  const shared = scope === 'public';
  const reports = shared
    ? db.prepare('SELECT id, asin, brand, week_start, week_end, week_number, updated_at, row_count FROM aba_public_reports WHERE marketplace=? ORDER BY week_end DESC, asin').all(market)
    : db.prepare(`SELECT r.id, r.asin, r.week_start, r.week_end, r.week_number, r.updated_at, r.row_count
    FROM aba_asin_reports r WHERE r.user_id=? AND r.marketplace=? ORDER BY r.week_end DESC, r.asin`).all(userId, market);
  const library = abaSkuStatus(db);
  const useReportBrand = shared && !library.enabled;
  const skuItems = library.enabled
    ? db.prepare("SELECT 'aba:' || s.id AS id, s.asin, s.sku, s.brand, s.model, s.set_group AS setGroup FROM aba_sku_items s WHERE s.country=? AND EXISTS ("
      + (shared ? 'SELECT 1 FROM aba_public_reports r WHERE r.marketplace=? AND r.asin=s.asin AND lower(trim(r.brand))=s.brand_key'
        : 'SELECT 1 FROM aba_asin_reports r WHERE r.user_id=? AND r.marketplace=? AND r.asin=s.asin')
      + ') ORDER BY s.sku').all(...(shared ? [market, market] : [market, userId, market]))
    : shared
    ? db.prepare('SELECT MIN(id) AS id, asin, sku, brand, model, set_group AS setGroup FROM sku_items WHERE country=? AND asin IS NOT NULL AND asin IN (SELECT asin FROM aba_public_reports WHERE marketplace=?) GROUP BY asin, sku, brand, model, set_group ORDER BY sku').all(market, market)
    : db.prepare(`SELECT id, asin, sku, brand, model, set_group AS setGroup FROM sku_items
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
  const brands = [...new Map((useReportBrand ? modelReports : modelSkus).map((s) => [brandKey(s) || '__unassigned__', { key: brandKey(s) || '__unassigned__', label: String(s.brand ?? '').trim() || '未填写品牌' }])).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  const brand = String(query.brand ?? '');
  const brandAsins = new Set(useReportBrand ? modelReports.filter((r) => !brand || brandKey(r) === brand).map((r) => r.asin)
    : modelSkus.filter((s) => !brand || (brandKey(s) || '__unassigned__') === brand).map((s) => s.asin));
  const filteredSkus = modelSkus.filter((s) => !brand || (useReportBrand ? brandAsins.has(s.asin) : (brandKey(s) || '__unassigned__') === brand));
  const brandReports = modelReports.filter((r) => !brand || (brandAsins.has(r.asin)
    && (!shared || !library.enabled || brandKey(r) === brand)));
  const asin = String(query.asin ?? '').toUpperCase();
  const skuId = String(query.skuId ?? '');
  const skuAsin = skuId ? filteredSkus.find((s) => String(s.id) === skuId)?.asin : null;
  const available = brandReports.filter((r) => (!asin || r.asin === asin) && (!skuId || r.asin === skuAsin));
  const weeks = [...new Map(available.map((r) => [r.week_end, { week_start: r.week_start, week_end: r.week_end, week_number: r.week_number }])).values()];
  const requestedWeeks = query.weeks === undefined ? weeks.slice(0, 1).map((w) => w.week_end) : String(query.weeks).split(',');
  const selectedWeeks = weeks.filter((w) => requestedWeeks.includes(w.week_end)).map((w) => w.week_end);
  const selected = new Map(available.filter((r) => selectedWeeks.includes(r.week_end)).map((r) => [r.id, r]));
  const dRows = db.prepare("SELECT brand, term, series, printer FROM lib_items WHERE lib='D' AND scope=?").all(regionOf(market).id);
  const view = ['printers', 'cores'].includes(query.view) ? query.view : 'queries';
  const grouped = view !== 'queries';
  const coreMode = view === 'cores' || String(query.group ?? '').startsWith('core:');
  const wordType = coreMode ? 'cartridge' : ['printer', 'cartridge'].includes(query.wordType) ? query.wordType : 'all';
  const match = abaMatcher(String(query.q ?? '').slice(0, 1000), dRows, true, wordType === 'printer' ? 'printer' : 'all');
  const coreMatch = abaCoreMatcher(dRows);
  const alignmentFilter = ['all', 'mismatch'].includes(query.alignment) ? query.alignment : 'normal';
  const alignmentSummary = { mismatchRecords: 0, reviewRecords: 0, excludedRecords: 0 };
  const skusByAsin = new Map();
  for (const sku of skuItems) {
    if (!skusByAsin.has(sku.asin)) skusByAsin.set(sku.asin, []);
    skusByAsin.get(sku.asin).push(sku);
  }
  const alignments = new Map();
  const rows = [];
  if (selected.size) {
    const raw = shared
      ? db.prepare('SELECT q.* FROM aba_public_queries q JOIN aba_public_reports r ON r.id=q.report_id WHERE r.marketplace=? AND r.week_end>=? AND r.week_end<=?').iterate(market, selectedWeeks.at(-1), selectedWeeks[0])
      : db.prepare(`SELECT q.* FROM aba_asin_queries q JOIN aba_asin_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace=? AND r.week_end>=? AND r.week_end<=?`)
      .iterate(userId, market, selectedWeeks.at(-1), selectedWeeks[0]);
    for (const row of raw) {
      const report = selected.get(row.report_id);
      if (!report) continue;
      const classified = coreMatch(row.query);
      const initial = match(row.query);
      // A four-digit model stays a printer term even when its D-library mapping is absent.
      const matching = classified.printerNumbers.length && !initial.hasPrinter
        ? { ...initial, hasPrinter: true, group: classified.printerGroup, unmappedPrinter: true,
          matches: initial.matches || (wordType === 'printer' && (!query.q || (
            !/^(?:[a-z]+[-\s]*)?\d{2,3}(?:\s*xl)?$/i.test(String(query.q).trim())
            && row.query.normalize('NFKC').toLowerCase().includes(String(query.q).normalize('NFKC').trim().toLowerCase())))) } : initial;
      if (!matching.matches) continue;
      if (wordType === 'printer' && !matching.hasPrinter) continue;
      if (wordType === 'cartridge' && matching.hasPrinter) continue;
      if (query.group && (coreMode ? classified.core.key : matching.group.key) !== query.group) continue;
      const alignmentKey = JSON.stringify([report.asin, shared && library.enabled ? brandKey(report) : '', row.query]);
      if (!alignments.has(alignmentKey)) {
        const sourceSkus = (skusByAsin.get(report.asin) ?? []).filter((s) => !library.enabled
          || (shared ? brandKey(s) === brandKey(report) : !brand || brandKey(s) === brand));
        const ambiguous = library.enabled && !shared && !brand && new Set(sourceSkus.map(brandKey)).size > 1;
        const checked = asinQueryAlignment(matching, sourceSkus);
        if (matching.unmappedPrinter) {
          checked.status = 'review';
          checked.reason = `搜索词含四位机型 ${classified.printerNumbers.join(' / ')}，机型库尚未明确对应墨盒，请核对`;
        }
        if (ambiguous) {
          checked.status = 'review';
          checked.reason = '此国家的 ASIN 对应多个品牌，请先选择品牌再核对 SKU';
        }
        if (library.enabled && checked.status === 'insufficient' && !sourceSkus.length)
          checked.reason = 'ABA 专用 SKU 库未收录此国家的该 ASIN，请由超级管理员补充';
        checked.issues = ['mismatch', 'review', 'insufficient'].includes(checked.status) ? [{
          asin: report.asin, status: checked.status, reason: checked.reason,
          expectedModels: checked.expectedModels, sourceModels: checked.sourceModels,
          skus: [...new Map(sourceSkus.map((s) => [JSON.stringify([s.sku, s.brand, s.model, s.setGroup]),
            { sku: s.sku, brand: s.brand, model: s.model, setGroup: s.setGroup,
              status: asinQueryAlignment(matching, [s]).status }])).values()],
        }] : [];
        alignments.set(alignmentKey, checked);
      }
      const alignment = alignments.get(alignmentKey);
      if (alignment.status === 'mismatch') alignmentSummary.mismatchRecords++;
      if (['review', 'insufficient'].includes(alignment.status)) alignmentSummary.reviewRecords++;
      if ((alignmentFilter === 'normal' && alignment.status === 'mismatch')
        || (alignmentFilter === 'mismatch' && alignment.status !== 'mismatch')) {
        alignmentSummary.excludedRecords++; continue;
      }
      rows.push({ ...row, asin: report.asin, source_brand: library.enabled ? (shared ? report.brand : brand || null) : null,
        week_start: report.week_start, week_end: report.week_end,
        week_number: report.week_number, recognition: coreMode ? classified.core.label : matching.group.kind === 'other' ? '墨盒 KW 词' : matching.group.label,
        candidates: matching.candidates, group: coreMode ? classified.core : matching.group, alignment });
    }
  }
  const average = query.aggregation === 'average' && selectedWeeks.length > 1;
  const merged = average || grouped || query.merge !== '0';
  const exportAll = query.export === '1';
  const items = aggregateAsinView(rows, { series: !!model || !!query.group, view: grouped ? 'printers' : 'queries', mergeWeeks: merged, average, modelLabel: selectedModel?.label, includeQueries: exportAll });
  const sort = ASIN_COLUMNS.some((c) => c.key === query.sort) || (grouped && query.sort === 'query_count') ? query.sort : 'market_impressions';
  const direction = query.direction === 'asc' ? 'asc' : 'desc';
  items.sort((a, b) => {
    if (a[sort] === null && b[sort] !== null) return 1;
    if (b[sort] === null && a[sort] !== null) return -1;
    const difference = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh-CN') : (a[sort] ?? 0) - (b[sort] ?? 0);
    return (direction === 'asc' ? difference : -difference) || a.key.localeCompare(b.key);
  });
  return { skuSource: library.enabled ? 'aba' : 'legacy', skuLibrary: library, reports, years, year, months, month, modelOptions, selectedModel, brands, brand, seriesMerged: !!model || grouped || !!query.group,
    unlinkedAsins: [...new Set(dated.filter((r) => !skuItems.some((s) => s.asin === r.asin && String(s.model ?? '').trim())).map((r) => r.asin))],
    asins: [...new Set(brandReports.map((r) => r.asin))], skuItems: filteredSkus, weeks, selectedWeeks,
    selectedReportCount: selected.size, hasModelLibrary: !!dRows.length, total: items.length, recordCount: rows.length,
    items, exportAll, sort, direction, merged, view, coreClassified: coreMode, alignmentFilter, alignmentSummary, aggregation: average ? 'average' : 'sum' };
}

/** 从完整结果里切出请求的那一页；两种视图导出时都返回全部筛选结果。 */
export function asinPage(full, query) {
  const { exportAll, ...rest } = full;
  const pageSize = ABA_PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(full.items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(query.page) || 1)));
  return { ...rest, items: exportAll ? full.items : full.items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, pageCount };
}
