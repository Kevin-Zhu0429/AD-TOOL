import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffAttributes, localeOf, themeAttributes, pageYieldOf, priceOf, salePriceOf, setPageYield, setPrice, setSalePrice, setTextValues, textValues,
} from './listingEdit.js';

const M = 'A1RKKUPIHCS9HS';
const attributes = {
  item_name: [{ value: 'Tinta 301', language_tag: 'es_ES', marketplace_id: M }],
  bullet_point: [
    { value: 'Uno', language_tag: 'es_ES', marketplace_id: M },
    { value: 'Dos', language_tag: 'es_ES', marketplace_id: M },
  ],
  purchasable_offer: [
    { audience: 'B2B', currency: 'EUR', marketplace_id: M, our_price: [{ schedule: [{ value_with_tax: 15 }] }] },
    { audience: 'ALL', currency: 'EUR', marketplace_id: M, our_price: [{ schedule: [{ value_with_tax: 19.99 }] }],
      discounted_price: [{ schedule: [{ value_with_tax: 16.19, start_at: '2026-08-26T07:00:00.000Z', end_at: '2026-12-31T08:00:00.000Z' }] }] },
  ],
  page_yield: [{ value: 480, marketplace_id: M }],
  color: [{ value: 'Negro', language_tag: 'es_ES', marketplace_id: M }],
};
const locale = localeOf(attributes, { marketplaceId: M, country: 'ES' });

test('五点改一条、加一条，只有五点算改动', () => {
  assert.deepEqual(locale, { marketplace_id: M, language_tag: 'es_ES' });
  const edited = setTextValues(attributes, 'bullet_point', ['Uno', 'Dos nuevo', 'Tres', ''], locale);
  assert.deepEqual(textValues(edited, 'bullet_point'), ['Uno', 'Dos nuevo', 'Tres']);
  assert.deepEqual(diffAttributes(attributes, edited), {
    bullet_point: [
      { language_tag: 'es_ES', value: 'Uno', marketplace_id: M },
      { language_tag: 'es_ES', value: 'Dos nuevo', marketplace_id: M },
      { language_tag: 'es_ES', value: 'Tres', marketplace_id: M },
    ],
  });
});

test('清空搜索词算删除；没改就没有改动', () => {
  assert.deepEqual(diffAttributes(attributes, setTextValues(attributes, 'color', [''], locale)), { color: null });
  assert.deepEqual(diffAttributes(attributes, { ...attributes }), {});
});

test('改价只动面向所有买家的报价，B2B 价不变', () => {
  assert.deepEqual(priceOf(attributes), { value: '19.99', currency: 'EUR' });
  const edited = setPrice(attributes, '17.5', { locale, currency: 'EUR' });
  assert.equal(edited.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 15);
  assert.equal(edited.purchasable_offer[1].our_price[0].schedule[0].value_with_tax, 17.5);
  assert.deepEqual(attributes.purchasable_offer[1].our_price[0].schedule[0].value_with_tax, 19.99);
});

test('促销价和日期：只改截止日期时开始时间原样保留，清空促销价就去掉', () => {
  assert.deepEqual(salePriceOf(attributes), { value: '16.19', start: '2026-08-26', end: '2026-12-31' });
  const edited = setSalePrice(attributes, { value: '15.5', start: '2026-08-26', end: '2027-01-15' }, { locale, currency: 'EUR' });
  assert.deepEqual(edited.purchasable_offer[1].discounted_price, [{ schedule: [
    { value_with_tax: 15.5, start_at: '2026-08-26T07:00:00.000Z', end_at: '2027-01-15T00:00:00.000Z' },
  ] }]);
  assert.equal(edited.purchasable_offer[1].our_price[0].schedule[0].value_with_tax, 19.99);
  const cleared = setSalePrice(attributes, { value: '', start: '', end: '' }, { locale, currency: 'EUR' });
  assert.equal(cleared.purchasable_offer[1].discounted_price, undefined);
  assert.ok(attributes.purchasable_offer[1].discounted_price);
});

test('打印页数可改，清空即删除', () => {
  assert.equal(pageYieldOf(attributes), '480');
  assert.deepEqual(setPageYield(attributes, '600', locale).page_yield, [{ value: 600, marketplace_id: M }]);
  assert.equal(setPageYield(attributes, '', locale).page_yield, undefined);
  assert.deepEqual(setPageYield({}, '300', locale).page_yield, [{ value: 300, marketplace_id: M }]);
});

test('变体主题换算成子体要带的属性，亚马逊给了就用亚马逊的', () => {
  assert.deepEqual(themeAttributes('SIZE_NAME/COLOR_NAME'), ['size', 'color']);
  assert.deepEqual(themeAttributes('COLOR'), ['color']);
  assert.deepEqual(themeAttributes('SET_NAME'), ['set_name']);
  assert.deepEqual(themeAttributes('COLOR', ['color', 'item_package_quantity']), ['color', 'item_package_quantity']);
});
