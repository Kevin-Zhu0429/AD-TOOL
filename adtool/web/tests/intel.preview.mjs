// 产品情报示例数据截图(不是自动化测试):node web/tests/intel.preview.mjs <输出目录>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { startPetTestServer } from '../../server/tests/petHarness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.PET_TODAY = '2026-10-02';
const backend = await startPetTestServer();
const { db } = backend;
const M = 'ATVPDKIKX0DER';
const ENV = { PET_SP_LWA_CLIENT_ID: 'x', PET_SP_LWA_CLIENT_SECRET: 'x', PET_SP_LWA_REFRESH_TOKEN: 'x', PET_SP_SELLER_ID: 'x' };
Object.assign(process.env, ENV);
const pic = (color, text) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="25" y="60" width="150" height="95" rx="30" fill="${color}"/><rect x="45" y="78" width="110" height="58" rx="22" fill="#f1ede6"/><text x="100" y="185" font-size="18" text-anchor="middle" font-family="sans-serif" fill="#555">${text}</text></svg>`)}`;
const item = (asin, o = {}) => ({ asin,
  summaries: [{ marketplaceId: M, itemName: o.title ?? asin, brand: o.brand, size: o.size ?? null, color: o.color ?? null }],
  attributes: { bullet_point: (o.bullets ?? []).map((value) => ({ value, marketplace_id: M })) },
  images: [{ marketplaceId: M, images: Array.from({ length: o.images ?? 7 }, (_, i) => ({ variant: i ? `PT0${i}` : 'MAIN', link: i ? `x${i}` : o.main, width: 1000 })) }],
  salesRanks: [{ marketplaceId: M, displayGroupRanks: o.bsr ? [{ title: 'Pet Supplies', rank: o.bsr }] : [], classificationRanks: o.sub ? [{ title: 'Dog Beds', rank: o.sub }] : [] }],
  relationships: [{ marketplaceId: M, relationships: o.parent ? [{ type: 'VARIATION', parentAsins: [o.parent] }] : o.children ? [{ type: 'VARIATION', childAsins: o.children }] : [] }],
  productTypes: [{ marketplaceId: M, productType: 'PET_BED' }] });

const SIZES = ['S', 'M', 'L', 'XL'];
const NAME = { S: 'Small', M: 'Medium', L: 'Large', XL: 'X-Large' };
const catalog = {}, prices = {};
// 自家方窝牛津
const ownBullets = ['WATERPROOF OXFORD BOTTOM: keeps the bed dry on any floor', 'REMOVABLE COVER: zip off and machine wash', 'BOLSTERED SIDES for head and neck support', 'NON-SLIP BOTTOM stays in place', 'SIZE GUIDE: measure your dog before ordering'];
const ownPrices = { S: 25.99, M: 32.99, L: 39.99, XL: 49.99 };
const skuRows = [];
for (const [i, size] of SIZES.entries()) {
  const asin = `B0OWNRR0${i}${i}`;
  catalog[asin] = item(asin, { brand: 'Miguel', title: 'Miguel Waterproof Dog Bed for Large Medium Small Dogs, Square Oxford Pet Bed with Removable Washable Cover', size: NAME[size], color: 'Black', bullets: ownBullets, images: 6, main: pic('#3b3f46', 'Miguel'), bsr: [8200, 6100, 15400, 21000][i], sub: [210, 160, 380, 510][i], parent: 'B0OWNRRPAR' });
  skuRows.push({ sku: `RR22002BK${size}`, asin, size, color: 'Black' });
}
skuRows.push({ sku: 'RR26001BRM', asin: 'B0OWNCORD1', size: 'M', color: 'Brown' }, { sku: 'BM25001AG24', asin: 'B0OWNPAD01', size: '24 inch' });
catalog.B0OWNCORD1 = item('B0OWNCORD1', { brand: 'Miguel', title: 'Orthopedic Dog Bed Corduroy Washable Pet Sofa', size: 'Medium', bullets: ownBullets.slice(0, 4), images: 5, main: pic('#8a6a4b', 'Corduroy'), bsr: 40100, sub: 900 });
catalog.B0OWNPAD01 = item('B0OWNPAD01', { brand: 'Miguel', title: 'Miguel Crate Pad Washable Dog Kennel Mat 24 inch', size: '24 inch', bullets: ownBullets, images: 7, main: pic('#7a8a6a', 'Pad'), bsr: 30500, sub: 700 });

const rivals = [
  { parent: 'B0BEDSURE0', brand: 'Bedsure', color: '#6e7f99', base: 24.99, bsr: 900, title: 'Bedsure Waterproof Dog Bed for Large Dogs, Cat Bed, Orthopedic Egg Crate Foam Pet Bed with Removable Washable Cover', bullets: ['Waterproof liner protects the foam', 'Egg crate foam relieves joints', 'Cat bed and dog bed in one', 'Machine washable cover', 'Non-slip bottom'] },
  { parent: 'B0FURHAVEN', brand: 'FURHAVEN', color: '#a07c5a', base: 29.99, bsr: 1500, title: 'Furhaven Orthopedic Dog Bed for Large/Medium Dogs w/ Removable Bolsters & Washable Cover', bullets: ['Orthopedic foam', 'Bolstered sides', 'Removable washable cover', 'Water-resistant liner', 'Multiple sizes'] },
  { parent: 'B0WESTHOME', brand: 'Western Home', color: '#9a8f86', base: 27.99, bsr: 2600, title: 'Western Home Waterproof Dog Bed Calming Rectangle Pet Bed for Dogs and Cats, Machine Washable', bullets: ['Calming raised rim', 'Waterproof bottom', 'For dogs and cats', 'Machine washable', 'Anti-slip'] },
];
for (const rival of rivals) {
  const children = SIZES.map((size, i) => `${rival.parent.slice(0, 8)}C${i}`);
  catalog[rival.parent] = item(rival.parent, { brand: rival.brand, title: rival.title, bullets: rival.bullets, children, main: pic(rival.color, rival.brand), images: 9 });
  children.forEach((asin, i) => {
    catalog[asin] = item(asin, { brand: rival.brand, title: rival.title, bullets: rival.bullets, size: NAME[SIZES[i]], color: 'Grey', parent: rival.parent, bsr: rival.bsr * (1 + i * 0.6), sub: Math.round(rival.bsr / 30 * (1 + i)) });
    prices[asin] = Number((rival.base + i * 7).toFixed(2));
  });
}
catalog.B0SUGGEST1 = item('B0SUGGEST1', { brand: 'BFPETHOME', title: 'BFPETHOME Washable Dog Bed for Small Medium Dogs and Cats, Square Calming Pet Bed', main: pic('#c48f6a', 'BFPET'), bullets: ['x'] });
catalog.B0SUGGEST2 = item('B0SUGGEST2', { brand: 'Lesure', title: 'Lesure Waterproof Dog Bed Large - Cat Bed with Bolster', main: pic('#5f7a6a', 'Lesure'), bullets: ['x'] });
prices.B0SUGGEST1 = 22.99; prices.B0SUGGEST2 = 84.99;

const gateway = {
  reports: [],
  async request(account, region, method, path, { query, body } = {}) {
    if (path === '/catalog/2022-04-01/items') return { items: query.identifiers.split(',').map((a) => catalog[a]).filter(Boolean) };
    if (path.includes('itemOffers')) return { responses: body.requests.map((r) => { const asin = /items\/(\w+)\//.exec(r.uri)[1]; return { status: { statusCode: 200 }, body: { payload: { ASIN: asin, Summary: { TotalOfferCount: 1, ListPrice: { Amount: Math.round((prices[asin] ?? 30) * 1.3) - 0.01 }, BuyBoxPrices: prices[asin] == null ? [] : [{ condition: 'New', LandedPrice: { Amount: prices[asin] } }] } } } }; }) };
    if (path.startsWith('/listings/')) return { attributes: { generic_keyword: [{ value: 'kennel mat crate bed indoor', marketplace_id: M }] }, issues: [] };
    if (method === 'POST') { gateway.reports.push(body); return { reportId: 'r1' }; }
    if (/reports\/r1$/.test(path)) return { processingStatus: 'DONE', reportDocumentId: 'd1' };
    if (/documents\/d1$/.test(path)) return { url: 'd1' };
    throw new Error(path);
  },
  async stream(document, onText) {
    const row = (term, rank, asin, click, conv) => ({ departmentName: 'Amazon.com', searchTerm: term, searchFrequencyRank: 100, clickedAsin: asin, clickedItemName: asin, clickShareRank: rank, clickShare: click, conversionShare: conv });
    onText(JSON.stringify({ reportSpecification: {}, dataByDepartmentAndSearchTerm: [
      row('dog bed', 1, 'B0BEDSURC0', 0.12, 0.15), row('dog bed', 2, 'B0FURHAVC1', 0.08, 0.1), row('dog bed', 3, 'B0SUGGEST1', 0.05, 0.06),
      row('waterproof dog bed', 1, 'B0WESTHOC2', 0.1, 0.12), row('waterproof dog bed', 2, 'B0SUGGEST2', 0.07, 0.08),
      row('cat bed', 1, 'B0SUGGEST1', 0.09, 0.11), row('dog beds for large dogs', 1, 'B0BEDSURC2', 0.15, 0.2),
      row('washable dog bed', 1, 'B0SUGGEST1', 0.11, 0.1)] }));
  },
};

const { reportTiming, pricingTiming } = await import('../../server/src/petAmazon.js');
const { spApiTiming } = await import('../../server/src/spApi.js');
Object.assign(reportTiming, { pollMs: 0, throttleMs: 0 }); pricingTiming.batchGapMs = 0; spApiTiming.minIntervalMs = 0;
const { suggestCompetitors, syncCompetitors, saveMetrics } = await import('../../server/src/petCompetitors.js');

let vite, browser;
try {
  const login = await fetch(`${backend.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pet-owner', password: 'pet-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await fetch(`${backend.url}/api/sku/rows`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ rows: skuRows }) });
  const listing = db.prepare('INSERT INTO pet_listing_cache(sku,asin,price,status) VALUES(?,?,?,?)');
  for (const [i, size] of SIZES.entries()) listing.run(`RR22002BK${size}`, `B0OWNRR0${i}${i}`, ownPrices[size], 'Active');
  const sale = db.prepare('INSERT OR REPLACE INTO pet_daily_sales(day,sku,asin,units) VALUES(?,?,?,?)');
  for (let d = 1; d <= 30; d += 1) { const day = new Date(Date.UTC(2026, 9, 2) - d * 86400000).toISOString().slice(0, 10); sale.run(day, 'RR22002BKS', 'B0OWNRR000', 6); sale.run(day, 'RR22002BKM', 'B0OWNRR011', 4); sale.run(day, 'RR22002BKL', 'B0OWNRR022', 2); sale.run(day, 'RR26001BRM', 'B0OWNCORD1', 1); }
  const report = db.prepare(`INSERT INTO aba_asin_reports(user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash) VALUES(-1,'US',?,'2026-09-20','2026-09-26',39,'Amazon SP-API','h') RETURNING id`);
  const q = db.prepare('INSERT INTO aba_asin_queries VALUES(?,?,?,?,?,?,?,?,?)');
  const r0 = report.get('B0OWNRR000').id, r1 = report.get('B0OWNRR011').id;
  for (const [term, mp, ac, ap] of [['dog bed', 4200, 160, 14], ['dog beds for large dogs', 2100, 40, 3], ['waterproof dog bed', 1300, 90, 9], ['cat bed', 1100, 12, 0], ['washable dog bed', 800, 35, 4], ['dog bed medium size dog', 650, 50, 6], ['orthopedic dog bed', 600, 8, 0], ['calming dog bed', 560, 5, 0]]) {
    q.run(r0, term, mp * 20, mp * 300, mp * 8, mp, ac * 30, ac, ap); q.run(r1, term, mp * 20, mp * 300, mp * 8, mp, ac * 10, Math.round(ac / 3), Math.round(ap / 3));
  }
  await suggestCompetitors(1, gateway, ENV, () => new Date('2026-10-02T18:00:00Z'));
  // 前三个推荐已加入,留 BFPETHOME / Lesure 作推荐
  db.prepare(`UPDATE pet_competitors SET status='active' WHERE asin IN ('B0BEDSURE0','B0FURHAVEN','B0WESTHOME')`).run();
  for (let d = 12; d >= 0; d -= 1) {
    const day = new Date(Date.UTC(2026, 9, 2, 18) - d * 86400000);
    for (const asin of Object.keys(prices)) if (asin.startsWith('B0BEDSUR')) prices[asin] = Number((prices[asin] + (d === 1 ? -3 : 0)).toFixed(2));
    for (const asin of Object.keys(catalog)) { const ranks = catalog[asin].salesRanks[0].displayGroupRanks; if (ranks[0]) ranks[0].rank = Math.round(ranks[0].rank * (0.94 + ((asin.charCodeAt(9) + d) % 7) * 0.02)); }
    if (d === 2) catalog.B0WESTHOME.summaries[0].itemName = 'Western Home Waterproof Dog Bed Cat Bed Calming Rectangle Pet Bed for Small Medium Large Dogs, Machine Washable';
    await syncCompetitors(1, gateway, ENV, () => day);
  }
  const metrics = [];
  for (const rival of rivals) SIZES.forEach((_, i) => metrics.push({ asin: `${rival.parent.slice(0, 8)}C${i}`, parentAsin: rival.parent, rating: rival.brand === 'Bedsure' ? 4.5 : 4.4, reviews: rival.brand === 'Bedsure' ? 48211 : 15320, units: Math.round(9000 / rival.bsr * 120 / (i + 1)) }));
  saveMetrics(metrics, '2026-09', 'sellersprite.xlsx', 1);

  vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: backend.url, changeOrigin: true } } } });
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByLabel('用户名').fill('pet-owner'); await page.getByLabel('密码').fill('pet-test-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.locator('.topnav').getByRole('button', { name: '产品情报', exact: true }).click();
  await page.getByText('竞品对比').waitFor();
  await page.screenshot({ path: `${output}/产品情报-竞品监控.png`, fullPage: true });
  await page.locator('.intel-table tbody tr').filter({ hasText: 'Bedsure' }).first().getByRole('button', { name: /^4/ }).click();
  await page.locator('.intel-children').waitFor();
  await page.locator('.intel-table').first().screenshot({ path: `${output}/产品情报-子体展开.png` });
  await page.locator('section.card').filter({ hasText: '核心词覆盖' }).screenshot({ path: `${output}/产品情报-核心词覆盖.png` });
  await page.locator('.intel-table tbody tr').filter({ hasText: 'Western Home' }).first().getByRole('button', { name: '对照' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').screenshot({ path: `${output}/产品情报-文案对照.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '自家 Listing 体检' }).click();
  await page.locator('.intel-health').waitFor();
  await page.screenshot({ path: `${output}/产品情报-Listing体检.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('tab', { name: '竞品监控' }).click();
  await page.getByText('竞品对比').waitFor();
  await page.screenshot({ path: `${output}/产品情报-手机.png` });
  if (errors.length) console.error('page errors', errors);
  console.log('done', output);
} finally {
  await browser?.close(); await vite?.close(); await backend.close();
}
