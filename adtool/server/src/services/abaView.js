// ABA 品牌报告的查询、匹配、聚合、排序。只依赖传进来的 db,主线程和 worker 线程都能调用。
import { regionOf } from '../libs.js';
import { ABA_COLUMNS, BRAND_COLUMNS, BRAND_SOURCE_COLUMNS, brandRates, ABA_PAGE_SIZES, abaMatcher, aggregateAbaRows } from '../../../shared/aba.js';

/** 算出和页码无关的完整结果(排好序的全部行 + 汇总);翻页只是在它上面切片 */
export function buildAbaView(db, userId, market, query) {
  // No owner/scope override: every query starts with the current account.
  const reports = db.prepare(`SELECT r.id, r.brand, r.week_start, r.week_end, r.week_number, r.source_file, r.updated_at, r.row_count
    FROM aba_reports r WHERE r.user_id=? AND r.marketplace=? ORDER BY r.week_end DESC, r.brand`).all(userId, market);
  const brands = [...new Set(reports.map((r) => r.brand))];
  const requestedBrand = String(query.brand ?? '');
  const brand = brands.find((b) => b.toLowerCase() === requestedBrand.toLowerCase()) ?? (requestedBrand ? '' : brands[0] ?? '');
  const available = reports.filter((r) => r.brand === brand);
  const weeks = query.weeks === undefined ? available.slice(0, 1).map((r) => r.week_end) : String(query.weeks).split(',');
  const selected = available.filter((r) => weeks.includes(r.week_end));
  const q = String(query.q ?? '').trim().slice(0, 1000);
  const dRows = db.prepare("SELECT brand, term, series, printer FROM lib_items WHERE lib='D' AND scope=?").all(regionOf(market).id);
  const view = query.view === 'printers' ? 'printers' : 'queries';
  const wordType = ['printer', 'cartridge'].includes(query.wordType) ? query.wordType : 'all';
  const merged = query.merge !== '0' && selected.length > 1;
  const match = abaMatcher(q, dRows, query.models !== '0', wordType);
  const selectedIds = new Set(selected.map((r) => r.id));
  const selectedById = new Map(selected.map((r) => [r.id, r]));
  // Iterate on the server and return only one page; never send the account's entire history to the browser.
  const rows = [];
  if (selectedIds.size) {
    const raw = db.prepare(`SELECT q.* FROM aba_queries q JOIN aba_reports r ON r.id=q.report_id
      WHERE r.user_id=? AND r.marketplace=? AND r.brand=? AND r.week_end>=? AND r.week_end<=?`)
      .iterate(userId, market, brand, selected.at(-1).week_end, selected[0].week_end);
    for (const row of raw) {
      if (!selectedIds.has(row.report_id)) continue;
      const matching = match(row.query);
      if (!matching.matches) continue;
      if (query.group && matching.group.key !== query.group) continue;
      const report = selectedById.get(row.report_id);
      rows.push({ ...row, week_start: report.week_start, week_end: report.week_end, week_number: report.week_number,
        recognition: matching.group.kind === 'other' ? '墨盒 KW 词' : matching.group.label,
        linked: matching.linked, candidates: matching.candidates, group: matching.group });
    }
  }
  const items = (view === 'printers' ? aggregateAbaRows(rows, 'printer') : merged ? aggregateAbaRows(rows) : rows).map(brandRates);
  const priceSortable = items.every((row) => (row.record_count ?? 1) === 1);
  const allowedSort = [...ABA_COLUMNS.map((c) => c.key), ...BRAND_COLUMNS.map((c) => c.key), ...(view === 'printers' ? ['query_count'] : [])];
  const sort = allowedSort.includes(query.sort) && (query.sort !== 'click_price' || priceSortable) ? query.sort : 'query_volume';
  const direction = query.direction === 'asc' ? 'asc' : 'desc';
  items.sort((a, b) => {
    if (a[sort] === null && b[sort] !== null) return 1;
    if (b[sort] === null && a[sort] !== null) return -1;
    const comparison = typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort], 'zh-CN') : (a[sort] ?? 0) - (b[sort] ?? 0);
    return (direction === 'asc' ? comparison : -comparison) || b.week_end.localeCompare(a.week_end) || a.query.localeCompare(b.query);
  });
  const trend = selected.toReversed().map((r) => ({ week_start: r.week_start, week_end: r.week_end, week_number: r.week_number, query_volume: 0, impressions: 0, clicks: 0, purchases: 0, brand_impressions: 0, brand_clicks: 0, brand_purchases: 0, count: 0 }));
  const byWeek = new Map(trend.map((r) => [r.week_end, r]));
  for (const row of rows) {
    const week = byWeek.get(row.week_end);
    for (const key of ['query_volume', 'impressions', 'clicks', 'purchases']) week[key] += row[key];
    BRAND_SOURCE_COLUMNS.forEach(({ key }) => { week[key] = week[key] == null || row[key] == null ? null : week[key] + row[key]; });
    week.count++;
  }
  for (const week of trend) {
    week.click_rate = week.query_volume ? week.clicks / week.query_volume * 100 : null;
    Object.assign(week, brandRates(week));
  }
  return { reports, brands, brand, selectedWeeks: selected.map((r) => r.week_end), items,
    total: items.length, recordCount: rows.length, queryCount: new Set(rows.map((r) => r.query)).size,
    linkedCount: items.filter((r) => r.linked).length, sort, direction, trend,
    view, wordType, merged, priceSortable, missingBrandData: rows.some((r) => BRAND_SOURCE_COLUMNS.some(({ key }) => r[key] == null)), hasModelLibrary: !!dRows.length };
}

/** 从完整结果里切出请求的那一页 */
export function abaPage(full, query) {
  const pageSize = ABA_PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(full.items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(query.page) || 1)));
  return { ...full, items: full.items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, pageCount };
}
