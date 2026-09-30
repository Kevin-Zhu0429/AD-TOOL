import test from 'node:test';
import assert from 'node:assert/strict';
import { countryOfMarketplace, readSpApiConfig } from '../src/spApi.js';

test('each brand has its own app and one seller account per region', () => {
  const { brands, accounts, issues } = readSpApiConfig({
    BRAND3_NAME: 'CC',
    BRAND3_MARKETS: 'ES,DE,FR,IT,UK,US,CA',
    BRAND3_LWA_CLIENT_ID: 'cc-client',
    BRAND3_LWA_CLIENT_SECRET: 'cc-secret',
    BRAND3_LWA_REFRESH_TOKEN_EU: ' Atzr|cc-eu ',
    BRAND3_SELLER_ID_EU: 'a1cceu',
    BRAND3_LWA_REFRESH_TOKEN_NA: 'Atzr|cc-na',
    BRAND3_SELLER_ID_NA: 'A2CCNA',
    BRAND1_NAME: 'CE',
    BRAND1_LWA_CLIENT_ID: 'ce-client',
    BRAND1_LWA_CLIENT_SECRET: 'ce-secret',
    BRAND1_LWA_REFRESH_TOKEN_EU: 'Atzr|ce-eu',
    BRAND1_SELLER_ID_EU: 'A3CEEU',
  });
  assert.deepEqual(issues, []);
  // 按品牌编号排序;没填 MARKETS 的品牌读取该账号能管的全部站点(没单独配中东账号时 AE 归欧洲)
  assert.deepEqual(brands, [
    { name: 'CE', markets: [], accounts: [{ slot: 'eu', sellerId: 'A3CEEU' }] },
    { name: 'CC', markets: ['ES', 'DE', 'FR', 'IT', 'UK', 'US', 'CA'], accounts: [
      { slot: 'eu', sellerId: 'A1CCEU' }, { slot: 'na', sellerId: 'A2CCNA' },
    ] },
  ]);
  assert.deepEqual(accounts.map(({ brand, slot, region, sellerId, refreshToken, clientId, clientSecret, markets, allMarkets }) => (
    { brand, slot, region, sellerId, refreshToken, clientId, clientSecret, markets, allMarkets }
  )), [
    { brand: 'CE', slot: 'eu', region: 'eu', sellerId: 'A3CEEU', refreshToken: 'Atzr|ce-eu', clientId: 'ce-client', clientSecret: 'ce-secret', markets: ['ES', 'DE', 'FR', 'IT', 'UK', 'AE'], allMarkets: true },
    { brand: 'CC', slot: 'eu', region: 'eu', sellerId: 'A1CCEU', refreshToken: 'Atzr|cc-eu', clientId: 'cc-client', clientSecret: 'cc-secret', markets: ['ES', 'DE', 'FR', 'IT', 'UK'], allMarkets: false },
    { brand: 'CC', slot: 'na', region: 'na', sellerId: 'A2CCNA', refreshToken: 'Atzr|cc-na', clientId: 'cc-client', clientSecret: 'cc-secret', markets: ['US', 'CA'], allMarkets: false },
  ]);
});

test('incomplete brand settings are reported instead of guessed', () => {
  const app = (n) => ({ [`BRAND${n}_LWA_CLIENT_ID`]: 'id', [`BRAND${n}_LWA_CLIENT_SECRET`]: 'secret' });
  const { brands, issues } = readSpApiConfig({
    // 没有品牌名
    ...app(1), BRAND1_LWA_REFRESH_TOKEN_EU: 'r', BRAND1_SELLER_ID_EU: 'S1',
    // 缺应用密钥
    BRAND2_NAME: 'PG', BRAND2_LWA_CLIENT_ID: 'id', BRAND2_LWA_REFRESH_TOKEN_EU: 'r', BRAND2_SELLER_ID_EU: 'S2',
    // 北美只填了 token;MARKETS 有不支持的 MX,US / CA 因此没有账号
    BRAND3_NAME: 'CY', ...app(3), BRAND3_MARKETS: 'es，gb MX US CA',
    BRAND3_LWA_REFRESH_TOKEN_EU: 'r', BRAND3_SELLER_ID_EU: 'S3', BRAND3_LWA_REFRESH_TOKEN_NA: 'r',
    // 和 CY 重名
    BRAND4_NAME: 'cy', ...app(4), BRAND4_LWA_REFRESH_TOKEN_EU: 'r', BRAND4_SELLER_ID_EU: 'S4',
    // 什么区域都没填
    BRAND5_NAME: 'CE', ...app(5),
    // 填了北美账号,MARKETS 却只有欧洲站点
    BRAND6_NAME: 'CC', ...app(6), BRAND6_MARKETS: 'ES',
    BRAND6_LWA_REFRESH_TOKEN_EU: 'r', BRAND6_SELLER_ID_EU: 'S6', BRAND6_LWA_REFRESH_TOKEN_NA: 'r', BRAND6_SELLER_ID_NA: 'S7',
  });
  assert.deepEqual(issues, [
    'BRAND1_NAME 没有填，BRAND1 的配置先不用',
    'PG 缺少 BRAND2_LWA_CLIENT_SECRET',
    'CY 的 BRAND3_MARKETS 里 MX 网站不支持，已忽略',
    'CY 北美账号缺少 BRAND3_SELLER_ID_NA',
    'CY 的 US、CA 没有对应的北美账号授权（要填 BRAND3_LWA_REFRESH_TOKEN_NA 和 BRAND3_SELLER_ID_NA），读取店铺时会跳过',
    'BRAND4_NAME 和前面的品牌重名（cy），BRAND4 的配置先不用',
    'CE 还没有填任何账号的 Refresh Token 和卖家编号',
    'CC 填了北美账号，但 BRAND6_MARKETS 里没有它管的站点，这个账号不会读取',
  ]);
  assert.deepEqual(brands.map((brand) => [brand.name, brand.markets]), [
    ['CY', ['ES', 'UK', 'US', 'CA']],
    ['CC', ['ES']],
  ]);
});

test('AU accounts use the _AU suffix (or Amazon\'s _FE) and typos are named', () => {
  const app = (n) => ({ [`BRAND${n}_LWA_CLIENT_ID`]: 'id', [`BRAND${n}_LWA_CLIENT_SECRET`]: 'secret' });
  const { brands, accounts, issues } = readSpApiConfig({
    BRAND1_NAME: 'CC', ...app(1), BRAND1_MARKETS: 'ES,US,AU',
    BRAND1_LWA_REFRESH_TOKEN_EU: 'r-eu', BRAND1_SELLER_ID_EU: 'CCEU',
    BRAND1_LWA_REFRESH_TOKEN_NA: 'r-na', BRAND1_SELLER_ID_NA: 'CCNA',
    BRAND1_LWA_REFRESH_TOKEN_AU: 'r-au', BRAND1_SELLER_ID_AU: 'ccau',
    BRAND2_NAME: 'PG', ...app(2), BRAND2_MARKETS: 'AU',
    BRAND2_LWA_REFRESH_TOKEN_FE: 'r-fe', BRAND2_SELLER_ID_FE: 'PGFE',
    // 按国家写了后缀:不认识,AU 也就没有授权
    BRAND3_NAME: 'CY', ...app(3), BRAND3_MARKETS: 'ES,AU',
    BRAND3_LWA_REFRESH_TOKEN_EU: 'r', BRAND3_SELLER_ID_EU: 'CYEU',
    BRAND3_LWA_REFRESH_TOKEN_AUS: 'r', BRAND3_SELLER_ID_AUS: 'CYAU',
    // 澳洲只填了 token,提示里用他在用的 _AU
    BRAND4_NAME: 'CE', ...app(4), BRAND4_MARKETS: 'AU', BRAND4_LWA_REFRESH_TOKEN_AU: 'r',
  });
  assert.deepEqual(accounts.map(({ brand, region, sellerId, markets }) => [brand, region, sellerId, markets]), [
    ['CC', 'eu', 'CCEU', ['ES']],
    ['CC', 'na', 'CCNA', ['US']],
    ['CC', 'fe', 'CCAU', ['AU']],
    ['PG', 'fe', 'PGFE', ['AU']],
    ['CY', 'eu', 'CYEU', ['ES']],
  ]);
  assert.deepEqual(brands.find((brand) => brand.name === 'CC').accounts.map((account) => account.slot), ['eu', 'na', 'au']);
  assert.deepEqual(issues, [
    'CY 的 BRAND3_LWA_REFRESH_TOKEN_AUS、BRAND3_SELLER_ID_AUS 不认识，已忽略（账号后缀只能是 EU / NA / AE / AU）',
    'CY 的 AU 没有对应的澳洲账号授权（要填 BRAND3_LWA_REFRESH_TOKEN_AU 和 BRAND3_SELLER_ID_AU），读取店铺时会跳过',
    'CE 澳洲账号缺少 BRAND4_SELLER_ID_AU',
  ]);
});

test('AE uses its own seller account when _AE is filled, otherwise the EU one', () => {
  const app = (n) => ({ [`BRAND${n}_LWA_CLIENT_ID`]: 'id', [`BRAND${n}_LWA_CLIENT_SECRET`]: 'secret' });
  const { accounts, issues } = readSpApiConfig({
    // 单独的中东账号:AE 归它,欧洲账号不再读 AE
    BRAND1_NAME: 'CC', ...app(1), BRAND1_MARKETS: 'ES,DE,UK,AE,AU',
    BRAND1_LWA_REFRESH_TOKEN_EU: 'r-eu', BRAND1_SELLER_ID_EU: 'CCEU',
    BRAND1_LWA_REFRESH_TOKEN_AE: 'r-ae', BRAND1_SELLER_ID_AE: 'CCAE',
    BRAND1_LWA_REFRESH_TOKEN_AU: 'r-au', BRAND1_SELLER_ID_AU: 'CCAU',
    // 不填 MARKETS 也一样:中东账号管 AE,欧洲账号管其余欧洲站点
    BRAND2_NAME: 'PG', ...app(2),
    BRAND2_LWA_REFRESH_TOKEN_EU: 'r-eu2', BRAND2_SELLER_ID_EU: 'PGEU',
    BRAND2_LWA_REFRESH_TOKEN_AE: 'r-ae2', BRAND2_SELLER_ID_AE: 'PGAE',
    // 没有中东账号:AE 跟着欧洲账号读
    BRAND3_NAME: 'CY', ...app(3), BRAND3_MARKETS: 'FR,AE',
    BRAND3_LWA_REFRESH_TOKEN_EU: 'r-eu3', BRAND3_SELLER_ID_EU: 'CYEU',
    // 只有 AE 没有任何授权:提示填中东账号
    BRAND4_NAME: 'CE', ...app(4), BRAND4_MARKETS: 'US,AE',
    BRAND4_LWA_REFRESH_TOKEN_NA: 'r-na4', BRAND4_SELLER_ID_NA: 'CENA',
  });
  assert.deepEqual(accounts.map(({ brand, slot, region, sellerId, markets }) => [brand, slot, region, sellerId, markets]), [
    ['CC', 'eu', 'eu', 'CCEU', ['ES', 'DE', 'UK']],
    ['CC', 'ae', 'eu', 'CCAE', ['AE']],
    ['CC', 'au', 'fe', 'CCAU', ['AU']],
    ['PG', 'eu', 'eu', 'PGEU', ['ES', 'DE', 'FR', 'IT', 'UK']],
    ['PG', 'ae', 'eu', 'PGAE', ['AE']],
    ['CY', 'eu', 'eu', 'CYEU', ['FR', 'AE']],
    ['CE', 'na', 'na', 'CENA', ['US']],
  ]);
  assert.deepEqual(issues, [
    'CE 的 AE 没有对应的中东账号授权（要填 BRAND4_LWA_REFRESH_TOKEN_AE 和 BRAND4_SELLER_ID_AE），读取店铺时会跳过',
  ]);
});

test('marketplace ids map back to the site codes the tool uses', () => {
  assert.equal(countryOfMarketplace('A1RKKUPIHCS9HS'), 'ES');
  assert.equal(countryOfMarketplace('A1F83G8C2ARO7P'), 'UK');
  assert.equal(countryOfMarketplace('ATVPDKIKX0DER'), 'US');
  assert.equal(countryOfMarketplace('A1805IZSGTT6HS'), null);
});
