import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, requireRole } from './auth.js';
import { MARKETPLACES } from './libs.js';
import { respondWithTask, runTask, dataGeneration, bumpDataGeneration } from './workers/pool.js';
import { viewKey } from './workers/tasks.js';
import { createPublicSync } from './services/publicAsinSync.js';

export const publicAbaSync = createPublicSync({
  db, save: (payload) => runTask('publicAsinSave', payload), onSaved: bumpDataGeneration,
});
export const abaPublicRouter = express.Router();
abaPublicRouter.use(requireLogin);
abaPublicRouter.get('/status', (_req, res) => res.json(publicAbaSync.status()));
abaPublicRouter.post('/sync', requireRole('owner'), (req, res) => {
  const result = publicAbaSync.start(req.session.user.id);
  if (!result.alreadyRunning) audit(req.session.user.id, null, 'sync', 'aba_public_reports', result.jobId, { initialWeeks: 4 });
  res.status(202).json({ ...result, ...publicAbaSync.status() });
});
abaPublicRouter.get('/asin', async (req, res) => {
  const market = String(req.query.marketplace ?? '').toUpperCase();
  if (!MARKETPLACES.includes(market)) return res.status(400).json({ error: '请选择有效国家' });
  const payload = { userId: null, market, query: { ...req.query }, generation: dataGeneration() };
  await respondWithTask(res, 'publicAsinView', payload, { key: viewKey('publicAsin', payload), cancelOnClose: true });
});
export function startPublicAbaScheduler() {
  const tick = () => publicAbaSync.tick().catch((error) => console.error('[aba-public-sync]', error.name));
  tick();
  const timer = setInterval(tick, 10000);
  timer.unref();
  return () => clearInterval(timer);
}
