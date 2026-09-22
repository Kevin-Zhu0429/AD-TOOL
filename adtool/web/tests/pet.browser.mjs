import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';
import { startPetTestServer } from '../../server/tests/petHarness.js';
import { brandFixture } from '../../server/tests/abaFixture.js';
import { asinFixture } from '../../server/tests/abaAsinFixture.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const backend = await startPetTestServer();
let vite, browser;
function workbook(rows, name = 'pet-products.xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '产品数据');
  return { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
try {
  vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const nav = async (name) => page.locator('.topnav').getByRole('button', { name, exact: true }).click();
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.getByLabel('用户名').fill('pet-owner'); await page.getByLabel('密码', { exact: true }).fill('pet-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.topbar-name').filter({ hasText: '宠物广告工作台' }).waitFor();
  assert.equal(await page.getByLabel('切换站点').count(), 0);
  assert.equal(await page.locator('.topnav').getByRole('button', { name: '否定词库' }).count(), 0);
  assert.doesNotMatch(await page.locator('.home').innerText(), /墨盒|打印机/);
  await nav('SKU 库');
  await page.getByLabel('批量添加 SKU').fill('PET-RAIN-L\t雨衣 A 款\tL\t黄色\t防水涂层\t0\t80\tPet Brand\tB000000001\nPET-RAIN-XL\t雨衣 A 款\tXL\t黄色\t防水涂层\t120\t60\tPet Brand\tB000000002');
  await page.getByRole('button', { name: '写入我的库' }).click();
  await page.getByText('新增 2 行', { exact: true }).waitFor();
  const lRow = page.locator('tbody tr').filter({ hasText: 'PET-RAIN-L' });
  await lRow.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('面料外观 PET-RAIN-L', { exact: true }).fill('防水涂层 / 纯色');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await lRow.getByText('防水涂层 / 纯色', { exact: true }).waitFor();
  await page.getByLabel('尺码', { exact: true }).selectOption('L');
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.getByLabel('尺码', { exact: true }).selectOption('');
  await page.getByLabel('每页记录数').selectOption('25');
  await page.screenshot({ path: output + 'pet-sku.png', fullPage: true });

  await nav('自动广告');
  assert.doesNotMatch(await page.locator('.shell-main').innerText(), /打印机|墨盒/);
  await page.getByRole('button', { name: '从 SKU 库选', exact: true }).click();
  await page.getByRole('dialog').getByLabel('尺码', { exact: true }).selectOption('XL');
  assert.equal(await page.getByRole('dialog').locator('.pickrow').count(), 1);
  await page.getByRole('dialog').getByRole('button', { name: '追加填入' }).click();
  assert.equal(await page.getByPlaceholder('填这个任务要投的 SKU').inputValue(), 'PET-RAIN-XL');
  assert.equal(await page.getByRole('option', { name: '自动识别投放 SKU' }).count(), 0);
  await page.getByRole('button', { name: '从 SKU 库选', exact: true }).click();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
  await nav('手动广告');
  assert.doesNotMatch(await page.locator('.shell-main').innerText(), /打印机|墨盒/);

  await nav('产品情报');
  await page.getByLabel('导入产品文件').setInputFiles(workbook([
    ['ASIN', '标题', '款式', '尺码', '颜色', '价格 USD', '对比组', '自家产品'],
    ['B000000001', '黄色宠物雨衣', '雨衣 A 款', 'L', '黄色', 19.99, '同规格雨衣', '是'],
    ['B000000002', '黄色宠物雨衣 XL', '雨衣 A 款', 'XL', '黄色', 23.99, '同规格雨衣', '否'],
  ]));
  await page.getByRole('dialog').getByText(/校验通过，共 2 行/).waitFor();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await page.getByText(/已导入：新增 2 条/).waitFor();
  let productRow = page.locator('tbody tr').filter({ hasText: 'B000000001' });
  await productRow.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('dialog').getByLabel('评分', { exact: true }).fill('8');
  await page.getByRole('button', { name: '保存产品' }).click();
  await page.getByRole('alert').getByText('评分不能超过 5').waitFor();
  await page.getByRole('dialog').getByLabel('评分', { exact: true }).fill('4.5');
  await page.route('**/api/products/B000000001', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '测试保存失败，可重试' }) }), { times: 1 });
  await page.getByRole('button', { name: '保存产品' }).click();
  await page.getByRole('alert').getByText('测试保存失败，可重试').waitFor();
  assert.equal(await page.getByRole('dialog').getByLabel('评分', { exact: true }).inputValue(), '4.5');
  await page.getByRole('button', { name: '保存产品' }).click();
  await page.getByText('产品已保存。', { exact: true }).waitFor();
  await page.getByLabel('对比组', { exact: true }).selectOption('同规格雨衣');
  await page.getByText(/最低 \$19.99，最高 \$23.99/).waitFor();
  await page.screenshot({ path: output + 'pet-products.png', fullPage: true });
  const exportDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出筛选结果' }).click(); await exportDownload;
  await productRow.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await productRow.count(), 1);
  await page.getByRole('button', { name: '添加产品', exact: true }).click();
  await page.getByRole('dialog').getByLabel('ASIN *', { exact: true }).fill('B000000003');
  await page.getByRole('dialog').getByLabel('对比组', { exact: true }).fill('同规格雨衣');
  await page.getByRole('button', { name: '保存产品' }).click();
  const third = page.locator('tbody tr').filter({ hasText: 'B000000003' }); await third.waitFor();
  await third.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除产品', exact: true }).click();
  await page.getByText('已删除 B000000003', { exact: true }).waitFor();
  await page.getByLabel('搜索产品').fill('不存在的产品'); await page.getByText('没有匹配的产品，请调整筛选。').waitFor();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: output + 'pet-narrow.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'product page should not overflow the viewport');
  await page.setViewportSize({ width: 1440, height: 980 });

  await nav('ABA 报告');
  await page.getByLabel('选择品牌视图 CSV', { exact: true }).setInputFiles({ name: 'US_Week.csv', mimeType: 'text/csv', buffer: Buffer.from(brandFixture({ brand: 'Pet Brand', rows: [['dog raincoat', 100, 1000, 100, 100, 12, 20]] })) });
  await page.getByRole('button', { name: '上传并保存', exact: true }).click();
  await page.locator('.aba-table tbody').getByText('dog raincoat', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('词类型', { exact: true }).count(), 0);
  const brandDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Excel', exact: true }).click(); await brandDownload;
  await page.getByRole('button', { name: 'ASIN 视图', exact: true }).click();
  await page.getByLabel('选择ASIN视图 CSV / XLSX', { exact: true }).setInputFiles(['B000000001', 'B000000002'].map((asin) => ({ name: `US_${asin}.csv`, mimeType: 'text/csv', buffer: Buffer.from(asinFixture({ asin, rows: [['dog raincoat', 100, 1000, 100, 20, 200, 10, 5]] })) })));
  await page.getByRole('button', { name: '上传并保存', exact: true }).click();
  await page.getByLabel('尺码', { exact: true }).selectOption('XL');
  await page.locator('.aba-table tbody').getByText('PET-RAIN-XL', { exact: false }).waitFor();
  assert.equal(await page.locator('.aba-table tbody tr').count(), 1);
  assert.doesNotMatch(await page.locator('.aba-asin-view').innerText(), /墨盒|打印机|机型/);
  await page.screenshot({ path: output + 'pet-aba.png', fullPage: true });
  const asinDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 Excel', exact: true }).click(); await asinDownload;

  await nav('广告优化');
  const ads = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(ads, XLSX.utils.json_to_sheet([
    { Product: 'Sponsored Products', Entity: 'Campaign', 'Campaign ID': 'c1', 'Campaign Name': '美国宠物雨衣', State: 'enabled', 'Daily Budget': 30 },
    { Product: 'Sponsored Products', Entity: 'Ad Group', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad Group Name': 'Rain', State: 'enabled', 'Ad Group Default Bid': 0.5 },
    { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad ID': 'a1', SKU: 'PET-RAIN-L', ASIN: 'B000000001', State: 'enabled', Impressions: 300, Clicks: 18, Spend: 18, Orders: 0, Sales: 0 },
  ]), 'Sponsored Products Campaigns');
  await page.locator('#fileA').setInputFiles({ name: 'US-pet-ads.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(ads, { type: 'buffer', bookType: 'xlsx' }) });
  await page.locator('[data-view="analysis"]').click();
  await page.locator('.inventory-alert').waitFor();
  assert.match(await page.locator('.inventory-alert').innerText(), /\$18\.00/);
  assert.equal(await page.getByRole('button', { name: '跑偏词检测（Beta）' }).count(), 0);
  await page.screenshot({ path: output + 'pet-optimizer.png', fullPage: true });
  await nav('价格策略表');
  await page.getByRole('button', { name: '添加记录' }).click();
  await page.getByRole('dialog').getByLabel('SKU *').fill('PET-RAIN-L');
  await page.getByRole('dialog').getByLabel('售价').fill('19.99');
  await page.getByRole('dialog').getByRole('button', { name: '保存记录' }).click();
  await page.locator('.price-table tbody tr').filter({ hasText: 'PET-RAIN-L' }).waitFor();
  await page.screenshot({ path: output + 'pet-price-strategy.png', fullPage: true });
  await nav('账号管理'); assert.doesNotMatch(await page.locator('.shell-main').innerText(), /B\/C\/D\/E|干扰墨盒/);
  assert.deepEqual(errors, []);
  console.log('Pet browser passed: US-only, SKU variants, picker keyboard, product import/edit/retry/delete/export, narrow viewport, ABA linkage/export and optimizer inventory.');
} finally { await browser?.close(); await vite?.close(); await backend.close(); }
