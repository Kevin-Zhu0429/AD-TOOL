import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('SB brand assets: per-market shared store, needs manual-ads right and market access', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());

  async function call(route, cookie = '', method = 'GET', body) {
    const response = await fetch(server.url + '/api' + route, {
      method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (username) => (await call('/auth/login', '', 'POST', { username, password: 'local-test-password' })).cookie;
  const owner = await login('aba-other');
  const operator = await login('aba-test');
  const data = {
    brands: [{ entityId: 'ENTITY3GOUUEW2BL7Y7', name: 'COLORETTO' }, { entityId: 'bad', name: 'x' }],
    logos: [{ assetId: 'amzn1.assetlibrary.asset1.logo:version_v1', name: 'logo.png', url: 'https://x/l.png', crop: '{"left":"0"}', extra: 'drop me' }],
    videos: [{ assetId: 'vid1', name: 'v.mp4' }],
  };

  assert.equal((await call('/sb-assets?marketplace=IT')).status, 401);
  // 运营默认没有手动 / 品牌广告使用权
  assert.equal((await call('/sb-assets?marketplace=ES', operator)).status, 403);
  assert.equal((await call('/sb-assets?marketplace=XX', owner)).status, 400);
  assert.deepEqual((await call('/sb-assets?marketplace=IT', owner)).data.data, null);
  assert.equal((await call('/sb-assets', owner, 'POST', { marketplace: 'IT', data: { brands: [] } })).status, 400);

  const saved = await call('/sb-assets', owner, 'POST', { marketplace: 'IT', data, fileName: 'bulk.xlsx' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.data.brands, [{ entityId: 'ENTITY3GOUUEW2BL7Y7', name: 'COLORETTO' }]);
  assert.equal(saved.data.data.logos[0].extra, undefined);
  assert.equal(saved.data.data.logos[0].crop, '{"left":"0"}');

  const got = (await call('/sb-assets?marketplace=IT', owner)).data;
  assert.equal(got.fileName, 'bulk.xlsx');
  assert.equal(got.uploadedBy, 'aba-other');
  assert.equal(got.data.videos[0].assetId, 'vid1');

  server.db.prepare("UPDATE users SET manual_ads = 1 WHERE username = 'aba-test'").run();
  const operator2 = await login('aba-test');
  assert.equal((await call('/sb-assets?marketplace=ES', operator2)).status, 200);
  assert.equal((await call('/sb-assets?marketplace=IT', operator2)).status, 403);
});
