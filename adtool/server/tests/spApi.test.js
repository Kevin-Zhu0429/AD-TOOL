import test from 'node:test';
import assert from 'node:assert/strict';
import { countryOfMarketplace, spApiAccounts } from '../src/spApi.js';

test('SP-API accounts are read from numbered .env entries without guessing', () => {
  const base = { SPAPI_CLIENT_ID: 'client', SPAPI_CLIENT_SECRET: 'secret' };
  assert.deepEqual(spApiAccounts({ SPAPI_REFRESH_TOKEN: 'r', SPAPI_SELLER_ID: 's' }), []);

  const accounts = spApiAccounts({
    ...base,
    SPAPI_REFRESH_TOKEN: ' Atzr|one ',
    SPAPI_SELLER_ID: 'a1seller',
    SPAPI_STORE_NAME: 'CY',
    SPAPI_REGION: 'EU',
    // _2 缺卖家编号,跳过;_10 排在 _3 后面;重名的店铺名自动带上卖家编号
    SPAPI_REFRESH_TOKEN_2: 'Atzr|two',
    SPAPI_REFRESH_TOKEN_10: 'Atzr|ten',
    SPAPI_SELLER_ID_10: 'TEN',
    SPAPI_REFRESH_TOKEN_3: 'Atzr|three',
    SPAPI_SELLER_ID_3: 'THREE',
    SPAPI_STORE_NAME_3: 'cy',
    SPAPI_REGION_3: 'mars',
  });
  assert.deepEqual(accounts.map(({ sellerId, name, region, refreshToken }) => ({ sellerId, name, region, refreshToken })), [
    { sellerId: 'A1SELLER', name: 'CY', region: 'eu', refreshToken: 'Atzr|one' },
    { sellerId: 'THREE', name: 'cy-THREE', region: '', refreshToken: 'Atzr|three' },
    { sellerId: 'TEN', name: 'TEN', region: '', refreshToken: 'Atzr|ten' },
  ]);
  assert.ok(accounts.every((account) => account.clientId === 'client' && account.clientSecret === 'secret'));
});

test('marketplace ids map back to the site codes the tool uses', () => {
  assert.equal(countryOfMarketplace('A1RKKUPIHCS9HS'), 'ES');
  assert.equal(countryOfMarketplace('A1F83G8C2ARO7P'), 'UK');
  assert.equal(countryOfMarketplace('ATVPDKIKX0DER'), 'US');
  assert.equal(countryOfMarketplace('A1805IZSGTT6HS'), null);
});
