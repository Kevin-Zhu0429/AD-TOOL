import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

test('shared price snapshots validate atomically and Captain metrics preserve manual prices', async (t) => {
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
  assert.equal((await call('/price-strategy/rows', owner, { rows: [{ date: '2026-09-21', sku: 'DOG-L', price: 19.99, totalStock: 40 }] })).status, 200);
  assert.equal((await call('/price-strategy?date=2026-09-21', user)).data.items[0].price, 19.99);
  const { syncPriceStrategy } = await import('../src/priceStrategySync.js');
  const stamp = (day) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);
  let adApiCalls = 0;
  const gateway = { discoverChannels: async () => [{ channels: [{ country: 'US', openChannelId: 'us-shop' }] }],
    paged: async (path, query) => {
      if (path.includes('get_order_list')) return [
        { AmazonOrderId: 'ORDER-1', OrderStatus: 'Shipped', LocalDate: stamp('2026-09-20'), order_item: [{ OrderItemId: 'ITEM-1', SellerSKU: 'DOG-L', ASIN: 'B000000001', QuantityOrdered: 3 }] },
        { AmazonOrderId: 'ORDER-0', OrderStatus: 'Shipped', LocalDate: stamp('2026-09-14'), order_item: [{ OrderItemId: 'ITEM-0', SellerSKU: 'DOG-L', ASIN: 'B000000001', QuantityOrdered: 1 }] },
      ];
      if (path.endsWith('/advertise')) {
        assert.equal(query.type, 1);
        assert.ok(query.start_modified_time > 0);
        assert.ok(query.end_modified_time > query.start_modified_time);
        assert.ok(query.end_modified_time - query.start_modified_time <= 30 * 86400);
        adApiCalls++;
        return adApiCalls === 1 ? [{ adId: 'ad-1', sku: 'DOG-L' }] : [];
      }
      if (path.endsWith('/advertise_report')) return query.report_date === '20260920' ? [{ adId: 'ad-1', clicks: 12, ad_order_num: 2 }] : [];
      if (path.includes('inventory_list')) return [{ SKU: 'DOG-L', fulfillable_quantity: 25, inbound_shipped_quantity: 5 }];
      return [];
    } };
  const result = await syncPriceStrategy('2026-09-21', 1, gateway);
  assert.equal(result.channels, 1);
  const synced = (await call('/price-strategy?date=2026-09-21', user)).data;
  assert.equal(synced.items[0].sales7d, 3);
  assert.equal(synced.items[0].movement7d, 3);
  assert.equal(synced.items[0].turnoverWeeks, 13.33);
  assert.equal(synced.items[0].estimatedSelloutDate, '2026-12-24');
  assert.equal(synced.items[0].monthlySales, 4);
  assert.equal(synced.items[0].monthlyOrders, 2);
  assert.equal(synced.items[0].orders7d, 1);
  assert.equal(synced.items[0].weekOverWeek, 200);
  assert.equal(synced.items[0].clicks7d, 12);
  assert.equal(synced.items[0].adOrders7d, 2);
  assert.equal(synced.items[0].conversion7d, 16.67);
  assert.equal(synced.items[0].availableStock, 25);
  assert.equal(synced.items[0].inboundStock, 5);
  assert.equal(synced.items[0].price, 19.99);
  assert.equal(synced.items[0].totalStock, 40);
  assert.equal(synced.items[0].day6, 3);
  assert.equal(synced.items[0].adSales7d, null);
  await syncPriceStrategy('2026-09-21', 1, gateway);
  assert.equal((await call('/price-strategy?date=2026-09-21', owner)).data.items.length, 1);
  assert.equal((await call('/price-strategy?date=2026-09-21', owner)).data.items[0].clicks7d, 12);
  await assert.rejects(syncPriceStrategy('2026-09-21', 1, {
    ...gateway,
    discoverChannels: async () => [{ channels: [
      { country: 'US', openChannelId: 'us-shop' }, { country: 'US', openChannelId: 'another-us-shop' },
    ] }],
  }), /多个美国站店铺/);
  assert.equal((await call('/price-strategy?date=2026-09-21', user)).data.items[0].price, 19.99);
  assert.equal((await call(`/price-strategy/${synced.items[0].id}`, user, {}, 'DELETE')).status, 200);
  assert.equal((await call('/price-strategy?date=2026-09-21', owner)).data.items.length, 0);
});
