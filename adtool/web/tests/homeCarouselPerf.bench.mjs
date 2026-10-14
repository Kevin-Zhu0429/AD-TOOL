// 首页轮播帧率基准(手动跑,不进 CI):PLAYWRIGHT_MODULE=... node tests/homeCarouselPerf.bench.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL, headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const user = { id: 1, username: 'bench', displayName: 'Kevin', role: 'owner', markets: ['ES'], manualAds: true, adOpt: true, productIntel: true, goodsAdmin: true, seenVersion: '999.0.0' };
const throttle = Number(process.env.CPU_THROTTLE || 4);
try {
  for (const theme of (process.env.THEMES || 'light,dark').split(',')) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    await context.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/me') return route.fulfill({ json: { user, marketplaces: ['ES'] } });
      if (path === '/api/neg') return route.fulfill({ json: { items: { A: Array(12).fill('词') } } });
      if (path === '/api/aba-public/attention') return route.fulfill({ json: { items: [], total: 0, asinTotal: 0 } });
      return route.fulfill({ json: {} });
    });
    await context.addInitScript((value) => localStorage.setItem('adtool-theme', value), theme);
    if (process.env.QUALITY) await context.addInitScript((value) => localStorage.setItem('adtool-motion-quality', JSON.stringify({ quality: value, at: Date.now() })), process.env.QUALITY);
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('.circular-carousel[data-ready]').waitFor();
    if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
    await page.waitForTimeout(2500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.waitForTimeout(4000);
    await cdp.send('Performance.enable');
    const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const before = await metric();
    const result = await page.evaluate(() => new Promise((resolve) => {
      const times = [];
      const start = performance.now();
      const tick = (now) => {
        times.push(now);
        if (now - start < 5000) requestAnimationFrame(tick);
        else {
          const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
          resolve({ fps: +(times.length / ((now - start) / 1000)).toFixed(1), p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
            layers: document.querySelectorAll('.circular-carousel__tile').length,
            shown: [...document.querySelectorAll('.circular-carousel__tile')].filter((t) => getComputedStyle(t).display !== 'none').length,
            tier: document.querySelector('.circular-carousel')?.dataset.quality || '-' });
        }
      };
      requestAnimationFrame(tick);
    }));
    const after = await metric();
    result.mainThread = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration']
      .map((key) => [key.replace('Duration', ''), +((after[key] - before[key]) / 5).toFixed(3)]));
    if (process.env.SHOT) await page.locator('.home-carousel-stage').screenshot({ path: `${process.env.SHOT}-${theme}.png` });
    console.log(theme, `cpu x${throttle}`, JSON.stringify(result));
    await context.close();
  }
} finally { await browser.close(); await vite.close(); }
