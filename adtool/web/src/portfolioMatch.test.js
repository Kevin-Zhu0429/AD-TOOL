import test from 'node:test';
import assert from 'node:assert/strict';
import { isMixedPortfolio, portfolioSeriesKey, resolvePortfolio } from './portfolioMatch.js';

const portfolios = [
  { portfolioId: '101', name: 'SP-CY 540 Series' },
  { portfolioId: '102', name: 'SP-CY 545 Series' },
  { portfolioId: '199', name: 'SP-CY 混投' },
];
const skus = [
  { sku: 'SKU-540-BK', model: '540XL' },
  { sku: 'SKU-540-C', model: '540' },
  { sku: 'SKU-545', model: 'PG-545' },
];

test('extracts series and mixed portfolio names from the uploaded format', () => {
  assert.equal(portfolioSeriesKey('SP-CY 540 Series'), '540');
  assert.equal(portfolioSeriesKey('SP-CY PG-545 Series'), '545');
  assert.equal(portfolioSeriesKey('SP-CY 302 系列'), '302');
  assert.equal(isMixedPortfolio('SP-CY 混投'), true);
});

test('matches one SKU series and strips XL from the SKU model', () => {
  const result = resolvePortfolio('SKU-540-BK\nSKU-540-C', skus, portfolios);
  assert.equal(result.status, 'matched');
  assert.equal(result.portfolioId, '101');
});

test('uses mixed portfolio for multiple SKU series', () => {
  const result = resolvePortfolio('SKU-540-BK\nSKU-545', skus, portfolios);
  assert.equal(result.status, 'matched');
  assert.equal(result.portfolioId, '199');
});

test('does not guess when SKU data or portfolio mapping is incomplete', () => {
  assert.equal(resolvePortfolio('UNKNOWN', skus, portfolios).status, 'missing-sku');
  assert.equal(resolvePortfolio('SKU-X', [{ sku: 'SKU-X', model: '' }], portfolios).status, 'missing-model');
  assert.equal(resolvePortfolio('SKU-540-BK', skus, portfolios.slice(1)).status, 'missing-portfolio');
  assert.equal(resolvePortfolio('SKU-540-BK\nSKU-575', [...skus, { sku: 'SKU-575', model: '575' }], portfolios).status, 'missing-portfolio');
});
