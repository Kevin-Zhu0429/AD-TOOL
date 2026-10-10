import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startAbaTestServer } from './abaHarness.js';

test('owner pulls a whole store, validates edits, and live submit validates first', async (t) => {
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
    if (url.pathname.startsWith('/listings/2021-08-01/items/CCEU/') && init.method === 'PUT') {
      const preview = url.searchParams.get('mode') === 'VALIDATION_PREVIEW';
      return json({ sku: 'NEW-P', status: preview ? 'VALID' : 'ACCEPTED', submissionId: 'p1', issues: [] });
    }
    if (url.pathname.startsWith('/listings/2021-08-01/items/CCEU/') && init.method === 'PATCH') {
      const sku = decodeURIComponent(url.pathname.split('/').pop());
      if (init.body.includes('BAD')) return json({ sku, status: 'INVALID', submissionId: 's0', issues: [{ code: '1', message: '标题不合规', severity: 'ERROR' }] });
      const preview = url.searchParams.get('mode') === 'VALIDATION_PREVIEW';
      return json({ sku, status: preview ? 'VALID' : 'ACCEPTED', submissionId: 's1', issues: [] });
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
  assert.equal(stores.data.liveSubmit, true);

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

  const patches = () => requests.filter((r) => r.method === 'PATCH');
  const submit = (body) => call('/listings/item/submit', owner, 'POST', { brand: 'CC', country: 'ES', sku: 'SKU-1', ...body });

  // 校验不通过:只发了校验,没有正式提交
  let before = patches().length;
  const blocked = await submit({ changes: { item_name: [{ ...changes.item_name[0], value: 'BAD' }] }, live: true });
  assert.equal(blocked.data.blocked, true);
  assert.equal(blocked.data.issues[0].message, '标题不合规');
  assert.deepEqual(patches().slice(before).map((r) => r.query.mode), ['VALIDATION_PREVIEW']);

  // 正式提交:先校验再提交,接收后本地缓存变成新标题
  before = patches().length;
  const live = await submit({ changes, live: true });
  assert.equal(live.status, 200, live.data.error);
  assert.equal(live.data.mode, 'live');
  assert.equal(live.data.status, 'ACCEPTED');
  assert.deepEqual(patches().slice(before).map((r) => r.query.mode), ['VALIDATION_PREVIEW', undefined]);
  const after = await call(`/listings/item?${q}&sku=SKU-1`, owner);
  assert.equal(after.data.item.attributes.item_name[0].value, 'Tinta nueva');
  assert.equal(after.data.row.itemName, 'Tinta nueva');

  // 变体合并:SKU-2、SKU-3 挂到 SKU-1 下面
  const merge = (body) => call('/listings/variation/merge', owner, 'POST', { brand: 'CC', country: 'ES', parentSku: 'SKU-1', theme: 'COLOR', ...body });
  before = patches().length;
  const mergeBlocked = await merge({ live: true, children: [{ sku: 'SKU-2', values: { color: 'Negro' } }, { sku: 'SKU-3', values: { color: 'BAD' } }] });
  assert.equal(mergeBlocked.data.blocked, true);
  // 有一个校验不通过,两个都只发了校验
  assert.deepEqual(patches().slice(before).map((r) => r.query.mode), ['VALIDATION_PREVIEW', 'VALIDATION_PREVIEW']);
  before = patches().length;
  const merged = await merge({ live: true, children: [{ sku: 'SKU-2', values: { color: 'Negro' } }, { sku: 'SKU-3', values: { color: 'Tricolor' } }] });
  assert.equal(merged.status, 200, merged.data.error);
  assert.deepEqual(merged.data.results.map((r) => [r.sku, r.mode, r.status]), [['SKU-2', 'live', 'ACCEPTED'], ['SKU-3', 'live', 'ACCEPTED']]);
  const sent = patches().slice(before);
  assert.deepEqual(sent.map((r) => r.query.mode), ['VALIDATION_PREVIEW', 'VALIDATION_PREVIEW', undefined, undefined]);
  assert.deepEqual(sent[2].body.patches, [
    { op: 'replace', path: '/attributes/parentage_level', value: [{ marketplace_id: 'A1RKKUPIHCS9HS', value: 'child' }] },
    { op: 'replace', path: '/attributes/child_parent_sku_relationship', value: [{ marketplace_id: 'A1RKKUPIHCS9HS', child_relationship_type: 'variation', parent_sku: 'SKU-1' }] },
    { op: 'replace', path: '/attributes/variation_theme', value: [{ name: 'COLOR' }] },
    { op: 'replace', path: '/attributes/color', value: [{ language_tag: 'es_ES', value: 'Negro', marketplace_id: 'A1RKKUPIHCS9HS' }] },
  ]);
  const familyRows = (await call(`/listings/items?${q}`, owner)).data.items;
  assert.equal(familyRows.find((r) => r.sku === 'SKU-3').parent, 'SKU-1');
  assert.equal((await merge({ children: [{ sku: 'SKU-1' }] })).status, 400);

  // 移出变体
  before = patches().length;
  const detached = await call('/listings/variation/detach', owner, 'POST', { brand: 'CC', country: 'ES', sku: 'SKU-3', live: true });
  assert.equal(detached.data.status, 'ACCEPTED');
  assert.deepEqual(patches().slice(before)[1].body.patches.map((p) => [p.op, p.path]), [
    ['delete', '/attributes/parentage_level'], ['delete', '/attributes/child_parent_sku_relationship'], ['delete', '/attributes/variation_theme'],
  ]);
  assert.equal((await call(`/listings/items?${q}`, owner)).data.items.find((r) => r.sku === 'SKU-3').parent, null);

  // 新建父体:先校验、建好父体,再校验、挂子体
  const calls = requests.length;
  const created = await merge({ parentSku: undefined, theme: 'SET_NAME', live: true,
    newParent: { sku: 'NEW-P', itemName: 'Cyloral 67XL', brand: 'Cyloral', category: '34285014031' },
    fill: { gdpr_risk: 'no_electronic_information_stored', country_of_origin: '' },
    children: [{ sku: 'SKU-3', values: { set_name: '67xl Black' } }] });
  assert.equal(created.status, 200, created.data.error);
  assert.equal(created.data.parent.status, 'ACCEPTED');
  assert.deepEqual(created.data.results.map((r) => [r.sku, r.status]), [['SKU-3', 'ACCEPTED']]);
  const order = requests.slice(calls).map((r) => `${r.method}:${r.query.mode ?? 'live'}`);
  assert.deepEqual(order, ['PUT:VALIDATION_PREVIEW', 'PUT:live', 'PATCH:VALIDATION_PREVIEW', 'PATCH:live']);
  // 父体照抄子体的商品属性(这里是 color),缺的必填项按页面选的补上,空值不补
  assert.deepEqual(requests[calls].body, { productType: 'INK_OR_TONER', requirements: 'LISTING_PRODUCT_ONLY', attributes: {
    color: [{ language_tag: 'es_ES', value: 'Tricolor', marketplace_id: 'A1RKKUPIHCS9HS' }],
    gdpr_risk: [{ value: 'no_electronic_information_stored', marketplace_id: 'A1RKKUPIHCS9HS' }],
    parentage_level: [{ marketplace_id: 'A1RKKUPIHCS9HS', value: 'parent' }],
    variation_theme: [{ name: 'SET_NAME' }],
    item_name: [{ language_tag: 'es_ES', value: 'Cyloral 67XL', marketplace_id: 'A1RKKUPIHCS9HS' }],
    brand: [{ language_tag: 'es_ES', value: 'Cyloral', marketplace_id: 'A1RKKUPIHCS9HS' }],
    // 西班牙站用推荐浏览节点,不是美国站的 item_type_keyword
    recommended_browse_nodes: [{ value: '34285014031', marketplace_id: 'A1RKKUPIHCS9HS' }],
  } });
  assert.deepEqual(requests[calls + 3].body.patches.at(-1), {
    op: 'replace', path: '/attributes/gdpr_risk', value: [{ value: 'no_electronic_information_stored', marketplace_id: 'A1RKKUPIHCS9HS' }],
  });
  const withParent = (await call(`/listings/items?${q}`, owner)).data.items;
  assert.equal(withParent.find((r) => r.sku === 'NEW-P').parentage, 'parent');
  assert.equal(withParent.find((r) => r.sku === 'SKU-3').parent, 'NEW-P');
  // 同名父体已经存在就不再新建
  assert.equal((await merge({ theme: 'SET_NAME', newParent: { sku: 'NEW-P', itemName: 'x', brand: 'y' }, children: [{ sku: 'SKU-2' }] })).status, 400);

  // 服务器设了 LISTINGS_LIVE_SUBMIT=false:直接拒绝,不会发到亚马逊
  process.env.LISTINGS_LIVE_SUBMIT = 'false';
  before = patches().length;
  assert.equal((await submit({ changes, live: true })).status, 403);
  assert.equal(patches().length, before);
  delete process.env.LISTINGS_LIVE_SUBMIT;
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
  assert.throws(() => buildPatches({ color: [{ value: 'Negro' }] }), /目前不开放修改/);
  assert.throws(() => buildPatches({ item_name: 'text' }), /值格式不对/);
});

test('补填项:空壳算缺;亚马逊报缺而缓存显示有时,按页面选的值强制补', async () => {
  const { fillMissing, forcedFillPatches } = await import('../src/listings.js');
  const fill = { gdpr_risk: 'no_electronic_information_stored', country_of_origin: 'CN' };
  assert.deepEqual(Object.keys(fillMissing({ gdpr_risk: [{ marketplace_id: 'M1' }], country_of_origin: [{ value: 'CN' }] }, fill, 'M1')), ['gdpr_risk']);
  const issues = [{ severity: 'ERROR', attributeNames: ['gdpr_risk'] }, { severity: 'WARNING', attributeNames: ['country_of_origin'] }];
  assert.deepEqual(forcedFillPatches(issues, [], fill, 'M1'), [
    { op: 'replace', path: '/attributes/gdpr_risk', value: [{ value: 'no_electronic_information_stored', marketplace_id: 'M1' }] },
  ]);
  // 已经在补丁里的不重复加
  assert.deepEqual(forcedFillPatches(issues, [{ path: '/attributes/gdpr_risk' }], fill, 'M1'), []);
});
