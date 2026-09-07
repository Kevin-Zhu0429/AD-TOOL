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

test('treats HP 305 and 305XL as ink models instead of inventing a TS305 printer match', () => {
  const hpLib = {
    libs: [{ id: 'D', special: 'series' }],
    items: { D: [
      { brand: 'HP', term: '305', printer: 'DeskJet 2700' },
      { brand: 'Canon', term: '545, 546', printer: 'TS305' },
    ] },
  };
  const hpIndex = buildDModelIndex(hpLib);
  const canonContext = campaignModelContext(
    { ads: [{ sku: 'CANON-545' }] }, [{ sku: 'CANON-545', model: '545' }], hpIndex,
  );
  for (const term of ['tinta impresora hp 305', 'cartucho tinta hp 305', 'tinta 305 xl']) {
    const result = detectModelDrift(term, canonContext, hpIndex);
    assert.equal(result.drift, true);
    assert.equal(result.review, false);
    assert.deepEqual(result.wrong, ['305']);
    assert.equal(result.findings[0].reason, '本活动中未投放 305 系列');
  }
});

test('does not guess when a SKU is absent from the SKU library', () => {
  const unknown = campaignModelContext({ ads: [{ sku: 'missing' }] }, [], index);
  assert.equal(detectModelDrift('545 ink', unknown, index).drift, false);
});

test('uses printer prefix, then brand, and asks for review when a number is ambiguous', () => {
  const ambiguousLib = {
    libs: [{ id: 'D', special: 'series' }],
    items: { D: [
      { brand: 'Canon', term: '510', printer: 'MP260' },
      { brand: 'HP', term: '301', printer: 'DeskJet 260' },
    ] },
  };
  const ambiguousIndex = buildDModelIndex(ambiguousLib);
  const hpContext = campaignModelContext(
    { ads: [{ sku: 'HP-301' }] }, [{ sku: 'HP-301', model: '301XL' }], ambiguousIndex,
  );

  assert.equal(detectModelDrift('ink for mp 260', hpContext, ambiguousIndex).findings[0].series, '510');
  assert.equal(detectModelDrift('canon printer 260', hpContext, ambiguousIndex).findings[0].series, '510');
  assert.equal(detectModelDrift('hp printer 260', hpContext, ambiguousIndex).drift, false);
  const unclear = detectModelDrift('printer ink 260', hpContext, ambiguousIndex);
  assert.equal(unclear.review, true);
  assert.match(unclear.findings[0].reason, /需要自行判断/);
});
