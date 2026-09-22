import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyDates, normalizePriceRow, parsePriceSheet, priceTemplateHeaders } from '../../shared/priceStrategy.js';

test('price strategy keeps daily columns tied to selected date and rejects invalid full imports', () => {
  assert.deepEqual(dailyDates('2026-08-26'), ['8/20','8/21','8/22','8/23','8/24','8/25','8/26']);
  const headers = priceTemplateHeaders('2026-08-26');
  const row = headers.map((header) => header === '日期' ? '2026-08-26' : header === 'SKU' ? 'PET-L' : header === '8/26销量' ? 3 : '');
  assert.equal(parsePriceSheet([headers,row], '2026-08-26')[0].day7, 3);
  assert.throws(() => parsePriceSheet([headers,row,row], '2026-08-26'), /重复/);
  assert.throws(() => normalizePriceRow({ date: '2026-08-26', sku: 'PET-L', marketplace: 'DE' }), /US/);
  assert.equal(normalizePriceRow({ date: '2026-08-26', sku: 'PET-L', currentProfit: -5 }).currentProfit, -5);
  assert.equal(normalizePriceRow({ date: '2026-08-26', sku: 'PET-L', monthlyMargin: -12 }).monthlyMargin, -12);
});
