import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('Amazon SP-API shared EU inventory is assigned to separate users by country', async (t) => {
  process.env.SPAPI_CLIENT_ID = 'test-client';
  process.env.SPAPI_CLIENT_SECRET = 'test-secret';
  // 第一个账号不填区域,自动识别出 EU + NA;第二个账号只在 EU
  process.env.SPAPI_REFRESH_TOKEN = 'Atzr|refresh-hp';
  process.env.SPAPI_SELLER_ID = 'sellerhp';
  process.env.SPAPI_STORE_NAME = 'HP';
  process.env.SPAPI_REFRESH_TOKEN_2 = 'Atzr|refresh-cc';
  process.env.SPAPI_SELLER_ID_2 = 'SELLERCC';
  process.env.SPAPI_STORE_NAME_2 = 'CC';
  process.env.SPAPI_REGION_2 = 'eu';
  const spApiEnv = Object.keys(process.env).filter((key) => key.startsWith('SPAPI_'));

  const originalFetch = global.fetch;
  let server;
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of spApiEnv) delete process.env[key];
    if (server) await server.close();
  });

  server = await startAbaTestServer();
  const { spApiTiming } = await import('../src/spApi.js');
  spApiTiming.minIntervalMs = 0;
  spApiTiming.retryBaseMs = 0;
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
     VALUES (?, ?, 'HP', '301', 'BKC', 'EU-SKU-1', ?, ?, null, ?)`
  );
  insertSku.run(users['aba-test'], 'ES', 1, 2, 'ES|eu-sku-1');
  insertSku.run(users['aba-test'], 'DE', 777, 888, 'DE|eu-sku-1');
  insertSku.run(users['aba-test'], 'UK', 1, 2, 'UK|eu-sku-1');
  insertSku.run(users['aba-test'], 'US', 1, 2, 'US|eu-sku-1');
  insertSku.run(users['aba-de'], 'DE', 1, 2, 'DE|eu-sku-1');
  insertSku.run(users['aba-other'], 'FR', 1, 2, 'FR|eu-sku-1');
  insertSku.run(users['aba-other'], 'IT', 1, 2, 'IT|eu-sku-1');
  server.db.prepare(
    `INSERT INTO sku_items
       (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
     VALUES (?, 'ES', 'Canon', '545', 'BK', 'EU-SKU-1', 77, 88, 'ES|canon-eu-sku-1')`
  ).run(users['aba-test']);

  const MARKETPLACE = {
    ES: 'A1RKKUPIHCS9HS', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4',
    UK: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER', NL: 'A1805IZSGTT6HS',
  };
  const countryOf = Object.fromEntries(Object.entries(MARKETPLACE).map(([country, id]) => [id, country]));
  const participation = (country, isParticipating = true) => ({
    marketplace: { id: MARKETPLACE[country], countryCode: country === 'UK' ? 'GB' : country, name: `Amazon.${country}` },
    participation: { isParticipating, hasSuspendedListings: false },
  });
  // 每个卖家在每个区域能看到的站点;没列出的区域按亚马逊的做法回 403
  const participations = {
    'token-hp:eu': [participation('ES'), participation('DE'), participation('FR'), participation('IT'),
      participation('UK'), participation('NL')],
    'token-hp:na': [participation('US')],
    'token-cc:eu': [participation('ES'), participation('DE'), participation('FR'), participation('IT'),
      participation('UK', false)],
  };
  const tokens = { 'Atzr|refresh-hp': 'token-hp', 'Atzr|refresh-cc': 'token-cc' };
  const regionOfHost = {
    'sellingpartnerapi-eu.amazon.com': 'eu', 'sellingpartnerapi-na.amazon.com': 'na', 'sellingpartnerapi-fe.amazon.com': 'fe',
  };

  let failingChannel = '';
  let rejectTokenOnce = false;
  let throttleOnce = false;
  let lwaCalls = 0;
  const quantityOverrides = new Map();
  const inventoryCalls = new Map();
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.amazon.com' && url.pathname === '/auth/o2/token') {
      assert.equal(options.method, 'POST');
      const body = new URLSearchParams(String(options.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), 'test-client');
      assert.equal(body.get('client_secret'), 'test-secret');
      lwaCalls += 1;
      const token = tokens[body.get('refresh_token')];
      if (!token) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `${token}`, token_type: 'bearer', expires_in: 3600 });
    }
    const region = regionOfHost[url.host];
    assert.ok(region, `Unexpected remote request: ${url}`);
    const token = new Headers(options.headers).get('x-amz-access-token');
    const denied = () => Response.json({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }, { status: 403 });

    if (url.pathname === '/sellers/v1/marketplaceParticipations') {
      const rows = participations[`${token}:${region}`];
      return rows ? Response.json({ payload: rows }) : denied();
    }
    if (url.pathname === '/fba/inventory/v1/summaries') {
      if (rejectTokenOnce) {
        rejectTokenOnce = false;
        return denied();
      }
      if (throttleOnce) {
        throttleOnce = false;
        return Response.json({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] }, { status: 429 });
      }
      assert.equal(url.searchParams.get('granularityType'), 'Marketplace');
      assert.equal(url.searchParams.get('details'), 'true');
      const marketplaceId = url.searchParams.get('marketplaceIds');
      assert.equal(url.searchParams.get('granularityId'), marketplaceId);
      const seller = token === 'token-hp' ? 'hp' : 'cc';
      const channel = `${seller}-${countryOf[marketplaceId].toLowerCase()}`;
      inventoryCalls.set(channel, (inventoryCalls.get(channel) ?? 0) + 1);
      if (channel === failingChannel) throw new TypeError('temporary remote failure');
      const quantities = {
        'hp-de': [15, 1], 'hp-es': [15, 1], 'hp-fr': [15, 1], 'hp-it': [15, 1],
        'hp-uk': [7, 4], 'hp-us': [99, 5],
      };
      const [stock, transit] = quantityOverrides.get(channel) ?? quantities[channel] ?? [0, 0];
      const summary = (sellerSku, fulfillable, shipped) => ({
        asin: 'B012345678', fnSku: `X-${sellerSku}`, sellerSku, condition: 'NewItem',
        inventoryDetails: {
          fulfillableQuantity: fulfillable, inboundWorkingQuantity: 0,
          inboundShippedQuantity: shipped, inboundReceivingQuantity: 0,
        },
        totalQuantity: fulfillable + shipped,
      });
      // US 分两页返回,第二页要带上第一页给的 nextToken
      if (channel === 'hp-us' && !url.searchParams.get('nextToken')) {
        return Response.json({
          payload: { granularity: { granularityType: 'Marketplace', granularityId: marketplaceId },
            inventorySummaries: [summary('US-ONLY-SKU', 3, 0)] },
          pagination: { nextToken: 'us-page-2' },
        });
      }
      if (channel === 'hp-us') assert.equal(url.searchParams.get('nextToken'), 'us-page-2');
      return Response.json({
        payload: { granularity: { granularityType: 'Marketplace', granularityId: marketplaceId },
          inventorySummaries: [summary('EU-SKU-1', stock, transit)] },
      });
    }
    throw new Error(`Unexpected remote request: ${url}`);
  };

  // 缺 Client Secret 算没配置
  const clientSecret = process.env.SPAPI_CLIENT_SECRET;
  delete process.env.SPAPI_CLIENT_SECRET;
  assert.equal((await call('/captain/discover', ownerCookie, 'POST')).status, 503);
  assert.equal((await call('/captain/status', esCookie)).data.configured, false);
  process.env.SPAPI_CLIENT_SECRET = clientSecret;

  const discovered = await call('/captain/discover', ownerCookie, 'POST');
  assert.equal(discovered.status, 200, discovered.data.error);
  assert.deepEqual(discovered.data.errors, []);
  // NL 不是网站支持的站点;CC 的 UK 没开通(isParticipating = false)
  assert.deepEqual(
    discovered.data.groups.map((group) => [group.groupName, group.scope, group.countries]),
    [
      ['CC_EU', 'EU', ['ES', 'DE', 'FR', 'IT']],
      ['HP_EU', 'EU', ['ES', 'DE', 'FR', 'IT']],
      ['HP_UK', 'UK', ['UK']],
      ['HP_US', 'US', ['US']],
    ],
  );
  const euGroup = discovered.data.groups.find((group) => group.groupName === 'HP_EU');
  const ukGroup = discovered.data.groups.find((group) => group.groupName === 'HP_UK');
  const usGroup = discovered.data.groups.find((group) => group.groupName === 'HP_US');
  assert.equal(euGroup.groupKey, 'hp_eu:EU');
  assert.deepEqual(euGroup.channels[0], {
    openChannelId: 'spapi:SELLERHP:A1RKKUPIHCS9HS', channelName: 'HP_ES', siteId: null, country: 'ES', status: 1,
  });

  // 店铺编号和国家对不上(比如手工拼的请求)不能保存
  const tampered = await call('/captain/bindings', ownerCookie, 'POST', {
    ...euGroup,
    brand: 'hp',
    channels: euGroup.channels.map((channel) => (
      channel.country === 'DE' ? { ...channel, openChannelId: 'spapi:SELLERHP:A1RKKUPIHCS9HS' } : channel
    )),
    assignments: [{ country: 'ES', userId: users['aba-test'] }],
  });
  assert.equal(tampered.status, 400);

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
  assert.deepEqual(esSync.data.errors, []);
  assert.equal(esSync.data.succeeded, 6);
  // 六家店,US 两页:ES/DE/FR/IT/UK 各 1 条,US 2 条
  assert.equal(esSync.data.fetched, 7);
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
  // 每家店只拉一遍(US 两页);没分配的 CC 店铺不拉
  assert.deepEqual(Object.fromEntries(inventoryCalls), {
    'hp-es': 1, 'hp-de': 1, 'hp-fr': 1, 'hp-it': 1, 'hp-uk': 1, 'hp-us': 2,
  });
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'FR' AND brand = 'HP'"
  ).get(users['aba-other']).stock, 15);

  const status = await call('/captain/status', esCookie);
  assert.deepEqual(status.data.bindings.map((row) => row.country).sort(), ['ES', 'UK', 'US']);
  const admin = await call('/captain/admin', ownerCookie);
  assert.equal(admin.data.assignments.length, 6);
  assert.deepEqual(admin.data.accounts, [
    { sellerId: 'SELLERHP', name: 'HP', region: 'auto' },
    { sellerId: 'SELLERCC', name: 'CC', region: 'eu' },
  ]);
  assert.doesNotMatch(JSON.stringify(admin.data), /refresh|test-secret/);

  // access token 被拒一次:换新 token 重试;被限流一次:退避重试。都不算失败
  const lwaBefore = lwaCalls;
  rejectTokenOnce = true;
  throttleOnce = true;
  const retried = await call('/captain/sync', deCookie, 'POST');
  assert.equal(retried.status, 200);
  assert.equal(retried.data.failed, 0);
  assert.equal(lwaCalls, lwaBefore + 1);
  assert.ok(admin.data.skuCoverage.some((row) => (
    row.userId === users['aba-de'] && row.country === 'DE' && row.brand === 'HP'
  )));

  failingChannel = 'hp-es';
  inventoryCalls.clear();
  const partial = await call('/captain/sync', esCookie, 'POST');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.failed, 1);
  assert.match(partial.data.errors[0], /^HP_ES：连不上亚马逊接口：temporary remote failure/);
  // 网络错误先退避重试,重试用完才算失败
  assert.equal(inventoryCalls.get('hp-es'), 5);
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

  // 库存变动:这次同步 US 从 99 变 0 = 新断货;下次从 0 变 25 = 补货
  failingChannel = '';
  const quietSync = await call('/captain/sync', esCookie, 'POST');
  assert.equal(quietSync.data.stockSync.outCount, 0);
  assert.equal(quietSync.data.stockSync.restockCount, 0);

  quantityOverrides.set('hp-us', [0, 3]);
  const outSync = await call('/captain/sync', esCookie, 'POST');
  assert.equal(outSync.status, 200);
  assert.equal(outSync.data.stockSync.outCount, 1);
  assert.equal(outSync.data.stockSync.restockCount, 0);
  assert.deepEqual(
    outSync.data.stockSync.outOfStock.map(({ country, sku, prevStock, stock, transit }) => ({
      country, sku, prevStock, stock, transit,
    })),
    [{ country: 'US', sku: 'EU-SKU-1', prevStock: 99, stock: 0, transit: 3 }],
  );
  let list = await call('/sku', esCookie);
  assert.equal(list.data.stockSync.id, outSync.data.stockSync.id);
  const usRow = () => list.data.items.find((item) => item.country === 'US');
  assert.equal(usRow().stockEvent.kind, 'out');
  assert.equal(usRow().stockEvent.prevStock, 99);
  assert.equal(list.data.items.find((item) => item.country === 'ES' && item.brand === 'HP').stockEvent, undefined);

  // 同步没变化:本次结果清零,但表格里仍标着还成立的新断货
  await call('/captain/sync', esCookie, 'POST');
  list = await call('/sku', esCookie);
  assert.equal(list.data.stockSync.outCount, 0);
  assert.equal(usRow().stockEvent.kind, 'out');

  // 别的账号看不到这条变动
  const deList = await call('/sku', deCookie);
  assert.equal(deList.data.stockSync.outCount, 0);
  assert.ok(deList.data.items.every((item) => !item.stockEvent));

  quantityOverrides.set('hp-us', [25, 0]);
  const backSync = await call('/captain/sync', esCookie, 'POST');
  assert.equal(backSync.data.stockSync.outCount, 0);
  assert.equal(backSync.data.stockSync.restockCount, 1);
  assert.equal(backSync.data.stockSync.restocked[0].prevStock, 0);
  assert.equal(backSync.data.stockSync.restocked[0].stock, 25);
  list = await call('/sku', esCookie);
  assert.equal(usRow().stockEvent.kind, 'restock');

  // 手动改回 0:补货标记不再成立,不提示
  const usId = usRow().id;
  assert.equal((await call(`/sku/${usId}`, esCookie, 'PATCH', { stock: '0' })).status, 200);
  list = await call('/sku', esCookie);
  assert.equal(usRow().stockEvent, undefined);

  // 超级管理员统一同步:按账号汇总新断货 / 补货数量
  quantityOverrides.set('hp-us', [0, 0]);
  assert.equal((await call(`/sku/${usId}`, esCookie, 'PATCH', { stock: '5' })).status, 200);
  const allOut = await call('/captain/sync-all', ownerCookie, 'POST');
  assert.equal(allOut.status, 200);
  assert.equal(allOut.data.outOfStock, 1);
  assert.equal(allOut.data.results.find((row) => row.userId === users['aba-test']).outOfStock, 1);
});
