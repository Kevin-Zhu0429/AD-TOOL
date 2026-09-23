import express from 'express';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { calculateInventory, calculateSkuFee } from '../../shared/agedStorageFee.js';

export const agedFeesRouter = express.Router();
agedFeesRouter.use(requireLogin);

function cleanBatch(batch) {
  const items = db.prepare('SELECT * FROM aged_fee_rows WHERE batch_id = ? ORDER BY row_index').all(batch.id);
  return {
    batch: { id: batch.id, sourceFile: batch.source_file, date: batch.base_date, scenario: batch.scenario,
      rowCount: batch.row_count, createdAt: batch.created_at },
    rows: items.map((item) => ({
      ...JSON.parse(item.base_json), id: item.id,
      correction: { special: !!item.special, value: item.correction_value == null ? '' : String(item.correction_value),
        reason: item.reason, revision: item.revision },
      canEdit: true,
    })),
  };
}

agedFeesRouter.get('/', (req, res) => {
  const id = Number(req.query.batchId);
  const batch = Number.isInteger(id) && id > 0
    ? db.prepare('SELECT * FROM aged_fee_batches WHERE id = ?').get(id)
    : db.prepare('SELECT * FROM aged_fee_batches ORDER BY id DESC LIMIT 1').get();
  if (!batch) return res.json({ batch: null, rows: [] });
  res.json(cleanBatch(batch));
});

agedFeesRouter.post('/import', (req, res) => {
  const { rows, date, scenario = 'uniform', sourceFile = '' } = req.body ?? {};
  if (!Array.isArray(rows) || !rows.length || rows.length > 20000) return res.status(400).json({ error: '一次请导入 1 到 20000 行库存数据' });
  if (typeof sourceFile !== 'string' || sourceFile.length > 255) return res.status(400).json({ error: '文件名过长' });
  let calculated;
  try { calculated = calculateInventory(rows, date, scenario); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const insertBatch = db.prepare('INSERT INTO aged_fee_batches (source_file, base_date, scenario, row_count, created_by) VALUES (?, ?, ?, ?, ?)');
  const insertRow = db.prepare('INSERT INTO aged_fee_rows (batch_id, row_index, market, brand, base_json) VALUES (?, ?, ?, ?, ?)');
  const batchId = db.transaction(() => {
    const id = insertBatch.run(sourceFile.trim() || '库存表', date, scenario, calculated.length, req.session.user.id).lastInsertRowid;
    for (const row of calculated) insertRow.run(id, row.id, row.market, row.brand, JSON.stringify(row));
    return Number(id);
  })();
  audit(req.session.user.id, null, 'import', 'aged_fee_batches', batchId, { rows: calculated.length, date });
  res.json(cleanBatch(db.prepare('SELECT * FROM aged_fee_batches WHERE id = ?').get(batchId)));
});

agedFeesRouter.patch('/rows/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '记录编号不合法' });
  const item = db.prepare('SELECT * FROM aged_fee_rows WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: '这条库存记录不存在' });
  const latest = db.prepare('SELECT id FROM aged_fee_batches ORDER BY id DESC LIMIT 1').get();
  if (item.batch_id !== latest?.id) return res.status(409).json({ error: '已有新批次，请刷新共享结果后再修改' });
  const { special, value, reason, revision } = req.body ?? {};
  if (typeof special !== 'boolean' || !Number.isInteger(revision) || revision < 0) return res.status(400).json({ error: '修正内容不完整' });
  if (typeof reason !== 'string' || reason.length > 500) return res.status(400).json({ error: '备注最多 500 字' });
  const numeric = String(value ?? '').trim() === '' ? null : Number(value);
  if (special && numeric !== null && (!Number.isFinite(numeric) || numeric <= 0)) return res.status(400).json({ error: '修正日销必须大于 0' });
  if (special && numeric !== null) {
    const row = JSON.parse(item.base_json);
    try { calculateSkuFee(row.buckets, numeric, row.date, row.market, db.prepare('SELECT scenario FROM aged_fee_batches WHERE id = ?').get(item.batch_id).scenario); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  }
  const saved = db.prepare(`UPDATE aged_fee_rows SET special = ?, correction_value = ?, reason = ?, revision = revision + 1,
    updated_by = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND revision = ?`)
    .run(special ? 1 : 0, special ? numeric : null, special ? reason.trim() : '', req.session.user.id, id, revision);
  if (!saved.changes) return res.status(409).json({ error: '这行数据已被其他运营修改，请刷新后重试' });
  const next = db.prepare('SELECT revision FROM aged_fee_rows WHERE id = ?').get(id);
  audit(req.session.user.id, item.market, 'update', 'aged_fee_rows', id, { special, corrected: special && numeric !== null });
  res.json({ ok: true, revision: next.revision });
});
