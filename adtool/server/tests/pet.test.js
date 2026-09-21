import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startPetTestServer } from './petHarness.js';
import { asinFixture } from './abaAsinFixture.js';
import { brandFixture } from './abaFixture.js';

test('pet US-only workflow, SKU variants, product imports, ABA ownership and database isolation', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  async function call(route, cookie, body, method = 'POST') {
    const response = await fetch(backend.url + '/api' + route, { method: body === undefined ? 'GET' : method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = (await call('/auth/login', null, { username: 'pet-owner', password: 'pet-test-password' })).cookie;
  const user = (await call('/auth/login', null, { username: 'pet-user', password: 'pet-test-password' })).cookie;
  const sku = { sku: 'PET-RAIN-L', style: '雨衣 A 款', size: 'L', color: '黄色', fabric: '涂层 / 纯色', stock: 0, transit: 80, brand: 'Pet Brand', asin: 'B000000001' };
  await t.test('only US is available even for the owner', async () => {
    assert.deepEqual((await call('/config')).data.markets, ['US']);
    assert.deepEqual((await call('/auth/me', owner)).data.user.markets, ['US']);
    assert.equal((await call('/sku?marketplace=ES', owner)).status, 400);
    assert.equal((await call('/products?marketplace=ES', owner)).status, 403);
    assert.equal((await call('/aba?marketplace=DE', owner)).status, 400);
    assert.equal((await call('/neg?marketplace=US', owner)).status, 404);
    assert.equal((await call('/auth/users', owner, { username: 'wrong-market', displayName: 'wrong', password: 'test-password', role: 'operator', markets: ['ES'] })).status, 400);
  });
  await t.test('SKU attributes survive import and update; partial invalid replace cannot clear inventory', async () => {
    assert.equal((await call('/sku/rows', owner, { rows: [sku, { ...sku, sku: 'PET-RAIN-XL', size: 'XL', stock: '', asin: 'B000000002' }] })).data.added, 2);
    let rows = (await call('/sku', owner)).data.items;
    assert.deepEqual(rows.map((s) => s.size).sort(), ['L', 'XL']);
    assert.equal(rows[0].country, 'US'); assert.equal(rows.find((s) => s.size === 'XL').stock, null);
    const result = await call('/sku/rows', owner, { replace: true, rows: [{ ...sku, stock: 10 }, { ...sku, sku: 'WRONG', country: 'DE' }] });
    assert.equal(result.data.errorCount, 1); assert.equal(result.data.removed, 0);
    rows = (await call('/sku', owner)).data.items; assert.equal(rows.find((s) => s.size === 'L').stock, 0);
    assert.equal((await call('/sku', user)).data.items.length, 0);
    assert.equal((await call('/sku/' + rows[0].id, user, { color: '红色' }, 'PATCH')).status, 403);
    assert.equal((await call('/sku/' + rows[0].id, owner, { fabric: '细绒', stock: '' }, 'PATCH')).status, 200);
    assert.equal((await call('/sku', owner)).data.items[0].fabric, '细绒');
  });
  await t.test('product validation is atomic and manual pet attributes survive refresh', async () => {
    const product = { asin: sku.asin, title: 'Pet raincoat', style: '雨衣 A 款', size: 'L', price: 15.99, is_own: true, comparison_group: '同规格雨衣' };
    assert.equal((await call('/products/import', owner, { marketplace: 'US', dataMonth: '2026-09', products: [product] })).status, 200);
    assert.equal((await call('/products/import', owner, { marketplace: 'US', dataMonth: '2026-09', products: [{ ...product, price: 25 }, { asin: 'BAD' }] })).status, 400);
    let data = (await call('/products?marketplace=US', owner)).data;
    assert.equal(data.products[0].price, 15.99);
    assert.equal((await call('/products/' + sku.asin, owner, { marketplace: 'US', dataMonth: '2026-09', changes: { comparison_group: '', is_own: false, style: '手工款式' } }, 'PATCH')).status, 200);
    await call('/products/import', owner, { marketplace: 'US', dataMonth: '2026-09', products: [{ ...product, price: 18 }] });
    data = (await call('/products?marketplace=US', owner)).data;
    assert.equal(data.products[0].style, '手工款式'); assert.equal(data.products[0].comparison_group, ''); assert.equal(data.products[0].is_own, false); assert.equal(data.products[0].price, 18);
    assert.equal((await call('/products/' + sku.asin, owner, { marketplace: 'US', changes: { rating: 9 } }, 'PATCH')).status, 400);
  });
  await t.test('ABA keeps ASIN metrics separate while filtering exact pet sizes', async () => {
    const files = ['B000000001', 'B000000002'].map((asin) => ({ name: 'US_Week.csv', text: asinFixture({ asin, rows: [['dog raincoat', 100, 1000, 100, 20, 200, 10, 5]] }) }));
    assert.equal((await call('/aba/asin/import', owner, { marketplace: 'US', files })).status, 200);
    let data = (await call('/aba/asin?marketplace=US&view=printers&model=301&wordType=printer', owner)).data;
    assert.equal(data.view, 'queries'); assert.equal(data.total, 2); assert.equal(data.seriesMerged, false); assert.equal(data.hasModelLibrary, false);
    data = (await call('/aba/asin?marketplace=US&size=XL', owner)).data;
    assert.equal(data.total, 1); assert.equal(data.items[0].asin, 'B000000002'); assert.equal(data.items[0].market_impressions, 1000);
    assert.equal((await call('/aba/asin?marketplace=US&size=M', owner)).data.total, 0);
    assert.equal((await call('/aba/asin?marketplace=US&scope=all', user)).data.total, 0);
    await call('/sku/rows', owner, { rows: [{ ...sku, sku: 'SECOND-L' }] });
    data = (await call('/aba/asin?marketplace=US&size=L', owner)).data;
    assert.equal(data.total, 1); assert.equal(data.items[0].asin_clicks, 10);
    assert.equal((await call('/aba/import', owner, { marketplace: 'US', files: [{ name: 'US_Week.csv', text: brandFixture({ brand: 'Pet Brand', rows: [['dog coat', 100, 1000, 100, 100, 12, 20]] }) }] })).status, 200);
    data = (await call('/aba?marketplace=US&q=dog&view=printers&wordType=printer&export=1', owner)).data;
    assert.equal(data.total, 1); assert.equal(data.items[0].recognition, '');
  });
  await t.test('database profile marker blocks opening a pet database in ink mode', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/src/db.js')"], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, APP_PROFILE: 'ink', DATA_DIR: backend.directory }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /数据库品类不匹配/);
  });
});
