// 超龄仓储费:库存计算、写批次、读批次。计算和 2 万行的 JSON 解析都在 worker 线程里执行。
import { writeAudit } from '../dbConnect.js';
import { calculateInventory } from '../../../shared/agedStorageFee.js';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function saveBatch(db, calculated, date, scenario, sourceFile, userId, uploadId = null) {
  const insertBatch = db.prepare('INSERT INTO aged_fee_batches (source_file, base_date, scenario, row_count, created_by) VALUES (?, ?, ?, ?, ?)');
  const insertRow = db.prepare('INSERT INTO aged_fee_rows (batch_id, row_index, market, brand, base_json) VALUES (?, ?, ?, ?, ?)');
  const batchId = db.transaction(() => {
    const id = Number(insertBatch.run(sourceFile.trim() || '库存表', date, scenario, calculated.length, userId).lastInsertRowid);
    for (const row of calculated) insertRow.run(id, row.id, row.market, row.brand, JSON.stringify(row));
    if (uploadId) db.prepare('DELETE FROM aged_fee_uploads WHERE id = ?').run(uploadId);
    return id;
  })();
  writeAudit(db, userId, null, 'import', 'aged_fee_batches', batchId, { rows: calculated.length, date });
  return cleanBatch(db, db.prepare('SELECT * FROM aged_fee_batches WHERE id = ?').get(batchId));
}

export function cleanBatch(db, batch) {
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

/** 当前(或指定)批次的全部行;没有批次时 rows 为空 */
export function readBatch(db, batchId) {
  const batch = Number.isInteger(batchId) && batchId > 0
    ? db.prepare('SELECT * FROM aged_fee_batches WHERE id = ?').get(batchId)
    : db.prepare('SELECT * FROM aged_fee_batches ORDER BY id DESC LIMIT 1').get();
  return batch ? cleanBatch(db, batch) : { batch: null, rows: [] };
}

/** 一次性导入:算完直接存成新批次 */
export function importInventory(db, { rows, date, scenario, sourceFile, userId }) {
  let calculated;
  try { calculated = calculateInventory(rows, date, scenario); }
  catch (error) { throw badRequest(error.message); }
  return saveBatch(db, calculated, date, scenario, sourceFile, userId);
}

/** 分片导入的最后一步:校验分片齐全、计算、存成新批次并删掉暂存 */
export function finishUpload(db, { uploadId, userId }) {
  const upload = db.prepare('SELECT * FROM aged_fee_uploads WHERE id = ? AND created_by = ?').get(uploadId, userId);
  if (!upload) throw Object.assign(new Error('导入任务不存在或已完成'), { status: 404 });
  const items = db.prepare('SELECT row_index, raw_json FROM aged_fee_upload_rows WHERE upload_id = ? ORDER BY row_index').all(upload.id);
  if (items.length !== upload.expected_rows || items.some((item, index) => item.row_index !== index))
    throw badRequest(`导入不完整：已收到 ${items.length} / ${upload.expected_rows} 行`);
  let calculated;
  try { calculated = calculateInventory(items.map((item) => JSON.parse(item.raw_json)), upload.base_date, upload.scenario); }
  catch (error) { throw badRequest(error.message); }
  return saveBatch(db, calculated, upload.base_date, upload.scenario, upload.source_file, userId, upload.id);
}
