import test from 'node:test';
import assert from 'node:assert/strict';
import { asinUploadBatches } from '../../shared/abaAsinUpload.js';
import { parseAsinUpload } from '../../shared/abaAsin.js';
import { asinFixture, mergedFixture } from '../../server/tests/abaAsinFixture.js';

test('501 ASIN workbook uploads in bounded batches with identical validated data', () => {
  const files = Array.from({ length: 501 }, (_, i) => ({ name: `${i}.csv`, text: asinFixture({ asin: `B${String(i).padStart(9, '0')}`, rows: [['词,"test"\nnext', 2, 3, 2, 1, 2, 1, 1]] }) }));
  const reports = parseAsinUpload(mergedFixture(files), 'ES');
  assert.equal(reports.length, 501);
  const batches = asinUploadBatches([{ reports }], 'ES', 3000);
  assert.ok(batches.length > 50);
  assert.ok(batches.every((files) => files.length <= 10 && Buffer.byteLength(JSON.stringify({ marketplace: 'ES', files })) <= 3000));
  const imported = batches.flat().flatMap((file) => parseAsinUpload(file, 'ES'));
  assert.deepEqual(imported.map(({ asin, rows, week_end }) => ({ asin, rows, week_end })), reports.map(({ asin, rows, week_end }) => ({ asin, rows, week_end })));
  assert.throws(() => asinUploadBatches([{ reports }, { reports: [reports[0]] }], 'ES'), /重复报告/);
});
