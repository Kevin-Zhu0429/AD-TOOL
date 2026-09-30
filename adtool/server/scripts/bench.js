/**
 * 压测:ABA 查询和 ABA 导入跑的时候主线程被卡多久。
 *   node scripts/bench.js                     # 默认线程池
 *   WORKER_POOL_SIZE=0 node scripts/bench.js  # 全部在主线程跑,做对照
 * 在临时目录里造数据,不碰项目自己的数据库。
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { startAbaTestServer } from '../tests/abaHarness.js';
import { csvFixture } from '../tests/abaFixture.js';

const WEEKS = Number(process.env.BENCH_WEEKS) || 12;
const QUERIES = Number(process.env.BENCH_QUERIES) || 20000;

const server = await startAbaTestServer();
const userId = server.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get().id;
const words = ['cartuchos hp 305', 'tinta hp deskjet 2700', 'hp 4310', 'hp deskjet 3050', 'canon TS305', 'tinta canon 545', 'hp 302 negro', 'sin coincidencia'];
const insertReport = server.db.prepare(`INSERT INTO aba_reports (user_id, marketplace, brand, week_start, week_end, week_number, source_file, content_hash, row_count)
  VALUES (?, 'ES', 'Cyloral', ?, ?, ?, 'bench.csv', ?, ?) RETURNING id`);
const insertQuery = server.db.prepare(`INSERT INTO aba_queries (report_id, query, query_volume, impressions, clicks, click_rate, click_price, purchases)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const weekEnds = [];
server.db.transaction(() => {
  for (let w = 0; w < WEEKS; w++) {
    const end = new Date(Date.UTC(2026, 8, 26) - w * 7 * 864e5).toISOString().slice(0, 10);
    const start = new Date(Date.parse(end) - 6 * 864e5).toISOString().slice(0, 10);
    weekEnds.push(end);
    const { id } = insertReport.get(userId, start, end, 39 - w, `bench-${w}`, QUERIES);
    for (let i = 0; i < QUERIES; i++) insertQuery.run(id, `${words[i % words.length]} ${i}`, 100 + i % 50, 5000, 45, 1, 9.99, 3);
  }
})();

const login = await fetch(server.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'aba-test', password: 'local-test-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (params) => {
  const t = performance.now();
  const response = await fetch(`${server.url}/api/aba?marketplace=ES&weeks=${weekEnds.join(',')}&${params}`, { headers: { cookie } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return { ms: performance.now() - t, total: data.total };
};

const delay = monitorEventLoopDelay({ resolution: 5 });
delay.enable();
const first = await get('merge=0&page=1');
const second = await get('merge=0&page=2');
const concurrent = await Promise.all([get('merge=0&sort=clicks'), get('merge=1'), get('view=printers'), get('merge=0&sort=impressions')]);
delay.disable();

const ms = (ns) => (ns / 1e6).toFixed(1);
console.log(`线程池: ${process.env.WORKER_POOL_SIZE === '0' ? '关闭(主线程执行)' : '开启'} · 数据: ${WEEKS} 周 × ${QUERIES} 词`);
console.log(`首次查询 ${first.ms.toFixed(0)} ms(${first.total} 行) · 翻到第 2 页 ${second.ms.toFixed(0)} ms`);
console.log(`4 个不同查询并发: 最慢 ${Math.max(...concurrent.map((r) => r.ms)).toFixed(0)} ms`);
console.log(`主线程事件循环延迟: p50 ${ms(delay.percentile(50))} ms · p99 ${ms(delay.percentile(99))} ms · 最大 ${ms(delay.max)} ms`);

// 导入:10 份 CSV,每份 1 万行(报告上限),一次提交
const IMPORT_ROWS = 10000;
const files = Array.from({ length: 10 }, (_, f) => {
  const end = new Date(Date.UTC(2025, 8, 27) - f * 7 * 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.parse(end) - 6 * 864e5).toISOString().slice(0, 10);
  const rows = Array.from({ length: IMPORT_ROWS }, (_, i) => [`${words[i % words.length]} ${i}`, 100, 5000, 45, 1, 9.99, 3]);
  return { name: `ES_Week_${end}.csv`, text: csvFixture({ week: 39 - f, start, end, brand: 'Bench', rows }) };
});
const body = JSON.stringify({ marketplace: 'ES', files });
const importDelay = monitorEventLoopDelay({ resolution: 5 });
importDelay.enable();
const t = performance.now();
const imported = await fetch(`${server.url}/api/aba/import`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body });
const importMs = performance.now() - t;
importDelay.disable();
if (!imported.ok) throw new Error((await imported.json()).error);
console.log(`导入 10 份 CSV(${(body.length / 1024 / 1024).toFixed(1)} MB,共 ${10 * IMPORT_ROWS} 行): ${importMs.toFixed(0)} ms · 主线程延迟 p99 ${ms(importDelay.percentile(99))} ms · 最大 ${ms(importDelay.max)} ms`);
await server.close();
