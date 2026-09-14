import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('Captain inventory sync binds stores by user, brand and country and shares EU totals', async (t) => {
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
  const operatorCookie = await login('aba-test');
  const ownerCookie = await login('aba-other');
  const operator = server.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get();

  const insertSku = server.db.prepare(
    `INSERT INTO sku_items
       (user_id, country, brand, model, set_group, sku, stock, transit, asin, dedupe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const country of ['ES', 'DE', 'FR', 'UK', 'US']) {
    insertSku.run(operator.id, country, 'HP', '301', 'BKC', 'EU-SKU-1', 1, 2, null, `${country}|eu-sku-1`);
  }
  insertSku.run(operator.id, 'ES', 'Canon', '545', 'BK', 'EU-SKU-1', 77, 88, null, 'ES|canon-eu-sku-1');

  const bindings = [
    { openChannelId: 'channel-de', channelName: 'HP 德国', siteId: 2, country: 'DE' },
    { openChannelId: 'channel-es', channelName: 'HP 西班牙', siteId: 1, country: 'ES' },
    { openChannelId: 'channel-us', channelName: 'HP 美国', siteId: 6, country: 'US' },
  ];
  assert.equal((await call('/captain/bindings', operatorCookie, 'POST', {
    ...bindings[0], userId: operator.id, brand: 'HP',
  })).status, 403);
  assert.equal((await call('/captain/bindings', ownerCookie, 'POST', {
    ...bindings[0], userId: operator.id, brand: 'Cyloral',
  })).status, 400);
  for (const binding of bindings) {
    const result = await call('/captain/bindings', ownerCookie, 'POST', {
      ...binding, userId: operator.id, brand: 'HP',
    });
    assert.equal(result.status, 200);
  }

  let failingChannel = '';
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
        { site_id: 3, code: 'FR' }, { site_id: 4, code: 'IT' }, { site_id: 5, code: 'UK' },
      ] });
    }
    if (url.pathname === '/v1/open_user/get_channel_list') {
      const data = [
        { title: 'HP_EU_DE', site_id: 2, open_channel_id: 'channel-de', status: 1 },
        { title: 'HP_EU_ES', site_id: 1, open_channel_id: 'channel-es', status: 1 },
        { title: 'HP_EU_FR', site_id: 3, open_channel_id: 'channel-fr', status: 1 },
        { title: 'HP_EU_IT', site_id: 4, open_channel_id: 'channel-it', status: 0 },
        { title: 'HP_EU_UK', site_id: 5, open_channel_id: 'channel-uk', status: 1 },
      ];
      return Response.json({ code: 200, max_result: data.length, data });
    }
    if (url.pathname === '/v1/open_fba/inventory_list') {
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-token');
      const channel = new Headers(options.headers).get('OpenChannelId');
      if (channel === failingChannel) throw new Error('temporary remote failure');
      const byChannel = {
        'channel-de': [
          { SKU: 'EU-SKU-1', asin: 'B012345678', fulfillable_quantity: 10, inbound_shipped_quantity: 1, inbound_receiving_quantity: 2, inbound_working_quantity: 0, is_delete: 0 },
          { SKU: 'NOT-IN-LIBRARY', fulfillable_quantity: 5, is_delete: 0 },
        ],
        'channel-es': [
          { SKU: 'EU-SKU-1', asin: 'B012345678', fulfillable_quantity: 20, inbound_shipped_quantity: 2, inbound_receiving_quantity: 0, inbound_working_quantity: 2, is_delete: 0 },
        ],
        'channel-us': [
          { SKU: 'EU-SKU-1', asin: 'B012345678', fulfillable_quantity: 99, inbound_shipped_quantity: 7, inbound_receiving_quantity: 0, inbound_working_quantity: 0, is_delete: 0 },
        ],
      };
      const data = byChannel[channel] ?? [];
      return Response.json({ code: 200, msg: 'ok', max_result: data.length, data });
    }
    throw new Error(`Unexpected remote request: ${url}`);
  };

  const synced = await call('/captain/sync', operatorCookie, 'POST');
  assert.equal(synced.status, 200);
  assert.equal(synced.data.succeeded, 3);
  assert.equal(synced.data.failed, 0);
  assert.equal(synced.data.updated, 5);
  assert.equal(synced.data.unmatched, 1);

  const hpRows = server.db.prepare(
    "SELECT country, brand, model, set_group, stock, transit, asin FROM sku_items WHERE user_id = ? AND brand = 'HP' ORDER BY country"
  ).all(operator.id);
  for (const row of hpRows.filter((row) => ['ES', 'DE', 'FR', 'UK'].includes(row.country))) {
    assert.equal(row.stock, 30);
    assert.equal(row.transit, 7);
    assert.equal(row.asin, 'B012345678');
    assert.equal(row.model, '301');
    assert.equal(row.set_group, 'BKC');
  }
  const us = hpRows.find((row) => row.country === 'US');
  assert.equal(us.stock, 99);
  assert.equal(us.transit, 7);

  const canon = server.db.prepare("SELECT stock, transit FROM sku_items WHERE user_id = ? AND brand = 'Canon'").get(operator.id);
  assert.deepEqual(canon, { stock: 77, transit: 88 });

  failingChannel = 'channel-es';
  const partial = await call('/captain/sync', operatorCookie, 'POST');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.failed, 1);
  assert.match(partial.data.errors[0], /temporary remote failure/);
  const preserved = server.db.prepare(
    "SELECT stock, transit FROM sku_items WHERE user_id = ? AND country = 'FR' AND brand = 'HP'"
  ).get(operator.id);
  assert.deepEqual(preserved, { stock: 30, transit: 7 });

  const discovered = await call('/captain/discover', ownerCookie, 'POST');
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.data.groups.map((group) => [group.groupName, group.countries]), [
    ['HP_EU', ['ES', 'DE', 'FR']],
    ['HP_EU_UK', ['UK']],
  ]);

  const bulk = await call('/captain/bindings', ownerCookie, 'POST', {
    userId: operator.id,
    brand: 'hp',
    channels: discovered.data.groups[0].channels,
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.count, 3);
  assert.equal(server.db.prepare("SELECT COUNT(*) count FROM captain_channel_bindings WHERE brand = 'HP'").get().count, 4);

  const admin = await call('/captain/admin', ownerCookie);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data.brandOptions, [{ userId: operator.id, brands: ['Canon', 'HP'] }]);
});
