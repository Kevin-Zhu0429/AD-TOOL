// worker 线程入口:自己开一个数据库连接,一次处理一条任务消息。
import { parentPort } from 'node:worker_threads';
import { openDb } from '../dbConnect.js';
import { runTask } from './tasks.js';

// 目前搬进来的都是查询任务,用只读连接;以后搬写入任务时再开读写连接
const db = openDb({ readonly: true });

parentPort.on('message', ({ id, name, payload }) => {
  try {
    parentPort.postMessage({ id, ok: true, value: runTask(db, name, payload) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: error.message, status: error.status } });
  }
});
