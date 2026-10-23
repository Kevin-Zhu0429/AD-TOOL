import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';
import { asinFixture } from '../../server/tests/abaAsinFixture.js';
import { publicFixture, publicTask } from '../../server/tests/abaPublicFixture.js';
import { savePublicReports } from '../../server/src/services/publicAsinData.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const XLSX = require('xlsx');
const backend = await startAbaTestServer();
let vite, browser;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
try {
  backend.db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)')
    .run('D', 'EU', 'HP', '305', 'ENVY', '6000', 'envy-group-regression');
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
  await page.goto(base);
  await page.getByLabel('用户名').fill('aba-test'); await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.topnav').getByRole('button', { name: 'ABA 报告', exact: true }).waitFor();
  const one = 'B000006001', two = 'B000006002', wrong = 'B000006004';
  assert.ok((await page.request.post(base + '/api/sku/rows', { data: { rows: [
    { country: 'ES', sku: 'CE-305-BK', brand: 'CE', model: '305', asin: one },
    { country: 'ES', sku: 'CY-305XL-2C', brand: 'CY', model: '305XL', asin: two },
    { country: 'ES', sku: 'WRONG-304', brand: 'CE', model: '304', asin: wrong },
  ] } })).ok());
  const files = [];
  for (const [index, week] of [
    { week: 39, start: '2026-09-20', end: '2026-09-26' },
    { week: 40, start: '2026-09-27', end: '2026-10-03' },
    { week: 41, start: '2026-10-04', end: '2026-10-10' },
  ].entries()) for (const asin of [one, two, wrong]) {
    if (asin === two && index === 1) continue;
    const rows = [['hp envy6000 ink', 100, 1000, 100, 20, 200, asin === two ? 20 : 10, asin === two ? 4 : 2]];
    if (asin === one && index === 1) rows.push(['hp envy6000 rare ink', 20, 200, 20, 4, 40, 6, 1]);
    files.push({ name: asin + '-' + week.week + '.csv', text: asinFixture({ asin, ...week, rows }) });
    const task = { ...publicTask, brand: asin === two ? 'CY' : 'CE', week_start: week.start, week_end: week.end, asins_json: JSON.stringify([asin]) };
    const payload = publicFixture(task);
    payload.dataByAsin = rows.map((r) => {
      const record = structuredClone(payload.dataByAsin[0]);
      record.searchQueryData = { searchQuery: r[0], searchQueryVolume: r[1] };
      record.impressionData = { totalQueryImpressionCount: r[2], asinImpressionCount: r[5] };
      record.clickData = { totalClickCount: r[3], asinClickCount: r[6] };
      record.purchaseData = { totalPurchaseCount: r[4], asinPurchaseCount: r[7] };
      return record;
    });
    savePublicReports(backend.db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
  }
  assert.ok((await page.request.post(base + '/api/aba/asin/import', { data: { marketplace: 'ES', files } })).ok());
  for (const scope of ['private', 'public']) {
    const endpoint = scope === 'private' ? '/api/aba/asin' : '/api/aba-public/asin';
    const params = new URLSearchParams({ marketplace: 'ES', weeks: '2026-09-26,2026-10-03,2026-10-10', view: 'printers', aggregation: 'average', wordType: 'printer' });
    const grouped = await (await page.request.get(base + endpoint + '?' + params)).json();
    assert.equal(grouped.total, 1); assert.equal(grouped.items[0].query_count, 2);
    assert.equal(grouped.items[0].market_impressions, 1200); close(grouped.items[0].asin_clicks, 88 / 3);
    assert.deepEqual(grouped.items[0].asins, [one, two]); assert.equal(grouped.alignmentSummary.mismatchRecords, 3);
    const exported = await (await page.request.get(base + endpoint + '?' + params + '&export=1')).json();
    close(exported.items[0].query_rows.reduce((n, r) => n + r.asin_clicks, 0), 36);
    const child = await (await page.request.get(base + endpoint + '?' + params + '&view=queries&group=' + encodeURIComponent(grouped.items[0].group.key))).json();
    assert.equal(child.total, 2); close(child.items.reduce((n, r) => n + r.asin_clicks, 0), 88 / 3);
    const filtered = await (await page.request.get(base + endpoint + '?' + params + '&asin=' + two)).json();
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0].asin_clicks, 20);
    const byBrand = await (await page.request.get(base + endpoint + '?' + params + '&brand=cy')).json();
    assert.deepEqual(byBrand.items[0].asins, [two]);
    const byModel = await (await page.request.get(base + endpoint + '?' + params + '&model=305')).json();
    assert.equal(byModel.total, 1); close(byModel.items[0].asin_clicks, 88 / 3);
    const sku = grouped.skuItems.find((r) => r.asin === two);
    const bySku = await (await page.request.get(base + endpoint + '?' + params + '&skuId=' + sku.id)).json();
    assert.deepEqual(bySku.items[0].asins, [two]);
    await page.locator('.topnav').getByRole('button', { name: scope === 'private' ? 'ABA 报告' : 'ABA报告（公共）', exact: true }).click();
    if (scope === 'private') await page.getByRole('button', { name: 'ASIN 视图', exact: true }).click();
    const view = page.locator('.aba-asin-view');
    const idle = () => view.locator('.aba-results[aria-busy="false"]').waitFor();
    const perform = async (fn) => {
      await Promise.all([page.waitForResponse((r) => r.url().includes(endpoint + '?') && !r.url().includes('export=1') && r.status() === 200), fn()]);
      await idle();
    };
    await idle();
    await perform(() => view.getByLabel('词类型', { exact: true }).selectOption('printer'));
    await perform(() => view.getByLabel('显示方式', { exact: true }).selectOption('printers'));
    await perform(() => view.getByRole('button', { name: '全选', exact: true }).click());
    await perform(() => view.getByLabel('多周统计', { exact: true }).selectOption('average'));
    assert.equal(await view.getByLabel('墨盒型号', { exact: true }).inputValue(), '');
    assert.equal(await view.locator('.aba-group-row').count(), 1);
    assert.match(await view.locator('.aba-group-row').innerText(), /合并 2 个 ASIN/);
    assert.doesNotMatch(await view.locator('.aba-group-row').innerText(), /WRONG-304/);
    await view.locator('.aba-group-toggle').click();
    await view.locator('.aba-group-details .aba-table').waitFor();
    assert.equal(await view.locator('.aba-group-details tbody tr').count(), 2);
    assert.match(await view.locator('.aba-group-details').innerText(), /CE-305-BK[\s\S]*CY-305XL-2C/);
    const download = page.waitForEvent('download'); await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
    const book = XLSX.readFile(await (await download).path());
    const cells = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '' });
    assert.equal(cells.length, 4); close(cells.slice(1).reduce((n, r) => n + r[cells[0].indexOf('ASIN 点击')], 0), 36);
    assert.equal(cells.slice(1).reduce((n, r) => n + r[4], 0), 1200);
    const original = cells[0].indexOf('市场IMP(原始总量)');
    assert.ok(original > 0);
    for (const row of cells.slice(1)) {
      assert.equal(row[original], row[2] === 'hp envy6000 rare ink' ? 200 : 1000);
      close(row[cells[0].indexOf('市场CVR(原始总量)')], 0.2);
    }
    assert.deepEqual(new Set(cells.slice(1).map((r) => r[3])), new Set([one, two]));
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp/asin-grouping-' + scope + '.png', import.meta.url)), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await view.getByLabel('隐藏 ASIN / SKU', { exact: true }).check();
    assert.doesNotMatch(await view.locator('.aba-group-row').innerText(), /B000006|CE-305-BK|CY-305XL-2C/);
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp/asin-grouping-' + scope + '-narrow-dark.png', import.meta.url)), fullPage: true });
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await view.locator('.aba-group-toggle').focus(); await page.keyboard.press('Enter');
    assert.equal(await view.locator('.aba-group-details').count(), 0);
    await page.keyboard.press('Enter'); await view.locator('.aba-group-details .aba-table').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  // Reproduce mixed review statuses on the same merged query, including a SKU
  // outside the selected model filter that explains the source ASIN conflict.
  await page.request.post(base + '/api/sku/rows', { data: { rows: [
    { country: 'ES', sku: 'REVIEW-305', brand: 'CE', model: '305', asin: 'B000006005' },
    { country: 'ES', sku: 'REVIEW-WRONG-304', brand: 'CY', model: '304', asin: 'B000006005' },
    { country: 'ES', sku: 'REVIEW-NO-MODEL', brand: 'CE', model: '', asin: 'B000006006' },
  ] } });
  const reviewAsins = ['B000006005', 'B000006006', 'B000006007'];
  await page.request.post(base + '/api/aba/asin/import', { data: { marketplace: 'ES', files: reviewAsins.map((asin) => ({ name: asin + '.csv',
    text: asinFixture({ asin, week: 41, start: '2026-10-04', end: '2026-10-10', rows: [['hp envy6000 ink', 100, 1000, 100, 20, 200, 10, 2]] }) })) } });
  for (const asin of reviewAsins) {
    const task = { ...publicTask, week_start: '2026-10-04', week_end: '2026-10-10', asins_json: JSON.stringify([asin]) };
    const payload = publicFixture(task); payload.dataByAsin = [payload.dataByAsin[0]];
    payload.dataByAsin[0].searchQueryData.searchQuery = 'hp envy6000 ink';
    savePublicReports(backend.db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
  }
  for (const scope of ['private', 'public']) {
    const endpoint = scope === 'private' ? '/api/aba/asin' : '/api/aba-public/asin';
    const response = await (await page.request.get(base + endpoint + '?marketplace=ES&weeks=2026-10-10&view=printers&model=305')).json();
    const issue = response.items[0].alignment.issues.find((r) => r.asin === 'B000006005');
    assert.ok(issue.skus.some((r) => r.sku === 'REVIEW-WRONG-304' && r.status === 'mismatch'));
    await page.locator('.topnav').getByRole('button', { name: scope === 'private' ? 'ABA 报告' : 'ABA报告（公共）', exact: true }).click();
    if (scope === 'private') await page.getByRole('button', { name: 'ASIN 视图', exact: true }).click();
    const view = page.locator('.aba-asin-view'); await view.locator('.aba-results[aria-busy="false"]').waitFor();
    await view.getByLabel('隐藏 ASIN / SKU', { exact: true }).uncheck();
    const reasons = view.locator('.aba-group-row .aba-alignment-details');
    await reasons.locator('summary').click();
    const text = await reasons.innerText();
    for (const value of [...reviewAsins, 'REVIEW-WRONG-304', 'REVIEW-NO-MODEL', '库中型号：304', '库中型号：未填写', '关联 SKU：未关联', '机型对应型号：305']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /CE-305-BK|CY-305XL-2C|请展开明细查看/);
    await view.locator('.aba-group-toggle').click(); await view.locator('.aba-group-details .aba-table').waitFor();
    const nested = view.locator('.aba-group-details .aba-alignment-details');
    await nested.locator('summary').click();
    assert.match(await nested.innerText(), /B000006005[\s\S]*REVIEW-WRONG-304/);
    await view.getByLabel('隐藏 ASIN / SKU', { exact: true }).check();
    assert.doesNotMatch(await nested.innerText(), /B000006005|REVIEW-WRONG-304/);
    assert.match(await nested.innerText(), /取消表头/);
    await view.getByLabel('隐藏 ASIN / SKU', { exact: true }).uncheck();
    for (const display of ['printers', 'queries']) {
      if (display === 'queries') {
        await Promise.all([page.waitForResponse((r) => r.url().includes(endpoint + '?') && r.status() === 200), view.getByLabel('显示方式', { exact: true }).selectOption(display)]);
        await view.locator('.aba-results[aria-busy="false"]').waitFor();
      }
      const file = page.waitForEvent('download'); await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
      const book = XLSX.readFile(await (await file).path());
      const cells = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '' });
      const column = cells[0].indexOf('待核对来源与原因'); assert.ok(column >= 0);
      const details = cells.slice(1).map((r) => r[column]).join('\n');
      for (const value of [...reviewAsins, 'REVIEW-WRONG-304', 'REVIEW-NO-MODEL']) assert.ok(details.includes(value), value);
    }
    const disclosure = view.locator('.aba-alignment-details').first();
    await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
    await disclosure.screenshot({ path: fileURLToPath(new URL('../../.tmp/asin-review-' + scope + '.png', import.meta.url)) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await disclosure.screenshot({ path: fileURLToPath(new URL('../../.tmp/asin-review-' + scope + '-dark.png', import.meta.url)) });
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.deepEqual(errors, []);
  console.log('ASIN grouping passed: private/public one printer across brands and ASINs without selecting a model, three weeks, market deduplication, observed-week averages, drilldown, export, source filters, exact review causes, hidden identities, keyboard and narrow light/dark layout.');
} finally { await browser?.close(); await vite?.close(); await backend.close(); }
