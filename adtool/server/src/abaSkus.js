import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, requireRole } from './auth.js';
import { MARKETPLACES } from './libs.js';
import { abaSkuStatus } from './services/abaSkuLibrary.js';
import { respondWithTask, runTask } from './workers/pool.js';

export const abaSkuRouter = express.Router();
abaSkuRouter.use(requireLogin);
abaSkuRouter.get('/', (req, res) => {
  const country = String(req.query.country ?? '').toUpperCase();
  if (country && !MARKETPLACES.includes(country)) return res.status(400).json({ error: '请选择有效国家' });
  const where = [], args = [];
  if (country) { where.push('country=?'); args.push(country); }
  if (req.query.brand) { where.push('brand_key=?'); args.push(String(req.query.brand).trim().toLowerCase()); }
  const search = String(req.query.q ?? '').trim().toLowerCase().slice(0, 200);
  if (search) { where.push("instr(lower(sku || ' ' || asin || ' ' || model || ' ' || brand || ' ' || COALESCE(set_group,'')),?)>0"); args.push(search); }
  const condition = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) n FROM aba_sku_items' + condition).get(...args).n;
  const pageSize = [25, 50, 100, 200, 500].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(req.query.page) || 1)));
  const items = db.prepare('SELECT id,country,brand,sku,asin,model,set_group AS setGroup FROM aba_sku_items' + condition + ' ORDER BY country,brand_key,model,sku_key LIMIT ? OFFSET ?').all(...args, pageSize, (page - 1) * pageSize);
  const status = abaSkuStatus(db);
  res.json({ ...status, libraryTotal: status.total, total, items, page, pageSize, pageCount, canManage: req.session.user.role === 'owner', marketplaces: MARKETPLACES,
    brands: db.prepare('SELECT brand_key AS key, MIN(brand) AS label FROM aba_sku_items' + (country ? ' WHERE country=?' : '') + ' GROUP BY brand_key ORDER BY brand_key').all(...(country ? [country] : [])) });
});
abaSkuRouter.post('/preview', requireRole('owner'), async (req, res) => {
  await respondWithTask(res, 'abaSkuPreview', { rows: req.body?.rows });
});
abaSkuRouter.post('/import', requireRole('owner'), async (req, res) => {
  // Audit only a successfully committed import; worker errors retain the original library.
  try {
    const result = await runTask('abaSkuImport', { rows: req.body?.rows, filename: req.body?.filename, userId: req.session.user.id });
    audit(req.session.user.id, null, 'import', 'aba_sku_items', null, { added: result.added, updated: result.updated, countries: result.countries });
    res.json(result);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '保存请求未能完成，请刷新库确认结果后重试' }); }
});
