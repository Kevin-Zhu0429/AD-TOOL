import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { readInventoryRows } from './agedStorageImport.js';

const csv = '市场代码,SKU,7日均销量,14日均销量,0-30,31-60,61-90,91-180,181-270,271-365,366-455,>456\nCY_UK,TEST-SKU,0,2,0,0,0,0,0,0,0,10\n';
const file = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

function zip(name, content) {
  const title = Buffer.from(name);
  const source = Buffer.from(content);
  const packed = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(title.length, 26);
  const center = Buffer.alloc(46);
  center.writeUInt32LE(0x02014b50, 0);
  center.writeUInt16LE(8, 10);
  center.writeUInt32LE(packed.length, 20);
  center.writeUInt32LE(source.length, 24);
  center.writeUInt16LE(title.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(center.length + title.length, 12);
  end.writeUInt32LE(local.length + title.length + packed.length, 16);
  return Buffer.concat([local, title, packed, center, title, end]);
}

test('直接 CSV 与压缩 ZIP 都能读出库存表', async () => {
  for (const input of [file('inventory.csv', Buffer.from(csv)), file('inventory.zip', zip('库存.csv', csv))]) {
    const rows = await readInventoryRows(input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].SKU, 'TEST-SKU');
    assert.equal(rows[0]['14日均销量'], 2);
  }
});

test('ZIP 中的 Excel 工作簿读取首张表', async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['市场代码', 'SKU'], ['CY_CA', 'XLSX-SKU']]), '库存');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const rows = await readInventoryRows(file('inventory.zip', zip('库存.xlsx', bytes)));
  assert.deepEqual(rows, [{ 市场代码: 'CY_CA', SKU: 'XLSX-SKU' }]);
});

test('ZIP 没有表格时返回可读错误', async () => {
  await assert.rejects(readInventoryRows(file('inventory.zip', zip('说明.txt', 'hello'))), /没有 .*表格/);
});
