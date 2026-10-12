// 货件示例数据截图(不是自动化测试):node web/tests/shipments.preview.mjs <输出目录>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startPetTestServer } from '../../server/tests/petHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.PET_TODAY = '2026-10-12';
Object.assign(process.env, { PET_SP_LWA_CLIENT_ID: 'x', PET_SP_LWA_CLIENT_SECRET: 'x', PET_SP_LWA_REFRESH_TOKEN: 'x', PET_SP_SELLER_ID: 'x' });
const backend = await startPetTestServer();
const { db } = backend;
const shift = (days) => new Date(Date.parse('2026-10-12T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

// SKU:在库、日销量、库存接口拆分(可用, 接收中, 处理中, 已发货)(示例数据)
const skus = [
  ['RR22002BKS', '方窝牛津', 'S', 'Black', 18, 3, [10, 8, 0, 120]], ['RR22002BKM', '方窝牛津', 'M', 'Black', 6, 3, [6, 0, 80, 0]],
  ['RR22002BKL', '方窝牛津', 'L', 'Black', 140, 1, [140, 0, 0, 0]], ['RR22002BKXL', '方窝牛津', 'XL', 'Black', 95, 0.5, [95, 0, 0, 0]],
  ['CM22001GRY36', '牛津防水垫子', '36 inch', 'Grey', 36, 2, [0, 36, 0, 0]], ['CM22001GRY42', '牛津防水垫子', '42 inch', 'Grey', 210, 1, [210, 0, 0, 0]],
  ['BM25001AG24', '帆布平垫', '24 inch', 'Army Green', 9, 2, [9, 0, 0, 0]], ['BM25001AG30', '帆布平垫', '30 inch', 'Army Green', 44, 1.5, [44, 0, 0, 60]],
];
const insertSku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, stock, transit, dedupe) VALUES (-1, 'US', ?, ?, ?, ?, ?, ?, ?, ?)");
const insertDetail = db.prepare('INSERT INTO pet_inventory_detail (sku, asin, available, transshipment, receiving, working, shipped) VALUES (?, ?, ?, 0, ?, ?, ?)');
const insertSale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
skus.forEach(([sku, style, size, color, stock, perDay, [available, receiving, working, shipped]], index) => {
  const asin = `B0PET0000${index}`;
  insertSku.run(sku, asin, style, size, color, stock, working + shipped, `us|${sku.toLowerCase()}`);
  insertDetail.run(sku, asin, available, receiving, working, shipped);
  for (let day = 1; day <= 7; day += 1) {
    const units = Math.round(perDay * day) - Math.round(perDay * (day - 1));
    if (units) insertSale.run(shift(day), sku, asin, units, units, units * 30);
  }
});
const insertShipment = db.prepare(`INSERT INTO pet_inbound_shipments (shipment_id, name, status, destination, ship_from, created_day, first_seen_at,
  status_changed_at, shipped_at, receiving_at, closed_at, last_seen_at, items_synced_at) VALUES (?, ?, ?, ?, 'Ningbo, ZJ, CN', ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertItem = db.prepare('INSERT INTO pet_inbound_shipment_items (shipment_id, sku, fnsku, quantity_shipped, quantity_received, quantity_in_case) VALUES (?, ?, ?, ?, ?, ?)');
const shipments = [
  // 编号, 状态, 目的仓, 创建几天前, 进入当前状态几天前, 明细 [sku, 发, 收, 每箱]
  ['FBA18Z3K9QWM', 'WORKING', 'ONT8', 3, 3, [['RR22002BKM', 80, 0, 20]]],
  ['FBA18Y7TQ2PL', 'IN_TRANSIT', 'LGB8', 26, 22, [['RR22002BKS', 120, 0, 20], ['BM25001AG30', 60, 0, 15]]],
  ['FBA18X2MM8RC', 'RECEIVING', 'SBD1', 41, 17, [['CM22001GRY36', 72, 36, 12]]],
  ['FBA18W1LK3DV', 'CLOSED', 'ONT8', 58, 12, [['RR22002BKL', 100, 100, 20], ['RR22002BKXL', 60, 54, 12]]],
  ['FBA18V5HJ7NB', 'CLOSED', 'LGB8', 80, 40, [['CM22001GRY42', 150, 150, 10]]],
  ['FBA18U9GF4XZ', 'CANCELLED', 'ONT8', 35, 30, [['BM25001AG24', 40, 0, 10]]],
];
for (const [id, status, fc, created, since, items] of shipments) {
  const bucket = { WORKING: 0, IN_TRANSIT: 1, RECEIVING: 2, CLOSED: 3, CANCELLED: -1 }[status];
  insertShipment.run(id, `FBA STA (${shift(created).slice(5, 7)}/${shift(created).slice(8)}/2026 10:00)-${fc}`, status, fc, shift(created), ago(created),
    ago(since), bucket >= 1 ? ago(bucket === 1 ? since : created - 10) : null, bucket >= 2 ? ago(bucket === 2 ? since : created - 20) : null,
    bucket === 3 ? ago(since) : null, ago(0.1), ago(0.1));
  for (const [sku, shipped, received, inCase] of items) insertItem.run(id, sku, `X00${sku.slice(-4)}`, shipped, received, inCase);
}
db.prepare("INSERT INTO pet_price_sync_state (key, value) VALUES ('shipments_last_success', ?), ('last_success', ?)")
  .run(JSON.stringify({ completedAt: ago(0.05), startedAt: ago(0.06), shipments: 6, open: 3 }), JSON.stringify({ completedAt: ago(0.08) }));

let vite, browser;
try {
  vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByLabel('用户名').fill('pet-owner'); await page.getByLabel('密码').fill('pet-test-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.locator('.topnav').getByRole('button', { name: '货件', exact: true }).click();
  await page.locator('.ret-findings').waitFor();
  await page.locator('.ret-row').filter({ hasText: 'FBA18X2MM8RC' }).click();
  await page.screenshot({ path: `${output}/货件.png`, fullPage: true });
  await page.getByRole('tab', { name: /按 SKU/ }).click();
  await page.locator('section.card').filter({ hasText: '只看有在途的' }).screenshot({ path: `${output}/货件-按SKU.png` });
  // 价格策略表点「在途」跳过来
  await page.locator('.topnav').getByRole('button', { name: '价格策略表', exact: true }).click();
  await page.locator('.price-table .inv-link').first().waitFor();
  await page.locator('.price-table tr').filter({ hasText: 'RR22002BKS' }).locator('.inv-link').click();
  await page.locator('.shp-focus-card').waitFor();
  await page.screenshot({ path: `${output}/货件-从价格策略表跳转.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${output}/货件-手机.png`, fullPage: true });
  if (errors.length) console.error('page errors', errors);
  console.log('done', output);
} finally {
  await browser?.close(); await vite?.close(); await backend.close();
}
