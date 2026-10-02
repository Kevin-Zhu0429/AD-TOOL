import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const SP_ENV = { PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret', PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'apetseller' };

function fakeAmazon() {
  const calls = [];
  return { calls, async request(account, region, method, route, { query } = {}) {
    calls.push({ method, route, query });
    assert.equal(account.sellerId, 'APETSELLER');
    if (route.startsWith('/listings/2021-08-01/items/APETSELLER/')) {
      assert.equal(route, '/listings/2021-08-01/items/APETSELLER/DOG-L');
      return { sku: 'DOG-L', summaries: [{ marketplaceId: 'ATVPDKIKX0DER', asin: 'B000000001', productType: 'PET_BED', status: ['BUYABLE', 'DISCOVERABLE'], itemName: 'Dog Bed Large' }],
        attributes: {
          item_name: [{ value: 'Orthopedic Dog Bed Large', language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          bullet_point: [{ value: 'Memory foam', language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }, { value: 'Washable cover', language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          generic_keyword: [{ value: 'calming dog bed', language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          item_package_weight: [{ value: 3.2, unit: 'pounds', marketplace_id: 'ATVPDKIKX0DER' }],
          main_product_image_locator: [{ media_location: 'https://m.media-amazon.com/images/I/main.jpg', marketplace_id: 'ATVPDKIKX0DER' }],
        },
        issues: [{ code: '90220', message: 'missing color', severity: 'WARNING', attributeNames: ['color'] }],
        offers: [{ marketplaceId: 'ATVPDKIKX0DER', offerType: 'B2C', price: { amount: '39.99', currencyCode: 'USD' } }] };
    }
    if (route === '/catalog/2022-04-01/items') {
      return { items: query.identifiers.split(',').map((asin) => ({ asin,
        summaries: [{ marketplaceId: 'ATVPDKIKX0DER', itemName: `Bed ${asin}`, brand: asin === 'B000000001' ? 'PawNest' : 'Rival' }],
        attributes: { bullet_point: [{ value: 'Soft', marketplace_id: 'ATVPDKIKX0DER' }] },
        salesRanks: [{ marketplaceId: 'ATVPDKIKX0DER', classificationRanks: [{ title: 'Dog Beds', rank: 12 }], displayGroupRanks: [{ title: 'Pet Supplies', rank: 900 }] }],
        images: [{ marketplaceId: 'ATVPDKIKX0DER', images: [
          { variant: 'PT01', link: 'https://img/pt01-500.jpg', width: 500, height: 500 },
          { variant: 'MAIN', link: 'https://img/main-75.jpg', width: 75, height: 75 },
          { variant: 'MAIN', link: 'https://img/main-1000.jpg', width: 1000, height: 1000 },
        ] }] })) };
    }
    throw new Error(`unexpected ${route}`);
  } };
}

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-mcp-test-'));
  Object.assign(process.env, { APP_PROFILE: 'pet', DATA_DIR: directory, NODE_ENV: 'test', PET_TODAY: '2026-09-22' });
  const { db } = await import('../src/db.js');
  const { mountMcp } = await import('../src/mcp.js');
  for (const [username, role] of [['owner', 'owner'], ['staff', 'operator']]) {
    db.prepare(`INSERT INTO users (username, display_name, password_hash, role, marketplace) VALUES (?, ?, ?, ?, 'US')`)
      .run(username, username, bcrypt.hashSync('test-password', 4), role);
  }
  const app = express();
  app.use(express.json());
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const gateway = fakeAmazon();
  const download = async (link) => ({ data: Buffer.from(link).toString('base64'), mimeType: 'image/jpeg' });
  mountMcp(app, { publicUrl: url, deps: { gateway, env: SP_ENV, download } });
  return { db, url, gateway, async close() {
    await new Promise((resolve) => server.close(resolve)); db.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

function seed(db) {
  const sku = db.prepare(`INSERT INTO sku_items (user_id, country, brand, sku, asin, stock, transit, style, size, color, dedupe)
    VALUES (-1, 'US', 'PawNest', ?, ?, ?, ?, ?, ?, 'Grey', ?)`);
  sku.run('DOG-L', 'B000000001', 6, 20, '圆窝', 'L', 'us|dog-l');
  sku.run('DOG-XL', 'B000000002', 300, 0, '圆窝', 'XL', 'us|dog-xl');
  sku.run('CAT-S', 'B000000003', 0, 0, '方窝', 'S', 'us|cat-s');
  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  sale.run('2026-09-20', 'DOG-L', 'B000000001', 4, 3, 159.96);
  sale.run('2026-09-21', 'DOG-L', 'B000000001', 3, 3, 119.97);
  sale.run('2026-09-21', 'CAT-S', 'B000000003', 2, 2, 40);
  sale.run('2026-09-10', 'DOG-XL', 'B000000002', 1, 1, 49.99);
  db.prepare("INSERT INTO pet_listing_cache (sku, asin, price, status) VALUES ('DOG-L', 'B000000001', 39.99, 'Active')").run();
  db.prepare("INSERT INTO pet_listing_cache (sku, asin, price, status) VALUES ('DOG-XL', 'B000000002', 19.99, 'Active')").run();
  db.prepare("INSERT INTO pet_sku_costs (sku, fob, first_leg, duty) VALUES ('DOG-L', 12, 1.5, 0.5), ('DOG-XL', 14, 2, 1)").run();
  db.prepare("INSERT INTO pet_sku_fees (sku, fba_fee, referral_fee, referral_rate) VALUES ('DOG-L', 7.25, 6, 0.15), ('DOG-XL', 8, 3, 0.15)").run();
  const report = db.prepare(`INSERT INTO aba_asin_reports (user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash)
    VALUES (-1, 'US', ?, '2026-09-13', '2026-09-19', 38, 'Amazon SP-API', ?)`);
  const query = db.prepare(`INSERT INTO aba_asin_queries (report_id, query, query_volume, market_impressions, market_clicks, market_purchases,
    asin_impressions, asin_clicks, asin_purchases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const one = report.run('B000000001', 'h1').lastInsertRowid;
  const two = report.run('B000000002', 'h2').lastInsertRowid;
  query.run(one, 'dog bed', 1000, 10000, 500, 50, 1000, 50, 5);
  query.run(two, 'dog bed', 1000, 10000, 500, 50, 500, 25, 0);
  query.run(one, 'calming dog bed', 300, 3000, 150, 10, 0, 0, 0);
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const form = (fields) => new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined));

test('Claude connector: OAuth login, read-only tools and token lifecycle', async (t) => {
  const backend = await startServer();
  t.after(() => backend.close());
  seed(backend.db);
  const { url } = backend;
  const post = (route, body, headers = {}) => fetch(url + route, { method: 'POST', redirect: 'manual', headers, body });

  await t.test('unauthenticated calls point Claude to the OAuth metadata', async () => {
    const response = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { 'content-type': 'application/json' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), new RegExp(`resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`));
    const resource = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${url}/mcp`);
    assert.deepEqual(resource.authorization_servers, [`${url}/`]);
    const metadata = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.registration_endpoint, `${url}/register`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  });

  const register = (redirect) => post('/register', JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), { 'content-type': 'application/json' });

  await t.test('only Claude callbacks and loopback redirects can register', async () => {
    assert.equal((await register('https://evil.example/callback')).status, 400);
    assert.equal((await register('http://localhost:33418/callback')).status, 201);
  });

  const client = await (await register(CALLBACK)).json();
  const { verifier, challenge } = pkce();
  const authorize = { response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'xyz', scope: 'pet:read', resource: `${url}/mcp` };
  let code;

  await t.test('login page only lets an active owner authorize', async () => {
    const page = await fetch(`${url}/authorize?${form(authorize)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /登录并授权/);
    assert.match(html, /claude\.ai/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await post('/authorize', form({ ...authorize, username: 'owner', password: 'wrong' }))).status, 401);
    assert.equal((await post('/authorize', form({ ...authorize, username: 'staff', password: 'test-password' }))).status, 403);
    const wrongResource = await post('/authorize', form({ ...authorize, resource: 'https://other.example/mcp', username: 'owner', password: 'test-password' }));
    assert.equal(new URL(wrongResource.headers.get('location')).searchParams.get('error'), 'invalid_target');
    const ok = await post('/authorize', form({ ...authorize, username: 'owner', password: 'test-password' }));
    assert.equal(ok.status, 302);
    const location = new URL(ok.headers.get('location'));
    assert.equal(location.origin + location.pathname, CALLBACK);
    assert.equal(location.searchParams.get('state'), 'xyz');
    code = location.searchParams.get('code');
    assert.ok(code);
  });

  const token = (fields) => post('/token', form({ client_id: client.client_id, ...fields }));
  let tokens;

  await t.test('code exchange checks PKCE and works only once', async () => {
    const bad = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: CALLBACK });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_grant');
    const good = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, resource: `${url}/mcp` });
    assert.equal(good.status, 200);
    tokens = await good.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'pet:read');
    assert.ok(tokens.refresh_token);
    assert.equal((await token({ grant_type: 'authorization_code', code, code_verifier: verifier })).status, 400);
    // 数据库里只有摘要,没有令牌原文
    const stored = backend.db.prepare('SELECT token_hash FROM mcp_oauth_tokens').all().map((row) => row.token_hash);
    assert.ok(!stored.includes(tokens.access_token));
  });

  await t.test('MCP tools read the shop data', async () => {
    const mcp = new Client({ name: 'test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    t.after(() => mcp.close());
    const tools = (await mcp.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_catalog_items', 'get_listing', 'get_product_images', 'get_sales_trend',
      'get_search_terms', 'list_skus', 'store_overview']);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
    const call = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0]?.text);
      return result.content[0].type === 'text' && result.content.length === 1 ? JSON.parse(result.content[0].text) : result.content;
    };

    const overview = await call('store_overview');
    assert.equal(overview.data.today, '2026-09-22');
    assert.equal(overview.catalog.skus, 3);
    assert.deepEqual(overview.last7Days, { from: '2026-09-15', to: '2026-09-21', units: 9, orders: 8, sales: 319.93, previous7DaysUnits: 1, previous7DaysSales: 49.99 });
    assert.deepEqual(overview.alerts.soldOutWithDemand.map((row) => row.sku), ['CAT-S']);
    assert.deepEqual(overview.alerts.under21DaysOfStock.map((row) => row.sku), ['DOG-L']);
    assert.deepEqual(overview.alerts.stockButNoSales7d.map((row) => row.sku), ['DOG-XL']);
    // DOG-XL:19.99 − 17 − 8 − 3.00 = −8.01,每卖一件亏钱;CAT-S 近 7 天有销量但没有成本
    assert.deepEqual(overview.alerts.losingMoneyPerUnit.map((row) => [row.sku, row.profit]), [['DOG-XL', -8.01]]);
    assert.deepEqual(overview.alerts.missingCost, ['CAT-S']);

    const list = await call('list_skus', { style: '圆窝' });
    assert.deepEqual(list.rows.map((row) => row.sku), ['DOG-L', 'DOG-XL']);
    assert.equal(list.rows[0].price, 39.99);
    assert.equal(list.rows[0].sales7d, 7);
    assert.equal(list.rows[0].stockDays, 6);
    assert.deepEqual([list.rows[0].landedCost, list.rows[0].fbaFee, list.rows[0].profit, list.rows[0].margin], [14, 7.25, 12.74, 31.86]);
    assert.deepEqual((await call('list_skus', { sortBy: 'profit' })).rows.map((row) => row.sku), ['DOG-XL', 'DOG-L', 'CAT-S']);

    const trend = await call('get_sales_trend', { asin: 'B000000001', from: '2026-09-01', groupBy: 'week' });
    // 9/20 是周日,算 9/14 那周;9/21 是周一,新的一周
    assert.deepEqual(trend.series, [{ period: '2026-09-14', units: 4, orders: 3, sales: 159.96, estimatedSales: 0 },
      { period: '2026-09-21', units: 3, orders: 3, sales: 119.97, estimatedSales: 0 }]);
    assert.deepEqual(trend.total, { units: 7, orders: 6, sales: 279.93 });
    assert.deepEqual(trend.matchedSkus, ['DOG-L']);

    const terms = await call('get_search_terms');
    const dogBed = terms.rows.find((row) => row.query === 'dog bed');
    // 两个 ASIN 同一周同一个词:市场数据只算一次,ASIN 数据相加
    assert.equal(dogBed.query_volume, 1000);
    assert.equal(dogBed.market_impressions, 10000);
    assert.equal(dogBed.asin_impressions, 1500);
    assert.equal(dogBed.impression_share, 15);
    assert.deepEqual(dogBed.asins, ['B000000001', 'B000000002']);
    const one = await call('get_search_terms', { asin: 'B000000001', sortBy: 'purchase_share' });
    assert.equal(one.rows[0].query, 'dog bed');
    assert.equal(one.rows[0].purchase_share, 10);

    const listing = await call('get_listing', { asin: 'b000000001' });
    assert.equal(listing.title, 'Orthopedic Dog Bed Large');
    assert.deepEqual(listing.bulletPoints, ['Memory foam', 'Washable cover']);
    assert.deepEqual(listing.backendSearchTerms, ['calming dog bed']);
    assert.equal(listing.attributes.item_package_weight, '3.2 pounds');
    assert.equal(listing.attributes.main_product_image_locator, undefined);
    assert.deepEqual(listing.images, [{ slot: 'main', url: 'https://m.media-amazon.com/images/I/main.jpg' }]);
    assert.equal(listing.issues[0].message, 'missing color');

    const catalog = await call('get_catalog_items', { asins: ['B000000001', 'B0RIVAL001'] });
    assert.deepEqual(catalog.items.map((item) => [item.asin, item.ownProduct]), [['B000000001', true], ['B0RIVAL001', false]]);
    assert.deepEqual(catalog.items[1].images.map((image) => image.url), ['https://img/main-1000.jpg', 'https://img/pt01-500.jpg']);
    assert.deepEqual(catalog.items[1].salesRanks, [{ category: 'Dog Beds', rank: 12 }, { category: 'Pet Supplies', rank: 900 }]);

    const images = await call('get_product_images', { asin: 'B0RIVAL001', limit: 1 });
    assert.equal(images.filter((block) => block.type === 'image').length, 1);
    assert.equal(Buffer.from(images.find((block) => block.type === 'image').data, 'base64').toString(), 'https://img/main-1000.jpg');

    const failed = await mcp.callTool({ name: 'get_listing', arguments: {} });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /sku 或 asin/);
  });

  await t.test('refresh tokens rotate; disabling the owner cuts access', async () => {
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status, 400);
    const list = () => post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${next.access_token}` });
    assert.equal((await list()).status, 200);
    backend.db.prepare("UPDATE users SET is_active=0 WHERE username='owner'").run();
    assert.equal((await list()).status, 401);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status, 400);
  });
});
