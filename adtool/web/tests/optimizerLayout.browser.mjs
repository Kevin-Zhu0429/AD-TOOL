import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/optimizer-layout/', import.meta.url));
await mkdir(output, { recursive: true });

// Exercise the real React shell, including the persistent optimizer wrapper.
// Mounting optApp directly at a fixed height would miss the original regression.
function workbook() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const campaign = { Product: 'Sponsored Products', 'Campaign ID': `c${i}`, 'Campaign Name': `活动 ${String(i).padStart(2, '0')}`, State: 'enabled' };
    const group = { ...campaign, 'Ad Group ID': `g${i}`, 'Ad Group Name': `广告组 ${i}` };
    rows.push({ ...campaign, Entity: 'Campaign', 'Daily Budget': 30 });
    rows.push({ ...group, Entity: 'Ad Group', 'Ad Group Default Bid': 0.35 });
    for (let j = 0; j < (i === 0 ? 65 : 1); j++) {
      rows.push({ ...group, Entity: 'Keyword', 'Keyword ID': `k${i}-${j}`, 'Keyword Text': `hp 305 negro ${j}`, 'Match Type': 'Broad', Bid: 0.35, Impressions: 300, Clicks: 6, Spend: 2.1, Orders: 1, Sales: 20 });
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sponsored Products Campaigns');
  return { name: 'optimizer-layout.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}

async function state(page) {
  return page.evaluate(() => {
    const shadow = document.querySelector('.opt-host').shadowRoot;
    const scroll = (el) => ({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, total: el.scrollHeight });
    return {
      list: scroll(shadow.querySelector('.raillist')),
      detail: scroll(shadow.querySelector('.detail')),
      shell: scroll(document.querySelector('.shell-main')),
      document: scroll(document.scrollingElement),
      title: shadow.querySelector('.dtitle')?.textContent,
    };
  });
}

function contrast(foreground, background) {
  const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  for (const role of ['operator', 'owner']) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 920 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('adtool-theme', 'light'));
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path === '/api/auth/me'
        ? { user: { id: 1, username: 'layout-test', displayName: '布局验证', role, markets: ['ES'], adOpt: true, manualAd: true, seenVersion: '999.0.0' }, marketplaces: ['ES'] }
        : path === '/api/aba-public/attention'
          ? { total: 1, asinTotal: 1, items: [{ marketplace: 'ES', brand: 'CY', week_start: '2026-10-11', week_end: '2026-10-17', asinCount: 1, error: '测试待处理事项' }] }
          : path === '/api/neg' ? { libs: [], items: {} } : { items: [] };
      return route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    const attention = page.getByLabel('超级管理员待处理事项', { exact: true });
    await page.locator('.topnav').getByRole('button', { name: '首页', exact: true }).waitFor();
    if (role === 'owner') await attention.getByRole('heading', { name: '待处理事项 · 1 项' }).waitFor();
    else assert.equal(await attention.count(), 0);
    await page.getByRole('button', { name: '广告优化', exact: true }).click();
    await page.locator('.dropbox').waitFor();
    assert.equal(await attention.count(), 0);
    assert.equal((await state(page)).shell.top, 0);
    await page.locator('#fileA').setInputFiles(workbook());
    await page.locator('#raillist .crow').first().click();
    await page.locator('[data-tab="target"]').click();
    assert.equal(await page.locator('.tbl tbody tr').count(), 65);

    const initial = await state(page);
    assert.ok(initial.list.total > initial.list.height);
    assert.ok(initial.detail.total > initial.detail.height);
    assert.ok(initial.detail.height > 200);
    assert.ok(initial.shell.total <= initial.shell.height + 1, JSON.stringify(initial));
    assert.ok(initial.document.total <= initial.document.height + 1);
    const headBefore = await page.locator('.railhead').boundingBox();
    await page.locator('.raillist').hover();
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector('.opt-host').shadowRoot.querySelector('.raillist').scrollTop > 100);
    const afterLeft = await state(page);
    assert.equal(afterLeft.detail.top, initial.detail.top);
    assert.equal(afterLeft.title, initial.title);
    assert.deepEqual(await page.locator('.railhead').boundingBox(), headBefore);
    await page.locator('.detail').hover();
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector('.opt-host').shadowRoot.querySelector('.detail').scrollTop > 100);
    const afterRight = await state(page);
    assert.equal(afterRight.list.top, afterLeft.list.top);
    assert.equal(afterRight.shell.top, 0);

    // Scrolling past either boundary must not move the other pane or outer page.
    for (const selector of ['.raillist', '.detail']) {
      await page.locator(selector).evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const before = await state(page);
      await page.locator(selector).hover();
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(120);
      const after = await state(page);
      assert.deepEqual(after.shell, before.shell);
      assert.deepEqual(after.document, before.document);
      const stationary = selector === '.raillist' ? 'detail' : 'list';
      assert.deepEqual(after[stationary], before[stationary]);
      const scrolled = selector === '.raillist' ? 'list' : 'detail';
      assert.ok(Math.abs(after[scrolled].top - before[scrolled].top) <= 1);
    }
    await page.locator('.detail').evaluate((el) => { el.scrollTop = 0; });
    await page.locator('[data-ckall="target"]').check();
    const bid = page.getByLabel('设为', { exact: true });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await bid.fill('0.57');
      await bid.focus();
      const colors = await bid.evaluate((el) => {
        const css = getComputedStyle(el);
        return { color: css.color, background: css.backgroundColor, text: css.getPropertyValue('--text').trim(), focus: css.outlineStyle };
      });
      assert.ok(contrast(colors.color, colors.background) >= 4.5, JSON.stringify(colors));
      assert.notEqual(colors.focus, 'none');
      assert.equal(await bid.inputValue(), '0.57');
      await page.screenshot({ path: `${output}/${role}-${theme}.png` });
    }
    await page.locator('[data-batch="bid-set"]').click();
    assert.deepEqual(await page.locator('.tbl tbody .cellin').evaluateAll((els) => [...new Set(els.map((el) => el.value))]), ['0.57']);
    assert.match(await page.locator('#chgCount').innerText(), /65 处改动/);

    // Switching routes retains the native workbench instance and restores the sibling page layout.
    await page.getByRole('button', { name: '开设广告', exact: true }).click();
    await page.locator('.bhero').first().waitFor();
    assert.equal(await attention.count(), 0);
    assert.equal(await page.locator('.shell-main-optimizer').count(), 0);
    assert.equal(await page.locator('.optimizer-slot').isVisible(), false);
    const attentionReload = role === 'owner'
      ? page.waitForResponse((response) => new URL(response.url()).pathname === '/api/aba-public/attention' && response.ok())
      : Promise.resolve();
    await page.locator('.topnav').getByRole('button', { name: '首页', exact: true }).click();
    await attentionReload;
    if (role === 'owner') await attention.getByRole('heading', { name: '待处理事项 · 1 项' }).waitFor();
    else assert.equal(await attention.count(), 0);
    await page.getByRole('button', { name: '广告优化', exact: true }).click();
    assert.equal(await attention.count(), 0);
    assert.match(await page.locator('#chgCount').innerText(), /65 处改动/);
    await page.locator('[data-view="analysis"]').click();
    await page.locator('#anbody').waitFor();
    await page.locator('[data-antab="kw"]').click();
    const analysis = page.locator('#anbody');
    assert.ok(await analysis.evaluate((el) => el.scrollHeight > el.clientHeight));
    await analysis.evaluate((el) => { el.scrollTop = 300; });
    assert.ok(await analysis.evaluate((el) => el.scrollTop > 0));
    assert.equal((await state(page)).shell.top, 0);
    await page.locator('[data-view="work"]').click();

    await page.setViewportSize({ width: 520, height: 820 });
    const narrow = await state(page);
    assert.ok(narrow.detail.height > 80, JSON.stringify(narrow));
    assert.ok(narrow.list.height > 40, JSON.stringify(narrow));
    assert.ok(narrow.list.total > narrow.list.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.footbar').scrollIntoViewIfNeeded();
    await page.locator('.detail').evaluate((el) => { el.scrollTop = 500; });
    const narrowBefore = await state(page);
    await page.locator('.raillist').evaluate((el) => { el.scrollTop = 300; });
    const narrowAfter = await state(page);
    assert.equal(narrowAfter.detail.top, narrowBefore.detail.top);
    assert.equal(narrowAfter.shell.top, narrowBefore.shell.top);
    await page.screenshot({ path: `${output}/${role}-narrow.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.footbar').scrollIntoViewIfNeeded();
    const phone = await state(page);
    assert.ok(phone.list.height > 40, JSON.stringify(phone));
    assert.ok(phone.detail.height > 80, JSON.stringify(phone));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}/${role}-phone.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Optimizer layout browser workflow passed: home-only owner attention, independent scrolling, boundaries, theme contrast, bulk bids, persistent routes, analysis and narrow layouts (operator + owner).');
} finally {
  await browser?.close();
  await vite.close();
}
