// 退货分析示例数据截图(不是自动化测试):node web/tests/returns.preview.mjs <输出目录>
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
process.env.PET_TODAY = '2026-10-10';
Object.assign(process.env, { PET_SP_LWA_CLIENT_ID: 'x', PET_SP_LWA_CLIENT_SECRET: 'x', PET_SP_LWA_REFRESH_TOKEN: 'x', PET_SP_SELLER_ID: 'x' });
const backend = await startPetTestServer();
const { db } = backend;
const shift = (days) => new Date(Date.parse('2026-10-10T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);

// SKU、30 天销量、退货(示例数据)
const skus = [
  ['RR22002BKS', '方窝牛津', 'S', 'Black', 70], ['RR22002BKM', '方窝牛津', 'M', 'Black', 95], ['RR22002BKL', '方窝牛津', 'L', 'Black', 40], ['RR22002BKXL', '方窝牛津', 'XL', 'Black', 22],
  ['CM22001GRY36', '牛津防水垫子', '36 inch', 'Grey', 60], ['CM22001GRY42', '牛津防水垫子', '42 inch', 'Grey', 28],
  ['BM25001AG24', '帆布平垫', '24 inch', 'Army Green', 55], ['RR26001BRM', '灯芯绒窝', 'M', 'Brown', 9],
];
const insertSku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', ?, ?, ?, ?, ?, ?)");
const insertSale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
skus.forEach(([sku, style, size, color, units], index) => {
  const asin = `B0PET0000${index}`;
  insertSku.run(sku, asin, style, size, color, `us|${sku.toLowerCase()}`);
  for (let day = 0; day < 30; day += 1) {
    const count = Math.floor(units / 30) + (day < units % 30 ? 1 : 0);
    if (count) insertSale.run(shift(day), sku, asin, count, count, count * 30);
  }
});
const insertReturn = db.prepare(`INSERT INTO pet_returns (day, returned_at, order_id, sku, asin, quantity, fulfillment_center, disposition, reason, status, comments)
  VALUES (?, ?, ?, ?, ?, 1, 'LGB8', ?, ?, 'Unit returned to inventory', ?)`);
const returns = [
  ['RR22002BKS', 'APPAREL_TOO_SMALL', 'Too small for my 25 lb beagle, she hangs off the edge'], ['RR22002BKS', 'APPAREL_TOO_SMALL', 'Runs small. Need to size up'],
  ['RR22002BKS', 'APPAREL_TOO_SMALL', ''], ['RR22002BKS', 'APPAREL_TOO_SMALL', 'smaller than expected'], ['RR22002BKS', 'NOT_AS_DESCRIBED', 'Much thinner than the picture, pretty flat'],
  ['RR22002BKS', 'UNWANTED_ITEM', ''], ['RR22002BKS', 'APPAREL_TOO_SMALL', 'my dog could not fit'], ['RR22002BKS', 'DEFECTIVE', 'Zipper broke on first wash', 'DEFECTIVE'],
  ['RR22002BKM', 'APPAREL_TOO_SMALL', 'too small'], ['RR22002BKM', 'UNWANTED_ITEM', 'Dog would not lay on it'], ['RR22002BKM', 'NOT_AS_DESCRIBED', 'Not waterproof, pee soaked into the cushion', 'CUSTOMER_DAMAGED'],
  ['RR22002BKM', 'ORDERED_WRONG_ITEM', 'ordered wrong size'],
  ['RR22002BKXL', 'APPAREL_TOO_LARGE', 'way too big for our corgi'], ['RR22002BKXL', 'APPAREL_TOO_LARGE', ''],
  ['CM22001GRY36', 'NOT_AS_DESCRIBED', 'Not waterproof, it leaked through to the crate floor', 'CUSTOMER_DAMAGED'], ['CM22001GRY36', 'QUALITY_UNACCEPTABLE', 'seam ripped in two days', 'DEFECTIVE'],
  ['CM22001GRY36', 'DAMAGED_BY_CARRIER', '', 'CARRIER_DAMAGED'], ['CM22001GRY36', 'NOT_AS_DESCRIBED', 'Not waterproof as advertised'],
  ['CM22001GRY42', 'APPAREL_TOO_SMALL', "doesn't fit our 42 inch crate"],
  ['BM25001AG24', 'NOT_AS_DESCRIBED', 'Color is different from the picture, more brown than green'], ['BM25001AG24', 'DID_NOT_LIKE_FABRIC', 'fabric is stiff and hard'],
  ['BM25001AG24', 'UNWANTED_ITEM', ''], ['BM25001AG24', 'SWITCHEROO', 'Returned item is a different brand', 'CUSTOMER_DAMAGED'],
  ['RR26001BRM', 'NOT_AS_DESCRIBED', 'Not orthopedic at all, just poly filling', 'SELLABLE'],
];
returns.forEach(([sku, reason, comment, disposition = 'SELLABLE'], index) => {
  const day = shift(1 + (index * 7) % 28);
  const asin = `B0PET0000${skus.findIndex((row) => row[0] === sku)}`;
  insertReturn.run(day, `${day}T18:00:00+00:00`, `113-0000-${index}`, sku, asin, disposition, reason, comment || null);
});
db.prepare("INSERT INTO pet_price_sync_state (key, value) VALUES ('returns_coverage', ?), ('returns_last_success', ?)")
  .run(JSON.stringify({ from: shift(179), to: '2026-10-10' }), JSON.stringify({ completedAt: '2026-10-10T02:15:00Z', windows: 1, saved: returns.length }));

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
  await page.locator('.topnav').getByRole('button', { name: '退货分析', exact: true }).click();
  await page.locator('.ret-findings').waitFor();
  await page.screenshot({ path: `${output}/退货分析.png`, fullPage: true });
  await page.locator('section.card').filter({ hasText: '按款式' }).screenshot({ path: `${output}/退货分析-按款式.png` });
  await page.locator('.ret-row').first().click();
  await page.locator('.ret-records').waitFor();
  await page.locator('section.card').filter({ hasText: '每个 SKU' }).screenshot({ path: `${output}/退货分析-SKU明细.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${output}/退货分析-手机.png`, fullPage: true });
  if (errors.length) console.error('page errors', errors);
  console.log('done', output);
} finally {
  await browser?.close(); await vite?.close(); await backend.close();
}
