import { readCsv, BRAND_SOURCE_COLUMNS } from '../../shared/aba.js';

export const dRows = [
  { brand: 'HP', term: '305', series: 'DeskJet', printer: '2700, 2800, 2810, 2820e' },
  { brand: 'HP', term: '302', series: 'DeskJet', printer: '3050' },
  { brand: 'Canon', term: '545, 546', series: 'PIXMA', printer: 'TS305' },
  { brand: 'HP', term: '305', series: 'DeskJet', printer: '4310' },
  { brand: 'HP', term: '21, 22', series: 'OfficeJet', printer: '4310' },
];
export const fixtureHeader = ['搜索查询', '搜索查询量', '曝光：曝光总量', '点击量：总次数', '点击量：点击率 %', '点击量：价格(中位数)', '购买：下单总数', '报告日期'];
const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export function csvFixture({ week = 35, start = '2026-08-23', end = '2026-08-29', brand = 'Cyloral', rows } = {}) {
  const records = rows ?? [
    ['cartuchos hp 305', 100, 5000, 45, 45, 19.99, 15],
    ['tinta hp deskjet 2700', 20, 400, 10, 50, 21.99, 5],
    ['hp 4310', 5, 80, 2, 40, null, 0],
    ['hp deskjet 3050', 10, 800, 6, 60, 12, 1],
    ['canon TS305', 2, 60, 3, 150, 29.99, 1],
    ['sin coincidencia', 1, 30, 0, 0, null, 0],
  ];
  return `品牌=${JSON.stringify([brand])},报告范围=["每周"],选择周=["周 ${week} | ${start} - ${end} ${end.slice(0, 4)}"]\r\n` +
    [fixtureHeader, ...records.map((r) => [...r, end])].map((row) => row.map(quote).join(',')).join('\r\n');
}
export const firstFile = { name: 'ES_Week_2026_08_29.csv', text: csvFixture() };
export const secondFile = { name: 'ES_Week_2026_09_05.csv', text: csvFixture({ week: 36, start: '2026-08-30', end: '2026-09-05' }) };

export function brandFixture(options = {}, brandCounts = [100, 10, 2]) {
  const text = csvFixture(options);
  const end = text.indexOf('\n');
  const [header, ...rows] = readCsv(text.slice(end + 1));
  return text.slice(0, end + 1) + [[...header, ...BRAND_SOURCE_COLUMNS.map((c) => c.label)], ...rows.map((r) => [...r, ...brandCounts])]
    .map((r) => r.map(quote).join(',')).join('\n');
}
