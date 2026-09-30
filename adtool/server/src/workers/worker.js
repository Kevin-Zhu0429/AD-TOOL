// worker 线程入口:自己开一个数据库连接,一次处理一条任务消息。
import { parentPort } from 'node:worker_threads';
import { openDb } from '../dbConnect.js';
import { runTask } from './tasks.js';

// 导入任务要写库,用读写连接;建表和迁移只在主线程启动时做,这里不做
const db = openDb();

parentPort.on('message', ({ id, name, payload }) => {
  try {
    parentPort.postMessage({ id, ok: true, value: runTask(db, name, payload) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: error.message, status: error.status } });
  }
});
