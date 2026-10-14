import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';
import { savePublicReports } from '../../server/src/services/publicAsinData.js';
import { publicTask, publicFixture } from '../../server/tests/abaPublicFixture.js';
import { AMAZON_MARKETPLACES } from '../../server/src/spApi.js';
import { checkAsinExports } from './asinExportChecks.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const XLSX = require('xlsx');
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const backend = await startAbaTestServer();
let vite, browser;
try {
  for (const market of ['ES', 'DE']) for (const week of [
    { week_start: '2026-09-27', week_end: '2026-10-03' },
    { week_start: '2026-09-20', week_end: '2026-09-26' },
  ]) {
    const task = { ...publicTask, ...week, marketplace: market };
    const marketplaceId = AMAZON_MARKETPLACES[market].id;
    savePublicReports(backend.db, { task, marketplaceId, payload: publicFixture(task, marketplaceId) });
  }
  backend.db.prepare('INSERT INTO sku_items(user_id,country,brand,model,set_group,sku,asin,dedupe) VALUES(?,?,?,?,?,?,?,?)')
    .run(2, 'ES', 'CE', '305', 'BK', 'OWNER-305-BK', 'B000000305', 'public-browser-one');
  backend.db.prepare('INSERT INTO sku_items(user_id,country,brand,model,set_group,sku,asin,dedupe) VALUES(?,?,?,?,?,?,?,?)')
    .run(3, 'ES', 'CE', '305', 'COLOR', 'OTHER-ACCOUNT-COLOR', 'B000000306', 'public-browser-two');
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
  const login = async (p, username) => {
    await p.goto(base);
    await p.getByLabel('用户名').fill(username);
    await p.getByLabel('密码', { exact: true }).fill('local-test-password');
    await p.getByRole('button', { name: '登录', exact: true }).click();
    await p.locator('.topnav').getByRole('button', { name: 'ABA报告（公共）', exact: true }).click();
    await p.locator('.aba-results[aria-busy="false"]').waitFor();
    await p.getByRole('button', { name: '刷新进度' }).waitFor();
  };
  await login(page, 'aba-test');
  const view = page.locator('.aba-asin-view');
  const idle = () => view.locator('.aba-results[aria-busy="false"]').waitFor();
  await checkAsinExports(page, view, '/api/aba-public/asin');
  await page.locator('.verbadge').click();
  assert.match(await page.locator('.logrel').first().innerText(), /2\.9\.2[\s\S]*ABA ASIN 支持全筛选导出[\s\S]*仅墨盒 KW 词筛选/);
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  assert.equal(await view.locator('input[type="file"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '手动同步', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('超级管理员待处理事项', { exact: true }).count(), 0);
  assert.equal((await page.request.get(base + '/api/aba-public/attention')).status(), 403);
  assert.equal(await page.getByLabel('切换站点', { exact: true }).count(), 0);
  assert.equal(await page.locator('.aba-public-country').count(), 7);
  assert.match(await view.getByLabel('关联 SKU', { exact: true }).innerText(), /OWNER-305-BK/);
  assert.match(await view.getByLabel('关联 SKU', { exact: true }).innerText(), /OTHER-ACCOUNT-COLOR/);
  assert.equal((await page.request.post(base + '/api/aba-public/sync')).status(), 403);
  await page.getByRole('button', { name: '德国 DE 站' }).focus();
  await page.keyboard.press('Space');
  await idle();
  assert.equal(await page.getByRole('button', { name: '德国 DE 站' }).getAttribute('aria-pressed'), 'true');
  assert.match(await view.locator('.aba-table').innerText(), /hp deskjet 2820e/);
  await page.getByRole('button', { name: '西班牙 ES 站' }).click();
  await idle();
  await view.getByLabel('墨盒型号', { exact: true }).selectOption('305');
  await idle();
  await view.getByLabel('品牌', { exact: true }).selectOption('ce');
  await idle();
  await view.getByRole('button', { name: '全选', exact: true }).click();
  await idle();
  await view.getByLabel('多周统计', { exact: true }).selectOption('average');
  await idle();
  const averageDownload = page.waitForEvent('download');
  await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
  const averageBook = XLSX.readFile(await (await averageDownload).path());
  const averageRows = XLSX.utils.sheet_to_json(averageBook.Sheets['搜索查询明细'], { header: 1, defval: '' });
  assert.equal(averageRows.length, 3); // merged colors remain one record per search term, not per SKU
  assert.ok(averageRows.slice(1).every((r) => r[0].includes('OWNER-305-BK') && r[0].includes('OTHER-ACCOUNT-COLOR')));
  assert.ok(averageRows.slice(1).every((r) => r[averageRows[0].indexOf('统计方式')] === '周平均' && r[averageRows[0].indexOf('实际出现周数')] === 2));
  await view.getByLabel('显示方式', { exact: true }).selectOption('printers');
  await idle();
  let publicGroupRead = false;
  page.on('request', (request) => {
    if (request.url().includes('/api/aba-public/asin?') && request.url().includes('group=')) publicGroupRead = true;
  });
  const group = view.locator('.aba-group-toggle').first();
  await group.click();
  await view.locator('.aba-group-details .aba-table').waitFor();
  assert.equal(publicGroupRead, true);
  const downloadPromise = page.waitForEvent('download');
  await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
  const download = await downloadPromise;
  const workbook = XLSX.readFile(await download.path());
  const exported = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  assert.ok(exported.length > 2);
  assert.ok(exported.flat().includes('OWNER-305-BK'));
  assert.ok(exported.flat().includes('OTHER-ACCOUNT-COLOR'));
  await page.screenshot({ path: output + 'aba-public-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: output + 'aba-public-narrow-dark.png', fullPage: true });
  await view.getByLabel('搜索查询 / 墨盒型号', { exact: true }).fill('unlikely-no-results');
  await page.waitForTimeout(400);
  await idle();
  await view.getByRole('heading', { name: '没有匹配的搜索查询' }).waitFor();
  await view.getByRole('button', { name: '清除搜索', exact: true }).first().click();
  await idle();
  await page.route('**/api/aba-public/status?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"模拟进度读取失败"}' }));
  await page.getByRole('button', { name: '刷新进度', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟进度读取失败' }).waitFor();
  await page.unroute('**/api/aba-public/status?*');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟进度读取失败' }).waitFor({ state: 'hidden' });
  await page.route('**/api/aba-public/asin?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"模拟筛选失败"}' }));
  await view.getByLabel('词类型', { exact: true }).selectOption('cartridge');
  await view.getByRole('button', { name: '重新加载', exact: true }).waitFor();
  await page.unroute('**/api/aba-public/asin?*');
  await view.getByRole('button', { name: '重新加载', exact: true }).click();
  await idle();
  const ownerPage = await (await browser.newContext()).newPage();
  ownerPage.on('pageerror', (error) => errors.push(error.message));
  const putAction = backend.db.prepare('INSERT INTO aba_public_actions(marketplace,brand,week_start,week_end,asin,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  for (const [market, brand] of [['ES', 'CE'], ['ES', 'CC'], ['DE', 'CE'], ['DE', 'CC']]) {
    for (const asin of ['B000000305', 'B000000306']) putAction.run(market, brand, publicTask.week_start, publicTask.week_end, asin, '模拟报告尚未发布，自动补拉后仍失败，请核对后同步', Date.now(), Date.now());
  }
  await login(ownerPage, 'aba-other');
  const attention = ownerPage.getByLabel('超级管理员待处理事项', { exact: true });
  await attention.getByRole('heading', { name: '待处理事项 · 4 项' }).waitFor();
  assert.equal(await attention.locator('li').count(), 3);
  assert.match(await attention.innerText(), /8 份 ASIN 周报/);
  await ownerPage.locator('.topnav').getByRole('button', { name: '首页', exact: true }).click();
  await attention.getByRole('heading', { name: '待处理事项 · 4 项' }).waitFor();
  await ownerPage.reload();
  await attention.getByRole('heading', { name: '待处理事项 · 4 项' }).waitFor();
  await attention.getByRole('button', { name: '查看全部 4 项待处理事项' }).focus();
  await ownerPage.keyboard.press('Space');
  assert.equal(await attention.locator('li').count(), 4);
  await attention.getByLabel('分类明细每页记录数').selectOption('50');
  assert.equal(await attention.getByLabel('分类明细每页记录数').inputValue(), '50');
  await ownerPage.screenshot({ path: output + 'aba-admin-attention.png', fullPage: true });
  await ownerPage.getByRole('button', { name: '切换主题', exact: true }).click();
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.waitForFunction(() => {
    const button = [...document.querySelectorAll('.admin-attention button')].find((el) => el.textContent === '刷新待处理事项');
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    const expected = `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
    return document.documentElement.dataset.theme === 'dark' && getComputedStyle(button).color === expected;
  });
  assert.equal(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ownerPage.screenshot({ path: output + 'aba-admin-attention-narrow-dark.png', fullPage: true });
  await ownerPage.route('**/api/aba-public/attention?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"模拟待处理读取失败"}' }));
  await attention.getByRole('button', { name: '刷新待处理事项' }).click();
  await attention.getByRole('alert').filter({ hasText: '模拟待处理读取失败' }).waitFor();
  assert.equal(await attention.locator('li').count(), 4); // keep previous readable list, labelled stale
  await ownerPage.unroute('**/api/aba-public/attention?*');
  await attention.getByRole('button', { name: '刷新待处理事项' }).click();
  await attention.getByRole('alert').waitFor({ state: 'hidden' });
  await attention.getByRole('button', { name: '前往公共 ABA 处理' }).click();
  await ownerPage.getByRole('heading', { name: 'ABA报告（公共）', exact: true }).waitFor();
  await ownerPage.getByRole('button', { name: '手动同步', exact: true }).click();
  await ownerPage.getByRole('heading', { name: '同步进行中', exact: true }).waitFor();
  assert.ok(await ownerPage.getByLabel('报告批次处理进度').count());
  await ownerPage.locator('.aba-public-task-details').getByRole('button', { name: '下一页', exact: true }).click();
  await ownerPage.reload();
  await ownerPage.locator('.topnav').getByRole('button', { name: 'ABA报告（公共）', exact: true }).click();
  await ownerPage.getByRole('heading', { name: '同步进行中', exact: true }).waitFor();
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  await ownerPage.screenshot({ path: output + 'aba-public-progress.png', fullPage: true });
  const job = backend.db.prepare('SELECT id FROM aba_public_jobs ORDER BY id DESC LIMIT 1').get();
  backend.db.prepare("UPDATE aba_public_jobs SET state='partial',error='1 批失败，已保存数据可继续查看' WHERE id=?").run(job.id);
  backend.db.prepare("UPDATE aba_public_tasks SET stage='failed',error='模拟亚马逊权限不足' WHERE id=(SELECT MIN(id) FROM aba_public_tasks WHERE job_id=?)").run(job.id);
  backend.db.prepare('INSERT INTO aba_public_retries(source_job_id,due_at) VALUES(?,?)').run(job.id, Date.parse('2026-10-14T04:00:00Z'));
  await ownerPage.getByRole('button', { name: '刷新进度' }).click();
  await ownerPage.getByRole('heading', { name: '部分报告失败', exact: true }).waitFor();
  await ownerPage.getByRole('button', { name: '重试同步', exact: true }).waitFor();
  assert.match(await ownerPage.locator('.aba-public-sync').innerText(), /已保存数据可继续查看/);
  assert.match(await ownerPage.locator('.aba-public-sync').innerText(), /已安排自动补拉：2026\/10\/14 12:00:00/);
  // Server-confirmed recovery removes notices; reading them did not clear any rows.
  assert.equal(backend.db.prepare('SELECT COUNT(*) n FROM aba_public_actions').get().n, 8);
  backend.db.prepare('DELETE FROM aba_public_actions').run();
  await attention.getByRole('button', { name: '刷新待处理事项' }).click();
  await attention.getByRole('heading', { name: '待处理事项 · 暂无待处理事项' }).waitFor();
  assert.equal(await attention.locator('li').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Public ABA browser passed: all-country access, shared SKU/model filters, public nested details and XLSX export, role restriction, persisted progress, errors/retry, keyboard, light/dark and narrow layout.');
} finally {
  await browser?.close();
  await vite?.close();
  await backend.close();
}
