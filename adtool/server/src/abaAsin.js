import express from 'express';
import { respondWithTask, dataGeneration } from './workers/pool.js';
import { viewKey } from './workers/tasks.js';

// Mounted after the ABA account/market middleware.
export const abaAsinRouter = express.Router();
abaAsinRouter.post('/import', async (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length || files.length > 10) return res.status(400).json({ error: '每次请选择 1–10 份 CSV / XLSX 文件' });
  // 大小校验、解析和写库都在 worker 线程里做
  await respondWithTask(res, 'asinImport', { userId: req.session.user.id, market: req.abaMarket, files });
});

abaAsinRouter.get('/', async (req, res) => {
  // 匹配、聚合、排序都在 worker 线程里做,主线程只转发结果
  const payload = { userId: req.session.user.id, market: req.abaMarket, query: { ...req.query }, generation: dataGeneration() };
  await respondWithTask(res, 'asinView', payload, { key: viewKey('asin', payload), cancelOnClose: true });
});
