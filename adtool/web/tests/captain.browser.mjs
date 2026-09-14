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

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'browser-token', expires_in: 3600 });
  if (url.pathname === '/v1/open_user/get_site_list') {
    return Response.json({ code: 200, data: [
      { site_id: 1, code: 'ES' }, { site_id: 2, code: 'DE' }, { site_id: 3, code: 'FR' },
    ] });
  }
  if (url.pathname === '/v1/open_user/get_channel_list') {
    return Response.json({ code: 200, max_result: 6, data: [
      { title: 'CC_EU_ES', site_id: 1, open_channel_id: 'captain-browser-cc-es', status: 1 },
      { title: 'CC_EU_DE', site_id: 2, open_channel_id: 'captain-browser-cc-de', status: 1 },
      { title: 'CC_EU_FR', site_id: 3, open_channel_id: 'captain-browser-cc-fr', status: 1 },
      { title: 'HP_EU_ES', site_id: 1, open_channel_id: 'captain-browser-es', status: 1 },
      { title: 'HP_EU_DE', site_id: 2, open_channel_id: 'captain-browser-de', status: 1 },
      { title: 'HP_EU_FR', site_id: 3, open_channel_id: 'captain-browser-fr', status: 1 },
    ] });
  }
  if (url.pathname === '/v1/open_fba/inventory_list') {
    const channel = new Headers(options.headers).get('OpenChannelId');
    const stock = { 'captain-browser-es': 20, 'captain-browser-de': 20, 'captain-browser-fr': 20 }[channel];
    assert.ok(stock);
    return Response.json({ code: 200, max_result: 1, data: [{
      SKU: 'BROWSER-SKU', asin: 'B012345678', fulfillable_quantity: stock,
      inbound_shipped_quantity: 1, inbound_receiving_quantity: 0,
      inbound_working_quantity: 0, is_delete: 0,
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
  async function logout(username) {
    await page.getByRole('button', { name: new RegExp(username) }).click();
    await page.getByRole('button', { name: '退出登录' }).click();
  }

  await login('aba-other');
  await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByRole('button', { name: '船长库存', exact: true }).click();
  await page.getByRole('button', { name: '读取船长店铺', exact: true }).click();
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
  await page.getByRole('button', { name: '同步船长库存', exact: true }).click();
  await page.getByText(/已更新 1 行，读取 3 个库存 SKU/).waitFor();
  const skuRow = page.locator('tbody tr').filter({ hasText: 'BROWSER-SKU' });
  assert.match(await skuRow.innerText(), /20/);
  assert.match(await skuRow.innerText(), /1/);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log('Captain country assignment browser workflow passed');
} finally {
  global.fetch = originalFetch;
  delete process.env.CAPTAIN_CLIENT_ID;
  delete process.env.CAPTAIN_CLIENT_SECRET;
  delete process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS;
  await browser?.close();
  await vite?.close();
  await backend.close();
}
