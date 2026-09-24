import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

test('live API reads bypass cached responses without changing write URLs', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { status: 200 });
  });

  await api.me();
  await api.me();
  await api.library('ES');
  await api.updateUser(7, { manualAds: true });

  assert.notEqual(calls[0].url, calls[1].url);
  for (const call of calls.slice(0, 3)) {
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.credentials, 'include');
    assert.match(call.url, /[?&]_=/);
  }
  assert.match(calls[2].url, /^\/api\/neg\?marketplace=ES&_=/);
  assert.equal(calls[3].url, '/api/auth/users/7');
  assert.equal(calls[3].options.method, 'PATCH');
});
