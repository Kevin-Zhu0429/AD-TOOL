// 广告优化大表性能基准:导入耗时 / 主线程最长卡顿 / 数据分析里批量暂停的耗时
// 用法:node tests/optimizerPerf.browser.mjs [已有的大批量表.xlsx]   不给文件就现场生成 7.8 万行 + 15 万搜索词的模拟表
// PERF_PROFILE=步骤名前缀 PERF_PROFILE_OUT=x.cpuprofile 抓该步骤的 CPU 剖析;PERF_SHOT=x.png 存一张展开 SKU 后的截图
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { bigBulk } from './genBigBulk.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));

const skus = Array.from({ length: 60 }, (_, i) => ({ sku: 'PET-SKU-' + i, stock: i % 6 === 0 ? 0 : 50, transit: 0,
  ...(i % 12 === 0 ? { stockEvent: 'out', stockEventAt: new Date().toISOString() } : {}) }));
const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/index.css"><style>html,body{margin:0;width:100%;height:100%}#host{height:100vh}</style></head><body><div id="host" data-theme="light"></div><script type="module">
import {mountOptimizer} from '/src/optApp.js';
import css from '/src/components/optimizer.css?inline';
const host=document.querySelector('#host');const shadow=host.attachShadow({mode:'open'});
const style=document.createElement('style');style.textContent=css;shadow.append(style);
const mount=document.createElement('div');shadow.append(mount);
const app=mountOptimizer(mount,host,{pet:true});
app.setLibrary('US',{libs:[],items:{}},'',${JSON.stringify(skus)});
window.__long=[];
new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(e.duration)}).observe({type:'longtask',buffered:true});
window.__gap=0;let __t=performance.now();setInterval(()=>{const n=performance.now();window.__gap=Math.max(window.__gap,n-__t-50);__t=n},50);
window.__ready=true;
</script></body></html>`;
const file = process.argv[2] ? { name: 'big.xlsx', mimeType: 'application/octet-stream', buffer: readFileSync(process.argv[2]) }
  : { name: 'big.xlsx', mimeType: 'application/octet-stream', buffer: bigBulk().buffer };
const vite = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'perf', configureServer(s) { s.middlewares.use('/__perf', (_q, r) => { r.setHeader('Content-Type', 'text/html; charset=utf-8'); r.end(html); });
    s.middlewares.use('/__bigfile', (_q, r) => { r.setHeader('Content-Type', 'application/octet-stream'); r.end(file.buffer); }); } }] });
await vite.listen();


const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__perf`);
await page.waitForFunction(() => window.__ready);
const host = page.locator('#host');
const sh = (sel) => host.locator(sel);
// 最长一次卡住 = 页面心跳(每 50ms 一次)最长停了多久;累计卡住 = 浏览器报告的长任务总时长
const longest = () => page.evaluate(() => { const l = window.__long; window.__long = []; const g = window.__gap; window.__gap = 0; return { max: Math.round(Math.max(g, ...l)), total: Math.round(l.reduce((a, b) => a + b, 0)) }; });
const res = {};
async function step(name, fn) {
  await longest();
  const prof = process.env.PERF_PROFILE && name.startsWith(process.env.PERF_PROFILE) ? await page.context().newCDPSession(page) : null;
  if (prof) { await prof.send('Profiler.enable'); await prof.send('Profiler.setSamplingInterval', { interval: 200 }); await prof.send('Profiler.start'); }
  const t = Date.now(); await fn(); const ms = Date.now() - t;
  if (prof) { const { profile } = await prof.send('Profiler.stop'); (await import('node:fs')).writeFileSync(process.env.PERF_PROFILE_OUT || 'perf.cpuprofile', JSON.stringify(profile)); }
  await page.waitForTimeout(50);
  const lt = await longest();
  res[name] = { ms, longestFreezeMs: lt.max, blockedMs: lt.total };
  console.log(name.padEnd(22), String(ms).padStart(7) + ' ms', ' 最长一次卡住 ' + lt.max + ' ms', ' 累计卡住 ' + lt.total + ' ms');
}

// 文件先下载进页面再塞给 input:Playwright 的 setInputFiles 会在页面里 base64 解码,本身就卡好几秒,不算网站的耗时
await page.evaluate(async () => { const b = await (await fetch('/__bigfile')).blob(); window.__file = new File([b], 'big.xlsx'); });
await step('导入批量表', async () => {
  await page.evaluate(() => { const input = document.querySelector('#host').shadowRoot.querySelector('#fileA');
    const dt = new DataTransfer(); dt.items.add(window.__file); input.files = dt.files; input.dispatchEvent(new Event('change')); });
  await sh('#toast.on').waitFor({ timeout: 600000 });
});
await step('切到数据分析', async () => { await sh('[data-view="analysis"]').click(); await sh('#anbody table.antbl').waitFor(); });
const firstSku = await sh('#anbody tr.anrow').first().getAttribute('data-anexp');
await step('展开一个 SKU', async () => { await sh(`tr[data-anexp="${firstSku}"] td.anname`).click(); await sh('.subbatch').waitFor(); });
await step('全选该 SKU 的广告', async () => { await sh('[data-adpick="all"]').click(); await page.waitForTimeout(0); });
const n = await sh('.subbatch b').first().innerText();
await step(`批量暂停(${n} 条)`, async () => { await sh('[data-adbatch="pause"]').click(); await sh('#toast.on').waitFor(); });
if (await sh('[data-stockact="pause"]').count()) {
  const label = await sh('[data-stockact="pause"]').innerText();
  await step('一键关闭断货广告', async () => { await sh('[data-stockact="pause"]').click({ timeout: 600000 }); await sh('#toast.on').waitFor(); });
  console.log('   (' + label + ')');
}
if (process.env.PERF_SHOT) await page.screenshot({ path: process.env.PERF_SHOT });
await step('勾选一条广告', async () => { await sh('[data-adck]').nth(1).click(); });
await step('切回按活动优化', async () => { await sh('[data-view="work"]').click(); });
console.log(JSON.stringify(res));
await browser.close(); await vite.close();
