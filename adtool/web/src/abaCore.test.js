import test from 'node:test';
import assert from 'node:assert/strict';
import { abaCoreMatcher } from '../../shared/abaCore.js';

const classify = abaCoreMatcher([{ brand: 'HP', term: '305 / 67', printer: '2720', series: 'DeskJet' },
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

test('four digit runs are printer evidence; generic and incomplete core terms remain separate', () => {
  assert.deepEqual(classify('cartouche hp 9999').printerNumbers, ['9999']);
  assert.deepEqual(classify('hp 305 ink deskjet2720e').printerNumbers, ['2720']);
  assert.deepEqual(classify('hp 3050 ink').printerNumbers, ['3050']);
  assert.deepEqual(classify('hp 305 ink 10000').printerNumbers, [], 'never extract four digits from a longer number');
  for (const query of ['cartouche imprimante', 'encre noire', 'tinta negra']) assert.equal(classify(query).core.label, '墨盒泛词');
  for (const query of ['hp 305', 'cartouche 305', 'sin coincidencia', 'canon 260261 ink']) assert.equal(classify(query).core.label, '未识别核心词');
  assert.equal(classify('hp canon 305 ink').core.label, '多品牌 / 待核对');
  assert.equal(classify('HP 305 ink').core.key, classify('cartouche hp305xl').core.key);
});
