import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'apetseller', PET_SP_BRAND: 'PawNest',
};

const tsv = (rows) => rows.map((row) => row.join('\t')).join('\r\n');
const LISTINGS = tsv([
  ['item-name', 'seller-sku', 'price', 'asin1', 'status'],
  ['Dog Bed Large', 'DOG-L', '39.99', 'B000000001', 'Active'],
  ['Dog Bed XL', 'DOG-XL', '49.99', 'B000000002', 'Active'],
]);
// 9/20 太平洋时间下午的订单、9/14 的上周订单、一条取消、一条加拿大站
const ORDERS = tsv([
  ['amazon-order-id', 'purchase-date', 'order-status', 'sales-channel', 'sku', 'asin', 'item-status', 'quantity'],
  ['111-1', '2026-09-20T22:00:00+00:00', 'Shipped', 'Amazon.com', 'DOG-L', 'B000000001', 'Shipped', '3'],
  ['111-0', '2026-09-14T20:00:00+00:00', 'Shipped', 'Amazon.com', 'DOG-L', 'B000000001', 'Shipped', '1'],
  ['111-2', '2026-09-20T20:00:00+00:00', 'Cancelled', 'Amazon.com', 'DOG-L', 'B000000001', 'Cancelled', '5'],
  ['111-3', '2026-09-20T20:00:00+00:00', 'Shipped', 'Amazon.ca', 'DOG-L', 'B000000001', 'Shipped', '7'],
  // 太平洋时间 9/22 凌晨,不算进 9/21 的快照
  ['111-4', '2026-09-22T08:30:00+00:00', 'Pending', 'Amazon.com', 'DOG-XL', 'B000000002', 'Unshipped', '2'],
  ['111-5', '2026-09-21T08:30:00+00:00', 'Pending', 'Amazon.com', 'DOG-XL', 'B000000002', 'Unshipped', '2'],
]);

function fakeAmazon({ failOn } = {}) {
  const calls = [];
  const reports = new Map();
  const gateway = {
    async request(account, region, method, path, { query, body } = {}) {
      calls.push({ method, path, query, body });
      assert.equal(account.sellerId, 'APETSELLER');
      assert.equal(region, 'na');
      if (failOn && path.includes(failOn)) throw new Error('亚马逊接口请求失败 (403)');
      if (method === 'POST' && path === '/reports/2021-06-30/reports') {
        assert.deepEqual(body.marketplaceIds, ['ATVPDKIKX0DER']);
        const id = `r${reports.size + 1}`;
        reports.set(id, body);
        return { reportId: id };
      }
      const report = /\/reports\/(r\d+)$/.exec(path);
      if (report) return { processingStatus: 'DONE', reportDocumentId: `doc-${report[1]}` };
      const document = /\/documents\/doc-(r\d+)$/.exec(path);
      if (document) return { reportDocumentId: document[1], url: document[1] };
      if (path === '/fba/inventory/v1/summaries') {
        if (!query.nextToken) return { payload: { inventorySummaries: [
          { sellerSku: 'DOG-L', asin: 'B000000001', inventoryDetails: { fulfillableQuantity: 25, inboundShippedQuantity: 3, inboundReceivingQuantity: 2 } },
        ] }, pagination: { nextToken: 'page-2' } };
        return { payload: { inventorySummaries: [
          { sellerSku: 'DOG-XL', asin: 'B000000002', inventoryDetails: { fulfillableQuantity: 0, inboundWorkingQuantity: 40 } },
        ] } };
      }
      if (path === '/catalog/2022-04-01/items') {
        return { items: query.identifiers.split(',').map((asin) => ({ asin, summaries: [
          { marketplaceId: 'ATVPDKIKX0DER', size: asin.endsWith('1') ? 'Large' : 'X-Large', color: 'Grey' },
        ] })) };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async download(document) {
      const body = reports.get(document.url);
      return body.reportType === 'GET_MERCHANT_LISTINGS_ALL_DATA' ? LISTINGS : ORDERS;
    },
  };
  return { gateway, calls, reports };
}

test('Amazon sync fills the shared SKU library and price snapshot without overwriting manual fields', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const call = async (path, cookie, body, method = 'POST') => {
    const response = await fetch(`${backend.url}/api${path}`, { method: body === undefined ? 'GET' : method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await call('/auth/login', null, { username: 'pet-owner', password: 'pet-test-password' })).cookie;
  const user = (await call('/auth/login', null, { username: 'pet-user', password: 'pet-test-password' })).cookie;
  assert.equal((await call('/price-strategy/rows', owner, { rows: [
    { date: '2026-09-21', sku: 'DOG-L', price: 19.99, totalStock: 40 },
    { date: '2026-09-21', sku: 'DOG-XL', price: -2 },
  ] })).status, 400);
  assert.equal((await call('/price-strategy?date=2026-09-21', user)).data.items.length, 0);
  // 人工录入的售价、总库存和广告点击/订单
  assert.equal((await call('/price-strategy/rows', owner, { rows: [
    { date: '2026-09-21', sku: 'DOG-L', price: 19.99, totalStock: 40, clicks7d: 12, adOrders7d: 2 },
  ] })).status, 200);
  // SKU 库已有 DOG-L,款式和尺码是人工填的
  assert.equal((await call('/sku/rows', owner, { rows: [{ sku: 'DOG-L', style: '圆形狗窝', size: 'L' }] })).status, 200);

  // 没配置凭证时不能同步
  assert.equal((await call('/price-strategy?date=2026-09-21', user)).data.sync.configured, false);
  assert.equal((await call('/price-strategy/sync', user, { date: '2026-09-21' })).status, 503);

  const { syncPriceStrategy, priceSyncStatus } = await import('../src/priceStrategySync.js');
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0;
  const amazon = fakeAmazon();
  const result = await syncPriceStrategy('2026-09-21', 1, amazon.gateway, ENV);
  assert.deepEqual({ ...result }, { date: '2026-09-21', skus: 2, listings: 2, inventorySkus: 2, orderLines: 4, skuAdded: 1, skuUpdated: 1 });

  // 订单报告覆盖月初到快照日次日 0 点(太平洋时间,夏令时 UTC-7)
  const orderReport = [...amazon.reports.values()].find((body) => body.reportType.includes('ORDERS'));
  assert.equal(orderReport.dataStartTime, '2026-09-01T07:00:00.000Z');
  assert.equal(orderReport.dataEndTime, '2026-09-22T07:00:00.000Z');

  const synced = (await call('/price-strategy?date=2026-09-21', user)).data;
  const dog = synced.items.find((row) => row.sku === 'DOG-L');
  const xl = synced.items.find((row) => row.sku === 'DOG-XL');
  assert.equal(dog.sales7d, 3);
  assert.equal(dog.movement7d, 3);
  assert.equal(dog.day6, 3);
  assert.equal(dog.monthlySales, 4);
  assert.equal(dog.monthlyOrders, 2);
  assert.equal(dog.orders7d, 1);
  assert.equal(dog.weekOverWeek, 200);
  assert.equal(dog.availableStock, 25);
  assert.equal(dog.inboundStock, 5);
  assert.equal(dog.turnoverWeeks, 13.33);
  assert.equal(dog.estimatedSelloutDate, '2026-12-24');
  assert.equal(dog.price, 19.99, '人工售价保留');
  assert.equal(dog.totalStock, 40);
  assert.equal(dog.clicks7d, 12, '人工广告点击保留');
  assert.equal(dog.conversion7d, 16.67);
  assert.equal(dog.style, '圆形狗窝');
  assert.equal(xl.price, 49.99, '空白售价用 Listing 价');
  assert.equal(xl.sales7d, 2);
  assert.equal(xl.day7, 2);
  assert.equal(xl.inboundStock, 40);
  assert.equal(synced.sync.lastSuccess.date, '2026-09-21');

  const skus = (await call('/sku', user)).data.items;
  const skuL = skus.find((row) => row.sku === 'DOG-L');
  const skuXl = skus.find((row) => row.sku === 'DOG-XL');
  assert.deepEqual([skuL.style, skuL.size, skuL.color, skuL.asin, skuL.stock, skuL.transit, skuL.brand],
    ['圆形狗窝', 'L', 'Grey', 'B000000001', 25, 5, 'PawNest']);
  assert.deepEqual([skuXl.size, skuXl.color, skuXl.asin, skuXl.stock, skuXl.transit, skuXl.brand],
    ['X-Large', 'Grey', 'B000000002', 0, 40, 'PawNest']);

  // 再同步一次不重复建行,也不再请求已有尺码颜色的目录
  const again = fakeAmazon();
  const second = await syncPriceStrategy('2026-09-21', 1, again.gateway, ENV);
  assert.equal(second.skuAdded, 0);
  assert.equal(second.skuUpdated, 0);
  assert.equal(again.calls.filter((entry) => entry.path.includes('/catalog/')).length, 0);
  assert.equal((await call('/price-strategy?date=2026-09-21', owner)).data.items.length, 2);

  // 失败会记录阶段,不动已保存的数据
  await assert.rejects(syncPriceStrategy('2026-09-20', 1, fakeAmazon({ failOn: '/fba/inventory' }).gateway, ENV), /读取 FBA 库存.*403/);
  const status = priceSyncStatus(ENV);
  assert.match(status.lastError.message, /读取 FBA 库存/);
  assert.equal(status.lastSuccess.date, '2026-09-21');
  assert.equal((await call('/price-strategy?date=2026-09-21', user)).data.items.find((row) => row.sku === 'DOG-L').price, 19.99);
  await assert.rejects(syncPriceStrategy('2999-01-01', 1, amazon.gateway, ENV), /还没有开始/);

  assert.equal((await call(`/price-strategy/${dog.id}`, user, {}, 'DELETE')).status, 200);
  assert.equal((await call('/price-strategy?date=2026-09-21', owner)).data.items.length, 1);
});

test('pet SP-API settings are read from PET_SP_* only and gaps are named', async () => {
  const { petSpConfig, pacificMidnight, pacificDay, parseTsv } = await import('../src/petAmazon.js');
  assert.equal(petSpConfig({ BRAND1_LWA_CLIENT_ID: 'ink' }).account, null);
  assert.deepEqual(petSpConfig({ BRAND1_LWA_CLIENT_ID: 'ink' }).issues, []);
  assert.deepEqual(petSpConfig({ PET_SP_LWA_CLIENT_ID: 'x', PET_SP_SELLER_ID: 'y' }).issues,
    ['亚马逊 SP-API 配置缺少 PET_SP_LWA_CLIENT_SECRET、PET_SP_LWA_REFRESH_TOKEN']);
  assert.deepEqual(petSpConfig(ENV).account.markets, ['US']);
  // 冬令时 UTC-8,夏令时 UTC-7
  assert.equal(pacificMidnight('2026-01-15').toISOString(), '2026-01-15T08:00:00.000Z');
  assert.equal(pacificMidnight('2026-07-15').toISOString(), '2026-07-15T07:00:00.000Z');
  assert.equal(pacificDay('2026-09-21T06:59:00Z'), '2026-09-20');
  assert.deepEqual(parseTsv('﻿seller-sku\tPrice\r\nA\t1.5\r\n\r\n'), [{ 'seller-sku': 'A', price: '1.5' }]);
});
