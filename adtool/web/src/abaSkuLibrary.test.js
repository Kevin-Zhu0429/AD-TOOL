import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbaSkuSheets } from '../../shared/abaSkuLibrary.js';

test('ABA SKU multi-market workbook maps named columns, combines sheets and rejects ambiguous headers', () => {
  const sheets = [{ name: 'ES', rows: [['ASIN', 'SKU', '国家', '品牌', '型号', '颜色'], ['B000000305', 'CE-ES', '西班牙', 'CE', '305', 'BK']] },
    { name: 'DE', rows: [['country', 'brand', 'sku', 'asin', 'model'], ['DE', 'CY', 'CY-DE', 'B000000306', '305XL']] },
    { name: '填写说明', rows: [['说明文字']] }];
  const rows = parseAbaSkuSheets(sheets);
  assert.deepEqual(rows.map((r) => [r.country, r.sku, r.model, r.setGroup]), [['西班牙', 'CE-ES', '305', 'BK'], ['DE', 'CY-DE', '305XL', '']]);
  assert.throws(() => parseAbaSkuSheets([{ name: 'bad', rows: [['国家', '品牌', 'SKU', '机型'], ['ES', 'CE', 'a', 'ENVY6000']] }]), /ASIN/);
  assert.throws(() => parseAbaSkuSheets([{ name: 'bad', rows: [['国家', '品牌', 'SKU', 'ASIN', '型号', '墨盒型号']] }]), /重复/);
  assert.throws(() => parseAbaSkuSheets([{ name: 'empty', rows: [] }]), /没有 SKU 数据/);
});
