import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAgedFeeRows } from './agedStorageUpload.js';
import { api } from './api.js';

test('大量库存行拆成远小于 1 MB 的连续请求', () => {
  const rows = Array.from({ length: 1200 }, (_, index) => ({ 市场代码: 'CY_UK', SKU: `SKU-${index}`, '7日均销量': 1,
    '14日均销量': 0, '0-30': 1, '31-60': 1, '61-90': 1, '91-180': 1,
    '181-270': 1, '271-365': 1, '366-455': 1, '>456': 1 }));
  const chunks = splitAgedFeeRows(rows);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.rows), rows);
  chunks.forEach((chunk, index) => {
    assert.ok(chunk.rows.length <= 150);
    assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length <= 128 * 1024);
    if (index) assert.equal(chunk.offset, chunks[index - 1].offset + chunks[index - 1].rows.length);
  });
});

test('旧版后端没有分片接口时回退到原导入接口', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (path) => {
    paths.push(path);
    return new Response(path.endsWith('/start') ? '{}' : JSON.stringify({ batch: { rowCount: 1 }, rows: [] }),
      { status: path.endsWith('/start') ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await api.importAgedFees([{ 市场代码: 'CY_UK', SKU: 'SKU' }], '2026-09-24', 'uniform', '库存.xlsx');
    assert.equal(result.batch.rowCount, 1);
    assert.deepEqual(paths, ['/api/aged-fees/import/start', '/api/aged-fees/import']);
  } finally { globalThis.fetch = originalFetch; }
});
