import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startAbaTestServer } from './abaHarness.js';

test('owner pulls a whole store, edits validate only, live submit stays locked', async (t) => {
  const env = {
    BRAND1_NAME: 'CC', BRAND1_MARKETS: 'ES,US',
    BRAND1_LWA_CLIENT_ID: 'cc-client', BRAND1_LWA_CLIENT_SECRET: 'cc-secret',
    BRAND1_LWA_REFRESH_TOKEN_EU: 'Atzr|cc-eu', BRAND1_SELLER_ID_EU: 'CCEU',
  };
  Object.assign(process.env, env);
  delete process.env.LISTINGS_LIVE_SUBMIT;
  const originalFetch = global.fetch;
  let server;
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of Object.keys(env)) delete process.env[key];
    if (server) await server.close();
  });
  server = await startAbaTestServer();
  const { spApiTiming } = await import('../src/spApi.js');
  const { listingTiming } = await import('../src/listings.js');
  spApiTiming.minIntervalMs = 0;
  spApiTiming.retryBaseMs = 0;
  listingTiming.reportPollMs = 0;

  const item = (sku, n) => ({
    sku,
    summaries: [{ marketplaceId: 'A1RKKUPIHCS9HS', asin: `B0SKU0000${n}`, productType: 'INK_OR_TONER',
      itemName: `Tinta ${n}`, status: ['BUYABLE', 'DISCOVERABLE'], mainImage: { link: `https://m.media-amazon.com/${n}.jpg` } }],
    attributes: { item_name: [{ value: `Tinta ${n}`, language_tag: 'es_ES', marketplace_id: 'A1RKKUPIHCS9HS' }] },
    issues: n === 2 ? [{ code: '90220', message: '缺少必填项', severity: 'ERROR', attributeNames: ['color'] }] : [],
    offers: [{ marketplaceId: 'A1RKKUPIHCS9HS', offerType: 'B2C', price: { currencyCode: 'EUR', amount: '19.99' } }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 7 }],
  });
  const requests = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.href === 'https://api.amazon.com/auth/o2/token') return json({ access_token: 'token-cc', expires_in: 3600 });
    requests.push({ method: init.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null });
    assert.equal(url.host, 'sellingpartnerapi-eu.amazon.com');
    if (url.pathname === '/listings/2021-08-01/items/CCEU') {
      // 第一页给 2 个,第二页给 1 个
      return url.searchParams.get('pageToken')
        ? json({ numberOfResults: 3, items: [item('SKU-3', 3)], pagination: {} })
        : json({ numberOfResults: 3, items: [item('SKU-1', 1), item('SKU-2', 2)], pagination: { nextToken: 'p2' } });
    }
    if (url.pathname === '/listings/2021-08-01/items/CCEU/SKU-1' && init.method === 'PATCH') {
      return json({ sku: 'SKU-1', status: 'VALID', submissionId: 's1', issues: [] });
    }
    throw new Error(`unexpected ${url.href}`);
  };

  async function call(route, cookie = '', method = 'GET', body) {
    const response = await originalFetch(server.url + '/api' + route, {
      method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data: await response.json() };
  }
  const login = async (username) => (await call('/auth/login', '', 'POST', { username, password: 'local-test-password' })).cookie;
  const owner = await login('aba-other');
  const operator = await login('aba-test');

  // 运营看不到这个板块
  assert.equal((await call('/listings/stores', operator)).status, 403);
  const stores = await call('/listings/stores', owner);
  assert.deepEqual(stores.data.stores, [{ brand: 'CC', country: 'ES', sellerId: 'CCEU' }]);
  assert.equal(stores.data.liveSubmit, false);

  const q = 'brand=CC&country=ES';
  assert.equal((await call(`/listings/items?brand=CC&country=US`, owner)).status, 400);
  const started = await call(`/listings/pull?${q}`, owner, 'POST');
  assert.equal(started.status, 202);
  let job;
  do { ({ data: { job } } = await call(`/listings/pull?${q}`, owner)); } while (job.status === 'running');
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.count, 3);
  // 三个都在搜索里翻到了,不需要拉报告
  assert.ok(!requests.some((r) => r.path.startsWith('/reports/')));
  assert.equal(requests[0].query.issueLocale, 'zh_CN');
  assert.equal(requests[0].query.pageSize, '20');

  const list = await call(`/listings/items?${q}`, owner);
  assert.deepEqual(list.data.items.map(({ sku, asin, price, quantity, channel, issues }) => ({ sku, asin, price, quantity, channel, issues })), [
    { sku: 'SKU-1', asin: 'B0SKU00001', price: { amount: 19.99, currency: 'EUR' }, quantity: 7, channel: 'FBM', issues: { error: 0, warning: 0 } },
    { sku: 'SKU-2', asin: 'B0SKU00002', price: { amount: 19.99, currency: 'EUR' }, quantity: 7, channel: 'FBM', issues: { error: 1, warning: 0 } },
    { sku: 'SKU-3', asin: 'B0SKU00003', price: { amount: 19.99, currency: 'EUR' }, quantity: 7, channel: 'FBM', issues: { error: 0, warning: 0 } },
  ]);

  const detail = await call(`/listings/item?${q}&sku=SKU-1`, owner);
  assert.equal(detail.data.item.attributes.item_name[0].value, 'Tinta 1');

  const changes = { item_name: [{ value: 'Tinta nueva', language_tag: 'es_ES', marketplace_id: 'A1RKKUPIHCS9HS' }] };
  const preview = await call('/listings/item/submit', owner, 'POST', { brand: 'CC', country: 'ES', sku: 'SKU-1', changes });
  assert.equal(preview.status, 200, preview.data.error);
  assert.equal(preview.data.mode, 'preview');
  assert.equal(preview.data.status, 'VALID');
  const patch = requests.find((r) => r.method === 'PATCH');
  assert.equal(patch.query.mode, 'VALIDATION_PREVIEW');
  assert.deepEqual(patch.body, { productType: 'INK_OR_TONER', patches: [{ op: 'replace', path: '/attributes/item_name', value: changes.item_name }] });

  // 服务器没开正式提交:live 请求直接拒绝,不会发到亚马逊
  const patchCount = requests.filter((r) => r.method === 'PATCH').length;
  const live = await call('/listings/item/submit', owner, 'POST', { brand: 'CC', country: 'ES', sku: 'SKU-1', changes, live: true });
  assert.equal(live.status, 403);
  assert.equal(requests.filter((r) => r.method === 'PATCH').length, patchCount);
});

test('stores over 1000 SKUs fill the rest from the all-listings report', async (t) => {
  const env = {
    BRAND2_NAME: 'PG', BRAND2_LWA_CLIENT_ID: 'pg', BRAND2_LWA_CLIENT_SECRET: 'pg',
    BRAND2_LWA_REFRESH_TOKEN_NA: 'Atzr|pg-na', BRAND2_SELLER_ID_NA: 'PGNA',
  };
  Object.assign(process.env, env);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(env)) delete process.env[key];
  });
  const { spApiTiming } = await import('../src/spApi.js');
  const { listingTiming, pullStore, SEARCH_LIMIT } = await import('../src/listings.js');
  spApiTiming.minIntervalMs = 0;
  spApiTiming.retryBaseMs = 0;
  listingTiming.reportPollMs = 0;
  const { spApiAccounts } = await import('../src/spApi.js');
  const account = spApiAccounts().find((row) => row.brand === 'PG');
  const skus = Array.from({ length: SEARCH_LIMIT + 2 }, (_, i) => `S${String(i).padStart(5, '0')}`);
  const report = 'item-name\tlisting-id\tseller-sku\tasin1\n' + skus.map((sku) => `n\tl\t${sku}\tB0X\n`).join('');
  let polls = 0;
  const fetched = [];
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'api.amazon.com') return json({ access_token: 'pg-token', expires_in: 3600 });
    if (url.hostname === 'reports.example.com') {
      return new Response(gzipSync(Buffer.from(report)), { headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    }
    if (url.pathname === '/listings/2021-08-01/items/PGNA') {
      const page = Number(url.searchParams.get('pageToken') ?? 0);
      const items = skus.slice(page * 20, page * 20 + 20).map((sku) => ({ sku }));
      return json({ numberOfResults: skus.length, items, pagination: (page + 1) * 20 < SEARCH_LIMIT ? { nextToken: String(page + 1) } : {} });
    }
    if (url.pathname === '/reports/2021-06-30/reports' && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA', marketplaceIds: ['ATVPDKIKX0DER'] });
      return json({ reportId: 'R1' });
    }
    if (url.pathname === '/reports/2021-06-30/reports/R1') {
      polls += 1;
      return json(polls < 2 ? { processingStatus: 'IN_PROGRESS' } : { processingStatus: 'DONE', reportDocumentId: 'D1' });
    }
    if (url.pathname === '/reports/2021-06-30/documents/D1') return json({ url: 'https://reports.example.com/d1', compressionAlgorithm: 'GZIP' });
    if (url.pathname.startsWith('/listings/2021-08-01/items/PGNA/')) {
      const sku = decodeURIComponent(url.pathname.split('/').pop());
      fetched.push(sku);
      return json({ sku, summaries: [] });
    }
    throw new Error(`unexpected ${url.href}`);
  };
  const store = { account, country: 'US', marketplaceId: 'ATVPDKIKX0DER', region: 'na' };
  const result = await pullStore(store);
  assert.equal(result.items.length, SEARCH_LIMIT + 2);
  assert.deepEqual(fetched, skus.slice(SEARCH_LIMIT));
  assert.equal(result.complete, true);
  assert.equal(result.reportBySku.size, SEARCH_LIMIT + 2);
});

// 这两个放在后面:listings.js 会连带打开数据库,要等测试服务器把数据库指到临时目录之后再加载
test('listings report TSV keeps one row per SKU', async () => {
  const { parseListingsReport } = await import('../src/listings.js');
  const tsv = '﻿item-name\titem-description\tlisting-id\tseller-sku\tprice\tquantity\topen-date\tasin1\tfulfillment-channel\tstatus\r\n'
    + 'Ink 301\t\tL1\tSKU-1\t19.99\t5\t2024-01-01\tB0AAAAAAAA\tDEFAULT\tActive\r\n'
    + 'Ink 301 dup\t\tL1\tSKU-1\t19.99\t5\t2024-01-01\tB0AAAAAAAA\tDEFAULT\tActive\r\n'
    + 'Ink 302\t\tL2\tSKU-2\t21.00\t\t2024-01-02\tB0BBBBBBBB\tAMAZON_EU\tInactive\r\n';
  assert.deepEqual(parseListingsReport(tsv).map(({ sku, asin, fulfillment, status }) => ({ sku, asin, fulfillment, status })), [
    { sku: 'SKU-1', asin: 'B0AAAAAAAA', fulfillment: 'DEFAULT', status: 'Active' },
    { sku: 'SKU-2', asin: 'B0BBBBBBBB', fulfillment: 'AMAZON_EU', status: 'Inactive' },
  ]);
});

test('changes become top-level JSON patches; delete keeps marketplace and language', async () => {
  const { buildPatches } = await import('../src/listings.js');
  const original = { generic_keyword: [{ value: 'ink', language_tag: 'es_ES', marketplace_id: 'M1' }] };
  assert.deepEqual(buildPatches({
    item_name: [{ value: 'New', language_tag: 'es_ES', marketplace_id: 'M1' }],
    generic_keyword: null,
  }, original), [
    { op: 'replace', path: '/attributes/item_name', value: [{ value: 'New', language_tag: 'es_ES', marketplace_id: 'M1' }] },
    { op: 'delete', path: '/attributes/generic_keyword', value: [{ marketplace_id: 'M1', language_tag: 'es_ES' }] },
  ]);
  assert.throws(() => buildPatches({}), /没有要提交的改动/);
  assert.throws(() => buildPatches({ 'bad/name': [{ value: 1 }] }), /属性名不对/);
  assert.throws(() => buildPatches({ item_name: 'text' }), /值格式不对/);
});
