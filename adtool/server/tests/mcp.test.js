import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import * as XLSX from 'xlsx';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startAbaTestServer } from './abaHarness.js';
import { firstFile } from './abaFixture.js';
import { asinFirst, mergedFixture } from './abaAsinFixture.js';
import { HEADERS, C } from '../../shared/adEngine.js';

const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const form = (value) => new URLSearchParams(value).toString();
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return {
  verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

test('ink MCP: OAuth, permissions, business tools and exports', async (t) => {
  const backend = await startAbaTestServer();
  const { mountMcp, mcpUrls } = await import('../src/mcp.js');
  const { invokeApi } = await import('../src/mcpApi.js');
  const ownerId = backend.db.prepare("SELECT id FROM users WHERE username='aba-other'").get().id;
  const staffId = backend.db.prepare("SELECT id FROM users WHERE username='aba-test'").get().id;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const listener = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${listener.address().port}`;
  mountMcp(app, { publicUrl: url });
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.close()));
    await new Promise((resolve) => listener.close(resolve)); await backend.close(); });
  const post = (path, body, headers = {}) => fetch(url + path, { method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, redirect: 'manual' });
  const register = (callback = CALLBACK) => post('/register', JSON.stringify({ client_name: 'Ink MCP Test', redirect_uris: [callback],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), { 'content-type': 'application/json' });
  const registration = await register();
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const authorize = (proof, scopes = 'ink:read') => ({ response_type: 'code', client_id: client.client_id,
    redirect_uri: CALLBACK, code_challenge: proof.challenge, code_challenge_method: 'S256', state: 'ink-state', scope: scopes, resource: url + '/mcp' });
  const exchange = (fields) => post('/token', form({ client_id: client.client_id, ...fields }));
  async function grant(username, scopes) {
    const proof = pkce();
    const response = await post('/authorize', form({ ...authorize(proof, scopes), username, password: 'local-test-password' }));
    assert.equal(response.status, 302, await response.text());
    const callback = new URL(response.headers.get('location'));
    assert.equal(callback.searchParams.get('iss'), url + '/');
    assert.equal(callback.searchParams.get('state'), 'ink-state');
    const token = await exchange({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: proof.verifier, redirect_uri: CALLBACK, resource: url + '/mcp' });
    assert.equal(token.status, 200, await token.clone().text());
    return token.json();
  }
  async function connect(token) {
    const c = new Client({ name: 'ink-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    clients.push(c); return c;
  }
  const call = async (c, name, args = {}) => {
    const result = await c.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${result.content[0]?.text}`);
    return JSON.parse(result.content[0].text);
  };
  const fail = async (c, name, args, message) => {
    const result = await c.callTool({ name, arguments: args }); assert.equal(result.isError, true);
    if (message) assert.match(result.content[0].text, message);
  };
  await t.test('discovery, exact callback allowlist, origin and URL validation', async () => {
    for (const bad of ['http://evil.example/cb', CALLBACK + '/evil', 'https://chatgpt.com/evil']) assert.equal((await register(bad)).status, 400);
    assert.equal((await register('http://127.0.0.1:12345/cb')).status, 201);
    assert.equal((await fetch(url + '/.well-known/oauth-authorization-server')).status, 200);
    const metadata = await (await fetch(url + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(metadata.resource, url + '/mcp');
    assert.deepEqual(metadata.scopes_supported, ['ink:read', 'ink:write']);
    const denied = await post('/mcp', '{}', { 'content-type': 'application/json' });
    assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /resource_metadata/);
    assert.equal((await post('/mcp', '{}', { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.throws(() => mcpUrls('http://evil.example')); assert.throws(() => mcpUrls('ftp://localhost'));
    const disabled = express(); mountMcp(disabled, { publicUrl: '' });
    const s = disabled.listen(0, '127.0.0.1'); await new Promise((r) => s.once('listening', r));
    assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/mcp`)).status, 503);
    await new Promise((r) => s.close(r));
  });
  await t.test('PKCE, one-time codes and truthful authorization page', async () => {
    const proof = pkce(), params = authorize(proof, 'ink:read ink:write');
    const page = await fetch(url + '/authorize?' + form(params));
    assert.equal(page.status, 200); assert.match(await page.text(), /读写授权/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await post('/authorize', form({ ...params, username: 'aba-test', password: 'bad' }))).status, 401);
    const response = await post('/authorize', form({ ...params, username: 'aba-test', password: 'local-test-password' }));
    const code = new URL(response.headers.get('location')).searchParams.get('code');
    assert.equal((await exchange({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: CALLBACK })).status, 400);
    assert.equal((await exchange({ grant_type: 'authorization_code', code, code_verifier: proof.verifier, redirect_uri: CALLBACK })).status, 200);
    assert.equal((await exchange({ grant_type: 'authorization_code', code, code_verifier: proof.verifier, redirect_uri: CALLBACK })).status, 400);
  });
  const readTokens = await grant('aba-test', 'ink:read');
  const staffTokens = await grant('aba-test', 'ink:read ink:write');
  const ownerTokens = await grant('aba-other', 'ink:read ink:write');
  const reader = await connect(readTokens.access_token), staff = await connect(staffTokens.access_token), owner = await connect(ownerTokens.access_token);
  await t.test('tools discover, inputs validate and read scopes cannot write', async () => {
    const tools = (await owner.listTools()).tools;
    assert.ok(tools.length >= 45); assert.equal(new Set(tools.map((x) => x.name)).size, tools.length);
    t.diagnostic(`Discovered ${tools.length} ink MCP tools`);
    assert.ok(tools.every((x) => x.description && x.inputSchema.type === 'object' && x.annotations));
    assert.equal(tools.find((x) => x.name === 'delete_user').annotations.destructiveHint, true);
    assert.equal(tools.find((x) => x.name === 'generate_auto_ads').annotations.readOnlyHint, true);
    assert.equal((await call(reader, 'workspace_overview')).user.id, staffId);
    await fail(reader, 'import_skus', { rows: [{ country: 'ES', sku: 'NO-WRITE' }] }, /ink:write/);
    await fail(staff, 'get_negative_library', { marketplace: 'DE' }, /无权/);
    await fail(staff, 'list_users', {}, /权限/);
    await fail(staff, 'list_skus', { marketplace: 'INVALID' });
  });
  await t.test('SKU CRUD, pagination, ownership and library permissions', async () => {
    await call(staff, 'import_skus', { rows: [{ country: 'ES', sku: 'INK-305', model: '305XL', stock: 8, asin: 'B000000305' }, { country: 'ES', sku: 'OTHER', model: '302', stock: 0 }] });
    const list = await call(staff, 'list_skus', { marketplace: 'ES', limit: 1 });
    assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.equal(list.nextOffset, 1);
    const all = await call(owner, 'list_skus', { marketplace: 'ES', scope: 'all' });
    assert.equal(all.total, 2);
    assert.equal((await call(owner, 'list_skus')).total, 0);
    const ink = (await call(staff, 'list_skus', { q: 'INK-305' })).items[0];
    await fail(owner, 'update_sku', { id: ink.id, stock: 9 }, /别人/);
    await call(staff, 'update_sku', { id: ink.id, stock: 10 });
    assert.equal((await call(staff, 'list_skus', { q: 'INK-305' })).items[0].stock, 10);
    await call(staff, 'import_negative_library', { marketplace: 'ES', lib: 'A', rows: [{ term: 'unwanted' }] });
    await fail(staff, 'import_negative_library', { marketplace: 'ES', lib: 'B', rows: [{ brand: 'wrong' }] }, /商品部/);
    assert.equal((await call(staff, 'get_negative_library', { marketplace: 'ES', lib: 'A' })).items.A.length, 1);
    await call(staff, 'configure_negative_library', { marketplace: 'ES', lib: 'A', enabled: false });
    assert.ok((await call(staff, 'list_cartridge_series', { marketplace: 'ES' })).groups.length > 0);
    const neg = await call(staff, 'plan_negatives', { marketplace: 'ES', adType: 'series', seriesModels: ['305'] });
    assert.ok(neg.negs.length > 0);
  });
  await t.test('portfolios match account SKUs and do not cross accounts', async () => {
    await call(staff, 'import_portfolios', { marketplace: 'ES', rows: [{ portfolioId: '123', name: '305 Series' }] });
    assert.equal((await call(staff, 'match_portfolio', { marketplace: 'ES', skus: 'INK-305' })).portfolioId, '123');
    assert.equal((await call(owner, 'list_portfolios', { marketplace: 'ES' })).total, 0);
  });
  await t.test('product tools enforce feature rights and keep analysis calculations', async () => {
    await fail(staff, 'list_products', { marketplace: 'ES' }, /权限|开通/);
    await call(owner, 'import_products', { marketplace: 'ES', dataMonth: '2026-10', products: [
      { asin: 'B000000001', model: '305', brand: 'Mine', price: 10, rating: 4.8 },
      { asin: 'B000000002', model: '305', brand: 'Rival', price: 15, rating: 4.1, child_sales: 200 }] });
    await call(owner, 'configure_product_intel', { marketplace: 'ES', ownBrand: 'Mine', minSales: 100 });
    const analysis = await call(owner, 'analyze_competitors', { marketplace: 'ES', model: '305' });
    assert.equal(analysis.stats.average, 12.5); assert.equal(analysis.opportunities[0].competitors[0].asin, 'B000000002');
    assert.equal((await call(owner, 'list_products', { marketplace: 'ES', limit: 1 })).products.length, 1);
    const multi = await call(owner, 'import_products_all_markets', { dataMonth: '2026-10', productsByMarketplace: {
      DE: [{ asin: 'B000000003', model: '305', brand: 'Mine', price: 11 }] } });
    assert.equal(multi.totals.added, 1);
  });
  await t.test('private ABA data, reports and worker reads match website routes', async () => {
    await call(staff, 'import_aba_brand', { marketplace: 'ES', files: [firstFile] });
    await call(staff, 'import_aba_asin', { marketplace: 'ES', files: [asinFirst] });
    const merged = mergedFixture(); merged.sheets[0].name = 'data';
    await call(staff, 'import_aba_asin', { marketplace: 'ES', files: [merged] });
    const result = await call(staff, 'get_aba_brand', { marketplace: 'ES', query: { q: '305', wordType: 'printer' } });
    const website = await invokeApi(staffId, 'GET', '/api/aba', { marketplace: 'ES', q: '305', wordType: 'printer' });
    assert.deepEqual(result, website);
    assert.equal((await call(owner, 'get_aba_brand', { marketplace: 'ES' })).reports.length, 0);
    assert.equal((await call(staff, 'get_aba_asin', { marketplace: 'ES' })).reports.length, 2);
    assert.equal((await call(owner, 'get_aba_asin', { marketplace: 'ES' })).reports.length, 0);
    assert.equal((await call(staff, 'get_public_aba', { marketplace: 'DE' })).total, 0);
    await call(reader, 'get_public_aba_sync_status'); await call(reader, 'get_inventory_status');
  });
  let generated;
  await t.test('auto/manual generation self-checks and XLSX output round-trip', async () => {
    generated = await call(staff, 'generate_auto_ads', { marketplace: 'ES', tasks: [{ skus: 'INK-305' }] });
    assert.deepEqual(generated.headers, HEADERS); assert.ok(generated.rows.length > 0);
    assert.equal(generated.rows[0][C.PORT], '123');
    await fail(staff, 'generate_auto_ads', { marketplace: 'ES', tasks: [{ skus: 'UNKNOWN' }] }, /SKU/);
    const manualArgs = { marketplace: 'ES', tasks: [{ skus: 'INK-305', camp: 'Manual-305', kw: { 精准: { on: true, text: 'hp 305' } } }] };
    await fail(staff, 'generate_manual_ads', manualArgs, /手动广告/);
    backend.db.prepare('UPDATE users SET manual_ads=1,ad_opt=1 WHERE id=?').run(staffId);
    const templates = await call(staff, 'get_ad_templates'); assert.deepEqual(templates.headers, HEADERS);
    const bid = await call(staff, 'calculate_ad_bid', { targetCpc: 0.36, strategy: 'updown', places: { TOS: 100, ROS: 0, PP: 0 } });
    assert.equal(bid.bid, 0.09);
    const drift = await call(staff, 'check_model_drift', { marketplace: 'ES', skus: ['INK-305'], searchTerms: ['hp deskjet 2820e', 'canon TS305'] });
    assert.equal(drift.items[0].status, 'matched'); assert.equal(drift.items[1].status, 'drift');
    const file = await call(staff, 'generate_manual_ads', { ...manualArgs, format: 'xlsx' });
    const wb = XLSX.read(Buffer.from(file.base64, 'base64'), { type: 'buffer' });
    const table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    assert.deepEqual(table[0], HEADERS); assert.ok(table.some((r) => r[C.KWTEXT] === '[hp 305]'));
    const triple = await call(staff, 'generate_manual_ads', { ...manualArgs, tasks: [{ ...manualArgs.tasks[0],
      kwTriple: true, kwShared: 'hp 305', kw: { 精准: { on: true }, 词组: { on: true }, 广泛: { on: true } } }] });
    assert.deepEqual(triple.rows.filter((r) => r[C.KWTEXT]).map((r) => r[C.KWTEXT]), ['[hp 305]', '"hp 305"', 'hp 305']);
    await fail(staff, 'generate_manual_ads', { ...manualArgs, tasks: [{ ...manualArgs.tasks[0], date: '20260230' }] }, /日期/);
  });
  await t.test('optimization exports include headers, only changed rows and valid entity fields', async () => {
    const input = { marketplace: 'ES', headers: generated.headers, rows: generated.rows };
    const analysis = await call(staff, 'analyze_ad_bulk', input);
    assert.equal(analysis.total, 1);
    for (const view of ['skus', 'targets', 'placements', 'portfolios']) {
      assert.ok((await call(staff, 'analyze_ad_bulk', { ...input, view })).total > 0);
    }
    const exported = await call(staff, 'export_ad_changes', { ...input, edits: [{ rowIndex: 0, field: 'dailyBudget', value: 2 }] });
    assert.deepEqual(exported.headers, HEADERS); assert.equal(exported.rowCount, 1);
    assert.equal(exported.rows[0][C.BUDGET], 2); assert.equal(exported.rows[0][C.OP], '更新');
    await fail(staff, 'export_ad_changes', { ...input, edits: [{ rowIndex: 0, field: 'dailyBudget', value: 0.1 }] }, /预算/);
    await fail(staff, 'export_ad_changes', { ...input, edits: [{ rowIndex: 0, field: 'bid', value: 2 }] }, /实体/);
    await fail(staff, 'export_ad_changes', { ...input, edits: [{ rowIndex: 0, field: 'state', value: 'nonsense' }] }, /状态/);
    const paused = await call(staff, 'export_ad_changes', { ...input, edits: [{ rowIndex: 0, field: 'state', value: 'paused' }] });
    assert.equal(paused.rows[0][C.STATUS], '已暂停');
  });
  await t.test('fees, permissions change immediately, logs and hashed tokens', async () => {
    const fees = await call(reader, 'calculate_aged_storage_fee', { marketplace: 'ES', buckets: [0, 0, 0, 0, 10, 0, 0, 0], dailySales: 1, date: '2026-10-12' });
    assert.ok(fees.result); await call(reader, 'get_aged_storage_fees');
    await call(owner, 'get_audit_log');
    assert.ok(backend.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='mcp_call'").get().n > 0);
    assert.ok(!backend.db.prepare('SELECT token_hash FROM mcp_oauth_tokens').all().some((r) => r.token_hash === staffTokens.access_token));
    backend.db.prepare('UPDATE users SET marketplace=? WHERE id=?').run('DE', staffId);
    await fail(staff, 'get_aba_brand', { marketplace: 'ES' }, /无权/);
    backend.db.prepare('UPDATE users SET marketplace=? WHERE id=?').run('ES', staffId);
  });
  await t.test('remaining CRUD tools update and delete the intended records', async () => {
    const sku = (await call(staff, 'list_skus', { q: 'OTHER' })).items[0];
    await call(staff, 'delete_skus', { ids: [sku.id] });
    assert.equal((await call(staff, 'list_skus', { q: 'OTHER' })).total, 0);
    const portfolio = (await call(staff, 'list_portfolios', { marketplace: 'ES' })).items[0];
    await call(staff, 'update_portfolio', { id: portfolio.id, name: 'Updated 305 Series' });
    await call(staff, 'delete_portfolios', { ids: [portfolio.id] });
    assert.equal((await call(staff, 'list_portfolios', { marketplace: 'ES' })).total, 0);
    const entry = (await call(staff, 'get_negative_library', { marketplace: 'ES', lib: 'A' })).items.A[0];
    await call(staff, 'update_negative_entry', { id: entry.id, term: 'updated negative' });
    await call(staff, 'delete_negative_entries', { ids: [entry.id] });
    assert.equal((await call(staff, 'get_negative_library', { marketplace: 'ES', lib: 'A' })).items.A.length, 0);
    await call(owner, 'update_product', { marketplace: 'ES', asin: 'B000000001', dataMonth: '2026-10', changes: { brand: 'UpdatedBrand' } });
    assert.equal((await call(owner, 'list_products', { marketplace: 'ES', q: 'B000000001' })).products[0].brand, 'UpdatedBrand');
    await call(owner, 'delete_products', { marketplace: 'ES', asins: ['B000000001'] });
    await call(owner, 'delete_product_month', { marketplace: 'DE', dataMonth: '2026-10' });
    assert.equal((await call(owner, 'list_products', { marketplace: 'DE' })).total, 0);
    const created = await call(owner, 'create_user', { username: 'mcp-created', displayName: '测试', password: 'test-password', role: 'operator', markets: ['ES'] });
    await call(owner, 'update_user', { id: created.id, displayName: '已修改', manualAds: true });
    assert.equal((await call(owner, 'list_users')).users.find((u) => u.id === created.id).display_name, '已修改');
    await fail(owner, 'delete_user', { id: ownerId }, /不能删除/);
    await call(owner, 'delete_user', { id: created.id });
    assert.ok(!(await call(owner, 'list_users')).users.some((u) => u.id === created.id));
  });
  await t.test('inventory binding tools use website ownership and owner gates', async () => {
    await call(staff, 'update_sku', { id: (await call(staff, 'list_skus')).items[0].id, brand: 'CY' });
    const bound = await call(owner, 'save_inventory_bindings', { brand: 'CY', groupName: 'CY_EU', groupKey: 'cy_eu:EU', scope: 'EU',
      channels: [{ country: 'ES', openChannelId: 'spapi:SELLER:A1RKKUPIHCS9HS', channelName: 'CY_ES' }], assignments: [{ country: 'ES', userId: staffId }] });
    const admin = await call(owner, 'get_inventory_admin');
    await call(owner, 'update_inventory_assignment', { id: admin.assignments[0].id, enabled: false });
    await call(owner, 'update_inventory_binding', { id: bound.ids[0], enabled: false });
    await call(staff, 'get_inventory_sync'); await call(owner, 'get_inventory_sync_all');
    await fail(staff, 'get_inventory_admin', {}, /权限/);
    await fail(staff, 'discover_amazon_shops', {}, /权限/);
    await fail(staff, 'sync_inventory_all', {}, /权限/);
    await fail(staff, 'sync_public_aba', {}, /权限/);
  });
  await t.test('shared fee import and revision conflicts work through MCP', async () => {
    const inventory = { 市场代码: 'CY_ES', SKU: 'FEE-SKU', '7日均销量': 1, '14日均销量': 1,
      ...Object.fromEntries(['0-30', '31-60', '61-90', '91-180', '181-270', '271-365', '366-455', '>456'].map((bucket) => [bucket, bucket === '>456' ? 10 : 0])) };
    await call(staff, 'import_aged_inventory', { date: '2026-10-12', rows: [inventory] });
    const record = (await call(reader, 'get_aged_storage_fees')).rows[0];
    await call(staff, 'correct_aged_sales', { id: record.id, special: true, value: 2, reason: '促销', revision: 0 });
    await fail(owner, 'correct_aged_sales', { id: record.id, special: true, value: 3, reason: '', revision: 0 }, /已被其他/);
    assert.equal((await call(owner, 'get_aged_storage_fees')).rows[0].correction.revision, 1);
  });
  await t.test('refresh rotates and account deactivation invalidates access and refresh', async () => {
    const escalated = await exchange({ grant_type: 'refresh_token', refresh_token: readTokens.refresh_token, scope: 'ink:read ink:write' });
    assert.equal(escalated.status, 400); assert.equal((await escalated.json()).error, 'invalid_scope');
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: readTokens.refresh_token });
    assert.equal(refreshed.status, 200); const next = await refreshed.json();
    assert.equal(next.scope, 'ink:read'); assert.notEqual(next.refresh_token, readTokens.refresh_token);
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: readTokens.refresh_token })).status, 400);
    backend.db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(staffId);
    const denied = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + next.access_token });
    assert.equal(denied.status, 401);
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status, 400);
  });
});
