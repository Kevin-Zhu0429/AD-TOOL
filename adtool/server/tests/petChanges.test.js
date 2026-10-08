import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const US = 'ATVPDKIKX0DER';
const SP_ENV = { PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret', PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'apetseller' };
const ADS_ENV = { ...SP_ENV, PET_ADS_REFRESH_TOKEN: 'Atzr|ads', PET_ADS_PROFILE_ID: '1234567890' };
const text = (value) => ({ value, language_tag: 'en_US', marketplace_id: US });
const price = (value) => [{ schedule: [{ value_with_tax: value }] }];

/** 假的 SP-API:Listing 存在内存里,PATCH 记下请求;preview 返回的问题可以按测试设置 */
function fakeListings() {
  const state = {
    'RR-S': { asin: 'B0RRS00001', productType: 'PET_BED', issues: [], attributes: {
      item_name: [text('PawNest Dog Bed Small Old')], bullet_point: ['one', 'two', 'three', 'four', 'five'].map(text),
      generic_keyword: [text('dog bed')],
      purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: price(25.99), minimum_seller_allowed_price: price(20) },
        { marketplace_id: US, currency: 'USD', audience: 'B2B', our_price: price(24.99) }] } },
    'RR-M': { asin: 'B0RRM00001', productType: 'PET_BED', issues: [], attributes: {
      item_name: [text('PawNest Dog Bed Medium')], bullet_point: [text('soft')], generic_keyword: [text('dog bed medium')],
      purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: price(29.99) }] } },
  };
  const calls = [];
  const fake = { state, calls, previewIssues: [], async request(account, region, method, route, { query, body } = {}) {
    assert.equal(account.sellerId, 'APETSELLER');
    calls.push({ method, route, query, body });
    const sku = decodeURIComponent(route.split('/').pop());
    const item = state[sku];
    if (!item) throw Object.assign(new Error('亚马逊接口请求失败 (404)'), { upstreamStatus: 404 });
    if (method === 'GET') return { sku, summaries: [{ marketplaceId: US, asin: item.asin, productType: item.productType }], attributes: item.attributes, issues: item.issues };
    if (query.mode === 'VALIDATION_PREVIEW') {
      return { sku, status: fake.previewIssues.some((issue) => issue.severity === 'ERROR') ? 'INVALID' : 'VALID', issues: fake.previewIssues };
    }
    return { sku, status: 'ACCEPTED', submissionId: `sub-${calls.length}`, issues: [] };
  } };
  return fake;
}

function fakeAds() {
  const calls = [];
  return { calls, fail: false, async request(account, method, route, body, media) {
    calls.push({ account, method, route, body, media });
    const list = Object.keys(body)[0];
    if (this.fail) return { [list]: { success: [], error: [{ index: 0, errors: [{ errorType: 'entityNotFound', errorValue: { entityNotFoundError: { message: 'Campaign not found' } } }] }] } };
    return { [list]: { success: [{ index: 0, keywordId: body[list][0].keywordId ?? 'new-1' }], error: [] } };
  } };
}

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-changes-test-'));
  Object.assign(process.env, { APP_PROFILE: 'pet', DATA_DIR: directory, NODE_ENV: 'test' });
  const { db } = await import('../src/db.js');
  const { authRouter } = await import('../src/auth.js');
  const changes = await import('../src/petChanges.js');
  for (const [username, role] of [['owner', 'owner'], ['staff', 'operator']]) {
    db.prepare(`INSERT INTO users (username, display_name, password_hash, role, marketplace, seen_version) VALUES (?, ?, ?, ?, 'US', '999.0.0')`)
      .run(username, username, bcrypt.hashSync('test-password', 4), role);
  }
  const sku = db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', 'PawNest', ?, ?, '方窝牛津', ?, 'Grey', ?)`);
  sku.run('RR-S', 'B0RRS00001', 'S', 'us|rr-s');
  sku.run('RR-M', 'B0RRM00001', 'M', 'us|rr-m');
  db.prepare("INSERT INTO pet_sku_costs (sku, fob, first_leg, duty) VALUES ('RR-M', 8, 1, 0.5)").run();
  db.prepare("INSERT INTO pet_sku_fees (sku, fba_fee, referral_fee, referral_rate) VALUES ('RR-M', 6.5, 4.5, 0.15)").run();
  const gateway = fakeListings();
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'changes-test-only', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRouter);
  app.use('/api/changes', changes.createChangeRouter({ gateway, adsGateway: fakeAds(), env: SP_ENV }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function call(route, cookie, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(url + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (username) => (await call('/auth/login', null, { username, password: 'test-password' })).cookie;
  return { db, changes, gateway, call, login, async close() {
    await new Promise((resolve) => server.close(resolve)); db.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('change queue: Claude proposes, the owner confirms, the site writes to Amazon and checks the result', async (t) => {
  const env = await start();
  t.after(() => env.close());
  const { db, changes, gateway, call } = env;
  const owner = await env.login('owner');
  const staff = await env.login('staff');
  const ownerId = db.prepare("SELECT id FROM users WHERE username='owner'").get().id;
  const deps = { gateway, env: SP_ENV };
  const status = (id) => db.prepare('SELECT status FROM pet_change_proposals WHERE id=?').get(id).status;
  const row = (id) => db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(id);
  let ids = {};

  await t.test('proposals record the live value and stop bad changes before they reach the queue', async () => {
    const result = await changes.proposeListingChanges({ title: '方窝牛津 S/M 文案', summary: '补 cat bed', changes: [
      { sku: 'rr-s', field: 'title', value: '  PawNest Dog Bed   Small for Cats and Dogs ', reason: 'ABA 里 cat bed 有量' },
      { sku: 'RR-S', field: 'bullets', value: ['one', 'two', 'three', 'four'], reason: '精简' },
      { sku: 'RR-M', field: 'search_terms', value: 'x'.repeat(250), reason: '太长' },
      { sku: 'RR-M', field: 'price', value: 15.99, reason: '清库存' },
      { sku: 'RR-M', field: 'title', value: 'PawNest Dog Bed Medium', reason: '一样' },
      { sku: 'NOPE', field: 'title', value: 'x', reason: '没有这个 SKU' },
      { sku: 'RR-S', field: 'price', value: 22.99, reason: '跟竞品' },
    ] }, { userId: ownerId, gateway, env: SP_ENV });
    assert.deepEqual(result.created.map((item) => [item.sku, item.field]), [['RR-S', 'title'], ['RR-S', 'bullets'], ['RR-M', 'price'], ['RR-S', 'price']]);
    assert.deepEqual(result.rejected.map((item) => item.index), [2, 4, 5]);
    assert.match(result.rejected[0].error, /250 字节/);
    assert.match(result.rejected[1].error, /一样/);
    assert.match(result.rejected[2].error, /SKU 库里没有/);
    // 同一个 SKU 只读一次亚马逊
    assert.equal(gateway.calls.filter((item) => item.method === 'GET').length, 2);
    [ids.title, ids.bullets, ids.priceM, ids.priceS] = result.created.map((item) => item.id);
    const title = row(ids.title);
    assert.equal(JSON.parse(title.before_json), 'PawNest Dog Bed Small Old');
    assert.equal(JSON.parse(title.after_json), 'PawNest Dog Bed Small for Cats and Dogs');
    assert.equal(JSON.parse(title.target_json).productType, 'PET_BED');
    assert.equal(title.created_by, ownerId);
    assert.match(row(ids.bullets).warnings_json, /少 1 条/);
    // RR-M 落地成本 9.5 + FBA 6.5 + 佣金 2.40 = 18.40 > 15.99
    assert.match(row(ids.priceM).warnings_json, /每件亏 \$2\.41/);
    assert.equal(JSON.parse(row(ids.priceM).target_json).priceImpact.profitAfter, -2.41);

    const again = await changes.proposeListingChanges({ title: '再改一次', changes: [{ sku: 'RR-S', field: 'title', value: 'PawNest Dog Bed Small Cat Bed', reason: '更短' }] },
      { userId: ownerId, gateway, env: SP_ENV });
    assert.equal(again.superseded, 1);
    assert.equal(status(ids.title), 'superseded');
    ids.title = again.created[0].id;
  });

  await t.test('only the owner can see and act on the queue', async () => {
    assert.equal((await call('/changes', staff)).status, 403);
    const list = await call('/changes?view=pending', owner);
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 4);
    assert.deepEqual(list.data.counts, { pending: 4, active: 0, history: 1 });
    assert.equal(list.data.batches.length, 2);
    assert.equal(list.data.items[0].createdBy, 'owner');
    assert.deepEqual([list.data.config.spApi, list.data.config.adsApi], [true, false]);
    assert.equal((await call('/changes/approve', staff, { ids: [ids.title] })).status, 403);
  });

  await t.test('the owner can reword a proposal before confirming', async () => {
    const edited = await call(`/changes/${ids.title}`, owner, { value: 'PawNest Dog Bed Small, Cat Bed' }, 'PUT');
    assert.equal(edited.status, 200);
    assert.equal(edited.data.after, 'PawNest Dog Bed Small, Cat Bed');
    const tooLong = await call(`/changes/${ids.title}`, owner, { value: 'x'.repeat(201) }, 'PUT');
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.data.error, /200/);
  });

  await t.test('confirmed listing changes are pre-checked by Amazon, then submitted', async () => {
    gateway.calls.length = 0;
    const approved = await call('/changes/approve', owner, { ids: [ids.title, ids.priceS] });
    assert.deepEqual(approved.data, { queued: 2, export: 0 });
    await changes.waitForQueue();
    assert.equal(status(ids.title), 'submitted');
    assert.equal(status(ids.priceS), 'submitted');
    const patches = gateway.calls.filter((item) => item.method === 'PATCH');
    // 每条先预检再正式提交,按确认的先后(编号)执行
    assert.deepEqual(patches.map((item) => [item.body.patches[0].path, item.query.mode ?? 'submit']), [
      ['/attributes/purchasable_offer', 'VALIDATION_PREVIEW'], ['/attributes/purchasable_offer', 'submit'],
      ['/attributes/item_name', 'VALIDATION_PREVIEW'], ['/attributes/item_name', 'submit']]);
    assert.deepEqual(patches[3].body, { productType: 'PET_BED', patches: [{ op: 'replace', path: '/attributes/item_name', value: [text('PawNest Dog Bed Small, Cat Bed')] }] });
    // 改价只动 ALL 报价的 our_price,最低价和 B2B 报价原样带上
    assert.deepEqual(patches[1].body.patches[0].value, [
      { marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: price(22.99), minimum_seller_allowed_price: price(20) },
      { marketplace_id: US, currency: 'USD', audience: 'B2B', our_price: price(24.99) }]);
    assert.equal(JSON.parse(row(ids.title).result_json).submissionId.startsWith('sub-'), true);
    assert.equal(row(ids.title).decided_by, ownerId);
    assert.equal((await call('/changes/approve', owner, { ids: [ids.title] })).status, 409);
  });

  await t.test('a failed Amazon pre-check stops the change; it can be edited back to pending or retried', async () => {
    const proposed = await changes.proposeListingChanges({ title: '后台词', changes: [{ sku: 'RR-S', field: 'search_terms', value: 'dog bed cat bed', reason: '补词' }] },
      { userId: ownerId, gateway, env: SP_ENV });
    ids.terms = proposed.created[0].id;
    gateway.previewIssues = [{ code: '8560', message: 'generic_keyword is invalid', severity: 'ERROR', attributeNames: ['generic_keyword'] }];
    gateway.calls.length = 0;
    await call('/changes/approve', owner, { ids: [ids.terms] });
    await changes.waitForQueue();
    assert.equal(status(ids.terms), 'failed');
    assert.match(row(ids.terms).error, /预检没通过.*generic_keyword is invalid/);
    assert.equal(gateway.calls.filter((item) => item.method === 'PATCH' && !item.query.mode).length, 0);
    // 改掉出错的词:退回待确认、清掉报错,要重新确认
    const edited = await call(`/changes/${ids.terms}`, owner, { value: 'dog bed kitty bed' }, 'PUT');
    assert.equal(edited.status, 200);
    assert.equal(status(ids.terms), 'pending');
    assert.equal(row(ids.terms).error, null);
    await call('/changes/approve', owner, { ids: [ids.terms] });
    await changes.waitForQueue();
    assert.equal(status(ids.terms), 'failed');
    gateway.previewIssues = [];
    assert.deepEqual((await call('/changes/retry', owner, { ids: [ids.terms] })).data, { updated: 1 });
    await changes.waitForQueue();
    assert.equal(status(ids.terms), 'submitted');
    const submit = gateway.calls.filter((item) => item.method === 'PATCH' && !item.query.mode).at(-1);
    assert.equal(submit.body.patches[0].value[0].value, 'dog bed kitty bed');
  });

  await t.test('if someone changed the listing after the proposal, it goes back for another look', async () => {
    gateway.state['RR-S'].attributes.bullet_point = [text('edited in Seller Central')];
    await call('/changes/approve', owner, { ids: [ids.bullets] });
    await changes.waitForQueue();
    const back = row(ids.bullets);
    assert.equal(back.status, 'pending');
    assert.deepEqual(JSON.parse(back.before_json), ['edited in Seller Central']);
    assert.match(back.warnings_json, /值变了/);
  });

  await t.test('the checker marks changes live once Amazon shows them, and flags ones that never landed', async () => {
    gateway.state['RR-S'].attributes.item_name = [text('PawNest Dog Bed Small, Cat Bed')];
    db.prepare("UPDATE pet_change_proposals SET executed_at=datetime('now','localtime','-3 days') WHERE id=?").run(ids.priceS);
    gateway.state['RR-S'].issues = [{ code: '1', message: 'price outside range', severity: 'ERROR', attributeNames: ['purchasable_offer'] }];
    assert.deepEqual(await changes.verifySubmitted(deps), { checked: 3 });
    assert.equal(status(ids.title), 'applied');
    assert.equal(status(ids.priceS), 'not_applied');
    assert.match(row(ids.priceS).error, /48 小时.*price outside range/);
    assert.equal(status(ids.terms), 'submitted');
  });

  await t.test('an applied change can be reverted through the same queue', async () => {
    const reverted = await call(`/changes/${ids.title}/revert`, owner, {});
    const back = row(reverted.data.id);
    assert.equal(back.status, 'pending');
    assert.equal(back.revert_of, ids.title);
    assert.equal(JSON.parse(back.after_json), 'PawNest Dog Bed Small Old');
    assert.equal(JSON.parse(back.before_json), 'PawNest Dog Bed Small, Cat Bed');
    assert.equal((await call('/changes/reject', owner, { ids: [back.id, ids.priceM] })).data.updated, 2);
  });

  await t.test('sale price: set with dates, kept together with a list price change, cancelled by reverting', async () => {
    const { pacificDay, pacificMidnight } = await import('../src/petAmazon.js');
    const today = pacificDay(new Date());
    db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', 'PawNest', 'RR-L', 'B0RRL00001', '方窝牛津', 'L', 'Grey', 'us|rr-l')`).run();
    gateway.state['RR-L'] = { asin: 'B0RRL00001', productType: 'PET_BED', issues: [], attributes: {
      purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: price(39.99), maximum_seller_allowed_price: price(60) }] } };
    const proposed = await changes.proposeListingChanges({ title: 'L 码促销', changes: [
      { sku: 'RR-L', field: 'sale_price', value: 34.99, reason: '没写结束日' },
      { sku: 'RR-L', field: 'sale_price', value: 39.99, saleEnd: '2099-12-31', reason: '不比原价低' },
      { sku: 'RR-M', field: 'sale_price', value: 0, reason: '取消' },
    ] }, { userId: ownerId, gateway, env: SP_ENV });
    assert.equal(proposed.created.length, 0);
    assert.match(proposed.rejected[0].error, /结束日期/);
    assert.match(proposed.rejected[1].error, /低于原价 \$39\.99/);
    assert.match(proposed.rejected[2].error, /没有促销价/);

    const ok = await changes.proposeListingChanges({ title: 'L 码促销', changes: [
      { sku: 'RR-L', field: 'price', value: 42.99, reason: '原价上调' },
      { sku: 'RR-L', field: 'sale_price', value: 34.99, saleEnd: '2099-12-31', reason: '促销 34.99' },
    ] }, { userId: ownerId, gateway, env: SP_ENV });
    const [listId, saleId] = ok.created.map((item) => item.id);
    assert.equal(row(saleId).before_json, 'null');
    assert.deepEqual(JSON.parse(row(saleId).after_json), { price: 34.99, start: today, end: '2099-12-31' });
    assert.equal(JSON.parse(row(saleId).target_json).listPrice, 39.99);
    // 页面上改促销价:价格和起止日一起改,照样检查不能高于原价
    assert.equal((await call(`/changes/${saleId}`, owner, { value: { price: 41, start: today, end: '2099-12-31' } }, 'PUT')).status, 400);
    assert.equal((await call(`/changes/${saleId}`, owner, { value: { price: 33.99, start: today, end: '2099-12-31' } }, 'PUT')).status, 200);
    assert.equal(JSON.parse(row(saleId).after_json).price, 33.99);

    gateway.calls.length = 0;
    await call('/changes/approve', owner, { ids: [listId, saleId] });
    await changes.waitForQueue();
    assert.deepEqual([status(listId), status(saleId)], ['submitted', 'submitted']);
    const submits = gateway.calls.filter((item) => item.method === 'PATCH' && !item.query.mode);
    assert.equal(submits[0].body.patches[0].value[0].discounted_price, undefined);
    // 促销价这次整段替换报价时带上刚提交、还没生效的原价 42.99,不会把它改回 39.99
    const offer = submits[1].body.patches[0].value[0];
    assert.deepEqual(offer.our_price, price(42.99));
    assert.deepEqual(offer.maximum_seller_allowed_price, price(60));
    assert.deepEqual(offer.discounted_price, [{ schedule: [{ value_with_tax: 33.99, start_at: pacificMidnight(today).toISOString(),
      end_at: new Date(pacificMidnight('2100-01-01').getTime() - 1000).toISOString() }] }]);

    // 亚马逊生效后核对:促销价按太平洋时间的起止日比
    gateway.state['RR-L'].attributes.purchasable_offer = submits[1].body.patches[0].value;
    await changes.verifySubmitted(deps);
    assert.deepEqual([status(listId), status(saleId)], ['applied', 'applied']);
    const priceAgain = await changes.proposeListingChanges({ title: '改原价', changes: [{ sku: 'RR-L', field: 'price', value: 44.99, reason: '试' }] },
      { userId: ownerId, gateway, env: SP_ENV });
    assert.match(row(priceAgain.created[0].id).warnings_json, /促销价 \$33\.99.*要改前台价请改促销价/);

    // 撤回促销价 = 取消促销价
    const reverted = await call(`/changes/${saleId}/revert`, owner, {});
    assert.equal(row(reverted.data.id).after_json, 'null');
    gateway.calls.length = 0;
    await call('/changes/approve', owner, { ids: [reverted.data.id] });
    await changes.waitForQueue();
    assert.equal(status(reverted.data.id), 'submitted');
    const removed = gateway.calls.filter((item) => item.method === 'PATCH' && !item.query.mode)[0].body.patches[0].value[0];
    assert.equal(removed.discounted_price, undefined);
    assert.deepEqual(removed.our_price, price(42.99));
    assert.equal((await call('/changes/reject', owner, { ids: [priceAgain.created[0].id] })).data.updated, 1);
  });

  await t.test('without Ads API credentials confirmed ad changes become a bulk sheet to upload', async () => {
    const result = changes.proposeAdChanges({ title: '暂停烂词', changes: [
      { action: 'pause', entity: 'keyword', campaignId: '111', adGroupId: '222', entityId: '333', label: 'cheap dog bed', current: 'enabled', reason: 'ACOS 80%' },
      { action: 'add_negative', level: 'campaign', matchType: 'phrase', campaignId: '111', negativeText: 'cat tree', reason: '不相关' },
      { action: 'set_bid', entity: 'keyword', campaignId: '111', entityId: '333', bid: 0.5, reason: '缺广告组编号' },
      { action: 'add_negative', level: 'campaign', matchType: 'asin', campaignId: '111', negativeText: 'B0ABCDEFGH', reason: '活动级不能否 ASIN' },
    ] }, { userId: ownerId });
    assert.deepEqual(result.created.map((item) => item.kind), ['ad_state', 'ad_negative']);
    assert.match(result.rejected[0].error, /广告组编号/);
    assert.match(result.rejected[1].error, /广告组/);
    const [pause, negative] = result.created.map((item) => item.id);
    assert.deepEqual((await call('/changes/approve', owner, { ids: [pause, negative] })).data, { queued: 0, export: 2 });
    assert.equal(status(pause), 'export');
    const active = await call('/changes?view=active', owner);
    assert.deepEqual(active.data.items.filter((item) => item.status === 'export').map((item) => item.id), [pause, negative]);
    assert.equal((await call('/changes/uploaded', owner, { ids: [pause] })).status, 409);
    await call('/changes/exported', owner, { ids: [pause, negative] });
    await call('/changes/uploaded', owner, { ids: [pause, negative] });
    assert.equal(status(pause), 'applied');
    const log = await call('/changes/log', owner);
    const actions = log.data.events.filter((event) => event.proposalId === pause).map((event) => event.action).reverse();
    assert.deepEqual(actions, ['proposed', 'approved', 'to_export', 'exported', 'uploaded']);
    assert.equal(log.data.events.find((event) => event.action === 'uploaded').userName, 'owner');
  });

  await t.test('with Ads API credentials confirmed ad changes are sent straight to Amazon', async () => {
    const ads = fakeAds();
    const result = changes.proposeAdChanges({ title: '降竞价', changes: [
      { action: 'set_bid', entity: 'keyword', campaignId: '111', adGroupId: '222', entityId: '333', bid: 0.55, current: 0.8, reason: '降' },
      { action: 'set_budget', campaignId: '111', budget: 30, current: 20, reason: '加预算' },
    ] }, { userId: ownerId });
    const [bid, budget] = result.created.map((item) => item.id);
    assert.deepEqual(changes.approveChanges([bid], ownerId, ADS_ENV), { queued: 1, export: 0 });
    await changes.kickQueue({ gateway, adsGateway: ads, env: ADS_ENV });
    assert.equal(status(bid), 'applied');
    assert.equal(row(bid).channel, 'ads_api');
    assert.deepEqual(ads.calls.map((item) => [item.method, item.route, item.media, item.account.profileId]),
      [['PUT', '/sp/keywords', 'application/vnd.spKeyword.v3+json', '1234567890']]);
    assert.deepEqual(ads.calls[0].body, { keywords: [{ keywordId: '333', bid: 0.55 }] });
    // 没单独配广告 API 的 LWA 应用时沿用 SP-API 的
    assert.equal(ads.calls[0].account.clientId, 'pet-client');
    ads.fail = true;
    changes.approveChanges([budget], ownerId, ADS_ENV);
    await changes.kickQueue({ gateway, adsGateway: ads, env: ADS_ENV });
    assert.equal(status(budget), 'failed');
    assert.match(row(budget).error, /Campaign not found/);
  });
});

test('Ads API request shapes for each kind of change', async () => {
  const { adsRequestFor } = await import('../src/petAds.js');
  const ids = { campaignId: '1', adGroupId: '2' };
  assert.deepEqual(adsRequestFor('ad_budget', { entity: 'campaign', entityId: '1', ...ids }, { budget: 30 }).body,
    { campaigns: [{ campaignId: '1', budget: { budget: 30, budgetType: 'DAILY' } }] });
  assert.deepEqual(adsRequestFor('ad_bid', { entity: 'adGroup', entityId: '2', ...ids }, { bid: 0.4 }).body, { adGroups: [{ adGroupId: '2', defaultBid: 0.4 }] });
  const ad = adsRequestFor('ad_state', { entity: 'productAd', entityId: '9', ...ids }, { state: 'paused' });
  assert.deepEqual([ad.method, ad.path, ad.body], ['PUT', '/sp/productAds', { productAds: [{ adId: '9', state: 'PAUSED' }] }]);
  assert.deepEqual(adsRequestFor('ad_state', { entity: 'productTarget', entityId: '7', ...ids }, { state: 'enabled' }).body,
    { targetingClauses: [{ targetId: '7', state: 'ENABLED' }] });
  const exact = adsRequestFor('ad_negative', { level: 'adGroup', ...ids }, { matchType: 'exact', text: 'cat tree' });
  assert.deepEqual([exact.method, exact.path, exact.body], ['POST', '/sp/negativeKeywords',
    { negativeKeywords: [{ campaignId: '1', adGroupId: '2', keywordText: 'cat tree', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }] }]);
  assert.deepEqual(adsRequestFor('ad_negative', { level: 'campaign', campaignId: '1', adGroupId: null }, { matchType: 'phrase', text: 'toy' }).body,
    { campaignNegativeKeywords: [{ campaignId: '1', keywordText: 'toy', matchType: 'NEGATIVE_PHRASE', state: 'ENABLED' }] });
  assert.deepEqual(adsRequestFor('ad_negative', { level: 'adGroup', ...ids }, { matchType: 'asin', text: 'B0ABCDEFGH' }).body,
    { negativeTargetingClauses: [{ campaignId: '1', adGroupId: '2', expression: [{ type: 'ASIN_SAME_AS', value: 'B0ABCDEFGH' }], state: 'ENABLED' }] });
});
