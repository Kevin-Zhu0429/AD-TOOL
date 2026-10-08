import express from 'express';
import { requireLogin, canRead } from './auth.js';
import { MARKETPLACES } from './libs.js';
import { respondWithTask, dataGeneration } from './workers/pool.js';
import { viewKey } from './workers/tasks.js';
import { abaAsinRouter } from './abaAsin.js';

export const abaRouter = express.Router();
abaRouter.use(requireLogin);
abaRouter.use((req, res, next) => {
  const market = String(req.method === 'GET' ? req.query.marketplace ?? '' : req.body?.marketplace ?? '').toUpperCase();
  if (!MARKETPLACES.includes(market)) return res.status(400).json({ error: '请选择有效站点' });
  if (!canRead(req.session.user, market)) return res.status(403).json({ error: '无权访问这个站点' });
  req.abaMarket = market;
  next();
});

abaRouter.use('/asin', abaAsinRouter);

abaRouter.post('/import', async (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) return res.status(400).json({ error: '每次请选择 1–10 份 CSV 报告' });
  if (files.reduce((sum, file) => sum + (typeof file?.text === 'string' ? Buffer.byteLength(file.text) : 0), 0) > 30 * 1024 * 1024) return res.status(400).json({ error: '每批文件合计不能超过 30 MB' });
  // 解析 CSV 和写库都在 worker 线程里做
  await respondWithTask(res, 'abaImport', { userId: req.session.user.id, market: req.abaMarket, files });
});

abaRouter.get('/', async (req, res) => {
  // 匹配、聚合、排序都在 worker 线程里做,主线程只转发结果
  const payload = { userId: req.session.user.id, market: req.abaMarket, query: { ...req.query }, generation: dataGeneration() };
  await respondWithTask(res, 'abaView', payload, { key: viewKey('aba', payload), cancelOnClose: true });
});
