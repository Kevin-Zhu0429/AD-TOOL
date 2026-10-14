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
const text = (value) => ({ value, language_tag: 'en_US', marketplace_id: US });
const price = (value) => [{ schedule: [{ value_with_tax: value }] }];

// 亚马逊商品类型定义(JSON Schema)的一小部分
const PET_BED_SCHEMA = {
  required: ['item_name', 'brand'],
  propertyGroups: { product_details: { title: 'Product Details', propertyNames: ['product_description', 'material', 'item_dimensions'] } },
  properties: {
    item_name: { title: 'Item Name', items: { properties: { value: { type: 'string', maxLength: 200 }, language_tag: {}, marketplace_id: {} } } },
    brand: { title: 'Brand Name', items: { properties: { value: { type: 'string' }, language_tag: {}, marketplace_id: {} } } },
    product_description: { title: 'Product Description', items: { properties: { value: { type: 'string', maxLength: 2000 }, language_tag: {}, marketplace_id: {} } } },
    material: { title: 'Material', maxItems: 3, items: { properties: { value: { type: 'string', anyOf: [{ type: 'string' }, { enum: ['Oxford', 'Canvas'], enumNames: ['Oxford', 'Canvas'] }] },
      language_tag: {}, marketplace_id: {} } } },
    number_of_items: { title: 'Number of Items', items: { properties: { value: { type: 'integer' }, marketplace_id: {} } } },
    item_dimensions: { title: 'Item Dimensions', items: { properties: { length: {}, width: {}, height: {}, marketplace_id: {} } } },
  },
};

function fakeAmazon() {
  const state = {
    'RR-S': { asin: 'B0RRS00001', productType: 'PET_BED', issues: [{ severity: 'WARNING', code: '1', message: 'Missing material', attributeNames: ['material'] }],
      attributes: {
        item_name: [text('PawNest Dog Bed Small')], bullet_point: ['one', 'two'].map(text), generic_keyword: [text('dog bed')], brand: [text('PawNest')],
        product_description: [text('Old description')], number_of_items: [{ value: 1, marketplace_id: US }],
        item_dimensions: [{ length: { value: 20, unit: 'inches' }, width: { value: 15, unit: 'inches' }, height: { value: 6, unit: 'inches' }, marketplace_id: US }],
        item_package_dimensions: [{ length: { value: 28, unit: 'centimeters' }, width: { value: 28, unit: 'centimeters' }, height: { value: 11, unit: 'centimeters' }, marketplace_id: US }],
        item_package_weight: [{ value: 2.6, unit: 'pounds', marketplace_id: US }],
        purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: price(25.99) }] } },
    'RR-M': { asin: 'B0RRM00001', productType: 'PET_BED', issues: [], attributes: { item_name: [text('PawNest Dog Bed Medium')], brand: [text('PawNest')] } },
    'OLD-1': { asin: 'B0OLD00001', productType: 'PET_BED', issues: [], attributes: { item_name: [text('Old listing')] } },
  };
  const calls = [];
  const summary = (sku) => ({ marketplaceId: US, asin: state[sku].asin, productType: state[sku].productType, status: ['BUYABLE'], itemName: state[sku].attributes.item_name?.[0]?.value });
  const fake = { state, calls, previewIssues: [], searchFails: false, async request(account, region, method, route, { query, body } = {}) {
    calls.push({ method, route, query, body });
    if (route.startsWith('/catalog/')) return { asin: route.split('/').pop(), dimensions: [{ marketplaceId: US, package: { length: { value: 19.7, unit: 'inches' },
      width: { value: 17.8, unit: 'inches' }, height: { value: 7.2, unit: 'inches' }, weight: { value: 2.49, unit: 'pounds' } } }] };
    if (route.startsWith('/definitions/')) return { schema: { link: { resource: 'https://schemas.example/PET_BED.json' } }, productTypeVersion: { version: 'v1' } };
    if (route === '/listings/2021-08-01/items/APETSELLER') {
      if (fake.searchFails) throw Object.assign(new Error('亚马逊接口请求失败 (403)'), { upstreamStatus: 403 });
      // 一页 2 个
      const skus = Object.keys(state);
      const start = Number(query.pageToken ?? 0);
      const page = skus.slice(start, start + 2);
      return { numberOfResults: skus.length, items: page.map((sku) => ({ sku, summaries: [summary(sku)], attributes: state[sku].attributes, issues: state[sku].issues })),
        pagination: start + 2 < skus.length ? { nextToken: String(start + 2) } : {} };
    }
    const sku = decodeURIComponent(route.split('/').pop());
    const item = state[sku];
    if (!item) throw Object.assign(new Error('亚马逊接口请求失败 (404)'), { upstreamStatus: 404 });
    if (method === 'GET') return { sku, summaries: [summary(sku)], attributes: item.attributes, issues: item.issues };
    if (query.mode === 'VALIDATION_PREVIEW') return { sku, status: fake.previewIssues.some((issue) => issue.severity === 'ERROR') ? 'INVALID' : 'VALID', issues: fake.previewIssues };
    // 真的提交:直接改掉内存里的值,方便核对
    for (const patch of body.patches) {
      const name = patch.path.split('/').pop();
      if (patch.op === 'delete') delete item.attributes[name]; else item.attributes[name] = patch.value;
    }
    return { sku, status: 'ACCEPTED', submissionId: `sub-${calls.length}`, issues: [] };
  }, downloadSchema: async (url) => { calls.push({ method: 'DOWNLOAD', route: url }); return PET_BED_SCHEMA; } };
  return fake;
}

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-listings-test-'));
  Object.assign(process.env, { APP_PROFILE: 'pet', DATA_DIR: directory, NODE_ENV: 'test' });
  const { db } = await import('../src/db.js');
  const { authRouter } = await import('../src/auth.js');
  const listings = await import('../src/petListings.js');
  const changes = await import('../src/petChanges.js');
  const attrs = await import('../src/listingAttrs.js');
  for (const [username, role] of [['owner', 'owner'], ['staff', 'operator']]) {
    db.prepare(`INSERT INTO users (username, display_name, password_hash, role, marketplace, seen_version) VALUES (?, ?, ?, ?, 'US', '999.0.0')`)
      .run(username, username, bcrypt.hashSync('test-password', 4), role);
  }
  const sku = db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', 'PawNest', ?, ?, '方窝牛津', ?, 'Grey', ?)`);
  sku.run('RR-S', 'B0RRS00001', 'S', 'us|rr-s');
  sku.run('RR-M', 'B0RRM00001', 'M', 'us|rr-m');
  // SKU 库里有、整店翻页没翻到的,要单独读
  sku.run('RR-L', 'B0RRL00001', 'L', 'us|rr-l');
  listings.listingTiming.gapMs = 0;
  const gateway = fakeAmazon();
  const deps = { gateway, env: SP_ENV };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'listings-test-only', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRouter);
  app.use('/api/listings', listings.createListingRouter(deps));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function call(route, cookie, body) {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (username) => (await call('/auth/login', null, { username, password: 'test-password' })).cookie;
  return { db, listings, changes, attrs, gateway, deps, call, login, async close() {
    await new Promise((resolve) => server.close(resolve)); db.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('Listing board: read every SKU, edit on the site, upload through the logged change flow', async (t) => {
  const env = await start();
  t.after(() => env.close());
  const { db, listings, changes, gateway, deps, call } = env;
  const owner = await env.login('owner');
  const staff = await env.login('staff');
  const row = (id) => db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(id);

  await t.test('sync reads the whole shop page by page, then single SKUs the search missed', async () => {
    db.prepare("INSERT INTO pet_listing_items (sku, attributes_json) VALUES ('GONE-1', '{}')").run();
    const result = await listings.syncListingItems(deps);
    assert.equal(result.synced, 3);
    assert.equal(result.removed, 1, '亚马逊上已经没有的 SKU 删掉');
    assert.equal(gateway.calls.filter((item) => item.route === '/listings/2021-08-01/items/APETSELLER').length, 2);
    // RR-L 在 SKU 库里但亚马逊上没有:单独读了一次,读不到不算失败
    assert.ok(gateway.calls.some((item) => item.route.endsWith('/RR-L')));
    assert.equal(result.failed, 0);
    // 商品类型定义拉一次就缓存
    assert.equal(gateway.calls.filter((item) => item.method === 'DOWNLOAD').length, 1);
    const board = await call('/listings', staff);
    assert.equal(board.status, 200);
    assert.deepEqual(board.data.rows.map((item) => item.sku), ['OLD-1', 'RR-M', 'RR-S']);
    const small = board.data.rows.find((item) => item.sku === 'RR-S');
    assert.equal(small.style, '方窝牛津');
    assert.equal(small.bullets, 2);
    assert.equal(small.warnings, 1);
    assert.equal(small.statusText, '可售');
    assert.equal((await call('/listings?q=medium', staff)).data.rows.length, 1);
    const exported = await call('/listings/export', staff);
    assert.ok(exported.data.columns.includes('product_description'));
    assert.equal(exported.data.rows.find((item) => item.sku === 'RR-S').item_dimensions, 'length: {"value":20,"unit":"inches"}, width: {"value":15,"unit":"inches"}, height: {"value":6,"unit":"inches"}');
  });

  await t.test('falls back to reading SKUs one by one when the shop search is not available', async () => {
    gateway.searchFails = true;
    const result = await listings.syncListingItems(deps);
    gateway.searchFails = false;
    assert.match(result.searchError, /403/);
    assert.equal(result.removed, 0, '没翻完整店不删');
    assert.equal(result.synced, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_listing_items').get().n, 3);
  });

  await t.test('opening a SKU reads Amazon live with the attribute definitions', async () => {
    const detail = await call('/listings/item/rr-s', staff);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.sku, 'RR-S');
    assert.equal(detail.data.price, 25.99);
    assert.equal(detail.data.schema.attributes.material.title, 'Material');
    assert.deepEqual(detail.data.schema.attributes.material.options.map((option) => option.value), ['Oxford', 'Canvas']);
    assert.equal(detail.data.schema.attributes.item_dimensions.simple, false);
    assert.equal(detail.data.schema.attributes.number_of_items.languageTag, false);
    assert.ok(detail.data.readOnly.purchasable_offer);
    assert.equal(detail.data.cooldown, null);
    // 包装尺寸三套对照:卖家填的是标准件,亚马逊目录在用的是大件
    const pkg = detail.data.packaging;
    assert.deepEqual(pkg.seller.sides, [11.02, 11.02, 4.33]);
    assert.equal(pkg.seller.standard, true);
    assert.deepEqual(pkg.catalog.sides, [19.7, 17.8, 7.2]);
    assert.equal(pkg.catalog.standard, false);
    assert.deepEqual(pkg.catalog.over, ['最长边 19.7 > 18 英寸', '次长边 17.8 > 14 英寸']);
    assert.match(pkg.warning, /开 case/);
  });

  await t.test('only the owner can preview or upload', async () => {
    const body = { changes: [{ attribute: 'material', value: [{ value: 'Oxford' }] }] };
    assert.equal((await call('/listings/item/RR-S/submit', staff, body)).status, 403);
    assert.equal((await call('/listings/item/RR-S/preview', staff, body)).status, 403);
  });

  await t.test('preview sends every patch in one Amazon validation call and saves nothing', async () => {
    gateway.previewIssues = [{ severity: 'ERROR', code: '90220', message: 'material is invalid', attributeNames: ['material'] }];
    const result = await call('/listings/item/RR-S/preview', owner, { changes: [
      { attribute: 'material', value: [{ value: 'Oxford' }] },
      { attribute: 'product_description', value: [{ value: 'Relieves arthritis pain for senior dogs' }] },
      { field: 'price', value: 23.99 },
    ] });
    gateway.previewIssues = [];
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.issues[0].code, '90220');
    assert.ok(result.data.warnings.some((warning) => /arthritis/.test(warning)), '医疗说法要提醒');
    const preview = gateway.calls.filter((item) => item.query?.mode === 'VALIDATION_PREVIEW').at(-1);
    assert.deepEqual(preview.body.patches.map((patch) => patch.path), ['/attributes/material', '/attributes/product_description', '/attributes/purchasable_offer']);
    // 缺的 language_tag / marketplace_id 按定义补上
    assert.deepEqual(preview.body.patches[0].value, [{ value: 'Oxford', language_tag: 'en_US', marketplace_id: US }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_change_proposals').get().n, 0);
  });

  await t.test('a bad value stops the whole upload', async () => {
    const result = await call('/listings/item/RR-S/submit', owner, { changes: [
      { attribute: 'product_description', value: [{ value: 'New description' }] },
      { attribute: 'material', value: ['Oxford', 'Canvas', 'Cotton', 'Polyester'] },
      { attribute: 'purchasable_offer', value: [{ value: 1 }] },
      { attribute: 'brand', value: [] },
      { attribute: 'number_of_items', value: [{ value: 1 }] },
    ] });
    assert.equal(result.status, 200);
    assert.equal(result.data.submitted.length, 0);
    assert.deepEqual(result.data.rejected.map((item) => item.index), [1, 2, 3, 4]);
    assert.match(result.data.rejected[0].error, /最多 3 个/);
    assert.match(result.data.rejected[1].error, /售价/);
    assert.match(result.data.rejected[2].error, /必填/);
    assert.match(result.data.rejected[3].error, /一样/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_change_proposals').get().n, 0);
  });

  await t.test('upload is checked by Amazon as a whole first; one bad field means nothing goes live', async () => {
    gateway.previewIssues = [{ severity: 'ERROR', code: '90220', message: 'material is invalid', attributeNames: ['material'] }];
    const result = await call('/listings/item/RR-S/submit', owner, { changes: [
      { attribute: 'product_description', value: [{ value: 'Fine description' }] },
      { attribute: 'material', value: [{ value: 'Oxford' }] },
    ] });
    gateway.previewIssues = [];
    assert.equal(result.status, 200);
    assert.equal(result.data.submitted.length, 0);
    assert.equal(result.data.issues[0].code, '90220');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_change_proposals').get().n, 0);
    assert.equal(gateway.state['RR-S'].attributes.product_description[0].value, 'Old description');
  });

  let ids;
  await t.test('upload goes straight to Amazon through the change queue and is logged as the owner\'s edit', async () => {
    const result = await call('/listings/item/RR-S/submit', owner, { reason: '补描述和材质', changes: [
      { attribute: 'item_name', value: [{ value: 'PawNest Waterproof Dog Bed Small' }] },
      { attribute: 'bullet_point', value: [{ value: 'one' }, { value: 'two' }, { value: 'three' }] },
      { attribute: 'product_description', value: [{ value: 'New description' }] },
      { attribute: 'material', value: [{ value: 'Oxford' }] },
      { attribute: 'item_dimensions', value: [{ length: { value: 22, unit: 'inches' }, width: { value: 15, unit: 'inches' }, height: { value: 6, unit: 'inches' } }] },
    ] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.rejected, []);
    ids = result.data.submitted.map((item) => item.id);
    assert.deepEqual(result.data.submitted.map((item) => item.kind), ['listing_title', 'listing_bullets', 'listing_attribute', 'listing_attribute', 'listing_attribute']);
    await changes.waitForQueue();
    for (const id of ids) assert.equal(row(id).status, 'submitted', `#${id}`);
    assert.equal((await call('/listings', owner)).data.rows.find((item) => item.sku === 'RR-S').openChanges, 5, '等亚马逊生效的也算没处理完');
    const attr = changes.shape(row(ids[3]));
    assert.equal(attr.kindLabel, '属性 Material（material）');
    assert.deepEqual(attr.before, []);
    assert.equal(attr.source, 'listing');
    assert.equal(attr.reason, '补描述和材质');
    const actions = db.prepare('SELECT action, actor, detail_json FROM pet_change_log WHERE proposal_id=? ORDER BY id').all(ids[2]);
    assert.deepEqual(actions.map((item) => item.action), ['proposed', 'approved', 'submitted']);
    assert.equal(actions[1].actor, 'user');
    assert.equal(JSON.parse(actions[1].detail_json).via, 'listing');
    // 新尺寸写上去了,亚马逊没返回的字段不用一样
    assert.equal(gateway.state['RR-S'].attributes.item_dimensions[0].length.value, 22);
    assert.equal(gateway.state['RR-S'].attributes.item_name[0].value, 'PawNest Waterproof Dog Bed Small');
  });

  await t.test('the checker marks attribute changes live and the SKU shows its cooldown', async () => {
    // 亚马逊回来的值多了自己的字段,也算生效
    gateway.state['RR-S'].attributes.item_dimensions[0].length.extra = 'x';
    await changes.verifySubmitted({ gateway, env: SP_ENV });
    for (const id of ids) assert.equal(row(id).status, 'applied', `#${id}`);
    const board = await call('/listings', owner);
    const small = board.data.rows.find((item) => item.sku === 'RR-S');
    assert.equal(small.cooldown.daysLeft, 14);
    const detail = await call('/listings/item/RR-S', owner);
    assert.ok(detail.data.cooldown);
  });

  await t.test('attribute changes can be reverted, including deleting a newly added attribute', async () => {
    const revert = changes.revertChange(ids[3], 1);
    const proposal = row(revert.id);
    assert.equal(proposal.kind, 'listing_attribute');
    assert.deepEqual(JSON.parse(proposal.after_json), []);
    changes.approveChanges([revert.id], 1, SP_ENV);
    await changes.kickQueue({ gateway, env: SP_ENV });
    assert.equal(row(revert.id).status, 'submitted');
    const patch = gateway.calls.filter((item) => item.method === 'PATCH' && !item.query.mode).at(-1).body.patches[0];
    assert.equal(patch.op, 'delete');
    assert.equal(patch.path, '/attributes/material');
    assert.equal(gateway.state['RR-S'].attributes.material, undefined);
  });

  await t.test('Claude can read attributes and propose any attribute through the confirm queue', async () => {
    const all = await listings.listingAttributesForAgent({}, deps);
    assert.equal(all.total, 3);
    const small = all.items.find((item) => item.sku === 'RR-S');
    assert.equal(small.attributes.product_description, 'New description');
    assert.equal(small.attributes.number_of_items, undefined, '全店概览只给常用属性');
    const one = await listings.listingAttributesForAgent({ skus: ['rr-s'], live: true, includeSchema: true }, deps);
    assert.equal(one.items[0].attributes.number_of_items, 1);
    assert.equal(one.schemas.PET_BED.material.title, 'Material');
    assert.ok(one.schemas.PET_BED.material.options.includes('Canvas'));
    await assert.rejects(listings.listingAttributesForAgent({ live: true }, deps), /1–10/);
    assert.equal((await listings.listingAttributesForAgent({ style: '没有这个款' }, deps)).total, 0, '款式对不上不能返回全店');

    const proposed = await changes.proposeListingChanges({ title: '材质', changes: [
      { sku: 'RR-M', field: 'attribute', attribute: 'material', value: 'Oxford', reason: '图片 PT01 写的 900D Oxford' },
      { sku: 'RR-M', field: 'attribute', attribute: 'item_name', value: 'x', reason: '走专门字段' },
      { sku: 'RR-M', field: 'attribute', value: 'x', reason: '没属性名' },
    ] }, { userId: 1, gateway, env: SP_ENV });
    assert.equal(proposed.created.length, 1);
    assert.match(proposed.rejected[0].error, /专门的字段/);
    assert.match(proposed.rejected[1].error, /attribute/);
    const queued = row(proposed.created[0].id);
    assert.equal(queued.status, 'pending', 'Claude 提的要店主确认');
    assert.equal(queued.target_key, 'listing:rr-m:listing_attribute:material');
    assert.deepEqual(JSON.parse(queued.after_json), [{ value: 'Oxford', language_tag: 'en_US', marketplace_id: US }]);
    // 确认前可以改值
    const edited = changes.editChange(queued.id, ['Canvas'], 1);
    assert.deepEqual(edited.after, [{ value: 'Canvas', language_tag: 'en_US', marketplace_id: US }]);
  });
});

test('package size helpers convert units and judge standard size', async () => {
  const attrs = await import('../src/listingAttrs.js');
  assert.equal(attrs.toInches(31, 'centimeters'), 12.2);
  assert.equal(attrs.toPounds(1.2, 'kilograms'), 2.65);
  assert.equal(attrs.toInches(1, 'parsecs'), null);
  const blue = attrs.packageVerdict([10.3, 7.5, 12.0], 5);
  assert.deepEqual(blue, { sides: [12, 10.3, 7.5], weight: 5, standard: true, over: [] });
  assert.deepEqual(attrs.packageVerdict([8.5, 11.1, 14.9], 6.13).over, ['最短边 8.5 > 8 英寸']);
  assert.equal(attrs.packageVerdict([1, 2], 1).standard, null);
  const fba = attrs.measuredPackage({ longest: 50, median: 45, shortest: 18.3, dimensionUnit: 'centimeters', weight: 1.13, weightUnit: 'kilograms' }, 'Large Standard-Size');
  assert.deepEqual(fba.sides, [19.69, 17.72, 7.2]);
  assert.equal(fba.standard, false);
  assert.equal(fba.sizeTier, 'Large Standard-Size');
  assert.equal(attrs.packageMismatch({ standard: true }, { standard: false, over: ['x'] }) != null, true);
  assert.equal(attrs.packageMismatch({ standard: true }, { standard: true, over: [] }), null);
});
