import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

const buckets = ['0-30', '31-60', '61-90', '91-180', '181-270', '271-365', '366-455', '>456'];
function row(code, sku, sales7, sales14) {
  return { 市场代码: code, SKU: sku, '7日均销量': sales7, '14日均销量': sales14,
    ...Object.fromEntries(buckets.map((bucket) => [bucket, bucket === '>456' ? 100 : 0])) };
}

test('shared fee batches, all-account access, persisted revisions and latest-batch protection', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());
  async function call(path, cookie = '', method = 'GET', body) {
    const response = await fetch(`${server.url}/api${path}`, { method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (name) => (await call('/auth/login', '', 'POST', { username: name, password: 'local-test-password' })).cookie;
  const es = await login('aba-test');
  const de = await login('aba-de');
  const owner = await login('aba-other');
  assert.equal((await call('/aged-fees')).status, 401);

  const imported = await call('/aged-fees/import', es, 'POST', {
    date: '2026-09-01', scenario: 'uniform', sourceFile: '库存.xlsx',
    rows: [row('CY_EU', 'EU-SKU', 1, 2), row('CY_US', 'US-SKU', 0, 1), row('CY_AE', 'AE-SKU', 0, 0)],
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.batch.rowCount, 3);
  assert.deepEqual(imported.data.rows.map((item) => item.sku), ['EU-SKU', 'US-SKU', 'AE-SKU']);
  assert.deepEqual((await call('/aged-fees', de)).data.rows.map((item) => item.sku), ['EU-SKU', 'US-SKU', 'AE-SKU']);
  const all = (await call('/aged-fees', owner)).data.rows;
  assert.deepEqual(all.map((item) => item.sku), ['EU-SKU', 'US-SKU', 'AE-SKU']);
  assert.equal(all[2].dailySales, 0.14);
  const euId = all[0].id;
  const usId = all[1].id;
  assert.equal((await call(`/aged-fees/rows/${usId}`, es, 'PATCH', { special: true, value: 2, reason: '', revision: 0 })).status, 200);
  assert.deepEqual((await call('/aged-fees', de)).data.rows[1].correction, { special: true, value: '2', reason: '', revision: 1 });
  assert.equal((await call(`/aged-fees/rows/${euId}`, de, 'PATCH', { special: true, value: 2, reason: '促销', revision: 0 })).status, 200);
  assert.equal((await call(`/aged-fees/rows/${euId}`, es, 'PATCH', { special: true, value: 3, reason: '', revision: 0 })).status, 409);
  const saved = (await call('/aged-fees', es)).data.rows[0];
  assert.deepEqual(saved.correction, { special: true, value: '2', reason: '促销', revision: 1 });

  const newer = await call('/aged-fees/import', de, 'POST', { date: '2026-09-02', scenario: 'uniform', rows: [row('CY_EU', 'NEXT', 3, 3)] });
  assert.equal(newer.status, 200);
  assert.deepEqual((await call('/aged-fees', es)).data.rows.map((item) => item.sku), ['NEXT']);
  assert.equal((await call(`/aged-fees/rows/${euId}`, es, 'PATCH', { special: false, value: '', reason: '', revision: 1 })).status, 409);
  assert.equal((await call(`/aged-fees?batchId=${imported.data.batch.id}`, owner)).data.rows[0].sku, 'EU-SKU');
});
