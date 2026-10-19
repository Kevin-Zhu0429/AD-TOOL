import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';
import { asinFixture } from './abaAsinFixture.js';
import { publicFixture, publicTask } from './abaPublicFixture.js';
import { savePublicReports } from '../src/services/publicAsinData.js';

test('ABA shared SKU library: owner-only atomic multi-market upsert, private/public matching and personal-library independence', async (t) => {
  const server = await startAbaTestServer(); t.after(() => server.close());
  const call = async (path, cookie, body) => {
    const response = await fetch(server.url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie: cookie ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username) => (await call('/auth/login', '', { username, password: 'local-test-password' })).cookie;
  const owner = await login('aba-other'), operator = await login('aba-test'), de = await login('aba-de');
  const row = { country: 'ES', brand: 'CE', sku: 'CENTRAL-305', asin: 'B000000305', model: '305', setGroup: 'BK' };
  assert.equal((await call('/aba-skus')).status, 401);
  assert.equal((await call('/aba-skus/import', operator, { rows: [row] })).status, 403);
  assert.equal((await call('/aba-skus/preview', operator, { rows: [row] })).status, 403);
  assert.equal((await call('/aba-skus', operator)).data.canManage, false);
  assert.equal((await call('/aba-skus', owner)).data.enabled, false);
  const preview = await call('/aba-skus/preview', owner, { rows: [row, { ...row, country: 'DE' }, { ...row, country: 'US' }, row] });
  assert.equal(preview.data.count, 3); assert.equal(preview.data.duplicates, 1);
  assert.equal((await call('/aba-skus', owner)).data.enabled, false, 'preview never activates or saves');
  assert.equal((await call('/aba-skus/import', owner, { rows: [row, { ...row, country: 'XX' }] })).status, 400);
  assert.equal((await call('/aba-skus', owner)).data.libraryTotal, 0);
  assert.equal((await call('/aba-skus/import', owner, { rows: [row, { ...row, model: '304' }] })).status, 400);
  assert.equal((await call('/aba-skus/import', owner, { rows: [{ ...row, asin: '' }] })).status, 400);
  const imported = await call('/aba-skus/import', owner, { rows: [row, { ...row, country: 'DE' }, { ...row, country: 'US' }], filename: 'all.xlsx', replace: true });
  assert.equal(imported.data.added, 3); assert.equal(imported.data.library.enabled, true);
  assert.equal((await call('/aba-skus/import', owner, { rows: [{ ...row, setGroup: 'BKC' }] })).data.updated, 1);
  assert.equal((await call('/aba-skus', owner)).data.libraryTotal, 3, 'table-external countries remain');
  assert.equal((await call('/aba-skus/import', owner, { rows: [{ ...row, model: '304' }, { ...row, country: 'DE', asin: 'bad' }] })).status, 400);
  assert.equal((await call('/aba-skus?country=ES', owner)).data.items[0].model, '305', 'a later invalid row cannot partially change an existing mapping');
  assert.deepEqual((await call('/aba-skus/preview', owner, { rows: [{ ...row, country: '阿联酋' }] })).data.countries, ['AE']);
  assert.equal((await call('/aba-skus/preview', owner, { rows: [{ ...row, brand: {} }] })).status, 400);
  assert.equal((await call('/aba-skus?country=DE', operator)).data.items[0].country, 'DE');
  assert.equal((await call('/aba-skus?q=central', operator)).data.total, 3);
  assert.equal((await call('/aba-skus?q=missing&page=999', operator)).data.page, 1);
  // Wrong personal mapping must never leak into ABA once the dedicated library is enabled.
  await call('/sku/rows', operator, { rows: [{ ...row, sku: 'PERSONAL-WRONG', model: '304' }] });
  const files = [row.asin, 'B000000399'].map((asin) => ({ name: asin + '.csv', text: asinFixture({ asin, rows: [['hp deskjet 2820e', 100, 1000, 100, 20, 200, 10, 5]] }) }));
  assert.equal((await call('/aba/asin/import', operator, { marketplace: 'ES', files })).status, 200);
  for (const asin of [row.asin, 'B000000399']) {
    const task = { ...publicTask, asins_json: JSON.stringify([asin]) };
    savePublicReports(server.db, { task, payload: publicFixture(task), marketplaceId: 'A1RKKUPIHCS9HS' });
  }
  for (const endpoint of ['/aba/asin', '/aba-public/asin']) {
    const result = (await call(endpoint + '?marketplace=ES&year=&q=2820', operator)).data;
    assert.equal(result.skuSource, 'aba');
    assert.equal(result.skuItems[0].sku, 'CENTRAL-305');
    assert.ok(result.skuItems[0].id.startsWith('aba:'));
    assert.equal(result.items.find((r) => r.asin === row.asin).alignment.status, 'matched');
    assert.match(result.items.find((r) => r.asin === 'B000000399').alignment.reason, /专用 SKU 库未收录/);
    assert.equal((await call(endpoint + '?marketplace=ES&year=&q=2820&model=305&view=printers&export=1', operator)).data.items.length, 1);
  }
  assert.equal((await call('/aba/asin?marketplace=ES', owner)).data.reports.length, 0, 'private report ownership remains intact');
  assert.equal((await call('/aba/asin?marketplace=ES', de)).status, 403);
  await call('/sku/rows', operator, { rows: [{ ...row, sku: 'PERSONAL-MISSING', asin: 'B000000399' }] });
  assert.equal((await call('/aba/asin?marketplace=ES&year=&asin=B000000399', operator)).data.items[0].alignment.status, 'insufficient');
  // A country missing from the central library never falls back to a personal mapping.
  assert.equal((await call('/aba-public/asin?marketplace=FR', operator)).data.skuSource, 'aba');
  assert.equal(server.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity='aba_sku_items' AND action='import'").get().n, 2);
  assert.equal((await call('/sku', operator)).data.items.some((r) => r.sku === 'PERSONAL-WRONG'), true);
});
