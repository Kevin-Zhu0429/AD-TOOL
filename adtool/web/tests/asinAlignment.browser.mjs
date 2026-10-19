import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';
import { asinFixture } from '../../server/tests/abaAsinFixture.js';
import { publicFixture, publicTask } from '../../server/tests/abaPublicFixture.js';
import { savePublicReports } from '../../server/src/services/publicAsinData.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const XLSX = require('xlsx');
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const backend = await startAbaTestServer();
backend.db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)')
  .run('D', 'EU', 'HP', '305', 'ENVY', '6000', 'envy-browser-alignment');
let vite, browser;
try {
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
  await page.goto(base);
  await page.getByLabel('用户名').fill('aba-test'); await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.topnav').getByRole('button', { name: 'ABA 报告', exact: true }).waitFor();
  await page.request.post(base + '/api/sku/rows', { data: { rows: [
    { country: 'ES', sku: 'ENVY-WRONG-304', model: '304', brand: 'CE', asin: 'B000004304' },
    { country: 'ES', sku: 'ENVY-RIGHT-305', model: '305XL', brand: 'CE', asin: 'B000004305' },
  ] } });
  const files = ['B000004304', 'B000004305'].map((asin) => ({ name: asin + '.csv', text: asinFixture({ asin, rows: [['hp envy6000 ink', 100, 1000, 100, 20, 200, 10, 5]] }) }));
  await page.request.post(base + '/api/aba/asin/import', { data: { marketplace: 'ES', files } });
  for (const asin of ['B000004304', 'B000004305']) {
    const task = { ...publicTask, asins_json: JSON.stringify([asin]) };
    const payload = publicFixture(task);
    payload.dataByAsin = [payload.dataByAsin[0]]; payload.dataByAsin[0].searchQueryData.searchQuery = 'hp envy6000 ink';
    savePublicReports(backend.db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
  }
  for (const scope of ['private', 'public']) {
    await page.locator('.topnav').getByRole('button', { name: scope === 'private' ? 'ABA 报告' : 'ABA报告（公共）', exact: true }).click();
    if (scope === 'private') await page.getByRole('button', { name: 'ASIN 视图', exact: true }).click();
    const view = page.locator('.aba-asin-view');
    const idle = () => view.locator('.aba-results[aria-busy="false"]').waitFor();
    const choose = async (label, value) => {
      const select = view.getByLabel(label, { exact: true });
      if (await select.inputValue() === value) return;
      await Promise.all([
        page.waitForResponse((r) => r.url().includes(scope === 'private' ? '/api/aba/asin?' : '/api/aba-public/asin?') && !r.url().includes('export=1') && r.status() === 200),
        select.selectOption(value),
      ]);
      await idle();
    };
    await idle();
    assert.equal(await view.getByLabel('机型与 SKU', { exact: true }).inputValue(), 'normal');
    assert.match(await view.locator('.aba-table tbody').innerText(), /ENVY-RIGHT-305/);
    assert.doesNotMatch(await view.locator('.aba-table tbody').innerText(), /ENVY-WRONG-304/);
    assert.match(await view.innerText(), /已排除 1 条/);
    const defaultFile = page.waitForEvent('download');
    await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
    const defaultBook = XLSX.readFile(await (await defaultFile).path());
    const defaultCells = XLSX.utils.sheet_to_json(defaultBook.Sheets[defaultBook.SheetNames[0]], { header: 1, defval: '' });
    assert.equal(defaultCells.length, 2);
    assert.equal(defaultCells[1][3], 'B000004305');
    await choose('墨盒型号', '304');
    assert.match(await view.locator('.aba-table-empty').innerText(), /不匹配数据已全部排除.*保留不匹配数据/s);
    await choose('墨盒型号', '');
    await choose('显示方式', 'printers');
    assert.equal(await view.locator('.aba-group-row').count(), 1);
    await choose('机型与 SKU', 'mismatch');
    const mismatch = view.locator('.aba-group-row');
    assert.match(await mismatch.innerText(), /机型对应 305.*来源 SKU 是 304/);
    assert.match(await mismatch.innerText(), /ENVY-WRONG-304/);
    await mismatch.locator('.aba-group-toggle').click(); await view.locator('.aba-group-details .aba-table').waitFor();
    assert.match(await view.locator('.aba-group-details').innerText(), /型号不匹配/);
    for (const display of ['printers', 'queries']) {
      if (display === 'queries') await choose('显示方式', display);
      const file = page.waitForEvent('download'); await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
      const book = XLSX.readFile(await (await file).path());
      const cells = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '' });
      assert.equal(cells[1][cells[0].indexOf('机型与 SKU 对应')], '型号不匹配');
      assert.equal(cells[1][3], 'B000004304');
      assert.equal(cells[1][cells[0].indexOf('ASIN 购买')], 5); // purchases stay on 304, never transferred to the 305 ASIN
    }
    await choose('机型与 SKU', 'all');
    assert.equal(await view.locator('.aba-table tbody tr').count(), 2);
    await page.screenshot({ path: output + 'asin-alignment-' + scope + '.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await view.getByLabel('机型与 SKU', { exact: true }).focus();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.deepEqual(errors, []);
  console.log('ASIN alignment browser passed: private/public default exclusion, mismatch drilldown, unchanged source purchases, both Excel formats, all-record toggle, narrow layout and keyboard.');
} finally { await browser?.close(); await vite?.close(); await backend.close(); }
