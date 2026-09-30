// worker 线程里能跑的任务。每个任务拿到一个数据库连接和可结构化复制的参数,
// 大多返回 JSON 字符串 —— 主线程拿到后直接发给浏览器,不用再解析一遍大对象。
// 任务抛出带 status 的错误(比如 400 文件格式不对)会原样变成接口的错误响应。
// WORKER_POOL_SIZE=0 时主线程也直接调用这里,行为一致。
import { buildAbaView, abaPage } from '../services/abaView.js';
import { buildAsinView, asinPage } from '../services/asinView.js';
import { importAbaReports } from '../services/abaImport.js';
import { importAsinReports } from '../services/asinImport.js';
import { readBatch, importInventory, finishUpload } from '../services/agedFees.js';
import { importProducts, listProducts } from '../services/products.js';
import { applyAndTrackStock, saveSnapshots } from '../services/captainApply.js';

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

function cached(key, build, { store = true } = {}) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);   // 重新插入,Map 的顺序就是最近使用顺序
    return hit.value;
  }
  forget(key);
  const value = build();
  if (!store) return value;
  // 按底层匹配到的行数计:合并视图的一行汇总下面还挂着每条原始记录的明细
  const rows = Math.max(value.items.length, value.recordCount);
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
    // 打印机视图导出会给每组挂上全部搜索词明细,体积不可控,而且是一次性的,不进缓存
    const full = cached(viewKey('asin', payload), () => buildAsinView(db, payload.userId, payload.market, payload.query),
      { store: payload.query.export !== '1' });
    return JSON.stringify(asinPage(full, payload.query));
  },
  // ---------- 导入:解析 + 事务写库 ----------
  abaImport(db, { userId, market, files }) {
    return JSON.stringify(importAbaReports(db, userId, market, files));
  },
  asinImport(db, { userId, market, files }) {
    return JSON.stringify(importAsinReports(db, userId, market, files));
  },
  agedFeesImport(db, payload) {
    return JSON.stringify(importInventory(db, payload));
  },
  agedFeesFinish(db, payload) {
    return JSON.stringify(finishUpload(db, payload));
  },
  // 产品导入的结果主线程还要拼汇总,返回对象而不是字符串
  productsImport(db, payload) {
    return importProducts(db, payload);
  },
  // ---------- 库存同步:快照写库 + 回写 SKU 库存(返回对象,主线程要拼汇总) ----------
  captainSaveSnapshots(db, payload) {
    saveSnapshots(db, payload);
    return null;
  },
  captainApply(db, { userId }) {
    return applyAndTrackStock(db, userId);
  },
  // ---------- 大列表:整份 JSON 解析 ----------
  agedFeesRead(db, { batchId }) {
    return JSON.stringify(readBatch(db, batchId));
  },
  productsList(db, { marketplace, requestedMonth }) {
    return JSON.stringify(listProducts(db, marketplace, requestedMonth));
  },
};

export function runTask(db, name, payload) {
  const task = tasks[name];
  if (!task) throw new Error(`未知的后台任务:${name}`);
  return task(db, payload);
}
