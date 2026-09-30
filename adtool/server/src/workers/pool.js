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

// 单个任务从开始执行算起的最长时间;可用环境变量调,主要给压测用
const TASK_TIMEOUT_MS = Number(process.env.WORKER_TASK_TIMEOUT_MS) || 60_000;

function configuredSize() {
  const raw = process.env.WORKER_POOL_SIZE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return Math.min(n, 16);
  }
  return Math.max(1, Math.min(4, os.availableParallelism() - 1));
}

const size = configuredSize();
// 每个线程一次只跑一条任务;其余的在 queue 里排队,轮到了才开始计超时
const slots = Array.from({ length: size }, () => ({ worker: null, running: null, queue: [] }));
let nextId = 1;

const load = (slot) => slot.queue.length + (slot.running ? 1 : 0);

function fail(slot, worker, error) {
  if (slot.worker !== worker) return;          // error 和 exit 会先后触发,只处理一次
  slot.worker = null;
  const job = slot.running;
  slot.running = null;
  if (job) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  // 排队中的任务还没开始跑,换一个新线程接着做
  dispatch(slot);
}

function workerOf(slot) {
  if (slot.worker) return slot.worker;
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  worker.unref();                                // 空闲的线程不挡进程退出
  worker.on('message', ({ id, ok, value, error }) => {
    const job = slot.running;
    if (!job || job.id !== id) return;
    slot.running = null;
    clearTimeout(job.timer);
    if (ok) job.resolve(value);
    else job.reject(Object.assign(new Error(error.message), error.status ? { status: error.status } : {}));
    dispatch(slot);
  });
  worker.on('error', (error) => fail(slot, worker, error));
  worker.on('exit', (code) => fail(slot, worker, new Error(`后台线程意外退出(${code})`)));
  slot.worker = worker;
  return worker;
}

/** 线程空着就把队首任务发过去,并从这一刻开始计超时 */
function dispatch(slot) {
  if (slot.running) return;
  const job = slot.queue.shift();
  if (!job) {
    slot.worker?.unref();
    return;
  }
  const worker = workerOf(slot);
  worker.ref();
  job.timer = setTimeout(() => {
    // 超时的线程直接换掉:它卡在一个同步循环里,留着会拖住后面排队的任务
    fail(slot, worker, Object.assign(new Error('查询超时,请缩小筛选范围后重试'), { status: 503 }));
    worker.terminate();
  }, TASK_TIMEOUT_MS);
  slot.running = job;
  worker.postMessage({ id: job.id, name: job.name, payload: job.payload });
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
export function runTask(name, payload, { key, signal } = {}) {
  if (!size) {
    try { return Promise.resolve(runLocal(db, name, payload)); }
    catch (error) { return Promise.reject(error); }
  }
  const slot = key !== undefined
    ? slots[hash(key) % size]
    : slots.reduce((best, s) => (load(s) < load(best) ? s : best));
  return new Promise((resolve, reject) => {
    const job = { id: nextId++, name, payload, resolve, reject, timer: null };
    // 浏览器已经不要这个结果了(连点筛选时前一个请求会被取消):还在排队的直接撤掉,
    // 不让一串过期的查询挡在最新那次前面。已经在跑的同步任务停不下来,跑完结果丢掉即可
    signal?.addEventListener('abort', () => {
      const index = slot.queue.indexOf(job);
      if (index < 0) return;
      slot.queue.splice(index, 1);
      reject(Object.assign(new Error('请求已取消'), { status: 499, cancelled: true }));
    }, { once: true });
    slot.queue.push(job);
    dispatch(slot);
  });
}

/**
 * 跑一个返回 JSON 字符串的任务并直接发给浏览器;
 * 任务里抛出的带 status 的错误(400 格式不对、404 不存在、503 超时)原样回给前端。
 */
export async function respondWithTask(res, name, payload, { cancelOnClose = false, ...options } = {}) {
  // 只读查询才撤:导入之类的写任务浏览器走了也要做完
  const controller = new AbortController();
  if (cancelOnClose) res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    res.type('json').send(await runTask(name, payload, { ...options, signal: controller.signal }));
  } catch (error) {
    if (error.cancelled) return;
    if (!error.status) throw error;
    res.status(error.status).json({ error: error.message });
  }
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
