import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDModelIndex, campaignModelContext, detectModelDrift } from './modelDrift.js';

const lib = {
  libs: [{ id: 'D', special: 'series' }],
  items: { D: [
    { term: '301, 301XL', printer: 'DeskJet 2710, 2720' },
    { term: '305', printer: 'DeskJet 3050' },
    { term: '510', printer: 'MP260' },
  ] },
};
const index = buildDModelIndex(lib);
const context = campaignModelContext(
  { ads: [{ sku: 'SKU-301' }] },
  [{ sku: 'sku-301', model: 'HP 301XL' }],
  index,
);

test('finds a wrong cartridge or printer model for the advertised SKU', () => {
  const cartridge = detectModelDrift('compatible ink 510', context, index);
  const printer = detectModelDrift('ink for MP260', context, index);
  assert.equal(cartridge.findings[0].reason, '本活动中未投放 510 系列');
  assert.equal(printer.findings[0].reason, 'MP260 机型为 510 系列的机型，本活动中未投放 510 系列');
});

test('does not flag expected models or terms without a D model', () => {
  assert.equal(detectModelDrift('301 xl ink for deskjet 2720', context, index).drift, false);
  assert.equal(detectModelDrift('black printer ink multipack', context, index).drift, false);
});

test('uses token boundaries and does not confuse 305 with 3050', () => {
  const result = detectModelDrift('deskjet 3050 ink', context, index);
  assert.deepEqual(result.matched, ['DeskJet 3050']);
  assert.deepEqual(result.wrong, ['DeskJet 3050']);
});

test('does not guess when a SKU is absent from the SKU library', () => {
  const unknown = campaignModelContext({ ads: [{ sku: 'missing' }] }, [], index);
  assert.equal(detectModelDrift('545 ink', unknown, index).drift, false);
});
