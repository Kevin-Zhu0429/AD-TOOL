import express from 'express';
import { randomUUID } from 'node:crypto';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { calculateInventory, calculateSkuFee, MARKET_RATES } from '../../shared/agedStorageFee.js';

export const agedFeesRouter = express.Router();
agedFeesRouter.use(requireLogin);
const MAX_ROWS = 20000;
const MAX_CHUNK_ROWS = 200;
const MAX_CHUNK_BYTES = 256 * 1024;

function saveBatch(calculated, date, scenario, sourceFile, userId, uploadId = null) {
  const insertBatch = db.prepare('INSERT INTO aged_fee_batches (source_file, base_date, scenario, row_count, created_by) VALUES (?, ?, ?, ?, ?)');
  const insertRow = db.prepare('INSERT INTO aged_fee_rows (batch_id, row_index, market, brand, base_json) VALUES (?, ?, ?, ?, ?)');
  const batchId = db.transaction(() => {
    const id = Number(insertBatch.run(sourceFile.trim() || '库存表', date, scenario, calculated.length, userId).lastInsertRowid);
    for (const row of calculated) insertRow.run(id, row.id, row.market, row.brand, JSON.stringify(row));
    if (uploadId) db.prepare('DELETE FROM aged_fee_uploads WHERE id = ?').run(uploadId);
    return id;
  })();
  audit(userId, null, 'import', 'aged_fee_batches', batchId, { rows: calculated.length, date });
  return cleanBatch(db.prepare('SELECT * FROM aged_fee_batches WHERE id = ?').get(batchId));
}

function ownUpload(req, res) {
  const upload = db.prepare('SELECT * FROM aged_fee_uploads WHERE id = ? AND created_by = ?').get(req.params.id, req.session.user.id);
  if (!upload) res.status(404).json({ error: '导入任务不存在或已完成' });
  return upload;
}

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
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) return res.status(400).json({ error: '一次请导入 1 到 20000 行库存数据' });
  if (typeof sourceFile !== 'string' || sourceFile.length > 255) return res.status(400).json({ error: '文件名过长' });
  let calculated;
  try { calculated = calculateInventory(rows, date, scenario); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  res.json(saveBatch(calculated, date, scenario, sourceFile, req.session.user.id));
});

agedFeesRouter.post('/import/start', (req, res) => {
  const { date, scenario = 'uniform', sourceFile = '', rowCount } = req.body ?? {};
  const parsedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) return res.status(400).json({ error: '请选择有效的统计日期' });
  if (!['uniform', 'youngest', 'oldest'].includes(scenario)) return res.status(400).json({ error: '未知库龄场景' });
  if (typeof sourceFile !== 'string' || sourceFile.length > 255) return res.status(400).json({ error: '文件名过长' });
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_ROWS) return res.status(400).json({ error: '一次请导入 1 到 20000 行库存数据' });
  db.prepare("DELETE FROM aged_fee_uploads WHERE created_at < datetime('now', 'localtime', '-1 day')").run();
  const id = randomUUID();
  db.prepare('INSERT INTO aged_fee_uploads (id, created_by, base_date, scenario, source_file, expected_rows) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.session.user.id, date, scenario, sourceFile.trim() || '库存表', rowCount);
  res.json({ uploadId: id });
});

agedFeesRouter.post('/import/:id/rows', (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  const { offset, rows } = req.body ?? {};
  if (!Number.isInteger(offset) || offset < 0 || !Array.isArray(rows) || !rows.length || rows.length > MAX_CHUNK_ROWS || offset + rows.length > upload.expected_rows)
    return res.status(400).json({ error: '导入分片范围不合法' });
  const encoded = rows.map((row) => JSON.stringify(row));
  if (encoded.some((row) => !row) || Buffer.byteLength(encoded.join(','), 'utf8') > MAX_CHUNK_BYTES)
    return res.status(400).json({ error: '导入分片过大' });
  const insert = db.prepare('INSERT INTO aged_fee_upload_rows (upload_id, row_index, raw_json) VALUES (?, ?, ?) ON CONFLICT(upload_id, row_index) DO UPDATE SET raw_json = excluded.raw_json');
  db.transaction(() => encoded.forEach((row, index) => insert.run(upload.id, offset + index, row)))();
  res.json({ received: offset + rows.length });
});

agedFeesRouter.post('/import/:id/finish', (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  const items = db.prepare('SELECT row_index, raw_json FROM aged_fee_upload_rows WHERE upload_id = ? ORDER BY row_index').all(upload.id);
  if (items.length !== upload.expected_rows || items.some((item, index) => item.row_index !== index))
    return res.status(400).json({ error: `导入不完整：已收到 ${items.length} / ${upload.expected_rows} 行` });
  let calculated;
  try { calculated = calculateInventory(items.map((item) => JSON.parse(item.raw_json)), upload.base_date, upload.scenario); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  res.json(saveBatch(calculated, upload.base_date, upload.scenario, upload.source_file, req.session.user.id, upload.id));
});

agedFeesRouter.delete('/import/:id', (req, res) => {
  const upload = ownUpload(req, res);
  if (!upload) return;
  db.prepare('DELETE FROM aged_fee_uploads WHERE id = ?').run(upload.id);
  res.json({ ok: true });
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
    if (MARKET_RATES[row.market]) {
      try { calculateSkuFee(row.buckets, numeric, row.date, row.market, db.prepare('SELECT scenario FROM aged_fee_batches WHERE id = ?').get(item.batch_id).scenario); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
  }
  const saved = db.prepare(`UPDATE aged_fee_rows SET special = ?, correction_value = ?, reason = ?, revision = revision + 1,
    updated_by = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND revision = ?`)
    .run(special ? 1 : 0, special ? numeric : null, special ? reason.trim() : '', req.session.user.id, id, revision);
  if (!saved.changes) return res.status(409).json({ error: '这行数据已被其他运营修改，请刷新后重试' });
  const next = db.prepare('SELECT revision FROM aged_fee_rows WHERE id = ?').get(id);
  audit(req.session.user.id, item.market, 'update', 'aged_fee_rows', id, { special, corrected: special && numeric !== null });
  res.json({ ok: true, revision: next.revision });
});
