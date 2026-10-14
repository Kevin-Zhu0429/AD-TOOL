import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from '../../server/node_modules/express/index.js';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const backend = await startAbaTestServer();
const { mountMcp } = await import('../../server/src/mcp.js');
const app = express(); app.use(express.json());
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const url = `http://127.0.0.1:${server.address().port}`;
mountMcp(app, { publicUrl: url });
app.get('/oauth-test-callback', (_req, res) => res.send('OAuth completed'));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url)); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const registered = await (await fetch(url + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: '浏览器验证', redirect_uris: [url + '/oauth-test-callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: registered.client_id,
    redirect_uri: url + '/oauth-test-callback', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', scope: 'ink:read ink:write', resource: url + '/mcp' });
  const authUrl = url + '/authorize?' + params;
  await page.goto(authUrl);
  assert.match(await page.title(), /墨盒/);
  await page.getByRole('button', { name: '登录并授权' }).click();
  assert.match(await page.getByRole('alert').innerText(), /请填写/);
  assert.equal(await page.locator('#u').evaluate((el) => document.activeElement === el), true);
  await page.getByLabel('网站用户名').fill('aba-test');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '显示密码' }).click(); assert.equal(await page.locator('#p').getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏密码' }).click(); assert.equal(await page.locator('#p').getAttribute('type'), 'password');
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: '登录并授权' }).click()]);
  assert.match(await page.getByRole('alert').innerText(), /用户名或密码错误/);
  assert.equal(await page.getByLabel('网站用户名').inputValue(), 'aba-test');
  assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
  await page.setViewportSize({ width: 360, height: 780 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: output + 'mcp-auth-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1100, height: 850 }); await page.goto(authUrl);
  await page.screenshot({ path: output + 'mcp-auth-desktop.png', fullPage: true });
  assert.equal(await page.locator('#u').evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press('Tab'); assert.equal(await page.locator('#p').evaluate((el) => document.activeElement === el), true);
  params.delete('scope'); await page.goto(url + '/authorize?' + params);
  assert.match(await page.locator('main').innerText(), /读写授权/);
  assert.match(await page.locator('main').innerText(), /Listing 修改及变体关系到亚马逊/);
  assert.equal(await page.locator('input[name=scope]').inputValue(), 'ink:read ink:write');
  params.set('scope', 'ink:read'); await page.goto(url + '/authorize?' + params);
  assert.match(await page.locator('main').innerText(), /只读授权/); assert.doesNotMatch(await page.locator('main').innerText(), /读写授权/);
  await page.getByLabel('网站用户名').fill('aba-test'); await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await Promise.all([page.waitForURL(url + '/oauth-test-callback**'), page.getByRole('button', { name: '登录并授权' }).click()]);
  assert.ok(new URL(page.url()).searchParams.get('code'));
  assert.deepEqual(errors, []);
  await context.close();
  console.log('MCP OAuth browser: validation, failed login, password toggle, keyboard, narrow layout, scopes and authorization passed');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve)); await backend.close();
}
