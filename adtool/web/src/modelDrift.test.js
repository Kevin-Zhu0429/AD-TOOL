import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDModelIndex, campaignModelContext, detectModelDrift, resolveSearchModels, driftPresentation } from './modelDrift.js';

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
  for (const term of ['tinta impresora hp 305', 'cartucho tinta hp 305', 'tinta 305 xl', 'tinteiro 305']) {
    const result = detectModelDrift(term, canonContext, hpIndex);
    assert.equal(result.drift, true);
    assert.equal(result.review, false);
    assert.deepEqual(result.wrong, ['305']);
    assert.equal(result.findings[0].reason, '本活动中未投放 305 系列');
  }
  const hpContext = campaignModelContext(
    { ads: [{ sku: 'HP-305' }] }, [{ sku: 'HP-305', model: '305' }], hpIndex,
  );
  const printer = detectModelDrift('tinta para ts 305', hpContext, hpIndex);
  assert.deepEqual(printer.matched, ['TS305']);
  assert.deepEqual(printer.wrong, ['TS305']);
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

test('combines the D-table printer series column with numeric printer models', () => {
  const splitPrinterLib = {
    libs: [{ id: 'D', special: 'series' }],
    items: { D: [
      { brand: 'Canon', term: '540, 541', series: 'MG', printer: '3550' },
      { brand: 'HP', term: '305', series: 'DeskJet', printer: '2700' },
    ] },
  };
  const splitIndex = buildDModelIndex(splitPrinterLib);
  const hpContext = campaignModelContext(
    { ads: [{ sku: 'HP-305' }] }, [{ sku: 'HP-305', model: '305XL' }], splitIndex,
  );
  const result = detectModelDrift('tinta canon mg 3550 color', hpContext, splitIndex);
  assert.equal(result.review, false);
  assert.deepEqual(result.wrong, ['MG3550']);
  assert.equal(result.findings[0].reason, 'MG3550 机型为 540, 541 系列的机型，本活动中未投放 540, 541 系列');
});

test('recognizes a number as a printer when it does not exist in the ink-model column', () => {
  const printerOnlyLib = {
    libs: [{ id: 'D', special: 'series' }],
    items: { D: [
      { brand: 'Canon', term: '545, 546', series: 'TR', printer: '4755i' },
      { brand: 'HP', term: '305', series: 'DeskJet', printer: '2700' },
    ] },
  };
  const printerOnlyIndex = buildDModelIndex(printerOnlyLib);
  const hpContext = campaignModelContext(
    { ads: [{ sku: 'HP-305' }] }, [{ sku: 'HP-305', model: '305' }], printerOnlyIndex,
  );
  const result = detectModelDrift('4755i cartucho', hpContext, printerOnlyIndex);
  assert.equal(result.review, false);
  assert.deepEqual(result.wrong, ['TR4755i']);
});

// Representative D-table relationships from the reported European search terms.
const regressionRows = [
  { brand: 'HP', term: '350, 351', series: 'DeskJet', printer: 'D4200' },
  { brand: 'HP', term: '21, 22', series: 'DeskJet', printer: 'F350' },
  { brand: 'Canon', term: '510, 511', series: 'MX', printer: 'MX350' },
  { brand: 'HP', term: '305', series: 'DeskJet', printer: '2700' },
  { brand: 'Canon', term: '545, 546', series: 'TS', printer: 'TS305' },
  { brand: 'HP', term: '21, 22', series: 'OfficeJet', printer: '4310' },
  { brand: 'HP', term: '308', series: 'DeskJet', printer: '4310' },
  { brand: 'HP', term: '338, 343', series: 'PhotoSmart', printer: '2570' },
  { brand: 'HP', term: '337, 343', series: 'PhotoSmart', printer: '2570' },
  { brand: 'HP', term: '336, 342', series: 'PhotoSmart', printer: '2570' },
  { brand: 'HP', term: '110', series: 'PhotoSmart', printer: '2570' },
  { brand: 'HP', term: '56, 57', series: 'DeskJet', printer: '5550' },
  { brand: 'HP', term: '27, 28', series: 'DeskJet', printer: '3500' },
];
const regressionIndex = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: regressionRows } });
const campaignFor = (...models) => campaignModelContext(
  { ads: models.map((model) => ({ sku: `SKU-${model}` })) },
  models.map((model) => ({ sku: `SKU-${model}`, model })), regressionIndex,
);
const check = (term, ...models) => detectModelDrift(term, campaignFor(...models), regressionIndex);

test('resolves cartridge context, XL and known pairs before bare printer numbers', () => {
  const terms = [
    'cartouche hp 350 xl noir', 'cartouche hp 350 xl', 'hp 350 xl', 'hp350xl',
    'cartouche hp 350', 'cartouche hp 350 et 351 noir et couleur', 'cartouche hp 350/351',
    "cartouche d’encre hp 350 et 351", '350/351', '350 and 351', '350 und 351',
    '350 y 351', '350 e 351', '350 + 351', '350,351',
    'hp 350/351 sd412ee pack de 2, cartouche d’encre authentique, imprimantes deskjet, photosmart',
  ];
  for (const term of terms) {
    assert.equal(check(term, '350').status, 'matched', term);
    const wrong = check(term, '305');
    assert.equal(wrong.status, 'drift', term);
    assert.ok(wrong.matched.every((label) => ['350', '351'].includes(label)), term);
  }
});

test('handles localized cartridge words and known brand concatenation', () => {
  for (const term of ['cartouche hp305', 'hp305xl', 'HP305XL', 'ＨＰ３０５ＸＬ', 'cartouches hp 305 couleur',
    'tinte hp 305', 'tintenpatrone hp 305', 'cartuccia hp305', 'tinteiro hp305', '305xl hp']) {
    assert.equal(check(term, '350').status, 'drift', term);
    assert.deepEqual(check(term, '350').wrong, ['305'], term);
    assert.equal(check(term, '305').status, 'matched', term);
  }
});

test('retains explicit printer prefixes and full alphanumeric boundaries', () => {
  for (const term of ['ts305', 'ts 305', 'cartouche canon TS-305']) {
    assert.deepEqual(check(term, '305').wrong, ['TS305'], term);
  }
  for (const term of ['cartouche canon mx350', 'canon MX 350', 'mx-350']) {
    assert.deepEqual(check(term, '350').wrong, ['MX350'], term);
  }
  assert.deepEqual(check('cartouche hp f 350', '350').wrong, ['F350']);
  for (const term of ['hp3050', '30500', 'B0HP305XL', 'abc305', '305xyz', 'x350xl', '3500a']) {
    assert.equal(check(term, '350').status, 'unrecognized', term);
  }
  assert.deepEqual(check('hp 3500', '305').wrong, ['DESKJET3500']);
});

test('a Canon cartridge pair raises a brand conflict without inventing MX350', () => {
  for (const term of ["cartouche d'encre canon350 et 351", "cartouche d'encre canon 350 et 351", 'canon 350/351']) {
    const result = check(term, '350');
    assert.equal(result.status, 'brand_conflict', term);
    assert.equal(result.drift, false);
    assert.ok(!JSON.stringify(result).includes('MX350'));
    assert.match(result.findings[0].reason, /CANON.*350.*HP/);
  }
  assert.equal(check('cartouche canon305', '305').status, 'brand_conflict');
  assert.equal(check('cartouche hp MX350', '510').status, 'brand_conflict');
});

test('4310 review explains both candidate printers, cartridges and campaign coverage', () => {
  const result = check('hp 4310', '21');
  assert.equal(result.status, 'review');
  assert.match(result.findings[0].reason, /OFFICEJET4310（21, 22 墨盒，本活动已投放对应系列）/);
  assert.match(result.findings[0].reason, /DESKJET4310（308 墨盒，本活动未投放对应系列）/);
  assert.equal(check('hp 4310', '21', '308').status, 'matched');
  assert.equal(check('hp 4310', '350').status, 'drift');
  assert.deepEqual(check('hp officejet 4310', '350').wrong, ['OFFICEJET4310']);
  assert.deepEqual(check('hp deskjet 4310', '350').wrong, ['DESKJET4310']);
});

test('complete same-brand and same-series printers accept multiple compatible cartridge groups', () => {
  const result = check('amazon cartouche encre hp 2570', '338');
  assert.equal(result.status, 'matched');
  assert.equal(check('hp photosmart2570', '110').status, 'matched');
  const wrong = check('hp photosmart2570', '350');
  assert.equal(wrong.status, 'drift');
  for (const term of ['338, 343', '337, 343', '336, 342', '110']) assert.ok(wrong.findings[0].reason.includes(term));
  const duplicateIndex = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: [regressionRows[5], regressionRows[5],
    { ...regressionRows[5], term: '22, 21XL, 21' }] } });
  const ctx = campaignModelContext({ ads: [{ sku: '21' }] }, [{ sku: '21', model: '21' }], duplicateIndex);
  assert.equal(detectModelDrift('hp 4310', ctx, duplicateIndex).status, 'matched');
});

test('multiple mappings without a complete series-qualified identity still require review', () => {
  const unresolvedIndex = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: [
    { brand: 'HP', term: '45', printer: '9999' },
    { brand: 'HP', term: '78', printer: '9999' },
  ] } });
  const ctx = campaignModelContext({ ads: [{ sku: '45' }] }, [{ sku: '45', model: '45' }], unresolvedIndex);
  assert.equal(detectModelDrift('hp 9999', ctx, unresolvedIndex).status, 'mapping_conflict');
});

test('reported K7108 and MP210 relationships are treated as compatible alternatives', () => {
  const compatibleIndex = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: [
    { brand: 'HP', term: '339, 344', series: 'OfficeJet', printer: 'K7108' },
    { brand: 'HP', term: '338, 343', series: 'OfficeJet', printer: 'K7108' },
    { brand: 'HP', term: '337, 343', series: 'OfficeJet', printer: 'K7108' },
    { brand: 'Canon', term: '37, 38', series: 'PIXMA', printer: 'MP210' },
    { brand: 'Canon', term: '40, 41', series: 'PIXMA', printer: 'MP210' },
  ] } });
  const contextFor = (model) => campaignModelContext(
    { ads: [{ sku: `SKU-${model}` }] }, [{ sku: `SKU-${model}`, model }], compatibleIndex,
  );
  assert.equal(detectModelDrift('ink for hp K7108', contextFor('338'), compatibleIndex).status, 'matched');
  assert.equal(detectModelDrift('canon MP210 printer', contextFor('40'), compatibleIndex).status, 'matched');
  assert.equal(detectModelDrift('ink for hp K7108', contextFor('40'), compatibleIndex).status, 'drift');
});

test('mixed relevant and unrelated demand is partial instead of definite drift', () => {
  for (const term of ["cartouche d'encre 56 ou 27", '56 or 27', '56/27', '56 et 27']) {
    const result = check(term, '56');
    assert.equal(result.status, 'partial', term);
    assert.equal(result.drift, false);
    assert.equal(result.review, true);
    assert.match(result.findings[0].reason, /56.*已匹配.*27.*未匹配/);
    assert.equal(check(term, '350').status, 'drift');
    assert.equal(check(term, '56', '27').status, 'matched');
  }
});

test('missing SKUs and missing D mappings cannot establish that a series is absent', () => {
  for (const extra of [{ sku: 'missing' }, { sku: 'unmapped' }, { sku: '' }]) {
    const ctx = campaignModelContext({ ads: [{ sku: 'known' }, extra] },
      [{ sku: 'known', model: '350' }, { sku: 'unmapped', model: '99999' }], regressionIndex);
    const result = detectModelDrift('cartouche hp 305', ctx, regressionIndex);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.drift, false);
    assert.deepEqual(result.wrong, []);
    assert.ok(!JSON.stringify(result).includes('本活动中未投放'));
    assert.equal(detectModelDrift('black ink multipack', ctx, regressionIndex).status, 'unrecognized');
  }
  const unknown = campaignModelContext({ ads: [{ sku: 'missing' }] }, [], regressionIndex);
  assert.equal(detectModelDrift('hp 305', unknown, regressionIndex).status, 'insufficient');
});

test('a printer in another span does not erase an explicit cartridge mention', () => {
  const result = check('cartouche hp 350 xl pour hp f350', '350');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.matched, ['350', 'F350']);
  assert.equal(check('cartouche hp 350 et cartouche canon 545', '350', '545').status, 'matched');
  assert.equal(check('hp 4310 cartouche 350 xl', '350').status, 'partial');
});

test('SKU seller brands cannot override OEM mappings and OEM collisions remain incomplete', () => {
  const collisionIndex = buildDModelIndex({ libs: [{ id: 'D' }], items: { D: [
    regressionRows[0], { brand: 'Canon', term: '350', printer: 'XX123' },
  ] } });
  const ctx = (model) => campaignModelContext({ ads: [{ sku: 'test' }] }, [{ sku: 'test', model, brand: 'MySeller' }], collisionIndex);
  assert.equal(ctx('350').incomplete, true);
  assert.equal(ctx('HP 350').incomplete, false);
  assert.equal(detectModelDrift('cartouche canon350', ctx('HP 350'), collisionIndex).status, 'drift');
});

test('search interpretation is independent of campaign and result labels use one vocabulary', () => {
  assert.equal(resolveSearchModels('cartouche hp350', regressionIndex)[0].type, 'model');
  assert.equal(resolveSearchModels('hp350', regressionIndex)[0].type, 'ambiguous');
  for (const [term, model, label] of [
    ['hp305xl', '350', '疑似跑偏'], ['hp 4310', '21', '需人工判断'], ['canon 350/351', '350', '需核对品牌'],
    ['56 ou 27', '56', '部分匹配'], ['hp 2570', '338', '匹配'],
  ]) {
    const result = check(term, model);
    assert.equal(driftPresentation(result).label, label);
    assert.equal(driftPresentation(result).tone, result.drift ? 'bad' : result.status === 'matched' ? 'good' : 'warn');
  }
});
