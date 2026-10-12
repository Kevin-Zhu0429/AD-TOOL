import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('a queued read task is dropped when its request is cancelled', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-pool-test-'));
  process.env.DATA_DIR = directory;
  process.env.WORKER_POOL_SIZE = '1';
  const { db } = await import('../src/db.js');
  const { runTask, closeWorkerPool } = await import('../src/workers/pool.js');
  t.after(async () => {
    await closeWorkerPool();
    db.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('adtool-pool-test-')) throw new Error('Unexpected test directory');
    await rm(resolved, { recursive: true, force: true });
  });

  // 唯一的线程先被第一条任务占住,第二条只能排队
  const first = runTask('productsList', { marketplace: 'ES', requestedMonth: '' });
  const controller = new AbortController();
  const second = runTask('productsList', { marketplace: 'ES', requestedMonth: '' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, (error) => error.cancelled === true);
  assert.equal(typeof await first, 'string', 'the running task still finishes');
  // 取消之后线程还能接着干活
  assert.equal(typeof await runTask('productsList', { marketplace: 'ES', requestedMonth: '' }), 'string');
});
