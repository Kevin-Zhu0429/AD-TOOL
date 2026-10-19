import { ASIN_COLUMNS, ASIN_ALIGNMENT_LABELS } from '../../shared/abaAsin.js';

export const ASIN_GROUP_EXPORT_COLUMNS = [
  { key: 'sku', label: 'SKU', text: true },
  { key: 'recognition', label: '机型分类', text: true },
  { key: 'query', label: '搜索词', text: true },
  { key: 'asin', label: 'ASIN', text: true },
  ...ASIN_COLUMNS.slice(2),
  { key: 'alignment_status', label: '机型与 SKU 对应', text: true },
  { key: 'alignment_reason', label: '型号核对说明', text: true },
  { key: 'alignment_sources', label: '待核对来源与原因', text: true },
];

export function skusForAsinRow(row, data, params = {}) {
  const asins = row.asins ?? [row.asin];
  return (data.skuItems ?? []).filter((sku) => asins.includes(sku.asin)
    && (!params.skuId || String(sku.id) === String(params.skuId))
    && (!data.selectedModel || data.selectedModel.skuIds.includes(sku.id)));
}

function identitiesForAsinRow(row, data, params) {
  const asins = [...new Set((row.asins ?? [row.asin]).filter(Boolean))];
  if (!asins.length) return [{ asin: '', sku: '' }];

  const linkedSkus = skusForAsinRow(row, data, params);
  return asins.flatMap((asin) => {
    const skus = [...new Set(linkedSkus
      .filter((item) => item.asin === asin)
      .map((item) => item.sku)
      .filter(Boolean))];
    return skus.length
      ? skus.map((sku) => ({ asin, sku }))
      : [{ asin, sku: '' }];
  });
}

// Market totals repeat on every SKU row of a search term, so exports split each
// week's totals across the SKU rows whose ASIN has a report for that week.
const SHARED_MARKET_KEYS = ['market_impressions', 'market_clicks', 'market_purchases'];

// Rows without per-week data carry one already-aggregated total.
const marketWeeks = (row) => row.market_weeks?.length ? row.market_weeks
  : [{ week_end: '', ...Object.fromEntries(SHARED_MARKET_KEYS.map((key) => [key, row[key]])) }];

function splitMarketTotals(entries, average) {
  const terms = new Map();
  for (const entry of entries) {
    if (!terms.has(entry.termKey)) terms.set(entry.termKey, new Map());
    const weekCounts = terms.get(entry.termKey);
    for (const week of marketWeeks(entry.queryRow)) weekCounts.set(week.week_end, (weekCounts.get(week.week_end) ?? 0) + 1);
  }
  return entries.map(({ queryRow, termKey }) => {
    const weekCounts = terms.get(termKey);
    const averageWeeks = average && queryRow.market_weeks?.length ? weekCounts.size : 1;
    return Object.fromEntries(SHARED_MARKET_KEYS.map((key) => {
      let total = 0;
      for (const week of marketWeeks(queryRow)) {
        if (week[key] === null || week[key] === undefined) return [key, null];
        total += week[key] / weekCounts.get(week.week_end);
      }
      return [key, total / averageWeeks];
    }));
  });
}

function alignmentSourceText(alignment) {
  return (alignment?.issues ?? []).map((issue) => [
    `ASIN：${issue.asin} · ${ASIN_ALIGNMENT_LABELS[issue.status]}`,
    `机型对应型号：${issue.expectedModels.join(' / ') || '词库未明确对应型号'}`,
    ...issue.skus.map((sku) => `SKU：${sku.sku} · 品牌：${sku.brand || '未填写'} · 库中型号：${sku.model || '未填写'} · ${ASIN_ALIGNMENT_LABELS[sku.status]}`),
    ...(issue.skus.length ? [] : ['关联 SKU：未关联']),
    `原因：${issue.reason}`,
  ].join('\n')).join('\n\n');
}

export function buildAsinGroupExport(data, params = {}) {
  const entries = (data.items ?? []).flatMap((group) => {
    const queryRows = group.query_rows?.length ? group.query_rows : [{ ...group, query: '' }];
    return queryRows.flatMap((queryRow) => identitiesForAsinRow(queryRow, data, params)
      .map((identity) => ({ group, queryRow, identity, termKey: JSON.stringify([group.recognition, queryRow.query]) })));
  });
  const markets = splitMarketTotals(entries, data.aggregation === 'average');
  const rows = entries.map(({ group, queryRow, identity }, index) => ASIN_GROUP_EXPORT_COLUMNS.map((column) => {
    if (column.key === 'sku') return identity.sku;
    if (column.key === 'recognition') return group.recognition;
    if (column.key === 'asin') return identity.asin;
    if (column.key === 'alignment_status') return ASIN_ALIGNMENT_LABELS[queryRow.alignment?.status] ?? '';
    if (column.key === 'alignment_reason') return queryRow.alignment?.reason ?? '';
    if (column.key === 'alignment_sources') return alignmentSourceText(queryRow.alignment);
    const value = column.key in markets[index] ? markets[index][column.key] : queryRow[column.key];
    if (value === null || value === undefined) return '';
    return column.rate ? value / 100 : value;
  }));
  return { columns: ASIN_GROUP_EXPORT_COLUMNS, rows };
}

export const ASIN_QUERY_EXPORT_COLUMNS = [
  ...ASIN_GROUP_EXPORT_COLUMNS.map((column) => column.key === 'recognition' ? { ...column, label: '机型识别' } : column),
  { key: 'links', label: 'ASIN / SKU 对应', text: true },
  { key: 'periods', label: '报告周', text: true },
  { key: 'aggregation', label: '统计方式', text: true },
  { key: 'average_weeks', label: '实际出现周数' },
  { key: 'market_conflicts', label: '市场数据核对', text: true },
];

/** 明细保持一条显示记录一行，来源关系作为说明，关联多个 SKU 不复制指标。 */
export function buildAsinQueryExport(data, params = {}) {
  const rows = (data.items ?? []).map((row) => {
    const identities = identitiesForAsinRow(row, data, params);
    const text = {
      sku: [...new Set(identities.map((i) => i.sku).filter(Boolean))].join('\n'),
      asin: [...new Set(identities.map((i) => i.asin).filter(Boolean))].join('\n'),
      links: identities.map((i) => `${i.asin}：${i.sku || '未关联 SKU'}`).join('\n'),
      periods: (row.periods ?? []).map((p) => `${p.week_end.slice(0, 4)} 第 ${p.week_number} 周 · ${p.week_start} — ${p.week_end}`).join('\n'),
      aggregation: data.aggregation === 'average' ? '周平均' : data.merged === false ? '逐周' : '合计',
      average_weeks: row.average_weeks ?? row.periods?.length ?? '',
      alignment_status: ASIN_ALIGNMENT_LABELS[row.alignment?.status] ?? '',
      alignment_reason: row.alignment?.reason ?? '',
      alignment_sources: alignmentSourceText(row.alignment),
      market_conflicts: (row.market_conflicts ?? []).map((c) => `${c.week_end} · ${c.query} · ${c.label}：${c.values.map((v) => `${v.asin} = ${v.value}`).join('；')}`).join('\n')
        + (row.conflict_count > 20 ? '\n仅列出前 20 项待核对数据' : ''),
    };
    return ASIN_QUERY_EXPORT_COLUMNS.map((column) => {
      const value = column.key in text ? text[column.key] : row[column.key];
      if (value === null || value === undefined) return '';
      return column.rate ? value / 100 : value;
    });
  });
  return { columns: ASIN_QUERY_EXPORT_COLUMNS, rows };
}

export function buildAsinExport(data, params = {}) {
  return data.view === 'printers'
    ? { ...buildAsinGroupExport(data, params), sheetName: '机型分类汇总' }
    : { ...buildAsinQueryExport(data, params), sheetName: '搜索查询明细' };
}
