import { readCsv } from '../../shared/aba.js';

export function asinFixture({ asin = 'B000000305', week = 35, start = '2026-08-23', end = '2026-08-29', rows } = {}) {
  const header = ['搜索查询', '搜索查询量', '曝光：曝光总量', '点击量：总次数', '购买：下单总数', '曝光量：ASIN 计数', '点击量：ASIN 数量', '下单成交：ASIN 数量', '报告日期'];
  const data = rows ?? [
    ['hp deskjet 2820e', 100, 1000, 100, 20, 200, 10, 5],
    ['cartuchos hp 305', 200, 3000, 200, 50, 400, 20, 10],
    ['hp deskjet 3050', 30, 80, 0, 0, 10, 0, 0],
    ['hp 4310', 40, 70, 10, 4, 15, 5, 2],
  ];
  return `ASIN=["${asin}"],报告范围=["每周"],选择周=["周 ${week} | ${start} - ${end} ${end.slice(0, 4)}"]\n`
    + header.join(',') + '\n' + data.map((r) => [...r, end].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
}
export const asinFirst = { name: 'any-name.csv', text: asinFixture() };
export const asinSecond = { name: 'wrong-asin-week-in-filename.csv', text: asinFixture({ week: 36, start: '2026-08-30', end: '2026-09-05', rows: [
  ['hp deskjet 2820e', 10, 200, 20, 10, 30, 5, 3],
  ['cartuchos hp 305', 20, 150, 10, 5, 20, 2, 1],
] }) };

export function mergedFixture(files = [asinFirst, asinSecond]) {
  const rows = [];
  for (const file of files) {
    const [meta, ...lines] = file.text.split('\n');
    const [head, ...body] = readCsv(lines.join('\n'));
    if (!rows.length) { const header = Array(36).fill(''); head.forEach((v, i) => { header[i] = v; }); header[34] = 'ASIN'; header[35] = '时间范围'; rows.push(header); }
    for (const record of body) {
      const row = Array(36).fill('');
      record.forEach((v, i) => { row[i] = v; });
      row[34] = JSON.parse(meta.match(/^ASIN=(\[.*?\])/)[1])[0];
      row[35] = JSON.parse(meta.match(/选择周=(\[.*?\])/)[1])[0];
      rows.push(row);
    }
  }
  return { name: 'merged.xlsx', sheets: [{ rows }] };
}
