// 只负责定位数据库文件和打开连接,没有建表、迁移这类副作用 —— worker 线程直接 import 这个文件。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 所有数据只落在 DATA_DIR 里 —— 将来搬到别的机器就是拷这一个目录
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'adtool.db');
export const dataDir = DATA_DIR;

/**
 * 打开一个数据库连接并套上统一的 pragma。主线程和 worker 线程都走这里,
 * 保证每个连接设置一致(foreign_keys 这类 pragma 是按连接生效的,漏一个就会静默失效)。
 */
export function openDb({ readonly = false } = {}) {
  const conn = new Database(DB_PATH, { readonly });
  if (!readonly) conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');   // WAL 下安全:断电最多丢最后一个事务,不会损坏库
  conn.pragma('busy_timeout = 5000');    // 别的连接在写时最多等 5 秒,而不是直接报 SQLITE_BUSY
  conn.pragma('foreign_keys = ON');
  conn.pragma('cache_size = -32000');    // 32 MB 页缓存
  conn.pragma('temp_store = MEMORY');
  conn.pragma('mmap_size = 268435456');  // 256 MB 内存映射读
  return conn;
}
