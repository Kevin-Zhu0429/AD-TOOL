// 待确认改动页示例数据截图,顺带把「提议 → 修改 → 确认 → 提交 / 导出批量表」在浏览器里走一遍(不是自动化测试):
// node web/tests/changes.preview.mjs <输出目录>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import XLSX from 'xlsx';
import { startPetTestServer } from '../../server/tests/petHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
process.env.NODE_ENV = 'test';
const M = 'ATVPDKIKX0DER';
const ENV = { PET_SP_LWA_CLIENT_ID: 'x', PET_SP_LWA_CLIENT_SECRET: 'x', PET_SP_LWA_REFRESH_TOKEN: 'x', PET_SP_SELLER_ID: 'x' };
const text = (value) => ({ value, language_tag: 'en_US', marketplace_id: M });
const bullets = ['WATERPROOF OXFORD BOTTOM: keeps the bed dry on any floor', 'REMOVABLE COVER: zip off and machine wash',
  'BOLSTERED SIDES for head and neck support', 'NON-SLIP BOTTOM stays in place', 'SIZE GUIDE: measure your dog before ordering'];
const listing = (size, price) => ({ productType: 'PET_BED', asin: `B0OWNRR0${size}`, issues: [], attributes: {
  item_name: [text(`Miguel Waterproof Dog Bed for ${size === 'S' ? 'Small' : 'Medium'} Dogs, Square Oxford Pet Bed with Removable Washable Cover`)],
  bullet_point: bullets.map(text), generic_keyword: [text('dog bed waterproof pet bed washable kennel')],
  purchasable_offer: [{ marketplace_id: M, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: price }] }] }] } });
const state = { RR22002BKS: listing('S', 25.99), RR22002BKM: listing('M', 32.99) };
const gateway = {
  async request(account, region, method, path, { query, body } = {}) {
    const item = state[decodeURIComponent(path.split('/').pop())];
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (method === 'GET') return { summaries: [{ marketplaceId: M, asin: item.asin, productType: item.productType }], attributes: item.attributes, issues: item.issues };
    // 后台搜索词这条让亚马逊预检报错,页面上能看到失败的样子
    const bad = query.mode === 'VALIDATION_PREVIEW' && path.endsWith('RR22002BKM') && body.patches[0].path === '/attributes/generic_keyword';
    if (bad) { return { status: 'INVALID', issues: [{ code: '90244', severity: 'ERROR', message: "The value provided for 'generic_keyword' contains a prohibited word.", attributeNames: ['generic_keyword'] }] }; }
    return query.mode ? { status: 'VALID', issues: [] } : { status: 'ACCEPTED', submissionId: `f0e1d2c3${Math.random().toString(16).slice(2, 8)}`, issues: [] };
  },
};
Object.assign(process.env, ENV);
const backend = await startPetTestServer({ changeDeps: { gateway, env: ENV } });
const { db } = backend;
const { proposeListingChanges, proposeAdChanges, waitForQueue } = await import('../../server/src/petChanges.js');

let vite, browser;
try {
  const sku = db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', 'Miguel', ?, ?, '方窝牛津', ?, 'Black', ?)`);
  sku.run('RR22002BKS', 'B0OWNRR0S', 'S', 'us|rr22002bks');
  sku.run('RR22002BKM', 'B0OWNRR0M', 'M', 'us|rr22002bkm');
  db.prepare("INSERT INTO pet_sku_costs (sku, fob, first_leg, duty) VALUES ('RR22002BKM', 9.8, 1.6, 0.6)").run();
  db.prepare("INSERT INTO pet_sku_fees (sku, fba_fee, referral_fee, referral_rate) VALUES ('RR22002BKM', 7.1, 4.95, 0.15)").run();
  const owner = db.prepare("SELECT id FROM users WHERE username='pet-owner'").get().id;
  const newBullets = ['WATERPROOF OXFORD BOTTOM: keeps the bed dry on any floor, easy to wipe clean after muddy walks',
    'REMOVABLE COVER: zip off and machine wash', 'BOLSTERED SIDES for head and neck support, a cozy cat bed too',
    'NON-SLIP BOTTOM stays in place on hardwood and tile', 'SIZE GUIDE: S fits pets up to 25 lbs, measure from nose to tail before ordering'];
  await proposeListingChanges({ title: '方窝牛津 S/M 补「cat bed」', summary: 'ABA 里 cat bed 周搜索量 1,100，我们 S 码点击份额 0%；竞品 Bedsure、Western Home 标题都写了 Cat Bed。S 码标题、五点、后台词补上，M 码只改标题。',
    changes: [
      { sku: 'RR22002BKS', field: 'title', value: 'Miguel Waterproof Dog Bed for Small Dogs and Cat Bed, Square Oxford Pet Bed with Removable Washable Cover, Non-Slip', reason: 'cat bed 周搜索量 1,100，S 码点击份额 0%；标题里没有 cat' },
      { sku: 'RR22002BKS', field: 'bullets', value: newBullets, reason: '第 3 条补 cat bed，第 5 条写清 S 码适合 25 磅以内' },
      { sku: 'RR22002BKS', field: 'search_terms', value: 'cat bed kitty bed small dog bed waterproof pet bed washable kennel crate pad', reason: '后台词补 cat bed、kitty bed、crate pad' },
      { sku: 'RR22002BKM', field: 'title', value: 'Miguel Waterproof Dog Bed for Medium Dogs and Cat Bed, Square Oxford Pet Bed with Removable Washable Cover', reason: '和 S 码保持一致' },
      { sku: 'RR22002BKM', field: 'price', value: 29.99, reason: 'M 码可售 210 天，同尺码竞品中位价 $29.99' },
    ] }, { userId: owner, gateway, env: ENV });
  await proposeListingChanges({ title: '后台词去掉违禁词', changes: [
    { sku: 'RR22002BKM', field: 'search_terms', value: 'dog bed medium cat bed waterproof best seller', reason: '测试预检失败' }] }, { userId: owner, gateway, env: ENV });
  proposeAdChanges({ title: '方窝牛津 SP 手动：停烂词、降竞价', summary: '来自 9/22–9/28 批量表：两个词花费高零转化，一个词 ACOS 92%。',
    changes: [
      { action: 'pause', entity: 'keyword', campaignId: '284920118455321', adGroupId: '119283746650012', entityId: '400118273650981', campaignName: 'RR22002-SP-手动-精准', adGroupName: 'S码', label: 'cheap dog bed', current: 'enabled', reason: '近 7 天花费 $38.20，31 次点击 0 单' },
      { action: 'set_bid', entity: 'keyword', campaignId: '284920118455321', adGroupId: '119283746650012', entityId: '400118273650982', campaignName: 'RR22002-SP-手动-精准', adGroupName: 'S码', label: 'dog bed small', bid: 0.62, current: 0.95, reason: 'ACOS 92%，转化率 6% 低于同组平均 11%' },
      { action: 'add_negative', level: 'adGroup', matchType: 'phrase', campaignId: '284920118455321', adGroupId: '119283746650012', campaignName: 'RR22002-SP-手动-精准', adGroupName: 'S码', negativeText: 'heated', reason: '加热垫相关搜索词 14 次点击 0 单' },
    ] }, { userId: owner });

  vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // Claude 给的确认链接带 #changes,登录后直接到这一页
  await page.goto(`${vite.resolvedUrls.local[0]}#changes`);
  await page.getByLabel('用户名').fill('pet-owner'); await page.getByLabel('密码').fill('pet-test-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: /待确认改动/ }).waitFor();
  await page.locator('.chg-item').first().waitFor();
  await page.screenshot({ path: `${output}/待确认改动-待确认.png`, fullPage: true });
  await page.locator('.chg-item').filter({ hasText: '五点描述' }).screenshot({ path: `${output}/待确认改动-五点对比.png` });
  await page.locator('.topnav').screenshot({ path: `${output}/待确认改动-导航角标.png` });

  // 改一下 M 码标题再确认
  await page.locator('.chg-item').filter({ hasText: 'RR22002BKM' }).filter({ hasText: '标题' }).getByRole('button', { name: '修改' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByLabel('新值').fill('Miguel Waterproof Dog Bed for Medium Dogs, Cat Bed, Square Oxford Pet Bed with Removable Washable Cover');
  await page.getByRole('dialog').screenshot({ path: `${output}/待确认改动-修改.png` });
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
  await page.getByText('已修改，确认后执行').waitFor();

  await page.getByRole('toolbar').getByLabel('全选').check();
  await page.getByRole('toolbar').getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').screenshot({ path: `${output}/待确认改动-确认弹窗.png` });
  await page.getByRole('dialog').getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('tab', { name: /处理中/, selected: true }).waitFor();
  await page.locator('.chg-item').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.chg-item.s-queued, .chg-item.s-running'), null, { timeout: 30000 });
  await page.screenshot({ path: `${output}/待确认改动-处理中.png`, fullPage: true });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /下载批量表/ }).click();
  const file = await (await download).path();
  const sheet = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(sheet.Sheets[sheet.SheetNames[0]], { header: 1 });
  console.log('bulk sheet', sheet.SheetNames, rows.length - 1, 'rows', rows[1].slice(0, 9));
  await page.getByRole('button', { name: /已上传到广告后台/ }).waitFor();
  await page.locator('.chg-export').screenshot({ path: `${output}/待确认改动-批量表.png` });

  await page.getByRole('tab', { name: /日志/ }).click();
  await page.locator('.chg-log').waitFor();
  await page.screenshot({ path: `${output}/待确认改动-日志.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('tab', { name: /处理中/ }).click();
  await page.locator('.chg-item').first().waitFor();
  await page.screenshot({ path: `${output}/待确认改动-手机.png` });
  const statuses = db.prepare('SELECT kind, status FROM pet_change_proposals ORDER BY id').all();
  console.log(statuses);
  if (errors.length) console.error('page errors', errors);
  console.log('done', output);
} finally {
  await browser?.close(); await vite?.close(); await waitForQueue(); await backend.close();
}
