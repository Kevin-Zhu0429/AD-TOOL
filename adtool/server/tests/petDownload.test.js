import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { streamReportDocument, downloadTiming } from '../src/petAmazon.js';

/** 假的 S3:支持 Range;旧 token 的链接已过期(403);第 3 段第一次故意断开 */
async function fakeS3(body, { ranges = true } = {}) {
  const seen = { fresh: 0, expired: 0, dropped: 0, ranges: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== 'fresh') { seen.expired += 1; res.writeHead(403); return res.end('Request has expired'); }
    seen.fresh += 1;
    const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (!ranges || !match) { res.writeHead(200, { 'Content-Length': body.length }); return res.end(body); }
    const from = Number(match[1]), to = Math.min(Number(match[2]), body.length - 1);
    seen.ranges.push(from);
    if (from === 2 * downloadTiming.chunkBytes && !seen.dropped) {
      seen.dropped += 1;
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': to - from + 1 });
      res.write(body.subarray(from, from + 10));
      return res.destroy();
    }
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': to - from + 1 });
    res.end(body.subarray(from, to + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: (token) => `http://127.0.0.1:${server.address().port}/doc?token=${token}`, seen, close: () => server.close() };
}

test('big reports download in parallel ranges, in order, with expired links renewed and broken parts retried', async (t) => {
  const saved = { ...downloadTiming };
  Object.assign(downloadTiming, { chunkBytes: 4096, parallel: 4, retryMs: 0 });
  t.after(() => Object.assign(downloadTiming, saved));
  const text = JSON.stringify({ data: Array.from({ length: 3000 }, (_, i) => ({ term: `term ${i} ${'x'.repeat(i % 50)}`, n: i })) });
  const gz = gzipSync(Buffer.from(text));
  assert.ok(gz.length > 4096 * 4);
  const s3 = await fakeS3(gz);
  t.after(() => s3.close());

  let out = '', last = 0, refreshes = 0;
  await streamReportDocument({ url: s3.url('old'), compressionAlgorithm: 'GZIP' }, (piece) => { out += piece; },
    (received, total) => { last = received; assert.equal(total, gz.length); },
    async () => { refreshes += 1; return { url: s3.url('fresh') }; });
  assert.equal(out, text);
  assert.equal(last, gz.length);
  assert.equal(refreshes, 1);
  assert.equal(s3.seen.dropped, 1);
  assert.ok(new Set(s3.seen.ranges).size >= Math.ceil(gz.length / 4096));
});

test('servers without range support fall back to one plain download', async (t) => {
  const text = 'hello report';
  const s3 = await fakeS3(Buffer.from(text), { ranges: false });
  t.after(() => s3.close());
  let out = '';
  await streamReportDocument({ url: s3.url('fresh') }, (piece) => { out += piece; });
  assert.equal(out, text);
});
