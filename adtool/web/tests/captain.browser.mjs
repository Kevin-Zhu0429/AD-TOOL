import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';

process.env.CAPTAIN_CLIENT_ID = 'browser-client';
process.env.CAPTAIN_CLIENT_SECRET = 'browser-secret';
process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS = '1';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const originalFetch = global.fetch;
const backend = await startAbaTestServer();
const operator = backend.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get();

backend.db.prepare(
  `INSERT INTO captain_channel_bindings
     (user_id, brand, brand_key, country, open_channel_id, channel_name, site_id)
   VALUES (?, 'HP', 'hp', 'DE', 'captain-browser-de', 'HP 德国店', 2)`
).run(operator.id);
backend.db.prepare(
  `INSERT INTO sku_items
     (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
   VALUES (?, 'ES', 'HP', '301', 'BKC', 'BROWSER-SKU', 0, 0, 'ES|browser-sku')`
).run(operator.id);

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'browser-token', expires_in: 3600 });
  if (url.pathname === '/v1/open_user/get_site_list') {
    return Response.json({ code: 200, data: [{ site_id: 2, site_name: '德国', code: 'DE' }] });
  }
  if (url.pathname === '/v1/open_user/get_channel_list') {
    return Response.json({ code: 200, max_result: 1, data: [{
      title: 'HP 德国店', site_id: 2, open_channel_id: 'captain-browser-de', status: 1,
    }] });
  }
  if (url.pathname === '/v1/open_fba/inventory_list') {
    assert.equal(new Headers(options.headers).get('OpenChannelId'), 'captain-browser-de');
    return Response.json({ code: 200, max_result: 1, data: [{
      SKU: 'BROWSER-SKU', asin: 'B012345678', fulfillable_quantity: 42,
      inbound_shipped_quantity: 3, inbound_receiving_quantity: 2,
      inbound_working_quantity: 1, is_delete: 0,
    }] });
  }
  throw new Error(`Unexpected Captain request: ${url}`);
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

  await login('aba-test');
  await page.locator('.topnav').getByRole('button', { name: 'SKU 库', exact: true }).click();
  await page.getByText('HP · DE').waitFor();
  await page.getByRole('button', { name: '同步船长库存', exact: true }).click();
  await page.getByText(/已更新 1 行，读取 1 个库存 SKU/).waitFor();
  const skuRow = page.locator('tbody tr').filter({ hasText: 'BROWSER-SKU' });
  assert.match(await skuRow.innerText(), /42/);
  assert.match(await skuRow.innerText(), /6/);

  await page.getByRole('button', { name: /aba-test/ }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await login('aba-other');
  await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByRole('button', { name: '船长库存', exact: true }).click();
  await page.getByRole('button', { name: '读取船长店铺', exact: true }).click();
  await page.getByText('已读取 1 个库存店铺，包含 1 个真实站点').waitFor();
  assert.equal(await page.locator('.captain-table-scroll').first().getByText('HP 德国店').count(), 1);
  assert.equal(await page.getByLabel('HP 德国店 对应的 SKU 库品牌').inputValue(), 'HP');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '同步全部库存', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log('Captain browser workflow passed');
} finally {
  global.fetch = originalFetch;
  delete process.env.CAPTAIN_CLIENT_ID;
  delete process.env.CAPTAIN_CLIENT_SECRET;
  delete process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS;
  await browser?.close();
  await vite?.close();
  await backend.close();
}
