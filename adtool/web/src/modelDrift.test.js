import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDModelIndex, campaignModelContext, detectModelDrift } from './modelDrift.js';

const lib = {
  libs: [{ id: 'D', special: 'series' }],
  items: { D: [
    { term: '301, 301XL', printer: 'DeskJet 2710, 2720' },
    { term: '305', printer: 'DeskJet 3050' },
    { term: '545', printer: 'PIXMA TS3350' },
  ] },
};
const index = buildDModelIndex(lib);
const context = campaignModelContext(
  { ads: [{ sku: 'SKU-301' }] },
  [{ sku: 'sku-301', model: 'HP 301XL' }],
  index,
);

test('finds a wrong cartridge or printer model for the advertised SKU', () => {
  assert.deepEqual(detectModelDrift('compatible ink 545', context, index).wrong, ['545']);
  assert.deepEqual(detectModelDrift('ink for PIXMA TS3350', context, index).wrong, ['PIXMA TS3350']);
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
