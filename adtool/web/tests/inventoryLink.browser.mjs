import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });

const library = { libs: [], items: {} };
const initialSkus = [
  { sku: 'ZERO-SKU', stock: 0, transit: 30 },
  { sku: 'GOOD-SKU', stock: 24, transit: 0 },
  { sku: 'UNKNOWN-SKU', stock: null, transit: null },
];
const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><title>库存联动回归验证</title><link rel="stylesheet" href="/src/index.css"><style>html,body{margin:0;width:100%;height:100%}#host{height:100vh}</style></head><body><div id="host" data-theme="light"></div><script type="module">
import {mountOptimizer} from '/src/optApp.js';
import css from '/src/components/optimizer.css?inline';
const host=document.querySelector('#host');const shadow=host.attachShadow({mode:'open'});
const style=document.createElement('style');style.textContent=css;shadow.append(style);
const mount=document.createElement('div');shadow.append(mount);
const app=mountOptimizer(mount,host);
const library=${JSON.stringify(library)};
window.updateInventory=(items)=>app.setLibrary('ES',library,'',items);
window.updateInventory(${JSON.stringify(initialSkus)});
</script></body></html>`;
const vite = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'inventory-link-test-harness',
    configureServer(server) {
      server.middlewares.use('/__inventory-link-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
    },
  }],
});
await vite.listen();

function workbook() {
  const wb = XLSX.utils.book_new();
  const rows = [
    { Product: 'Sponsored Products', Entity: 'Campaign', 'Campaign ID': 'c1', 'Campaign Name': '库存风险验证', State: 'enabled', 'Daily Budget': 30 },
    { Product: 'Sponsored Products', Entity: 'Ad Group', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad Group Name': '组一', State: 'enabled', 'Ad Group Default Bid': 0.5 },
    { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad ID': 'a1', SKU: 'zero-sku', ASIN: 'B000000001', State: 'enabled', Impressions: 300, Clicks: 18, Spend: 18, Orders: 0, Sales: 0 },
    { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad ID': 'a2', SKU: 'GOOD-SKU', ASIN: 'B000000002', State: 'enabled', Impressions: 200, Clicks: 8, Spend: 6, Orders: 2, Sales: 40 },
    { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad ID': 'a3', SKU: 'UNKNOWN-SKU', ASIN: 'B000000003', State: 'enabled', Impressions: 50, Clicks: 1, Spend: 1, Orders: 0, Sales: 0 },
    { Product: 'Sponsored Products', Entity: 'Product Ad', 'Campaign ID': 'c1', 'Ad Group ID': 'g1', 'Ad ID': 'a4', SKU: 'BACK-SKU', ASIN: 'B000000004', State: 'paused', Impressions: 0, Clicks: 0, Spend: 0, Orders: 0, Sales: 0 },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sponsored Products Campaigns');
  return {
    name: 'inventory-link.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
  };
}

let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__inventory-link-test`);
  await page.locator('#fileA').setInputFiles(workbook());
  await page.locator('[data-view="analysis"]').click();

  const zeroRow = page.locator('tr[data-anexp="zero-sku"]');
  await zeroRow.waitFor();
  assert.equal(await zeroRow.evaluate((row) => row.classList.contains('stock-zero')), true);
  assert.match(await zeroRow.locator('.inventory-cell').innerText(), /在库 0[\s\S]*在途 30/);
  assert.match(await page.locator('.inventory-alert').innerText(), /发现 1 项[\s\S]*18 次点击[\s\S]*€18\.00/);
  assert.match(await page.locator('tr[data-anexp="UNKNOWN-SKU"] .inventory-cell').innerText(), /库存未填写/);

  await page.locator('[data-anmark="stock"]').click();
  assert.equal(await page.locator('.antbl tbody > tr.anrow').count(), 1);
  await page.screenshot({ path: output + 'inventory-link-desktop.png' });

  await page.setViewportSize({ width: 520, height: 820 });
  await page.screenshot({ path: output + 'inventory-link-narrow.png' });
  assert.equal(await zeroRow.count(), 1);

  await page.setViewportSize({ width: 1500, height: 920 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.querySelector('#host').dataset.theme = 'dark';
  });
  await page.screenshot({ path: output + 'inventory-link-dark.png' });

  await page.evaluate(() => window.updateInventory([
    { sku: 'ZERO-SKU', stock: 12, transit: 0 },
    { sku: 'GOOD-SKU', stock: 24, transit: 0 },
    { sku: 'UNKNOWN-SKU', stock: null, transit: null },
  ]));
  assert.equal(await page.locator('.inventory-alert').count(), 0);
  assert.equal(await page.locator('tr.stock-zero').count(), 0);

  // 船长同步:ZERO-SKU 新断货但广告还在投,BACK-SKU 补货但广告还停着
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.querySelector('#host').dataset.theme = 'light';
  });
  await page.evaluate(() => window.updateInventory([
    { sku: 'ZERO-SKU', stock: 0, transit: 0, stockEvent: { kind: 'out', at: '2026-09-28 09:30:00', prevStock: 40 } },
    { sku: 'GOOD-SKU', stock: 24, transit: 0 },
    { sku: 'UNKNOWN-SKU', stock: null, transit: null },
    { sku: 'BACK-SKU', stock: 15, transit: 0, stockEvent: { kind: 'restock', at: '2026-09-28 09:30:00', prevStock: 0 } },
  ]));
  // 按活动优化的 SKU 页签:在投的新断货 SKU 建议关闭,暂停的补货 SKU 建议开启
  await page.locator('[data-view="work"]').click();
  await page.locator('#raillist .crow').first().click();
  await page.locator('[data-tab="sku"]').click();
  assert.equal(await page.locator('.flagchip', { hasText: '新断货 · 建议关闭' }).count(), 1);
  assert.equal(await page.locator('.flagchip', { hasText: '已补货 · 可重新开启' }).count(), 1);
  await page.locator('[data-view="analysis"]').click();

  await page.locator('[data-anmark=""]').click();
  const alert = page.locator('.inventory-alert');
  assert.match(await alert.innerText(), /其中 1 个 SKU 是最近一次船长同步新断货[\s\S]*还有 1 条商品广告在投/);
  assert.match(await zeroRow.locator('.inventory-cell').innerText(), /新断货[\s\S]*1 条广告在投/);
  const restock = page.locator('.stock-act.restock');
  assert.match(await restock.innerText(), /已补货 1 个 SKU[\s\S]*有 1 条商品广告还处于暂停/);
  const backRow = page.locator('tr[data-anexp="BACK-SKU"]');
  assert.equal(await backRow.evaluate((row) => row.classList.contains('stock-restock')), true);
  assert.match(await backRow.locator('.inventory-cell').innerText(), /已补货[\s\S]*1 条广告暂停中/);
  await page.locator('[data-anmark="newout"]').click();
  assert.equal(await page.locator('.antbl tbody > tr.anrow').count(), 1);
  await page.locator('[data-anmark="restock"]').click();
  assert.equal(await page.locator('.antbl tbody > tr.anrow').count(), 1);
  await page.locator('[data-anmark=""]').click();
  await page.screenshot({ path: output + 'inventory-stock-change.png' });

  await page.locator('[data-stockact="pause"]').click();
  assert.match(await alert.innerText(), /这些 SKU 的广告已经都关了/);
  assert.equal(await page.locator('[data-stockact="pause"]').count(), 0);
  await page.locator('[data-stockact="enable"]').click();
  assert.match(await restock.innerText(), /这些 SKU 的广告都已在投放/);
  assert.match(await page.locator('#chgCount').innerText(), /2 处改动/);

  assert.deepEqual(errors, []);
  console.log('Inventory-linked SKU matrix browser workflow passed');
} finally {
  await browser?.close();
  await vite.close();
}
