import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('portfolio library import, isolation, update, replace and delete', async (t) => {
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
  const first = await login('aba-test');
  const second = await login('aba-other');
  const de = await login('aba-de');
  const rows = [
    { portfolioId: '101848370296114', name: 'SP-CY 540 Series' },
    { portfolioId: '166554279036853', name: 'SP-CY 混投' },
  ];

  assert.equal((await call('/portfolio?marketplace=ES')).status, 401);
  assert.equal((await call('/portfolio/rows', de, 'POST', { marketplace: 'ES', rows })).status, 403);
  assert.equal((await call('/portfolio/rows', first, 'POST', { marketplace: 'ES', rows })).status, 200);
  let own = (await call('/portfolio?marketplace=ES', first)).data;
  assert.equal(own.items.length, 2);
  assert.equal((await call('/portfolio?marketplace=ES', second)).data.items.length, 0);

  const item = own.items.find((row) => row.portfolioId === rows[0].portfolioId);
  assert.equal((await call(`/portfolio/${item.id}`, second, 'PATCH', { name: 'other' })).status, 404);
  assert.equal((await call(`/portfolio/${item.id}`, first, 'PATCH', { name: 'SP-CY 540 Series Updated' })).status, 200);
  own = (await call('/portfolio?marketplace=ES', first)).data;
  assert.equal(own.items.find((row) => row.id === item.id).name, 'SP-CY 540 Series Updated');

  const replacement = [{ portfolioId: '3996987210192', name: 'SP-CY 302 Series' }];
  const replaced = await call('/portfolio/rows', first, 'POST', { marketplace: 'ES', rows: replacement, replace: true });
  assert.equal(replaced.data.removed, 2);
  own = (await call('/portfolio?marketplace=ES', first)).data;
  assert.deepEqual(own.items.map((row) => row.portfolioId), ['3996987210192']);

  assert.equal((await call('/portfolio/delete', first, 'POST', { ids: [own.items[0].id] })).data.deleted, 1);
  assert.equal((await call('/portfolio?marketplace=ES', first)).data.items.length, 0);
});
