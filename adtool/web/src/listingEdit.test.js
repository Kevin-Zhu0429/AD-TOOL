import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffAttributes, localeOf, merchantQuantity, priceOf, setImageUrl, setMerchantQuantity, setPrice, setTextValues, textValues,
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
    { audience: 'ALL', currency: 'EUR', marketplace_id: M, our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] },
  ],
  fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }],
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

test('自发货库存可改，FBA 返回 null；图片地址清空即删除', () => {
  assert.equal(merchantQuantity(attributes), '7');
  assert.equal(setMerchantQuantity(attributes, '12').fulfillment_availability[0].quantity, 12);
  assert.equal(merchantQuantity({ fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] }), null);
  const withImage = setImageUrl(attributes, 'main_product_image_locator', ' https://example.com/a.jpg ', locale);
  assert.deepEqual(withImage.main_product_image_locator, [{ media_location: 'https://example.com/a.jpg', marketplace_id: M }]);
  assert.equal(setImageUrl(withImage, 'main_product_image_locator', '', locale).main_product_image_locator, undefined);
});
