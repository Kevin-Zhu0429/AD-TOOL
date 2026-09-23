import * as XLSX from 'xlsx';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function zipEntries(bytes) {
  const view = viewOf(bytes);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP 文件结构无效。');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64 压缩包。');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 文件目录损坏。');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const unpacked = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length) throw new Error('ZIP 文件目录损坏。');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'gb18030').decode(nameBytes);
    entries.push({ name, flags, method, size, unpacked, localOffset });
    offset = next;
  }
  return entries;
}

async function unzipFirstSheet(bytes) {
  const entries = zipEntries(bytes)
    .filter(({ name }) => /\.(csv|xlsx|xls)$/i.test(name) && !name.split(/[\\/]/).some((part) => part.startsWith('.') || part === '__MACOSX'))
    .sort((a, b) => Number(!/\.csv$/i.test(a.name)) - Number(!/\.csv$/i.test(b.name)) || a.name.localeCompare(b.name));
  if (!entries.length) throw new Error('ZIP 中没有 .csv、.xlsx 或 .xls 表格。');
  const entry = entries[0];
  if (entry.flags & 1) throw new Error('不支持加密的 ZIP 表格。');
  if (entry.unpacked > MAX_FILE_BYTES) throw new Error('ZIP 内表格超过 50 MB。');
  const view = viewOf(bytes);
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error('ZIP 文件内容损坏。');
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  if (start + entry.size > bytes.length) throw new Error('ZIP 文件内容不完整。');
  const compressed = bytes.subarray(start, start + entry.size);
  let content;
  if (entry.method === 0) content = compressed;
  else if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 ZIP 解压，请使用新版浏览器。');
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('ZIP 内表格超过 50 MB。'); }
      chunks.push(value);
    }
    content = new Uint8Array(length);
    let cursor = 0;
    for (const chunk of chunks) { content.set(chunk, cursor); cursor += chunk.length; }
  } else throw new Error('ZIP 使用了不支持的压缩方式。');
  if (content.length !== entry.unpacked) throw new Error('ZIP 内表格长度与目录不符。');
  return { name: entry.name, bytes: content };
}

export async function readInventoryRows(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 50 MB。');
  let name = file.name;
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.zip$/i.test(name)) ({ name, bytes } = await unzipFirstSheet(bytes));
  if (!/\.(csv|xlsx|xls)$/i.test(name)) throw new Error('请选择 .zip、.xlsx、.xls 或 .csv 文件。');
  let workbook;
  if (/\.csv$/i.test(name)) {
    let csv;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { csv = new TextDecoder('gb18030').decode(bytes); }
    workbook = XLSX.read(csv, { type: 'string' });
  } else workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('文件中没有工作表。');
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
}
