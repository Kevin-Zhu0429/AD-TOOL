import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
const owner = { id: 1, username: 'carousel-preview', displayName: 'Kevin', role: 'owner', markets: ['ES', 'DE'], manualAds: true, adOpt: true, productIntel: true, goodsAdmin: true, seenVersion: '999.0.0' };
const errors = [];
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
let currentUser = owner;
let libraryFails = false;
await context.route('**/api/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/auth/me') return route.fulfill({ json: { user: currentUser, marketplaces: ['ES', 'DE'] } });
  if (path === '/api/neg') return route.fulfill(libraryFails ? { status: 500, json: { error: '测试读取失败' } } : { json: { items: { A: Array(12).fill('词') } } });
  if (path === '/api/aba-public/attention') return route.fulfill({ json: { items: [], total: 0, asinTotal: 0 } });
  return route.fulfill({ json: {} });
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const active = () => page.locator('.home-carousel-detail h3');
const ready = () => page.locator('.circular-carousel[data-ready]').waitFor();
const select = async (title) => {
  await page.getByRole('button', { name: `查看${title}`, exact: true }).click();
  await assertEventually(() => active().innerText(), title);
};
async function assertEventually(getValue, expected) {
  for (let i = 0; i < 80; i++) {
    if (await getValue() === expected) return;
    await page.waitForTimeout(50);
  }
  assert.equal(await getValue(), expected);
}
try {
  await page.addInitScript(() => localStorage.setItem('adtool-theme', 'light'));
  // This browser renders WebGL in software, which the home page would answer with the static mode; pin full quality here.
  await page.addInitScript(() => localStorage.setItem('adtool-motion-quality', JSON.stringify({ quality: 'full', pinned: true })));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const result = original.call(this, type, ...args);
      if (type === 'webgl2' && result) window.__cardShaderTestContext = result;
      return result;
    };
  });
  await page.goto(url); await ready();
  assert.equal(await page.locator('.home-shortcut').count(), 11);
  assert.equal(await page.locator('.card-ambient canvas').count(), 88, 'Only front surfaces need 2D shader strips');
  const shaderCanvas = page.locator('.card-ambient-canvas').first();
  assert.equal(await shaderCanvas.getAttribute('data-renderer'), 'webgl2', await shaderCanvas.getAttribute('data-shader-error') || 'Expected the supplied GLSL shaders');
  await page.locator('.card-ambient-canvas[data-shader-frame]').first().waitFor();
  for (const [effect, index] of [['waves', 0], ['silk', 1], ['gradient', 2], ['lines', 3], ['aurora', 4]]) {
    const texture = await page.locator(`[data-cc-index="${index}"] .card-ambient-canvas`).evaluateAll((strips) => {
      const bitmap = document.createElement('canvas'); bitmap.width = 290; bitmap.height = 330;
      const painter = bitmap.getContext('2d');
      for (const strip of strips) painter.drawImage(strip, parseFloat(strip.style.left) || 0, 0, parseFloat(strip.style.width), 330);
      return bitmap.toDataURL('image/png');
    });
    await writeFile(output + `shader-${effect}-texture.png`, Buffer.from(texture.split(',')[1], 'base64'));
  }
  assert.equal(await page.locator('.card-ambient-canvas').evaluateAll((canvases) => new Set(canvases.map((canvas) => canvas.dataset.shaderContext)).size), 1, 'All strips share one WebGL2 context');
  assert.equal(await page.locator('.circular-carousel__card').evaluateAll((cards) => cards.every((card) => card.querySelector('.card-ambient'))), true);
  assert.equal(await page.locator('.card-ambient').evaluateAll((backgrounds) => new Set(backgrounds.map((node) => node.dataset.effect)).size), 5, 'Light theme adds silk and line waves');
  await page.waitForTimeout(100);
  const staticFrame = await shaderCanvas.getAttribute('data-shader-frame');
  await page.waitForTimeout(150);
  assert.equal(await shaderCanvas.getAttribute('data-shader-frame'), staticFrame);
  assert.equal(await active().innerText(), 'ABA 报告');
  const desktopDetailHeight = (await page.locator('.home-carousel-detail').boundingBox()).height;
  await page.locator('.shell-main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: output + 'home-carousel-light.png', fullPage: true });
  await page.getByRole('button', { name: '下一个功能', exact: true }).click();
  await assertEventually(() => active().innerText(), '自动广告');
  assert.equal((await page.locator('.home-carousel-detail').boundingBox()).height, desktopDetailHeight);
  await page.getByRole('button', { name: '上一个功能', exact: true }).click();
  await assertEventually(() => active().innerText(), 'ABA 报告');
  await select('我的 SKU 库');
  const carousel = page.getByRole('region', { name: '工作台功能轮播' });
  await carousel.focus(); await carousel.press('ArrowRight');
  await assertEventually(() => active().innerText(), 'ES 站广告组合库');
  await carousel.press('Home'); await assertEventually(() => active().innerText(), 'ABA 报告');
  await carousel.press('End'); await assertEventually(() => active().innerText(), '账号管理');
  await carousel.press('Home'); await assertEventually(() => active().innerText(), 'ABA 报告');
  const dragBox = await carousel.boundingBox();
  const dragX = dragBox.x + dragBox.width / 2;
  const dragY = dragBox.y + dragBox.height / 2;
  await page.mouse.move(dragX, dragY); await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(dragX - i * 22, dragY); await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await assertEventually(() => active().innerText(), '自动广告');
  assert.equal(await page.locator('.tools-page').count(), 0, 'Dragging should not enter a feature');
  await select('小工具');
  await carousel.focus(); await carousel.press('Enter');
  await page.locator('.tools-page').waitFor();
  await page.locator('.topnav').getByRole('button', { name: '首页', exact: true }).click(); await ready();
  await select('小工具');
  await page.locator('[data-cc-index="8"] .circular-carousel__tile').nth(3).click();
  await page.locator('.tools-page').waitFor();
  await page.locator('.topnav').getByRole('button', { name: '首页', exact: true }).click(); await ready();
  await select('ES 站否定词库');
  await page.getByLabel('切换站点').selectOption('DE');
  await assertEventually(() => active().innerText(), 'DE 站否定词库');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.deepEqual(await page.locator('.card-ambient').evaluateAll((backgrounds) => [...new Set(backgrounds.map((node) => node.dataset.effect))].sort()),
    ['aurora', 'gradient', 'waves'], 'Dark theme keeps the original three effects');
  await page.locator('.shell-main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: output + 'home-carousel-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await select('ABA 报告');
  const mobileDetailHeight = (await page.locator('.home-carousel-detail').boundingBox()).height;
  await select('手动广告');
  assert.equal((await page.locator('.home-carousel-detail').boundingBox()).height, mobileDetailHeight);
  await select('ABA 报告');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const cardBox = await page.locator('[data-cc-index="0"] .circular-carousel__content').nth(3).boundingBox();
  assert.ok(cardBox.width > 160, `Mobile card too small: ${cardBox.width}`);
  await page.locator('.shell-main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: output + 'home-carousel-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: '继续动效', exact: true }).click();
  await page.mouse.move(1, 1); await page.locator('.home-showcase-head h2').click();
  const ring = page.locator('.circular-carousel__ring');
  const transform = () => ring.getAttribute('style');
  await page.waitForTimeout(3100);
  const background = page.locator('.circular-carousel__card[data-motion-side="front"] .card-ambient-canvas').first();
  const backgroundFrame = await background.getAttribute('data-shader-frame');
  const backgroundPixels = await background.evaluate((canvas) => canvas.toDataURL());
  await page.waitForTimeout(350);
  assert.notEqual(await background.getAttribute('data-shader-frame'), backgroundFrame);
  assert.notEqual(await background.evaluate((canvas) => canvas.toDataURL()), backgroundPixels, 'Shader pixels should change with time');
  assert.equal(await page.locator('.circular-carousel__card[data-motion-side="front"]').first().locator('.card-ambient-canvas')
    .evaluateAll((canvases) => new Set(canvases.map((canvas) => canvas.dataset.shaderFrame)).size), 1, 'Curved strips use the exact same shader frame');
  // Capture the live artwork at desktop and phone sizes.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('.shell-main').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: output + 'home-card-backgrounds-dark.png', fullPage: true });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: output + 'home-card-backgrounds-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + 'home-card-backgrounds-mobile.png', fullPage: true });
  const moving = await transform(); await page.waitForTimeout(500);
  assert.notEqual(await transform(), moving, 'Autoplay should move the ring');
  await page.getByRole('button', { name: '暂停动效', exact: true }).click();
  await page.waitForTimeout(100);
  const pausedFrame = await background.getAttribute('data-shader-frame');
  await page.waitForTimeout(150);
  assert.equal(await background.getAttribute('data-shader-frame'), pausedFrame);
  await page.waitForTimeout(2200);
  const stopped = await transform(); await page.waitForTimeout(400);
  assert.equal(await transform(), stopped, 'Paused ring should settle');
  await page.getByRole('button', { name: '继续动效', exact: true }).click();
  // Pad the page so the carousel can leave the screen however short the latest changelog entry is.
  await page.locator('.shell-main').evaluate((element) => {
    element.querySelector('.home').style.paddingBottom = '1200px';
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.circular-carousel').getAttribute('data-motion-hidden'), '');
  const hiddenFrame = await background.getAttribute('data-shader-frame');
  await page.waitForTimeout(150);
  assert.equal(await background.getAttribute('data-shader-frame'), hiddenFrame);
  await page.locator('.shell-main').evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.circular-carousel').getAttribute('data-motion-hidden'), null);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.getByRole('button', { name: '动态效果已关闭', exact: true }).isDisabled(), true);
  await page.waitForTimeout(100);
  const reduced = await transform(); await page.waitForTimeout(400);
  assert.equal(await transform(), reduced, 'Reduced motion should stop autoplay');
  currentUser = { ...owner, id: 2, role: 'operator', manualAds: undefined, adOpt: false, productIntel: false, goodsAdmin: false };
  libraryFails = true;
  await page.reload(); await ready();
  assert.equal(await page.locator('.home-shortcut').count(), 7);
  for (const title of ['手动广告', '广告优化', 'DE 站产品情报', '账号管理']) {
    assert.equal(await page.getByRole('button', { name: `查看${title}`, exact: true }).count(), 0);
  }
  await select('ES 站否定词库');
  assert.match(await page.locator('.home-carousel-detail-copy').innerText(), /B–E 只读/);
  assert.equal(await page.locator('.circular-carousel img').count(), 0, 'Home cards should use local HTML, not external images');
  await page.evaluate(() => window.__cardShaderTestContext.getExtension('WEBGL_lose_context').loseContext());
  await page.locator('.card-ambient-canvas[data-renderer="fallback"]').first().waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('button', { name: '进入ES 站否定词库', exact: true }).isEnabled(), true);
  const unsupported = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await unsupported.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === 'webgl2' ? null : original.call(this, type, ...args);
    };
  });
  await unsupported.route('**/api/**', (route) => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/me'
    ? { user: currentUser, marketplaces: ['ES', 'DE'] } : { items: {} } }));
  const fallbackPage = await unsupported.newPage();
  fallbackPage.on('pageerror', (error) => errors.push(error.message));
  await fallbackPage.goto(url);
  await fallbackPage.locator('.circular-carousel[data-ready]').waitFor();
  assert.equal(await fallbackPage.locator('.card-ambient-canvas').first().getAttribute('data-renderer'), 'fallback');
  await fallbackPage.getByRole('button', { name: '查看小工具', exact: true }).click();
  await fallbackPage.getByRole('button', { name: '进入小工具', exact: true }).click();
  await fallbackPage.locator('.tools-page').waitFor();
  await unsupported.close();
  const software = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference' });
  await software.route('**/api/**', (route) => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/me'
    ? { user: owner, marketplaces: ['ES', 'DE'] } : { items: [] } }));
  const softwarePage = await software.newPage();
  softwarePage.on('pageerror', (error) => errors.push(error.message));
  await softwarePage.goto(url);
  await softwarePage.locator('.circular-carousel[data-ready]').waitFor();
  assert.equal(await softwarePage.locator('.circular-carousel').getAttribute('data-quality'), 'static', 'Software WebGL switches to the static mode');
  assert.equal(await softwarePage.getByRole('button', { name: '已切换静态画面', exact: true }).isDisabled(), true);
  await softwarePage.mouse.move(1, 1); await softwarePage.waitForTimeout(600);
  const softwareRing = softwarePage.locator('.circular-carousel__ring');
  const staticRing = await softwareRing.getAttribute('style'); await softwarePage.waitForTimeout(500);
  assert.equal(await softwareRing.getAttribute('style'), staticRing, 'Static mode does not autoplay');
  await softwarePage.getByRole('button', { name: '查看自动广告', exact: true }).click();
  await softwarePage.locator('.home-carousel-detail h3', { hasText: '自动广告' }).waitFor();
  await software.close();
  assert.deepEqual(errors, []);
  console.log('Home carousel browser passed: original GLSL, one context, animated pixels, synchronized strips, pause/reduced/offscreen states, context loss and unsupported WebGL fallback, software WebGL static mode, permissions, navigation, drag, themes, stations and mobile layout.');
} finally {
  await browser.close(); await vite.close();
}
