// worker 线程里能跑的任务。每个任务拿到一个数据库连接和可结构化复制的参数,
// 返回 JSON 字符串 —— 主线程拿到后直接发给浏览器,不用再解析一遍大对象。
// WORKER_POOL_SIZE=0 时主线程也直接调用这里,行为一致。
import { buildAbaView, abaPage } from '../services/abaView.js';
import { buildAsinView, asinPage } from '../services/asinView.js';

// 缓存的是排好序的完整结果,翻页、换每页条数都不用重算。
// 键里带数据版本号(任何写请求结束都会加一),所以数据一变旧结果就不会再被命中。
// 条数和总行数两道上限:一份大查询可能有几十万行,只按条数限会把内存吃满
const CACHE_LIMIT = 20;
const CACHE_ROW_LIMIT = 500_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
let cachedRows = 0;

function forget(key) {
  const hit = cache.get(key);
  if (!hit) return;
  cachedRows -= hit.rows;
  cache.delete(key);
}

function cached(key, build) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);   // 重新插入,Map 的顺序就是最近使用顺序
    return hit.value;
  }
  forget(key);
  const value = build();
  const rows = value.items.length;
  if (rows > CACHE_ROW_LIMIT) return value;   // 单份就超上限的不缓存
  cache.set(key, { value, rows, expires: Date.now() + CACHE_TTL_MS });
  cachedRows += rows;
  while (cache.size > CACHE_LIMIT || cachedRows > CACHE_ROW_LIMIT) forget(cache.keys().next().value);
  return value;
}

// 只影响切片的参数不进缓存键;_ 是前端防代理缓存加的随机数
const PAGE_ONLY = new Set(['page', 'pageSize', '_']);

/** 同一份完整结果的键;线程池也用它把同一个查询固定派给同一个 worker,缓存才命中得了 */
export function viewKey(kind, { userId, market, query, generation }) {
  const params = Object.entries(query)
    .filter(([key]) => !PAGE_ONLY.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([kind, generation, userId, market, params]);
}

const tasks = {
  abaView(db, payload) {
    const full = cached(viewKey('aba', payload), () => buildAbaView(db, payload.userId, payload.market, payload.query));
    return JSON.stringify(abaPage(full, payload.query));
  },
  asinView(db, payload) {
    const full = cached(viewKey('asin', payload), () => buildAsinView(db, payload.userId, payload.market, payload.query));
    return JSON.stringify(asinPage(full, payload.query));
  },
};

export function runTask(db, name, payload) {
  const task = tasks[name];
  if (!task) throw new Error(`未知的后台任务:${name}`);
  return task(db, payload);
}
