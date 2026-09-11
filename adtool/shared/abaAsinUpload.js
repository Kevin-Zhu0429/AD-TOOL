import { ASIN_COUNT_KEYS } from './abaAsin.js';

// Transfer only required columns; keep each ASIN/week whole so replacement stays atomic.
export function asinUploadBatches(files, marketplace, maxBytes = 750 * 1024) {
  const headers = ['搜索查询', '搜索查询量', '曝光：曝光总量', '点击量：总次数', '购买：下单总数', '曝光量：ASIN 计数', '点击量：ASIN 数量', '下单成交：ASIN 数量', '报告日期'];
  const line = (cells) => cells.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',');
  const seen = new Set(), batches = [];
  let batch = [];
  const size = (items) => new TextEncoder().encode(JSON.stringify({ marketplace, files: items })).byteLength;
  for (const file of files) for (const report of file.reports) {
    const key = `${report.asin}:${report.week_end}`;
    if (seen.has(key)) throw new Error(`同一批次包含重复报告：${report.asin} ${report.week_end}，请只保留一份`);
    seen.add(key);
    const period = `周 ${report.week_number} | ${report.week_start} - ${report.week_end}`;
    const text = `ASIN=${JSON.stringify([report.asin])},报告范围=["每周"],选择周=${JSON.stringify([period])}\n`
      + [headers, ...report.rows.map((r) => [r.query, ...ASIN_COUNT_KEYS.map((k) => r[k]), report.week_end])].map(line).join('\n');
    const item = { name: `${report.asin}_${report.week_end}.csv`, text };
    if (batch.length && (batch.length >= 10 || size([...batch, item]) > maxBytes)) { batches.push(batch); batch = []; }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
