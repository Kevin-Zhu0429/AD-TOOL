import test from 'node:test';
import assert from 'node:assert/strict';
import { changedAttributes, draftFrom, entriesOf, entryText, isSimple, parseJsonEntries, priceChanges, sameEntries, stripEntries, US } from './listingEdit.js';

test('attribute entries are edited without marketplace and language tags', () => {
  const attributes = {
    item_name: [{ value: 'Dog Bed', language_tag: 'en_US', marketplace_id: US }],
    material: [{ value: 'Oxford', language_tag: 'en_US', marketplace_id: US }, { value: 'Lona', language_tag: 'es_MX', marketplace_id: 'A1AM78C64UM0Y8' }],
    item_dimensions: [{ length: { value: 20, unit: 'inches' }, marketplace_id: US }],
  };
  const draft = draftFrom(attributes);
  assert.deepEqual(draft.material, [{ value: 'Oxford' }], '只留美国站');
  assert.deepEqual(draft.item_dimensions, [{ length: { value: 20, unit: 'inches' } }]);
  assert.deepEqual(stripEntries(null), []);
  assert.equal(isSimple('material', null, draft.material), true);
  assert.equal(isSimple('item_dimensions', null, draft.item_dimensions), false);
  assert.equal(isSimple('x', { simple: false }, [{ value: 'a' }]), false);
});

test('only changed attributes are uploaded; key order and spacing do not count', () => {
  const original = { a: [{ value: 'x  y' }], b: [{ length: { unit: 'in', value: 2 } }], c: [{ value: 'keep' }] };
  const draft = { a: [{ value: 'x y' }], b: [{ length: { value: 2, unit: 'in' } }], c: [{ value: 'changed' }], d: entriesOf(['', 'new ']) };
  assert.deepEqual(changedAttributes(original, draft), [{ attribute: 'c', value: [{ value: 'changed' }] }, { attribute: 'd', value: [{ value: 'new' }] }]);
  assert.equal(sameEntries([{ value: 1 }], [{ value: 2 }]), false);
});

test('price and sale price edits', () => {
  const live = { price: 25.99, sale: { price: 22.99, start: '2026-10-01', end: '2026-10-31' } };
  assert.deepEqual(priceChanges(live, { price: '25.99', salePrice: '22.99', saleStart: '2026-10-01', saleEnd: '2026-10-31' }), []);
  assert.deepEqual(priceChanges(live, { price: '24.99', salePrice: '22.99', saleStart: '2026-10-01', saleEnd: '2026-11-15' }), [
    { field: 'price', value: 24.99 }, { field: 'sale_price', value: 22.99, saleStart: '2026-10-01', saleEnd: '2026-11-15' }]);
  // 清空促销价 = 取消
  assert.deepEqual(priceChanges(live, { price: '25.99', salePrice: '', saleStart: '', saleEnd: '' }), [{ field: 'sale_price', value: 0, saleStart: undefined, saleEnd: undefined }]);
  assert.deepEqual(priceChanges({ price: 25.99, sale: null }, { price: '25.99', salePrice: '', saleStart: '', saleEnd: '' }), []);
});

test('JSON editing and display text', () => {
  assert.deepEqual(parseJsonEntries('{"length":{"value":1}}'), { value: [{ length: { value: 1 } }] });
  assert.match(parseJsonEntries('[1]').error, /对象/);
  assert.match(parseJsonEntries('{').error, /JSON/);
  assert.deepEqual(parseJsonEntries(' '), { value: [] });
  assert.equal(entryText({ value: 'Oxford' }), 'Oxford');
  assert.equal(entryText({ length: { value: 1 }, unit: 'in' }), 'length: {"value":1}, unit: in');
});
