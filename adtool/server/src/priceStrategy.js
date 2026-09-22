import express from 'express';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { isPet } from './profile.js';
import { normalizePriceRow, dailyDates } from '../../shared/priceStrategy.js';
import { priceSyncStatus, syncPriceStrategy } from './priceStrategySync.js';

export const priceStrategyRouter = express.Router();
priceStrategyRouter.use(requireLogin);
priceStrategyRouter.use((req, res, next) => isPet ? next() : res.status(404).json({ error: '未启用价格策略表' }));

const select = `SELECT id, data_json, updated_by, updated_at FROM pet_price_strategy`;
const unpack = (row) => ({ id: row.id, ...JSON.parse(row.data_json), updatedBy: row.updated_by, updatedAt: row.updated_at });

priceStrategyRouter.get('/', (req, res) => {
  const date = String(req.query.date ?? '');
  if (date && !dailyDates(date).length) return res.status(400).json({ error: '日期不合法' });
  const items = db.prepare(`${select}${date ? ' WHERE snapshot_date=?' : ''} ORDER BY updated_at DESC, id DESC${date ? '' : ' LIMIT 500'}`).all(...(date ? [date] : [])).map(unpack);
  const dates = db.prepare(`SELECT snapshot_date AS date, COUNT(*) AS count FROM pet_price_strategy GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 36`).all();
  res.json({ items, dates, sync: priceSyncStatus() });
});

priceStrategyRouter.post('/sync', async (req, res) => {
  const date = String(req.body?.date ?? '');
  if (!dailyDates(date).length) return res.status(400).json({ error: '同步日期不合法' });
  try { res.json(await syncPriceStrategy(date, req.session.user.id)); }
  catch (error) { res.status(error.message === '价格策略表正在同步' ? 409 : 502).json({ error: String(error.message).slice(0, 300) }); }
});

priceStrategyRouter.post('/rows', (req, res) => {
  const input = req.body?.rows;
  if (!Array.isArray(input) || !input.length || input.length > 20000) return res.status(400).json({ error: '一次需要导入 1–20000 行' });
  const rows = [], seen = new Set();
  try {
    input.forEach((raw, index) => {
      let row;
      try { row = normalizePriceRow(raw); } catch (error) { throw new Error(`第 ${index + 1} 行：${error.message}`); }
      const key = `${row.date}\0${row.sku.toLowerCase()}`;
      if (seen.has(key)) throw new Error(`第 ${index + 1} 行：同一日期的 SKU 重复`);
      seen.add(key); rows.push(row);
    });
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const upsert = db.prepare(`INSERT INTO pet_price_strategy(snapshot_date,marketplace,sku,data_json,updated_by)
    VALUES(@date,'US',@sku,@json,@actor)
    ON CONFLICT(snapshot_date,marketplace,sku) DO UPDATE SET data_json=excluded.data_json,
      updated_by=excluded.updated_by,updated_at=datetime('now','localtime')`);
  db.transaction(() => { for (const row of rows) upsert.run({ date: row.date, sku: row.sku, json: JSON.stringify(row), actor: req.session.user.id }); })();
  audit(req.session.user.id, 'US', 'import', 'pet_price_strategy', null, { count: rows.length, dates: [...new Set(rows.map((r) => r.date))] });
  res.json({ count: rows.length });
});

priceStrategyRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '记录编号不合法' });
  const result = db.prepare('DELETE FROM pet_price_strategy WHERE id=?').run(id);
  if (!result.changes) return res.status(404).json({ error: '记录不存在' });
  audit(req.session.user.id, 'US', 'delete', 'pet_price_strategy', id);
  res.json({ ok: true });
});
