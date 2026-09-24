const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_CHUNK_ROWS = 150;
const encoder = new TextEncoder();

export function splitAgedFeeRows(rows) {
  const chunks = [];
  let current = [];
  let offset = 0;
  let bytes = 64; // JSON 包装字段和索引的余量
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).length + 1;
    if (rowBytes + 64 > MAX_CHUNK_BYTES) throw new Error(`SKU ${row.SKU || '未知'} 的单行数据过长，无法导入。`);
    if (current.length && (bytes + rowBytes > MAX_CHUNK_BYTES || current.length >= MAX_CHUNK_ROWS)) {
      chunks.push({ offset, rows: current });
      offset += current.length;
      current = [];
      bytes = 64;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length) chunks.push({ offset, rows: current });
  return chunks;
}
