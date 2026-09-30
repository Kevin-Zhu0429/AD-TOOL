/**
 * worker 线程池。主线程只负责收请求、校验、回结果,
 * 匹配、聚合、排序这类吃 CPU 的活交给这里的线程,别人的请求就不用排队等。
 *
 * WORKER_POOL_SIZE 控制线程数:不填 = CPU 核数减 1,最多 4 个;填 0 = 全部回到主线程执行
 * (出问题时不用回滚代码,改环境变量重启即可)。
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { db } from '../db.js';
import { runTask as runLocal } from './tasks.js';

const TASK_TIMEOUT_MS = 60_000;

function configuredSize() {
  const raw = process.env.WORKER_POOL_SIZE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return Math.min(n, 16);
  }
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

const size = configuredSize();
const slots = Array.from({ length: size }, () => ({ worker: null, pending: new Map() }));
let nextId = 1;

function fail(slot, worker, error) {
  if (slot.worker !== worker) return;          // error 和 exit 会先后触发,只处理一次
  slot.worker = null;
  for (const job of slot.pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  slot.pending.clear();
}

function workerOf(slot) {
  if (slot.worker) return slot.worker;
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  worker.unref();                                // 空闲的线程不挡进程退出
  worker.on('message', ({ id, ok, value, error }) => {
    const job = slot.pending.get(id);
    if (!job) return;
    slot.pending.delete(id);
    clearTimeout(job.timer);
    if (!slot.pending.size) worker.unref();
    if (ok) job.resolve(value);
    else job.reject(Object.assign(new Error(error.message), error.status ? { status: error.status } : {}));
  });
  worker.on('error', (error) => fail(slot, worker, error));
  worker.on('exit', (code) => fail(slot, worker, new Error(`后台线程意外退出(${code})`)));
  slot.worker = worker;
  return worker;
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 把任务交给线程池,返回 Promise。
 * 传了 key 的任务固定派给同一个线程(缓存在线程里,同一个查询翻页才能命中);
 * 没传就派给手上任务最少的线程。
 */
export function runTask(name, payload, { key } = {}) {
  if (!size) {
    try { return Promise.resolve(runLocal(db, name, payload)); }
    catch (error) { return Promise.reject(error); }
  }
  const slot = key !== undefined
    ? slots[hash(key) % size]
    : slots.reduce((best, s) => (s.pending.size < best.pending.size ? s : best));
  const worker = workerOf(slot);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // 超时的线程直接换掉:它可能卡在一个同步循环里,留着会拖住后面排队的任务
      fail(slot, worker, Object.assign(new Error('查询超时,请缩小筛选范围后重试'), { status: 503 }));
      worker.terminate();
    }, TASK_TIMEOUT_MS);
    slot.pending.set(id, { resolve, reject, timer });
    worker.ref();
    worker.postMessage({ id, name, payload });
  });
}

// ---------- 数据版本号 ----------
// 每个写请求(非 GET)结束时加一。线程里的查询缓存把它放进键里,
// 数据一变旧结果就不会再被命中 —— 不用逐个接口去想该清哪块缓存。
let generation = 0;

export function dataGeneration() {
  return generation;
}

export function bumpOnWrite(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') res.once('close', () => { generation++; });
  next();
}
