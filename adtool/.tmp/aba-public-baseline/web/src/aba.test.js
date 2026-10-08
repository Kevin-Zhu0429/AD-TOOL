import test from 'node:test';
import assert from 'node:assert/strict';
import { abaMatcher, aggregateAbaRows, parseAbaReport, readCsv } from '../../shared/aba.js';
import { csvFixture, dRows, firstFile } from '../../server/tests/abaFixture.js';

test('ABA retains source week, date range, percentage points, nullable median and >100% rates', () => {
  const report = parseAbaReport('\uFEFF' + firstFile.text, firstFile.name, 'ES');
  assert.equal(report.brand, 'Cyloral');
  assert.equal(report.week_number, 35);
  assert.equal(report.week_start, '2026-08-23');
  assert.equal(report.rows[0].click_rate, 45);
  assert.equal(report.rows[2].click_price, null);
  assert.equal(report.rows[4].click_rate, 150);
});
test('ABA CSV handles quoted commas, embedded quotes, newlines and rejects malformed quoting', () => {
  assert.deepEqual(readCsv('"a,b","c""d"\r\n"line\nbreak",2'), [['a,b', 'c"d'], ['line\nbreak', '2']]);
  assert.throws(() => readCsv('"unclosed'), /未闭合/);
  assert.throws(() => readCsv('"closed"suffix'), /引号/);
});
test('ABA import rejects wrong scope, dates, columns, nonnumeric and duplicate rows', () => {
  const parse = (text, name = firstFile.name, market = 'ES') => parseAbaReport(text, name, market);
  assert.throws(() => parse(firstFile.text, firstFile.name, 'DE'), /切换站点/);
  assert.throws(() => parse(firstFile.text.replace('每周', '每月')), /每周报告/);
  assert.throws(() => parse(firstFile.text.replace('2026-08-23', '2026-02-30')), /连续 7 天/);
  assert.throws(() => parse(firstFile.text, 'ES_Week_2026_09_05.csv'), /不一致/);
  assert.throws(() => parse(firstFile.text.replace('搜索查询量', '其他列')), /缺少列/);
  assert.throws(() => parse(firstFile.text.replace('"100"', '"oops"')), /有效非负数字/);
  assert.throws(() => parse(firstFile.text.replace('"5000"', '"-1"')), /有效非负数字/);
  assert.throws(() => parse(firstFile.text.replace('sin coincidencia', 'cartuchos hp 305')), /重复/);
  assert.throws(() => parse(csvFixture({ rows: [] })), /1–10,000/);
});
test('ABA 305 includes substrings and related 4-digit printers without expanding 3050 into a wrong series', () => {
  const match = abaMatcher('305', dRows);
  assert.equal(match('cartuchos HP 305XL').matches, true);
  assert.equal(match('hp 3050').linked, false); // Still a literal substring, as requested.
  assert.equal(match('hp deskjet 2700').linked, true);
  assert.equal(match('cartucho impresora hp 2820e').linked, true);
  assert.equal(match('hp 4310').linked, true);
  assert.equal(match('hp 4310').candidates.length, 2);
  assert.equal(match('canon 2700').matches, false);
  assert.equal(match('hp 12700').matches, false);
  assert.equal(match('B0ABC2700X').matches, false);
  assert.equal(abaMatcher('305', dRows, false)('hp 2700').matches, false);
  assert.equal(abaMatcher('305', [])('hp 2700').matches, false);
  assert.equal(abaMatcher('TS305', dRows)('hp 2700').matches, false);
});

test('ABA type filters enforce cartridge scope even when an unrelated printer literally contains 305', () => {
  const printer = abaMatcher('305', dRows, false, 'printer');
  const cartridge = abaMatcher('305', dRows, true, 'cartridge');
  assert.equal(printer('hp deskjet 2700').matches, true);
  assert.equal(printer('hp 3050').matches, false);
  assert.equal(printer('canon TS305').matches, false);
  assert.equal(printer('hp 305xl').matches, false);
  assert.equal(cartridge('hp 305 xl cartuchos').matches, true);
  assert.equal(cartridge('hp305xl').matches, true);
  assert.equal(cartridge('hp 305 cartuchos para 2700').matches, false);
  assert.equal(cartridge('hp 3050').matches, false);
  assert.equal(cartridge('canon TS305').matches, false);
  assert.equal(cartridge('canon 305').matches, false);
  assert.equal(abaMatcher('305', [], true, 'printer')('hp2700').matches, false);
});

test('ABA groups HP e variants together, preserves brand identity and separates multiple candidates', () => {
  const match = abaMatcher('305', dRows, true, 'printer');
  const variants = ['hp 2820', 'cartucho hp2820e', 'hp deskjet 2820.e'];
  const groups = variants.map((q) => match(q));
  assert.ok(groups.every((r) => r.matches));
  assert.equal(new Set(groups.map((r) => r.group.key)).size, 1);
  assert.equal(match('hp 4310').group.kind, 'review');
  assert.equal(match('hp 2700 2820').group.kind, 'review');
  assert.equal(match('hp 12700').matches, false);
  assert.equal(match('canon 2820').matches, false);
});

test('ABA aggregation sums counts, weights CTR, preserves exact period membership and never averages medians', () => {
  const base = { query: 'hp 2820', candidates: [], linked: true, group: { key: 'hp2820', label: 'HP 2820', kind: 'printer' },
    week_start: '2026-08-23', week_end: '2026-08-29', week_number: 35, query_volume: 10, impressions: 100, clicks: 5, click_rate: 50, click_price: 20, purchases: 2 };
  const later = { ...base, week_start: '2026-09-06', week_end: '2026-09-12', week_number: 37, query_volume: 90, clicks: 9, click_rate: 10, click_price: 50, purchases: 3 };
  const differentTerm = { ...base, query: 'cartucho hp2820e' };
  const rows = aggregateAbaRows([base, later, differentTerm]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].query_volume, 100);
  assert.equal(rows[0].clicks, 14);
  assert.equal(rows[0].purchases, 5);
  assert.ok(Math.abs(rows[0].click_rate - 14) < 1e-9);
  assert.equal(rows[0].click_price, null);
  assert.deepEqual(rows[0].prices.map((p) => p.value), [20, 50]);
  assert.deepEqual(rows[0].periods.map((p) => p.week_number), [35, 37]);
  assert.equal(rows[1].click_price, 20);
  const groups = aggregateAbaRows([base, later, differentTerm], 'printer');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].query_count, 2);
  assert.equal(groups[0].clicks, 19);
  assert.equal(groups[0].purchases, 7);
  assert.equal(groups[0].click_rate, 19 / 110 * 100);
  assert.equal(aggregateAbaRows([{ ...base, query_volume: 0 }, { ...later, query_volume: 0 }])[0].click_rate, null);
});
