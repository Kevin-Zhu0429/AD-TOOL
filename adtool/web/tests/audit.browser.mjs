import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const backend = await startAbaTestServer();
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const insert = backend.db.prepare(`INSERT INTO audit_log(user_id,action,entity,created_at)
  VALUES(?,?,?,datetime('now','localtime',?))`);
for (const action of ['login', 'open', 'logout', 'export']) insert.run(1, action, 'user', '-1 days');
for (const action of ['login', 'open', 'import', 'update', 'sync']) insert.run(1, action, 'user', '-10 days');
insert.run(1, 'login', 'user', '-35 days');

let vite, browser;
try {
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
  await page.goto(base);
  await page.getByLabel('用户名').fill('aba-other');
  await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const openAudit = async () => {
    const response = page.waitForResponse((r) => r.url().includes('/api/auth/audit?') && r.status() === 200);
    await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();
    const data = await (await response).json();
    await page.getByRole('button', { name: '操作日志', exact: true }).click();
    await page.locator('.audit-stats-table tbody tr').filter({ hasText: 'aba-test' }).waitFor();
    return data;
  };
  const data = await openAudit();
  const row = page.locator('.audit-stats-table tbody tr').filter({ hasText: 'aba-test' });
  assert.deepEqual(await row.locator('.audit-rate strong').allTextContents(), ['75.0%', '55.6%']);
  assert.deepEqual(await row.locator('.audit-rate-fraction').allTextContents(), ['3 / 4', '5 / 9']);
  const empty = page.locator('.audit-stats-table tbody tr').filter({ hasText: 'aba-de' });
  assert.deepEqual(await empty.locator('.audit-rate strong').allTextContents(), ['—', '—']);
  assert.deepEqual(await empty.locator('.audit-rate-fraction').allTextContents(), ['0 / 0', '0 / 0']);
  const format = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const totalRates = page.locator('.audit-total-rate .audit-rate strong');
  assert.deepEqual(await totalRates.allTextContents(), [
    format.format(data.totals.sevenDayNonBusiness / data.totals.sevenDay),
    format.format(data.totals.thirtyDayNonBusiness / data.totals.thirtyDay),
  ]);
  assert.match(await page.locator('.audit-rate-formula').innerText(), /登录＋打开板块＋退出登录/);
  const headers = await page.locator('.audit-stats-table th').allTextContents();
  assert.deepEqual(headers, ['账号', '角色', '近 7 天', '近 7 天摸鱼率', '近 30 天', '近 30 天摸鱼率', '最近操作']);
  await page.screenshot({ path: output + 'audit-rate-desktop.png', fullPage: true });
  await page.locator('.audit-filters').getByRole('combobox', { name: /^账号/ }).selectOption('1');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/audit/logs?') && r.url().includes('action=login') && r.status() === 200),
    page.locator('.audit-filters').getByRole('combobox', { name: /^动作/ }).selectOption('login'),
  ]);
  assert.deepEqual(await row.locator('.audit-rate strong').allTextContents(), ['75.0%', '55.6%']); // detail filters cannot alter account metrics
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.audit-stats-scroll').evaluate((el) => el.scrollWidth > el.clientWidth), true);
  await page.locator('.audit-stats-scroll').focus();
  await page.keyboard.press('ArrowRight');
  await page.screenshot({ path: output + 'audit-rate-narrow-dark.png', fullPage: true });
  // Failed initial loading must not display a fabricated 0% rate.
  await page.route('**/api/auth/audit?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"模拟统计读取失败"}' }));
  await page.reload();
  await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();
  await page.getByText('模拟统计读取失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '操作日志', exact: true }).click();
  assert.deepEqual(await totalRates.allTextContents(), ['—', '—']);
  await page.unroute('**/api/auth/audit?*');
  await page.reload();
  await openAudit();
  assert.deepEqual(await row.locator('.audit-rate strong').allTextContents(), ['75.0%', '55.6%']);
  assert.deepEqual(errors, []);
  console.log('Audit rate browser passed: 7/30-day values, zero activity, weighted totals, filter independence, error recovery, keyboard, dark theme and narrow table scrolling.');
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
