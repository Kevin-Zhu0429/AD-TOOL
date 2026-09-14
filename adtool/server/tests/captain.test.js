import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('Captain shared EU inventory is assigned to separate users by country', async (t) => {
  process.env.CAPTAIN_CLIENT_ID = 'test-client';
  process.env.CAPTAIN_CLIENT_SECRET = 'test-secret';
  process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS = '1';

  const originalFetch = global.fetch;
  let server;
  t.after(async () => {
    global.fetch = originalFetch;
    delete process.env.CAPTAIN_CLIENT_ID;
    delete process.env.CAPTAIN_CLIENT_SECRET;
    delete process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS;
    if (server) await server.close();
  });

  server = await startAbaTestServer();
  const localFetch = originalFetch;
  const users = Object.fromEntries(server.db.prepare(
    "SELECT id, username FROM users WHERE username IN ('aba-test', 'aba-other', 'aba-de')"
  ).all().map((row) => [row.username, row.id]));

  async function call(route, cookie = '', method = 'GET', body) {
    const response = await localFetch(server.url + '/api' + route, {
      method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      data: await response.json(),
    };
  }
  const login = async (username) => (
    await call('/auth/login', '', 'POST', { username, password: 'local-test-password' })
  ).cookie;
  const esCookie = await login('aba-test');
  const ownerCookie = await login('aba-other');
  const deCookie = await login('aba-de');

  const insertSku = server.db.prepare(
    `INSERT INTO sku_items
       (user_id, country, brand, model, set_group, sku, stock, transit, asin, dedupe)
     VALUES (?, ?, ?, '301', 'BKC', 'EU-SKU-1', ?, ?, null, ?)`
  );
  insertSku.run(users['aba-test'], 'ES', 'HP', 1, 2, 'ES|eu-sku-1');
  insertSku.run(users['aba-test'], 'DE', 'HP', 777, 888, 'DE|eu-sku-1');
  insertSku.run(users['aba-test'], 'UK', 'HP', 1, 2, 'UK|eu-sku-1');
  insertSku.run(users['aba-test'], 'US', 'HP', 1, 2, 'US|eu-sku-1');
  insertSku.run(users['aba-de'], 'DE', 'HP', 1, 2, 'DE|eu-sku-1');
  insertSku.run(users['aba-other'], 'FR', 'HP', 1, 2, 'FR|eu-sku-1');
  insertSku.run(users['aba-other'], 'IT', 'HP', 1, 2, 'IT|eu-sku-1');
  server.db.prepare(
    `INSERT INTO sku_items
       (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
     VALUES (?, 'ES', 'Canon', '545', 'BK', 'EU-SKU-1', 77, 88, 'ES|canon-eu-sku-1')`
  ).run(users['aba-test']);

  let failingChannel = '';
  const inventoryCalls = new Map();
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') {
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /client_id=test-client/);
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    }
    if (url.pathname === '/v1/open_user/get_site_list') {
      return Response.json({ code: 200, data: [
        { site_id: 1, code: 'ES' }, { site_id: 2, code: 'DE' },
        { site_id: 3, code: 'FR' }, { site_id: 4, code: 'IT' },
        { site_id: 5, code: 'UK' }, { site_id: 6, code: 'US' },
      ] });
    }
    if (url.pathname === '/v1/open_user/get_channel_list') {
      const otherBrandGroups = ['CC', 'CE', 'CY', 'PG'].flatMap((brand) => (
        [['ES', 1], ['DE', 2], ['FR', 3], ['IT', 4]].map(([country, siteId]) => ({
          title: `${brand}_EU_${country}`,
          site_id: siteId,
          open_channel_id: `${brand.toLowerCase()}-${country.toLowerCase()}`,
          status: 1,
        }))
      ));
      const data = [
        ...otherBrandGroups,
        { title: 'HP_EU_DE', site_id: 2, open_channel_id: 'channel-de', status: 1 },
        { title: 'HP_EU_ES', site_id: 1, open_channel_id: 'channel-es', status: 1 },
        { title: 'HP_EU_FR', site_id: 3, open_channel_id: 'channel-fr', status: 1 },
        { title: 'HP_EU_IT', site_id: 4, open_channel_id: 'channel-it', status: 1 },
        { title: 'HP_EU_UK', site_id: 5, open_channel_id: 'channel-uk', status: 1 },
        { title: 'HP_US', site_id: 6, open_channel_id: 'channel-us', status: 1 },
      ];
      return Response.json({ code: 200, max_result: data.length, data });
    }
    if (url.pathname === '/v1/open_fba/inventory_list') {
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-token');
      const channel = new Headers(options.headers).get('OpenChannelId');
      inventoryCalls.set(channel, (inventoryCalls.get(channel) ?? 0) + 1);
      if (channel === failingChannel) throw new Error('temporary remote failure');
      const quantities = {
        'channel-de': [15, 1], 'channel-es': [15, 1], 'channel-fr': [15, 1], 'channel-it': [15, 1],
        'channel-uk': [7, 4], 'channel-us': [99, 5],
      };
      const [stock, transit] = quantities[channel] ?? [0, 0];
      return Response.json({ code: 200, msg: 'ok', max_result: 1, data: [{
        SKU: 'EU-SKU-1', asin: 'B012345678', fulfillable_quantity: stock,
        inbound_shipped_quantity: transit, inbound_receiving_quantity: 0,
        inbound_working_quantity: 0, is_delete: 0,
      }] });
    }
    throw new Error(`Unexpected remote request: ${url}`);
  };

  const discovered = await call('/captain/discover', ownerCookie, 'POST');
  assert.equal(discovered.status, 200);
  for (const groupName of ['CC_EU', 'CE_EU', 'CY_EU', 'PG_EU', 'HP_EU']) {
    assert.deepEqual(
      discovered.data.groups.find((group) => group.groupName === groupName)?.countries,
      ['ES', 'DE', 'FR', 'IT'],
    );
  }
  const euGroup = discovered.data.groups.find((group) => group.groupName === 'HP_EU');
  const ukGroup = discovered.data.groups.find((group) => group.groupName === 'HP_EU_UK');
  const usGroup = discovered.data.groups.find((group) => group.groupName === 'HP_US');

  assert.equal((await call('/captain/bindings', esCookie, 'POST', {})).status, 403);
  assert.equal((await call('/captain/bindings', ownerCookie, 'POST', {
    ...euGroup,
    brand: 'Cyloral',
    assignments: [
      { country: 'ES', userId: users['aba-test'] },
      { country: 'DE', userId: users['aba-de'] },
      { country: 'FR', userId: users['aba-other'] },
      { country: 'IT', userId: users['aba-other'] },
    ],
  })).status, 400);

  async function saveGroup(group, assignments) {
    const response = await call('/captain/bindings', ownerCookie, 'POST', {
      groupKey: group.groupKey,
      groupName: group.groupName,
      scope: group.scope,
      brand: 'hp',
      channels: group.channels,
      assignments,
    });
    assert.equal(response.status, 200, response.data.error);
    return response.data;
  }
  const partialBinding = await saveGroup(euGroup, [
    { country: 'ES', userId: users['aba-test'] },
  ]);
  assert.equal(partialBinding.assignments, 1);
  assert.equal((await call('/captain/sync', deCookie, 'POST')).status, 400);
  assert.deepEqual(
    (await call('/captain/status', esCookie)).data.bindings.map((row) => row.country),
    ['ES'],
  );

  await saveGroup(euGroup, [
    { country: 'ES', userId: users['aba-test'] },
    { country: 'DE', userId: users['aba-de'] },
    { country: 'FR', userId: users['aba-other'] },
    { country: 'IT', userId: users['aba-other'] },
  ]);
  await saveGroup(ukGroup, [{ country: 'UK', userId: users['aba-test'] }]);
  await saveGroup(usGroup, [{ country: 'US', userId: users['aba-test'] }]);

  const esSync = await call('/captain/sync', esCookie, 'POST');
  assert.equal(esSync.status, 200);
  assert.equal(esSync.data.succeeded, 6);
  assert.equal(esSync.data.updated, 3);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'ES' AND brand = 'HP'"
  ).get(users['aba-test']).stock, 15);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'DE' AND brand = 'HP'"
  ).get(users['aba-test']).stock, 777);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'DE' AND brand = 'HP'"
  ).get(users['aba-de']).stock, 1);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'UK' AND brand = 'HP'"
  ).get(users['aba-test']).stock, 7);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'US' AND brand = 'HP'"
  ).get(users['aba-test']).stock, 99);

  const deSync = await call('/captain/sync', deCookie, 'POST');
  assert.equal(deSync.status, 200);
  assert.equal(deSync.data.sources, 4);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'DE' AND brand = 'HP'"
  ).get(users['aba-de']).stock, 15);

  inventoryCalls.clear();
  const allSync = await call('/captain/sync-all', ownerCookie, 'POST');
  assert.equal(allSync.status, 200);
  assert.equal(allSync.data.users, 3);
  assert.equal(allSync.data.sources, 6);
  assert.equal(allSync.data.updated, 6);
  assert.deepEqual([...inventoryCalls.values()], [1, 1, 1, 1, 1, 1]);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'FR' AND brand = 'HP'"
  ).get(users['aba-other']).stock, 15);

  const status = await call('/captain/status', esCookie);
  assert.deepEqual(status.data.bindings.map((row) => row.country).sort(), ['ES', 'UK', 'US']);
  const admin = await call('/captain/admin', ownerCookie);
  assert.equal(admin.data.assignments.length, 6);
  assert.ok(admin.data.skuCoverage.some((row) => (
    row.userId === users['aba-de'] && row.country === 'DE' && row.brand === 'HP'
  )));

  failingChannel = 'channel-es';
  const partial = await call('/captain/sync', esCookie, 'POST');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.failed, 1);
  assert.match(partial.data.errors[0], /temporary remote failure/);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'ES' AND brand = 'HP'"
  ).get(users['aba-test']).stock, 15);

  const deAssignment = admin.data.assignments.find((row) => row.country === 'DE');
  assert.equal((await call(`/captain/assignments/${deAssignment.id}`, ownerCookie, 'PATCH', { enabled: false })).status, 200);
  const disabledStatus = await call('/captain/status', deCookie);
  assert.equal(disabledStatus.data.bindings[0].enabled, 0);

  const canon = server.db.prepare(
    "SELECT stock, transit FROM sku_items WHERE user_id = ? AND brand = 'Canon'"
  ).get(users['aba-test']);
  assert.deepEqual(canon, { stock: 77, transit: 88 });
});
