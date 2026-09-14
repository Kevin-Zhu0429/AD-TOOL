import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const backend = await startAbaTestServer();
backend.db.prepare("UPDATE users SET manual_ads = 1 WHERE username = 'aba-test'").run();
let vite;
let browser;

function uploadBuffer() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['广告组合编号', '广告组合名称'],
    ['101', 'SP-CY 540 Series'],
    ['102', 'SP-CY 545 Series'],
    ['199', 'SP-CY 混投'],
  ]), '广告组合库');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function downloadedPortfolio(download) {
  const workbook = XLSX.read(await readFile(await download.path()), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
  const header = rows[0];
  const portfolioAt = header.indexOf('广告组合编号');
  const entityAt = header.indexOf('实体层级');
  return String(rows.find((row) => row[entityAt] === '广告活动')?.[portfolioAt] ?? '');
}

try {
  vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.getByLabel('用户名').fill('aba-test');
  await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const skuResponse = await page.request.post(new URL('/api/sku/rows', page.url()).href, { data: { rows: [
    { country: 'ES', brand: 'CY', model: '540XL', sku: 'TEST-540' },
    { country: 'ES', brand: 'CY', model: '545', sku: 'TEST-545' },
    { country: 'ES', brand: 'CY', model: '575', sku: 'TEST-575' },
  ] } });
  assert.equal(skuResponse.ok(), true);

  await page.locator('.topnav').getByRole('button', { name: '广告组合库', exact: true }).click();
  await page.locator('.portfolio-file input').setInputFiles({
    name: '广告组合库.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: uploadBuffer(),
  });
  await page.getByText(/新增 3 行/).waitFor();
  assert.equal(await page.locator('.portfolio-table-scroll tbody tr').count(), 3);
  assert.match(await page.locator('.portfolio-table-scroll tbody').innerText(), /540 Series[\s\S]*混投/);

  await page.locator('.topnav').getByRole('button', { name: '自动广告', exact: true }).click();
  const autoSku = page.getByPlaceholder('填这个任务要投的 SKU');
  await autoSku.fill('TEST-540');
  await page.getByText(/已自动选择 SP-CY 540 Series/).waitFor();
  let [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '生成总表并下载', exact: true }).click(),
  ]);
  assert.equal(await downloadedPortfolio(download), '101');

  await autoSku.fill('TEST-540\nTEST-545');
  await page.getByText(/多个系列.*已自动选择 SP-CY 混投/).waitFor();
  [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '生成总表并下载', exact: true }).click(),
  ]);
  assert.equal(await downloadedPortfolio(download), '199');

  await autoSku.fill('TEST-575');
  await page.locator('.portfolio-status').filter({ hasText: '没有“575 Series”对应组合' }).waitFor();
  await page.locator('.portfolio-field select').first().selectOption('portfolio:101');
  assert.match(await page.locator('.portfolio-status').innerText(), /已手动选择库内广告组合/);
  [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '生成总表并下载', exact: true }).click(),
  ]);
  assert.equal(await downloadedPortfolio(download), '101');

  await page.locator('.topnav').getByRole('button', { name: '手动广告', exact: true }).click();
  await page.getByPlaceholder('例:ES_SP_KW_301_精准').fill('ES_SP_KW_540_精准');
  await page.getByPlaceholder('这条活动要投的 SKU').fill('TEST-540');
  await page.locator('.unitbox textarea').first().fill('cartuchos hp 540');
  await page.getByText(/已自动选择 SP-CY 540 Series/).waitFor();
  [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '生成总表并下载', exact: true }).click(),
  ]);
  assert.equal(await downloadedPortfolio(download), '101');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.portfolio-field').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + 'portfolio-manual-narrow.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log('portfolio browser workflow passed');
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
