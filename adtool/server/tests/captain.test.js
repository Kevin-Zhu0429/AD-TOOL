import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('Amazon SP-API shared EU inventory is assigned to separate users by country', async (t) => {
  // 每个品牌一个开发者应用;HP 的欧洲和北美是两个卖家账号,不限站点
  const brandEnv = {
    BRAND1_NAME: 'HP',
    BRAND1_LWA_CLIENT_ID: 'hp-client',
    BRAND1_LWA_CLIENT_SECRET: 'hp-secret',
    BRAND1_LWA_REFRESH_TOKEN_EU: 'Atzr|refresh-hp-eu',
    BRAND1_SELLER_ID_EU: 'hpeu',
    BRAND1_LWA_REFRESH_TOKEN_NA: 'Atzr|refresh-hp-na',
    BRAND1_SELLER_ID_NA: 'HPNA',
    // CC 只有欧洲账号,只要欧洲大陆四站(UK 开通了也不列)
    BRAND2_NAME: 'CC',
    BRAND2_MARKETS: 'ES, DE, FR, IT',
    BRAND2_LWA_CLIENT_ID: 'cc-client',
    BRAND2_LWA_CLIENT_SECRET: 'cc-secret',
    BRAND2_LWA_REFRESH_TOKEN_EU: 'Atzr|refresh-cc-eu',
    BRAND2_SELLER_ID_EU: 'CCEU',
    // PG 漏填卖家编号:不猜,在账号管理里提示
    BRAND5_NAME: 'PG',
    BRAND5_LWA_CLIENT_ID: 'pg-client',
    BRAND5_LWA_CLIENT_SECRET: 'pg-secret',
    BRAND5_LWA_REFRESH_TOKEN_EU: 'Atzr|refresh-pg-eu',
  };
  Object.assign(process.env, brandEnv);

  const originalFetch = global.fetch;
  let server;
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of Object.keys(brandEnv)) delete process.env[key];
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
  // 同步在后台跑:开始后轮询到结束,返回 { status, data },data 是同步结果;没能开始的原样返回
  async function sync(route, cookie) {
    const started = await call(route, cookie, 'POST');
    if (started.status !== 202) return started;
    assert.equal(started.data.job.status, 'running');
    for (;;) {
      const { data } = await call(route, cookie);
      if (data.job.status !== 'running') {
        assert.equal(data.job.id, started.data.job.id);
        assert.equal(data.job.status, 'done', data.job.error);
        return { status: 200, data: data.job.result };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
    'token-hp-eu:eu': [participation('ES'), participation('DE'), participation('FR'), participation('IT'),
      participation('UK'), participation('NL'), participation('AE', false)],
    'token-hp-na:na': [participation('US')],
    'token-cc-eu:eu': [participation('ES'), participation('DE'), participation('FR'), participation('IT'),
      participation('UK')],
  };
  // refresh token 只能配它自己品牌的应用换 access token
  const tokens = {
    'Atzr|refresh-hp-eu': ['hp-client', 'hp-secret', 'token-hp-eu'],
    'Atzr|refresh-hp-na': ['hp-client', 'hp-secret', 'token-hp-na'],
    'Atzr|refresh-cc-eu': ['cc-client', 'cc-secret', 'token-cc-eu'],
  };
  const regionOfHost = {
    'sellingpartnerapi-eu.amazon.com': 'eu', 'sellingpartnerapi-na.amazon.com': 'na', 'sellingpartnerapi-fe.amazon.com': 'fe',
  };

  let failingChannel = '';
  let rejectTokenOnce = false;
  let throttleOnce = false;
  let lwaCalls = 0;
  // 设了 hold 时库存请求先卡住,用来看同步进行中的状态和并发数
  let hold = null;
  let inFlight = 0;
  let maxInFlight = 0;
  const quantityOverrides = new Map();
  const inventoryCalls = new Map();
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.amazon.com' && url.pathname === '/auth/o2/token') {
      assert.equal(options.method, 'POST');
      const body = new URLSearchParams(String(options.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      lwaCalls += 1;
      const [clientId, clientSecret, token] = tokens[body.get('refresh_token')] ?? [];
      if (!token) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      return Response.json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
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
      const seller = token.startsWith('token-hp') ? 'hp' : 'cc';
      const channel = `${seller}-${countryOf[marketplaceId].toLowerCase()}`;
      inventoryCalls.set(channel, (inventoryCalls.get(channel) ?? 0) + 1);
      if (channel === failingChannel) throw new TypeError('temporary remote failure');
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hold) await hold.promise;
      } finally {
        inFlight -= 1;
      }
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

  // 缺 Client Secret 的品牌不算配好;一个配好的品牌都没有就是没配置
  delete process.env.BRAND1_LWA_CLIENT_SECRET;
  delete process.env.BRAND2_LWA_CLIENT_SECRET;
  assert.equal((await call('/captain/discover', ownerCookie, 'POST')).status, 503);
  assert.equal((await call('/captain/status', esCookie)).data.configured, false);
  Object.assign(process.env, brandEnv);

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
    openChannelId: 'spapi:HPEU:A1RKKUPIHCS9HS', channelName: 'HP_ES', siteId: null, country: 'ES', status: 1,
  });

  // 店铺编号和国家对不上(比如手工拼的请求)不能保存
  const tampered = await call('/captain/bindings', ownerCookie, 'POST', {
    ...euGroup,
    brand: 'hp',
    channels: euGroup.channels.map((channel) => (
      channel.country === 'DE' ? { ...channel, openChannelId: 'spapi:HPEU:A1RKKUPIHCS9HS' } : channel
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
  assert.equal((await sync('/captain/sync', deCookie)).status, 400);
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

  const esSync = await sync('/captain/sync', esCookie);
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

  const deSync = await sync('/captain/sync', deCookie);
  assert.equal(deSync.status, 200);
  assert.equal(deSync.data.sources, 4);
  assert.equal(server.db.prepare(
    "SELECT stock FROM sku_items WHERE user_id = ? AND country = 'DE' AND brand = 'HP'"
  ).get(users['aba-de']).stock, 15);

  // 统一同步进行中:再点一次拿到同一个任务;账号自己点同步要等它跑完;进度按店铺数走
  inventoryCalls.clear();
  maxInFlight = 0;
  let release;
  hold = { promise: new Promise((resolve) => { release = resolve; }) };
  const running = await call('/captain/sync-all', ownerCookie, 'POST');
  assert.equal(running.status, 202);
  assert.equal((await call('/captain/sync-all', ownerCookie, 'POST')).data.job.id, running.data.job.id);
  assert.equal((await call('/captain/sync', esCookie, 'POST')).status, 409);
  assert.equal((await call('/captain/sync-all', esCookie)).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const progress = (await call('/captain/sync-all', ownerCookie)).data.job.progress;
  assert.deepEqual({ phase: progress.phase, done: progress.done, total: progress.total }, { phase: 'fetch', done: 0, total: 6 });
  // HP 欧洲和 HP 北美是两个卖家账号,同时读;同一个账号的店铺排队读
  assert.equal(inFlight, 2);
  hold = null;
  release();
  let allSync;
  for (;;) {
    const { data } = await call('/captain/sync-all', ownerCookie);
    if (data.job.status !== 'running') {
      assert.equal(data.job.status, 'done', data.job.error);
      allSync = { status: 200, data: data.job.result };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(maxInFlight, 2);
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
  assert.deepEqual(admin.data.brands, [
    { name: 'HP', markets: [], accounts: [{ slot: 'eu', sellerId: 'HPEU' }, { slot: 'na', sellerId: 'HPNA' }] },
    { name: 'CC', markets: ['ES', 'DE', 'FR', 'IT'], accounts: [{ slot: 'eu', sellerId: 'CCEU' }] },
  ]);
  assert.deepEqual(admin.data.configIssues, ['PG 欧洲账号缺少 BRAND5_SELLER_ID_EU']);
  assert.doesNotMatch(JSON.stringify(admin.data), /Atzr|hp-secret|cc-secret/);

  // access token 被拒一次:换新 token 重试;被限流一次:退避重试。都不算失败
  const lwaBefore = lwaCalls;
  rejectTokenOnce = true;
  throttleOnce = true;
  const retried = await sync('/captain/sync', deCookie);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.failed, 0);
  assert.equal(lwaCalls, lwaBefore + 1);
  assert.ok(admin.data.skuCoverage.some((row) => (
    row.userId === users['aba-de'] && row.country === 'DE' && row.brand === 'HP'
  )));

  failingChannel = 'hp-es';
  inventoryCalls.clear();
  const partial = await sync('/captain/sync', esCookie);
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
  const quietSync = await sync('/captain/sync', esCookie);
  assert.equal(quietSync.data.stockSync.outCount, 0);
  assert.equal(quietSync.data.stockSync.restockCount, 0);

  quantityOverrides.set('hp-us', [0, 3]);
  const outSync = await sync('/captain/sync', esCookie);
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
  await sync('/captain/sync', esCookie);
  list = await call('/sku', esCookie);
  assert.equal(list.data.stockSync.outCount, 0);
  assert.equal(usRow().stockEvent.kind, 'out');

  // 别的账号看不到这条变动
  const deList = await call('/sku', deCookie);
  assert.equal(deList.data.stockSync.outCount, 0);
  assert.ok(deList.data.items.every((item) => !item.stockEvent));

  quantityOverrides.set('hp-us', [25, 0]);
  const backSync = await sync('/captain/sync', esCookie);
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
  const allOut = await sync('/captain/sync-all', ownerCookie);
  assert.equal(allOut.status, 200);
  assert.equal(allOut.data.outOfStock, 1);
  assert.equal(allOut.data.results.find((row) => row.userId === users['aba-test']).outOfStock, 1);
});
