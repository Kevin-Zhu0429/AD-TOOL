import test from 'node:test';
import assert from 'node:assert/strict';
import { abaCoreMatcher } from '../../shared/abaCore.js';

const classify = abaCoreMatcher([{ brand: 'HP', term: '301 / 302 / 303 / 304 / 305 / 62 / 67', printer: '2720', series: 'DeskJet' },
  { brand: 'Canon', term: '545 / 546', printer: 'TS305', series: 'PIXMA' }]);

test('core categories accept market languages, word order, concatenated XL and two/three digit cartridge models', () => {
  for (const query of ['cartouche hp 305', 'hp 305 ink', 'ink cartridge HP305XL', 'cartuchos hp 305', 'tinta 305 hp',
    'HP 305 Druckerpatronen', 'Druckertinte HP 305', 'cartucce hp 305', 'inchiostro 305 hp', 'HP305XLink', 'Hewlett-Packard 305 ink',
    'حبر hp 305', 'خراطيش HP305XL', 'أحبار hp 305']) {
    assert.equal(classify(query).core.label, 'HP 305', query);
  }
  assert.equal(classify('HP 67XL ink cartridge').core.label, 'HP 67');
  assert.equal(classify('canonPG545XL ink').core.label, 'CANON 545');
  assert.equal(classify('canon 545/546 cartouche').core.label, 'CANON 545 / 546');
  assert.equal(classify('hp 305 ink 10 pack').core.label, 'HP 305', 'known model wins over a pack quantity');
  assert.equal(classify('HP 999 ink').core.label, 'HP 999', 'explicit structure does not require every cartridge to exist in D');
});

test('brand/model and bare model queries no longer require ink words or an explicit brand', () => {
  for (const [model, queries] of [
    ['305', ['hp 305', 'hp305xl', 'hp 305 xl nero', 'hp 305xl colore', '305xl nero', 'cartucce 305']],
    ['302', ['302 hp', 'hp 302 colore', '302xl', 'toner hp 302']],
    ['301', ['hp 301 xl', 'hp 301 colore', 'hp 301 nero e colore', '301xl', 'hp301']],
    ['304', ['hp 304', 'hp 304 xl']], ['303', ['hp 303']], ['62', ['hp 62', 'hp62 nero']],
  ]) for (const query of queries) assert.equal(classify(query).core.label, `HP ${model}`, query);
  assert.equal(classify('canon 541').core.label, 'CANON 541');
  assert.equal(classify('999xl').core.label, '999', 'unknown OEM keeps a numeric category');
  assert.equal(classify('cartouche 545/546').core.label, 'CANON 545 / 546');
  assert.equal(classify('305xl').core.key, classify('hp 305 ink').core.key);
  const ambiguous = abaCoreMatcher([{ brand: 'HP', term: '305' }, { brand: 'Canon', term: '305' }]);
  assert.equal(ambiguous('305xl').core.label, '305', 'shared model numbers never guess a brand');
  assert.equal(ambiguous('canon 305').core.label, 'CANON 305');
  assert.equal(ambiguous('hp canon 305').core.label, '多品牌 / 待核对');
});

test('four digit runs are printer evidence; broad terms are 超大词 and longer numbers stay unrecognized', () => {
  assert.deepEqual(classify('cartouche hp 9999').printerNumbers, ['9999']);
  assert.deepEqual(classify('hp 305 ink deskjet2720e').printerNumbers, ['2720']);
  assert.deepEqual(classify('hp 3050 ink').printerNumbers, ['3050']);
  assert.deepEqual(classify('hp 305 ink 10000').printerNumbers, [], 'never extract four digits from a longer number');
  for (const query of ['cartouche imprimante', 'encre noire', 'tinta negra', 'imprimante canon', 'imprimante canon pixma', 'hp deskjet'])
    assert.equal(classify(query).core.label, '超大词', query);
  for (const query of ['canon 260261 ink', 'hp 3050', 'hp 305 ink deskjet2720e']) assert.equal(classify(query).core.label, '未识别核心词');
  assert.equal(classify('hp canon 305 ink').core.label, '多品牌 / 待核对');
  assert.equal(classify('HP 305 ink').core.key, classify('cartouche hp305xl').core.key);
});
