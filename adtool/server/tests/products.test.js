import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('product imports run in the worker pool and keep manual fields, audit and month isolation', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());
  server.db.prepare("UPDATE users SET product_intel = 1 WHERE username IN ('aba-test', 'aba-other')").run();

  async function call(route, cookie = '', method = 'GET', body) {
    const response = await fetch(server.url + '/api' + route, {
      method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (username) => (await call('/auth/login', '', 'POST', { username, password: 'local-test-password' })).cookie;
  const es = await login('aba-test');
  const owner = await login('aba-other');

  const first = await call('/products/import', es, 'POST', {
    marketplace: 'ES', dataMonth: '2026-08', sourceFile: 'ES-2026-08.xlsx',
    products: [{ asin: 'b0000000a1', brand: 'HP', model: '305', color_grp: 'BK' }, { asin: '' }, { asin: 'B0000000A2', brand: 'Canon' }],
  });
  assert.equal(first.status, 200);
  assert.deepEqual({ ...first.data }, { added: 2, updated: 0, skipped: 1, total: 2, received: 3, dataMonth: '2026-08' });

  assert.equal((await call('/products/B0000000A1?marketplace=ES', es, 'PATCH', { dataMonth: '2026-08', changes: { brand: 'Own' } })).status, 200);
  const again = await call('/products/import', es, 'POST', {
    marketplace: 'ES', dataMonth: '2026-08', sourceFile: 'ES-2026-08.xlsx', products: [{ asin: 'B0000000A1', brand: 'HP', model: '305XL' }],
  });
  assert.equal(again.data.updated, 1);

  const all = await call('/products/import-all', owner, 'POST', {
    dataMonth: '2026-09', sourceFile: 'all.xlsx', productsByMarketplace: { es: [{ asin: 'B0000000B1' }], DE: [{ asin: 'B0000000B2' }, { asin: 'B0000000B3' }] },
  });
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.totals, { added: 3, updated: 0, skipped: 0, total: 3, received: 3 });

  const august = (await call('/products?marketplace=ES&dataMonth=2026-08', es)).data;
  assert.equal(august.dataMonth, '2026-08');
  assert.deepEqual(august.months.map((m) => m.month), ['2026-09', '2026-08']);
  const kept = august.products.find((p) => p.asin === 'B0000000A1');
  assert.equal(kept.brand, 'Own', 'manually edited brand survives a re-import');
  assert.equal(kept.model, '305XL');
  assert.deepEqual((await call('/products?marketplace=ES', es)).data.products.map((p) => p.asin), ['B0000000B1']);
  assert.equal((await call('/products?marketplace=DE', es)).status, 403);

  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity = 'products' AND action = 'import'").get().count, 4);
});
