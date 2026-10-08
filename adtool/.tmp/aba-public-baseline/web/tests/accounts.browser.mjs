import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const backend = await startAbaTestServer();
const target = backend.db.prepare("SELECT id FROM users WHERE username = 'aba-de'").get();
backend.db.prepare("UPDATE users SET role = 'owner', marketplace = 'ALL', goods_admin = 0 WHERE id = ?").run(target.id);

let vite;
let browser;
try {
  vite = await createServer({
    root,
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } },
  });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.getByLabel('用户名').fill('aba-other');
  await page.getByLabel('密码', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.topnav').getByRole('button', { name: '账号管理', exact: true }).click();

  const row = page.locator('tbody tr').filter({ hasText: 'aba-de' });
  await row.getByRole('combobox').selectOption('admin');
  await row.getByText('改为国家管理员后负责哪些站点？').waitFor();
  await row.locator('label.chip').filter({ hasText: 'DE' }).click();
  await row.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('aba-de 已改为国家管理员，负责 DE 站').waitFor();
  assert.deepEqual(
    backend.db.prepare('SELECT role, marketplace FROM users WHERE id = ?').get(target.id),
    { role: 'admin', marketplace: 'DE' },
  );

  await row.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除账号' });
  await dialog.getByText(/SKU、ABA 报告、广告组合和店铺分配会永久删除/).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
  await dialog.getByRole('button', { name: '永久删除账号', exact: true }).click();
  await page.getByText('aba-de 的账号已永久删除').waitFor();
  assert.equal(backend.db.prepare('SELECT 1 FROM users WHERE id = ?').get(target.id), undefined);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log('Account downgrade and delete browser workflow passed');
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
