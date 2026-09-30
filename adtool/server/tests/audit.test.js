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

  // 明细按 id 倒序分页,账号和时间在服务端筛
  server.db.transaction(() => {
    const insert = server.db.prepare(
      "INSERT INTO audit_log (user_id, marketplace, action, entity) VALUES (?, 'ES', 'update', 'paging')"
    );
    for (let i = 0; i < 150; i += 1) insert.run(operatorId);
  })();
  const first = await call(`/auth/audit?userId=${operatorId}&days=7`, owner);
  assert.equal(first.data.logs.length, 100);
  assert.ok(first.data.logs.every((row) => row.user_id === operatorId));
  assert.ok(first.data.nextBefore);
  const second = await call(`/auth/audit/logs?userId=${operatorId}&days=7&before=${first.data.nextBefore}`, owner);
  assert.equal(second.status, 200);
  assert.ok(second.data.logs.every((row) => row.id < first.data.nextBefore));
  const seen = [...first.data.logs, ...second.data.logs].map((row) => row.id);
  assert.equal(new Set(seen).size, seen.length, 'pages do not overlap');
  const operatorRecent = server.db.prepare(
    "SELECT count(*) AS n FROM audit_log WHERE user_id = ? AND created_at >= datetime('now', 'localtime', '-7 days')"
  ).get(operatorId).n;
  assert.equal(seen.length, operatorRecent);
  assert.equal(second.data.nextBefore, null);
  const everything = await call(`/auth/audit/logs?userId=${operatorId}&days=all&limit=500`, owner);
  assert.ok(everything.data.logs.some((row) => row.created_at < first.data.logs.at(-1).created_at && row.entity === 'lib_items'),
    'days=all includes the 40-day-old row');
  assert.equal((await call('/auth/audit/logs', operator)).status, 403);
});
