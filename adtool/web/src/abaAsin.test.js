import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsinReport, parseAsinUpload, mergeAsinRows, asinRates, aggregateAsinSeries, asinModelOptions, aggregateAsinView, asinQueryAlignment, resolveAsinPrinter } from '../../shared/abaAsin.js';
import { abaMatcher } from '../../shared/aba.js';
import { asinFixture, asinFirst, asinSecond, mergedFixture } from '../../server/tests/abaAsinFixture.js';

test('ASIN cartridge number priority applies to every two/three-digit model without suppressing explicit printer identities', () => {
  const rows = [
    { brand: 'HP', term: '302', series: 'Deskjet', printer: '3050' },
    { brand: 'HP', term: '305', series: 'Deskjet', printer: '2700' },
    { brand: 'HP', term: '67', series: 'Deskjet', printer: '1255' },
    { brand: 'Canon', term: '545/546', series: 'PIXMA', printer: 'TS302, TS305, TS67, TS999' },
    { brand: 'HP', term: '304', series: 'Deskjet', printer: '302' },
  ];
  const match = abaMatcher('', rows, true, 'all', { preferCartridgeNumbers: true });
  for (const query of ['302', 'ho 302', 'ho 302 noir', '302XL', 'cartouche 302', 'canon 302', '67', '67 noir', '305', '999']) {
    assert.equal(match(query).hasPrinter, false, query);
    assert.equal(match(query).group.kind, 'other', query);
    assert.deepEqual(match(query).candidates, [], query);
  }
  for (const query of ['TS302', 'canon ts 302', 'TS305', 'TS67', 'TS999', 'hp deskjet 302', 'cartouche canon ts302 545', 'hp 3050'])
    assert.equal(match(query).hasPrinter, true, query);
  assert.equal(abaMatcher('', rows)('302').hasPrinter, true, 'shared brand-report behavior is unchanged');
  const search = abaMatcher('302', rows, true, 'printer', { preferCartridgeNumbers: true });
  assert.equal(search('302').matches, false);
  assert.equal(search('hp deskjet 3050').matches, true, 'search still expands cartridge compatibility');
  assert.equal(search('canon ts302').matches, false, 'a numeric overlap cannot expand to an unrelated printer');
});

test('source SKU models resolve exactly one compatible printer; incomplete, overlapping and mixed mappings stay in review', () => {
  const match = abaMatcher('', [
    { brand: 'HP', term: '304', series: 'Deskjet', printer: '2620' },
    { brand: 'HP', term: '301', series: 'Officejet', printer: '2620' },
  ])('cartouche hp 2620');
  for (const [model, name] of [['304', 'DESKJET'], ['301XL', 'OFFICEJET']]) {
    const resolved = resolveAsinPrinter(match, [{ model }]);
    assert.match(resolved.group.label, new RegExp(name));
    assert.equal(resolved.printers.length, 1);
    assert.equal(asinQueryAlignment(resolved, [{ model }]).status, 'matched');
  }
  for (const skus of [[], [{ model: '' }], [{ model: '301/' }], [{ model: '305' }], [{ model: '301/304' }], [{ model: '301' }, { model: '304' }], [{ model: '301' }, { model: '' }]])
    assert.equal(resolveAsinPrinter(match, skus), match, JSON.stringify(skus));
  const overlap = abaMatcher('', [
    { brand: 'HP', term: '301', series: 'Deskjet', printer: '2620' },
    { brand: 'HP', term: '301/304', series: 'Officejet', printer: '2620' },
  ])('hp 2620');
  assert.equal(resolveAsinPrinter(overlap, [{ model: '301' }]), overlap);
  assert.equal(resolveAsinPrinter(overlap, [{ model: '301/304' }]).group.kind, 'printer');
});

test('one query assigned to different printers has independent sums, observed-week averages and source contributions', () => {
  const report = parseAsinReport(asinFirst.text, asinFirst.name, 'ES');
  const base = { ...report, ...report.rows[0], query: 'hp 2620', candidates: [], group: { key: 'officejet' }, asin_clicks: 10 };
  const rows = [base, { ...base, week_end: '2026-09-05', asin_clicks: 30, market_impressions: 3000 },
    { ...base, asin: 'B000000304', group: { key: 'deskjet' }, asin_clicks: 20 }];
  const sums = aggregateAsinView(rows, { view: 'printers', includeQueries: true });
  assert.equal(sums.reduce((n, r) => n + r.asin_clicks, 0), 60);
  const groups = aggregateAsinView(rows, { view: 'printers', average: true, includeQueries: true });
  for (const [key, market, weeks] of [['officejet', 2000, 2], ['deskjet', 1000, 1]]) {
    const row = groups.find((r) => r.group.key === key);
    assert.equal(row.market_impressions, market);
    assert.equal(row.asin_clicks, 20);
    assert.equal(row.query_rows.length, 1);
    assert.equal(row.query_rows[0].average_weeks, weeks);
    assert.equal(row.query_rows[0].asin_clicks, 20);
  }
  const sameAsin = rows.map((r) => ({ ...r, asin: base.asin, source_brand: r.group.key === 'officejet' ? 'CE' : 'CY' }));
  const exported = aggregateAsinView(sameAsin, { view: 'printers', average: true, includeQueries: true });
  assert.equal(exported.length, 2);
  assert.ok(exported.every((r) => r.query_rows.length === 1 && r.query_rows[0].asin_clicks === 20));
});

test('printer/SKU compatibility flags ENVY6000 on 304, accepts 305XL and keeps incomplete or ambiguous cases for review', () => {
  const match = abaMatcher('', [
    { brand: 'HP', term: '305', series: 'ENVY', printer: '6000' },
    { brand: 'HP', term: '304', series: 'DESKJET', printer: '3700' },
    { brand: 'HP', term: '305', series: 'DESKJET', printer: '3700' },
    { brand: 'HP', term: '303', series: 'PHOTOSMART', printer: '3700' },
  ]);
  const envy = match('hp envy 6000 ink');
  assert.equal(asinQueryAlignment(envy, [{ model: '304' }]).status, 'mismatch');
  assert.equal(asinQueryAlignment(envy, [{ model: '305XL', brand: 'CE' }]).status, 'matched');
  assert.deepEqual(asinQueryAlignment(envy, [{ model: '304' }]).expectedModels, ['305']);
  assert.equal(asinQueryAlignment(envy, []).status, 'insufficient');
  assert.equal(asinQueryAlignment(envy, [{ model: '305' }, { model: '' }]).status, 'insufficient');
  assert.equal(asinQueryAlignment(envy, [{ model: '305' }, { model: '304' }]).status, 'review');
  assert.equal(asinQueryAlignment(envy, [{ model: '304/305' }]).status, 'review');
  assert.equal(asinQueryAlignment(envy, [{ model: '305/305XL' }]).status, 'matched');
  assert.equal(asinQueryAlignment(envy, [{ model: '305 Series' }]).status, 'review');
  assert.equal(asinQueryAlignment(match('hp deskjet 3700 ink'), [{ model: '304' }]).status, 'matched');
  assert.equal(asinQueryAlignment(match('hp 3700 ink'), [{ model: '304' }]).status, 'review');
  assert.equal(asinQueryAlignment(match('generic ink'), [{ model: '304' }]).status, 'unrecognized');
});

test('ASIN identity and week come only from A1/C1, even when filename conflicts', () => {
  const r = parseAsinReport(asinFirst.text, 'DE_B999999999_Week_2000_01_01.csv', 'ES');
  assert.equal(r.asin, 'B000000305');
  assert.equal(r.week_number, 35);
  assert.equal(r.week_start, '2026-08-23');
  assert.equal(r.rows[0].asin_purchases, 5);
  assert.equal(parseAsinReport(asinFixture({ rows: [] }), 'empty.csv', 'ES').rows.length, 0);
});

test('merged review retains exact problem ASIN/SKU details, deduplicates weeks and excludes healthy sources', () => {
  const report = parseAsinReport(asinFirst.text, asinFirst.name, 'ES');
  const base = { ...report, ...report.rows[0], candidates: [], recognition: 'HP 2820', group: { key: '2820' } };
  const good = { status: 'matched', sourceModels: ['305'], expectedModels: ['305'], reason: '匹配', issues: [] };
  const issue = { asin: 'B000000306', status: 'review', expectedModels: ['305'], sourceModels: ['304', '305'], reason: '同一 ASIN 关联型号不一致',
    skus: [{ sku: 'WRONG-304', model: '304', brand: 'CE', status: 'mismatch' }, { sku: 'RIGHT-305', model: '305', brand: 'CE', status: 'matched' }] };
  const uncertain = { ...good, status: 'review', sourceModels: ['304', '305'], reason: issue.reason, issues: [issue] };
  const rows = [{ ...base, alignment: good }, { ...base, asin: issue.asin, alignment: uncertain },
    { ...base, asin: issue.asin, alignment: uncertain, week_end: '2026-09-05' }];
  const result = aggregateAsinView(rows, { view: 'printers' })[0];
  assert.equal(result.alignment.status, 'review');
  assert.deepEqual(result.alignment.issues, [issue]);
  assert.equal(aggregateAsinView(rows, { series: true })[0].alignment.issues.length, 1);
  assert.deepEqual(result.alignment.issues[0].skus.map((s) => [s.sku, s.status]), [['WRONG-304', 'mismatch'], ['RIGHT-305', 'matched']]);
});
test('ASIN parser rejects missing identity, invalid period, duplicates and malformed count/date', () => {
  for (const text of [asinFirst.text.replace('ASIN=', '品牌='), asinFirst.text.replace('B000000305', '305'),
    asinFirst.text.replace('周 35 |', '周 99 |'), asinFirst.text.replaceAll('2026-08-29', '2026-02-30'),
    asinFirst.text.replace('"1000"', '"-1"'), asinFirst.text.replace('"2026-08-29"', '"2026-09-05"'),
    asinFirst.text + '\n' + asinFirst.text.split('\n')[2],
    asinFirst.text.replace('搜索查询量,', '搜索查询,')]) {
    assert.throws(() => parseAsinReport(text, 'valid.csv', 'ES'));
  }
});
test('ASIN rates use totals after weekly merge and never merge two ASINs', () => {
  const reports = [asinFirst, asinSecond, { name: 'other.csv', text: asinFixture({ asin: 'B000000302' }) }].map((f) => parseAsinReport(f.text, f.name, 'ES'));
  const rows = reports.flatMap((r) => r.rows.map((row) => ({ ...r, ...row, rows: undefined })));
  const result = mergeAsinRows(rows).map(asinRates);
  assert.equal(result.length, 8);
  const merged = result.find((r) => r.asin === 'B000000305' && r.query === 'hp deskjet 2820e');
  assert.equal(merged.market_impressions, 1200);
  assert.equal(merged.market_cvr, 25);
  assert.equal(merged.asin_cvr, 8 / 15 * 100);
  assert.equal(merged.brand_share, 8 / 30 * 100);
  assert.deepEqual(merged.periods.map((p) => p.week_number), [36, 35]);
  assert.equal(result.find((r) => r.query === 'hp deskjet 3050').brand_share, null);
});

test('merged XLSX rows split by AI/AJ; filename never determines identity or period', () => {
  const file = mergedFixture(); file.name = 'B999999999_2001.xlsx';
  const reports = parseAsinUpload(file, 'ES');
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((r) => r.week_number), [35, 36]);
  assert.equal(reports[0].asin, 'B000000305');
  assert.equal(reports[0].rows.length, 4);
  for (const edit of [(r) => { r[1][34] = ''; }, (r) => { r[1][35] = '2026'; },
    (r) => { r[1][8] = '2026-09-05'; }, (r) => { r[1][2] = -10; },
    (r) => { r[0][34] = '错误位置'; }, (r) => r.push([...r[1]])]) {
    const invalid = structuredClone(file); edit(invalid.sheets[0].rows);
    assert.throws(() => parseAsinUpload(invalid, 'ES'));
  }
  const split = { ...file, sheets: [{ rows: file.sheets[0].rows.slice(0, 3) }, { rows: [file.sheets[0].rows[0], ...file.sheets[0].rows.slice(3)] }] };
  assert.deepEqual(parseAsinUpload(split, 'ES'), reports);
});

test('series aggregation deduplicates weekly market metrics and propagates conflicts instead of inventing totals', () => {
  const report = parseAsinReport(asinFirst.text, asinFirst.name, 'ES');
  const base = { ...report, ...report.rows[0], candidates: [], recognition: 'HP 2820', group: { key: '2820' } };
  const other = { ...base, asin: 'B000000306', asin_clicks: 20, asin_purchases: 2 };
  const next = { ...base, week_end: '2026-09-05', week_start: '2026-08-30', week_number: 36 };
  let result = aggregateAsinSeries([base, other, next]).map(asinRates)[0];
  assert.equal(result.market_clicks, 200);
  assert.equal(result.asin_clicks, 40);
  assert.equal(result.asin_purchases, 12);
  assert.equal(result.market_cvr, 20);
  assert.equal(result.brand_share, 30);
  assert.equal(result.periods.length, 2);
  assert.equal(result.asins.length, 2);
  assert.equal(aggregateAsinSeries([base, other, next], { mergeWeeks: false }).length, 2);
  result = aggregateAsinSeries([base, { ...other, market_purchases: 25 }, next]).map(asinRates)[0];
  assert.equal(result.market_purchases, null);
  assert.equal(result.market_cvr, null);
  assert.equal(result.brand_share, null);
  assert.equal(result.asin_cvr, 30);
  assert.equal(result.conflict_count, 1);
  assert.equal(result.market_conflicts[0].values[1].value, 25);
  assert.equal(asinRates({ asin_purchases: null, asin_clicks: 20 }).asin_cvr, null);
  const options = asinModelOptions([{ id: 1, asin: base.asin, brand: 'HP', model: '305XL' }, { id: 2, asin: other.asin, brand: 'HP', model: '305' }, { id: 3, asin: 'missing', model: '302' }], [base.asin, other.asin]);
  assert.equal(options.length, 1);
  assert.equal(options[0].asins.length, 2);
});


test('weekly averages use each query observed weeks, preserve decimals and add up in printer groups', () => {
  const report = parseAsinReport(asinFirst.text, asinFirst.name, 'ES');
  const base = { ...report, ...report.rows[0], candidates: [], recognition: 'HP 2820', group: { key: '2820' } };
  const next = { ...base, week_end: '2026-09-05', week_number: 36, asin_clicks: 11 };
  const rare = { ...base, query: 'rare printer query', asin_clicks: 3, asin_purchases: 1 };
  const rows = [base, next, rare];
  const result = aggregateAsinView(rows, { average: true });
  assert.equal(result[0].asin_clicks, 10.5);
  assert.equal(result[0].average_weeks, 2);
  assert.equal(result[1].asin_clicks, 3);
  assert.equal(result[1].average_weeks, 1);
  const group = aggregateAsinView(rows, { average: true, view: 'printers' })[0];
  assert.equal(group.asin_clicks, 13.5);
  assert.equal(group.query_count, 2);
  assert.equal(group.asin_cvr, group.asin_purchases / 13.5 * 100);
  assert.equal(group.query_rows, undefined);
  const exportedGroup = aggregateAsinView(rows, { average: true, view: 'printers', includeQueries: true })[0];
  assert.deepEqual(exportedGroup.query_rows.map((row) => row.query), ['hp deskjet 2820e', 'rare printer query']);
  assert.equal(exportedGroup.query_rows[0].asin_clicks, 10.5);
  assert.equal(exportedGroup.query_rows[0].asin_cvr, exportedGroup.query_rows[0].asin_purchases / 10.5 * 100);
  const series = aggregateAsinView([...rows, { ...base, asin: 'B000008888' }], { average: true, series: true })[0];
  assert.equal(series.market_clicks, 100);
  assert.equal(series.asin_clicks, 15.5);
  assert.equal(series.average_weeks, 2);
  const seriesExport = aggregateAsinView([...rows, { ...base, asin: 'B000008888' }], { average: true, series: true, view: 'printers', includeQueries: true })[0];
  const original = seriesExport.query_rows.find((row) => row.asin === base.asin && row.query === base.query);
  const otherAsin = seriesExport.query_rows.find((row) => row.asin === 'B000008888' && row.query === base.query);
  assert.equal(seriesExport.query_rows.length, 3);
  assert.equal(original.asin_clicks, 10.5);
  assert.equal(otherAsin.asin_clicks, 10);
  assert.notEqual(original, otherAsin);
  const conflict = aggregateAsinView([base, { ...base, asin: 'B000008888', market_clicks: 101 }, next], { average: true, series: true })[0];
  assert.equal(conflict.market_clicks, null);
  assert.equal(conflict.market_cvr, null);
  assert.equal(conflict.conflict_count, 1);
});

test('printer summary merges all ASINs while exports retain each source own observed-week average', () => {
  const report = parseAsinReport(asinFirst.text, asinFirst.name, 'ES');
  const base = { ...report, ...report.rows[0], candidates: [], recognition: 'HP 2820', group: { key: '2820' } };
  const rows = [base, { ...base, week_end: '2026-09-05' }, { ...base, asin: 'B000008888', asin_clicks: 20 }];
  assert.equal(aggregateAsinView(rows).length, 2, 'plain query details keep source ASIN rows');
  const summed = aggregateAsinView(rows, { view: 'printers', includeQueries: true });
  assert.equal(summed.length, 1);
  assert.deepEqual(summed[0].asins, ['B000000305', 'B000008888']);
  assert.equal(summed[0].query_count, 1);
  assert.equal(summed[0].market_clicks, 200, 'same query/week market counts are counted once');
  assert.equal(summed[0].asin_clicks, 40);
  const averaged = aggregateAsinView(rows, { view: 'printers', average: true, includeQueries: true })[0];
  assert.equal(averaged.asin_clicks, 20);
  assert.equal(averaged.query_rows.reduce((n, r) => n + r.asin_clicks, 0), 30);
  assert.deepEqual(averaged.query_rows.map((r) => r.average_weeks), [2, 1]);
  const conflict = aggregateAsinView([base, { ...rows[2], market_clicks: 101 }], { view: 'printers' })[0];
  assert.equal(conflict.market_clicks, null);
  assert.equal(conflict.conflict_count, 1);
});
