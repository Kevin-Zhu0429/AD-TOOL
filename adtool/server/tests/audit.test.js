import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';

test('only owner can read per-account 7/30-day audit statistics', async (t) => {
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

  assert.equal((await call('/auth/audit', operator)).status, 403);
  assert.equal((await call('/auth/audit/events', operator, 'POST', {
    module: 'builder', action: 'export', marketplace: 'ES', detail: { campaigns: 3 },
  })).status, 200);
  assert.equal((await call('/auth/audit/events', operator, 'POST', {
    module: 'builder', action: 'invented', marketplace: 'ES', detail: {},
  })).status, 400);
  assert.equal((await call('/auth/audit/events', operator, 'POST', {
    module: 'builder', action: 'open', marketplace: 'DE', detail: {},
  })).status, 403);

  const operatorId = server.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get().id;
  server.db.prepare(
    `INSERT INTO audit_log (user_id, marketplace, action, entity, created_at)
     VALUES (?, 'ES', 'update', 'lib_items', datetime('now', 'localtime', '-10 days'))`
  ).run(operatorId);
  server.db.prepare(
    `INSERT INTO audit_log (user_id, marketplace, action, entity, created_at)
     VALUES (?, 'ES', 'update', 'lib_items', datetime('now', 'localtime', '-40 days'))`
  ).run(operatorId);

  const result = await call('/auth/audit', owner);
  assert.equal(result.status, 200);
  const operatorStats = result.data.stats.find((row) => row.username === 'aba-test');
  assert.ok(operatorStats.seven_day >= 2, 'login and export are both included in 7-day count');
  assert.equal(operatorStats.thirty_day, operatorStats.seven_day + 1);
  assert.ok(result.data.logs.some((row) => row.entity === 'module_builder' && row.action === 'export'));
});
