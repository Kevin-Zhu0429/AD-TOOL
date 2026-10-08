import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('owner can downgrade and permanently delete another account without rewriting shared history', async (t) => {
  const server = await startAbaTestServer();
  t.after(() => server.close());

  async function call(route, cookie = '', method = 'GET', body) {
    const response = await fetch(server.url + '/api' + route, {
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

  const operator = await login('aba-test');
  const owner = await login('aba-other');
  const operatorId = server.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get().id;
  const ownerId = server.db.prepare("SELECT id FROM users WHERE username = 'aba-other'").get().id;

  assert.equal((await call(`/auth/users/${operatorId}`, operator, 'DELETE')).status, 403);
  assert.equal((await call(`/auth/users/${ownerId}`, owner, 'DELETE')).status, 400);

  const downgradeId = server.db.prepare("SELECT id FROM users WHERE username = 'aba-de'").get().id;
  await call(`/auth/users/${downgradeId}`, owner, 'PATCH', { role: 'owner' });
  const missingMarkets = await call(`/auth/users/${downgradeId}`, owner, 'PATCH', { role: 'admin' });
  assert.equal(missingMarkets.status, 400);
  assert.match(missingMarkets.data.error, /同时指定负责的站点/);
  const savedDowngrade = await call(`/auth/users/${downgradeId}`, owner, 'PATCH', {
    role: 'admin', markets: ['DE', 'FR'],
  });
  assert.equal(savedDowngrade.status, 200);
  assert.deepEqual(
    server.db.prepare('SELECT role, marketplace FROM users WHERE id = ?').get(downgradeId),
    { role: 'admin', marketplace: 'DE,FR' },
  );

  server.db.prepare("INSERT INTO sku_items (user_id, country, sku, dedupe) VALUES (?, 'ES', 'DELETE-ME', 'ES|delete-me')").run(operatorId);
  server.db.prepare("INSERT INTO portfolio_items (user_id, marketplace, portfolio_id, name) VALUES (?, 'ES', 'P-DELETE', 'Delete me')").run(operatorId);
  server.db.prepare("INSERT INTO aba_reports (user_id, marketplace, brand, week_start, week_end, week_number, source_file, content_hash) VALUES (?, 'ES', 'HP', '2026-09-07', '2026-09-13', 37, 'delete.csv', 'delete-hash')").run(operatorId);
  server.db.prepare("INSERT INTO lib_items (lib, scope, term, dedupe, created_by) VALUES ('A', 'ES', 'shared-history', 'shared-history', ?)").run(operatorId);
  server.db.prepare("INSERT INTO products (marketplace, data_month, asin, data_json, created_by) VALUES ('ES', '2026-09', 'B000DELETE', '{}', ?)").run(operatorId);
  server.db.prepare("INSERT INTO captain_channel_groups (group_key, group_name, scope, brand, brand_key) VALUES ('unrelated-empty', 'Unrelated', 'ES', 'HP', 'hp')").run();
  server.db.prepare("INSERT INTO captain_channel_groups (group_key, group_name, scope, brand, brand_key) VALUES ('shared-group', 'Shared', 'EU', 'HP', 'hp')").run();
  server.db.prepare("INSERT INTO captain_channel_bindings (user_id, brand, brand_key, country, open_channel_id, channel_name) VALUES (?, 'HP', 'hp', 'ES', 'shared-source', 'HP_EU_ES')").run(operatorId);
  server.db.prepare("INSERT INTO captain_channel_group_members (group_key, open_channel_id) VALUES ('shared-group', 'shared-source')").run();
  server.db.prepare("INSERT INTO captain_channel_assignments (group_key, country, user_id) VALUES ('shared-group', 'ES', ?)").run(operatorId);
  server.db.prepare("INSERT INTO captain_channel_assignments (group_key, country, user_id) VALUES ('shared-group', 'DE', ?)").run(downgradeId);

  const deleted = await call(`/auth/users/${operatorId}`, owner, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(server.db.prepare('SELECT 1 FROM users WHERE id = ?').get(operatorId), undefined);
  assert.equal(server.db.prepare('SELECT 1 FROM sku_items WHERE user_id = ?').get(operatorId), undefined);
  assert.equal(server.db.prepare('SELECT 1 FROM portfolio_items WHERE user_id = ?').get(operatorId), undefined);
  assert.equal(server.db.prepare('SELECT 1 FROM aba_reports WHERE user_id = ?').get(operatorId), undefined);
  assert.equal(server.db.prepare("SELECT created_by FROM lib_items WHERE term = 'shared-history'").get().created_by, null);
  assert.equal(server.db.prepare("SELECT created_by FROM products WHERE asin = 'B000DELETE'").get().created_by, null);
  assert.ok(server.db.prepare("SELECT 1 FROM captain_channel_groups WHERE group_key = 'unrelated-empty'").get());
  assert.equal(server.db.prepare("SELECT user_id FROM captain_channel_bindings WHERE open_channel_id = 'shared-source'").get().user_id, downgradeId);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM captain_channel_assignments WHERE group_key = 'shared-group'").get().count, 1);
  assert.ok(server.db.prepare("SELECT 1 FROM audit_log WHERE action = 'delete' AND entity = 'user' AND entity_id = ?").get(operatorId));
  assert.ok(server.db.prepare('SELECT 1 FROM audit_log WHERE user_id IS NULL').get(), 'deleted account history remains anonymized');
  assert.equal((await call('/auth/me', operator)).data.user, null);
  assert.equal((await call('/auth/users/999999', owner, 'DELETE')).status, 404);
});
