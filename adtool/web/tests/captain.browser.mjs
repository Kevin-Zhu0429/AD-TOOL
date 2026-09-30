import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';

const brandEnv = {
  BRAND1_NAME: 'HP',
  BRAND1_MARKETS: 'ES,DE,FR',
  BRAND1_LWA_CLIENT_ID: 'hp-client',
  BRAND1_LWA_CLIENT_SECRET: 'hp-secret',
  BRAND1_LWA_REFRESH_TOKEN_EU: 'Atzr|browser-hp',
  BRAND1_SELLER_ID_EU: 'SELLERHP',
  BRAND2_NAME: 'CC',
  BRAND2_MARKETS: 'ES,DE,FR',
  BRAND2_LWA_CLIENT_ID: 'cc-client',
  BRAND2_LWA_CLIENT_SECRET: 'cc-secret',
  BRAND2_LWA_REFRESH_TOKEN_EU: 'Atzr|browser-cc',
  BRAND2_SELLER_ID_EU: 'SELLERCC',
};
Object.assign(process.env, brandEnv);

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const originalFetch = global.fetch;
const backend = await startAbaTestServer();
const users = Object.fromEntries(backend.db.prepare(
  "SELECT id, username FROM users WHERE username IN ('aba-test', 'aba-other', 'aba-de')"
).all().map((row) => [row.username, row.id]));
const insertSku = backend.db.prepare(
  `INSERT INTO sku_items
     (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
   VALUES (?, ?, 'HP', '301', 'BKC', 'BROWSER-SKU', 0, 0, ?)`
);
insertSku.run(users['aba-test'], 'ES', 'ES|browser-sku');
insertSku.run(users['aba-de'], 'DE', 'DE|browser-sku');
insertSku.run(users['aba-other'], 'FR', 'FR|browser-sku');
backend.db.prepare(
  `INSERT INTO sku_items
     (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
   VALUES (?, 'ES', 'HP', '302', 'BK', 'ZERO-SKU-BROWSER', 0, 0, 'ES|zero-sku-browser')`
).run(users['aba-test']);

const { spApiTiming } = await import('../../server/src/spApi.js');
spApiTiming.minIntervalMs = 0;
const MARKETPLACE = { ES: 'A1RKKUPIHCS9HS', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH' };
const countryOf = Object.fromEntries(Object.entries(MARKETPLACE).map(([country, id]) => [id, country]));
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.host === 'api.amazon.com') {
    const refreshToken = new URLSearchParams(String(options.body)).get('refresh_token');
    return Response.json({ access_token: refreshToken.replace('Atzr|', 'token-'), expires_in: 3600 });
  }
  assert.equal(url.host, 'sellingpartnerapi-eu.amazon.com');
  const token = new Headers(options.headers).get('x-amz-access-token');
  if (url.pathname === '/sellers/v1/marketplaceParticipations') {
    return Response.json({ payload: Object.values(MARKETPLACE).map((id) => ({
      marketplace: { id }, participation: { isParticipating: true, hasSuspendedListings: false },
    })) });
  }
  if (url.pathname === '/fba/inventory/v1/summaries') {
    // 只有 HP 分配了负责人,CC 的店铺不该被拉
    assert.equal(token, 'token-browser-hp');
    assert.ok(countryOf[url.searchParams.get('marketplaceIds')]);
    return Response.json({ payload: { inventorySummaries: [{
      sellerSku: 'BROWSER-SKU', asin: 'B012345678',
      inventoryDetails: {
        fulfillableQuantity: 20, inboundShippedQuantity: 1, inboundReceivingQuantity: 0, inboundWorkingQuantity: 0,
      },
    }] } });
  }
  throw new Error(`Unexpected Amazon request: ${url}`);
};

let vite;
let browser;
try {
  vite = await createServer({
    root,
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } },
  });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  async function login(username) {
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill('local-test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  async function logout(username) {
    await page.getByRole('button', { name: new RegExp(username) }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
  }

  await login('aba-other');
  await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByRole('button', { name: '亚马逊库存', exact: true }).click();
  await page.getByText('已配置品牌：HP（欧洲 SELLERHP）、CC（欧洲 SELLERCC）').waitFor();
  await page.getByRole('button', { name: '读取亚马逊店铺', exact: true }).click();
  await page.getByText('已读取 2 个库存店铺，包含 6 个真实站点').waitFor();
  assert.equal(await page.getByLabel('CC_EU 对应的 SKU 库品牌').inputValue(), 'CC');
  assert.equal(await page.getByLabel('CC_EU ES 负责人').inputValue(), '');
  assert.equal(await page.getByLabel('CC_EU ES 负责人').locator('option').first().innerText(), '该国家暂无账号有此品牌 SKU');
  assert.equal(await page.getByLabel('HP_EU 对应的 SKU 库品牌').inputValue(), 'HP');
  assert.equal(await page.getByLabel('HP_EU ES 负责人').inputValue(), String(users['aba-test']));
  assert.equal(await page.getByLabel('HP_EU DE 负责人').inputValue(), String(users['aba-de']));
  assert.equal(await page.getByLabel('HP_EU FR 负责人').inputValue(), String(users['aba-other']));
  await page.getByLabel('HP_EU DE 负责人').selectOption('');
  await page.getByLabel('HP_EU FR 负责人').selectOption('');
  await page.locator('tbody tr').filter({ hasText: 'HP_EU' }).getByRole('button', { name: '保存分配', exact: true }).click();
  await page.getByText(/HP_EU 已绑定 ES/).waitFor();
  await page.getByRole('button', { name: '同步全部库存', exact: true }).click();
  await page.getByText(/已处理 1 个账号，更新 1 行/).waitFor();
  assert.equal(await page.getByText('部分绑定 1/3').count(), 1);

  await logout('aba-other');
  await login('aba-test');
  await page.locator('.topnav').getByRole('button', { name: 'SKU 库', exact: true }).click();
  await page.getByText('HP · ES').waitFor();
  assert.equal(await page.getByText('HP · DE').count(), 0);
  assert.match(await page.locator('.sku-zero-summary').innerText(), /1 个 SKU 在库为 0/);
  assert.match(await page.locator('tbody tr').filter({ hasText: 'ZERO-SKU-BROWSER' }).innerText(), /已断货/);
  // 超级管理员统一同步时 BROWSER-SKU 在库 0 → 20,算这个账号的一次补货
  const changePanel = page.locator('.sku-change');
  assert.match(await changePanel.innerText(), /新断货 0 个，补货 1 个/);
  assert.match(await changePanel.locator('.sku-change-col.restock').innerText(), /本次补货 1[\s\S]*ES · BROWSER-SKU[\s\S]*在库 0 → 20/);
  const skuRow = page.locator('tbody tr').filter({ hasText: 'BROWSER-SKU' }).filter({ hasNotText: 'ZERO' });
  assert.match(await skuRow.innerText(), /已补货/);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/sku-stock-change.png`, fullPage: true });

  await page.getByRole('button', { name: '同步亚马逊库存', exact: true }).click();
  await page.getByText(/已更新 1 行，读取 3 个库存 SKU；新断货 0 个，补货 0 个/).waitFor();
  assert.match(await skuRow.innerText(), /20/);
  assert.match(await skuRow.innerText(), /1/);
  assert.match(await page.locator('.sku-zero-summary').innerText(), /1 个 SKU 在库为 0/);
  assert.match(await changePanel.innerText(), /这次同步没有新断货或补货/);
  assert.match(await skuRow.innerText(), /已补货/);
  await changePanel.getByRole('button', { name: '只看已补货 1', exact: true }).click();
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.getByLabel('按库存状态筛选').selectOption('');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/sku-stock-change-narrow.png`, fullPage: true });
  assert.deepEqual(pageErrors, []);
  console.log('Amazon inventory country assignment browser workflow passed');
} finally {
  global.fetch = originalFetch;
  for (const key of Object.keys(brandEnv)) delete process.env[key];
  await browser?.close();
  await vite?.close();
  await backend.close();
}
