import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};
const tsv = (head, rows) => [head.join('\t'), ...rows.map((row) => head.map((key) => row[key] ?? '').join('\t'))].join('\n');

const PLANNING_HEAD = ['snapshot-date', 'sku', 'fnsku', 'asin', 'product-name', 'available', 'inv-age-0-to-90-days', 'inv-age-91-to-180-days',
  'inv-age-181-to-270-days', 'inv-age-271-to-365-days', 'inv-age-365-plus-days', 'inv-age-0-to-30-days', 'inv-age-31-to-60-days', 'inv-age-61-to-90-days',
  'units-shipped-t30', 'units-shipped-t90', 'estimated-excess-quantity', 'fba-inventory-level-health-status', 'recommended-action',
  'quantity-to-be-charged-ais-181-210-days', 'estimated-ais-181-210-days', 'quantity-to-be-charged-ais-365-plus-days', 'estimated-ais-365-plus-days',
  'estimated-storage-cost-next-month', 'inbound-quantity', 'item-volume', 'volume-unit-measure'];
const PLANNING = [
  { 'snapshot-date': '2026-10-23', sku: 'DOG-XL', fnsku: 'X00XL', asin: 'B000000002', available: 120, 'inv-age-0-to-90-days': 20, 'inv-age-91-to-180-days': 60,
    'inv-age-181-to-270-days': 30, 'inv-age-271-to-365-days': 0, 'inv-age-365-plus-days': 10, 'inv-age-0-to-30-days': 5, 'inv-age-31-to-60-days': 5, 'inv-age-61-to-90-days': 10,
    'units-shipped-t30': 6, 'estimated-excess-quantity': 40, 'fba-inventory-level-health-status': 'Excess', 'recommended-action': 'Create a sale',
    'quantity-to-be-charged-ais-181-210-days': 30, 'estimated-ais-181-210-days': '15.60', 'quantity-to-be-charged-ais-365-plus-days': 10, 'estimated-ais-365-plus-days': '22.40',
    'estimated-storage-cost-next-month': '48.20', 'item-volume': '1.9', 'volume-unit-measure': 'cubic feet' },
  { 'snapshot-date': '2026-10-23', sku: 'DOG-S', fnsku: 'X00S', asin: 'B000000001', available: 15, 'inv-age-0-to-90-days': 15,
    'units-shipped-t30': 40, 'fba-inventory-level-health-status': 'Low stock', 'recommended-action': 'Restock', 'estimated-storage-cost-next-month': '2.10' },
];
const FEES_HEAD = ['asin', 'fnsku', 'product_name', 'fulfillment_center', 'country_code', 'item_volume', 'volume_units', 'product_size_tier',
  'average_quantity_on_hand', 'month_of_charge', 'base_rate', 'utilization_surcharge_rate', 'estimated_monthly_storage_fee'];
const FEES = {
  '2026-09': [
    { asin: 'B000000002', fnsku: 'X00XL', fulfillment_center: 'LGB8', country_code: 'US', average_quantity_on_hand: 80, month_of_charge: '2026-09', estimated_monthly_storage_fee: '30.00', product_size_tier: 'Large Bulky' },
    { asin: 'B000000002', fnsku: 'X00XL', fulfillment_center: 'ONT8', country_code: 'US', average_quantity_on_hand: 40, month_of_charge: '2026-09', estimated_monthly_storage_fee: '15.00', product_size_tier: 'Large Bulky' },
    { asin: 'B000000001', fnsku: 'X00S', fulfillment_center: 'LGB8', country_code: 'US', average_quantity_on_hand: 20, month_of_charge: '2026-09', estimated_monthly_storage_fee: '1.50' },
    { asin: 'B000000009', fnsku: 'X00ZZ', fulfillment_center: 'LGB8', country_code: 'CA', average_quantity_on_hand: 5, month_of_charge: '2026-09', estimated_monthly_storage_fee: '9.99' },
  ],
  '2026-08': [{ asin: 'B000000002', fnsku: 'X00XL', fulfillment_center: 'LGB8', country_code: 'US', average_quantity_on_hand: 130, month_of_charge: '2026-08', estimated_monthly_storage_fee: '40.00' }],
};
const AGED_HEAD = ['snapshot-date', 'sku', 'fnsku', 'asin', 'country', 'qty-charged', 'amount-charged', 'surcharge-age-tier', 'rate-surcharge'];
const AGED = {
  '2026-09': [{ 'snapshot-date': '2026-09-15', sku: 'DOG-XL', fnsku: 'X00XL', asin: 'B000000002', country: 'US', 'qty-charged': 25, 'amount-charged': '12.50', 'surcharge-age-tier': '181-210', 'rate-surcharge': '0.50' }],
  '2026-10': [{ 'snapshot-date': '2026-10-15', sku: 'DOG-XL', fnsku: 'X00XL', asin: 'B000000002', country: 'US', 'qty-charged': 30, 'amount-charged': '15.00', 'surcharge-age-tier': '181-210', 'rate-surcharge': '0.50' }],
};

/** 假亚马逊:按报告类型和月份返回 */
function fakeAmazon({ deniedFees = false } = {}) {
  const created = [];
  const gateway = {
    async request(account, region, method, path, { body } = {}) {
      if (method === 'POST') {
        if (deniedFees && body.reportType === 'GET_FBA_STORAGE_FEE_CHARGES_DATA') throw Object.assign(new Error('亚马逊接口请求失败 (403)'), { upstreamStatus: 403 });
        created.push(body);
        return { reportId: `r${created.length}` };
      }
      const report = /\/reports\/(r\d+)$/.exec(path);
      if (report) return { processingStatus: 'DONE', reportDocumentId: report[1] };
      const document = /\/documents\/(r\d+)$/.exec(path);
      if (document) return { url: document[1] };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async download(document) {
      const body = created[Number(document.url.slice(1)) - 1];
      // 太平洋时间 9 月 1 日 0 点 = UTC 9 月 1 日 07:00,按 +1 天取月份
      const month = body.dataStartTime ? new Date(Date.parse(body.dataStartTime) + 86400000).toISOString().slice(0, 7) : null;
      if (body.reportType === 'GET_FBA_INVENTORY_PLANNING_DATA') return tsv(PLANNING_HEAD, PLANNING);
      if (body.reportType === 'GET_FBA_STORAGE_FEE_CHARGES_DATA') return tsv(FEES_HEAD, FEES[month] ?? []);
      return tsv(AGED_HEAD, AGED[month] ?? []);
    },
  };
  return { gateway, created };
}

test('storage board: inventory planning, monthly storage fees and aged inventory surcharge', async (t) => {
  process.env.NODE_ENV = 'test';
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const { db } = backend;
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0; reportTiming.throttleMs = 0;
  const storage = await import('../src/petStorage.js');
  const sku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, stock, transit, dedupe) VALUES (-1, 'US', ?, ?, '方窝牛津', ?, 'Grey', ?, ?, ?)");
  sku.run('DOG-S', 'B000000001', 'S', 18, 200, 'us|dog-s');
  sku.run('DOG-XL', 'B000000002', 'XL', 125, 0, 'us|dog-xl');
  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  sale.run('2026-10-10', 'DOG-S', 'B000000001', 45, 45, 900);
  sale.run('2026-10-12', 'DOG-XL', 'B000000002', 5, 5, 300);
  sale.run('2026-09-10', 'DOG-XL', 'B000000002', 9, 9, 500);

  await t.test('parsers handle both age-column layouts, AIS tiers and old/new column names', () => {
    const plan = storage.planningFromReport(Object.fromEntries(Object.entries(PLANNING[0]).map(([key, value]) => [key, String(value)])));
    assert.deepEqual(plan.ages, { d0_90: 20, d91_180: 60, d181_365: 30, d365plus: 10 });
    assert.deepEqual(plan.aisTiers, [{ tier: '181-210', label: '181–210 天', quantity: 30, fee: 15.6 }, { tier: '365-plus', label: '365 天以上', quantity: 10, fee: 22.4 }]);
    assert.equal(plan.aisFee, 38);
    // 只有细分列(0-30 / 31-60 / 61-90、181-330 / 331-365)也能拼出四段
    assert.deepEqual(storage.ageBuckets({ 'inv-age-0-to-30-days': '1', 'inv-age-31-to-60-days': '2', 'inv-age-61-to-90-days': '3', 'inv-age-91-to-180-days': '4',
      'inv-age-181-to-330-days': '5', 'inv-age-331-to-365-days': '6', 'inv-age-365-plus-days': '7' }), { d0_90: 6, d91_180: 4, d181_365: 11, d365plus: 7 });
    assert.equal(storage.storageFeeFromReport({ asin: 'B1', country_code: 'CA', estimated_monthly_storage_fee: '1' }), null);
    const old = storage.agedChargeFromReport({ 'snapshot-date': '2023-02-15', sku: 'A', 'qty-charged-12-mo-long-term-storage-fee': '2', 'amount-charged-12-mo-long-term-storage-fee': '3.5',
      'qty-charged-6-mo-long-term-storage-fee': '1', 'amount-charged-6-mo-long-term-storage-fee': '1.25' });
    assert.equal(old.quantity, 3); assert.equal(old.amount, 4.75);
    assert.deepEqual(storage.monthsToFetch('2026-09', [], 3), ['2026-09', '2026-08', '2026-07']);
    assert.deepEqual(storage.monthsToFetch('2026-09', ['2026-07', '2026-08', '2026-09'], 3), ['2026-09', '2026-08']);
  });

  await t.test('sync pulls the three reports; a denied fee report does not lose the rest', async () => {
    const denied = fakeAmazon({ deniedFees: true });
    const partial = await storage.syncStorage({ backfill: 3 }, denied.gateway, ENV, '2026-10-24', new Date('2026-10-24T18:00:00Z'));
    assert.equal(partial.planning, 2);
    assert.equal(partial.errors.length, 3);
    assert.match(partial.errors[0], /Amazon Fulfillment/);
    assert.match(storage.storageSyncStatus(ENV).lastError.message, /月度仓储费/);

    const { gateway, created } = fakeAmazon();
    const result = await storage.syncStorage({ backfill: 3 }, gateway, ENV, '2026-10-24', new Date('2026-10-24T18:00:00Z'));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(created.map((body) => body.reportType.replace('GET_FBA_', '')), ['INVENTORY_PLANNING_DATA',
      'STORAGE_FEE_CHARGES_DATA', 'STORAGE_FEE_CHARGES_DATA', 'STORAGE_FEE_CHARGES_DATA',
      'FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA', 'FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA']);
    assert.deepEqual(result.fees, { '2026-09': 3, '2026-08': 1, '2026-07': 0 });
    assert.deepEqual(result.aged, { '2026-10': 1, '2026-09': 1 });
    assert.equal(storage.storageSyncStatus(ENV).lastError, null);
    // 下一次只刷新最近两个月
    const again = fakeAmazon();
    await storage.syncStorage({ backfill: 3 }, again.gateway, ENV, '2026-10-24', new Date('2026-10-24T18:00:00Z'));
    assert.equal(again.created.length, 1 + 2 + 2);
  });

  await t.test('board joins SKU library stock, age, AIS estimate and charged fees', async () => {
    process.env.PET_TODAY = '2026-10-24';
    const board = storage.storageBoard({ months: 3 });
    const xl = board.skus.find((row) => row.sku === 'DOG-XL');
    assert.equal(xl.style, '方窝牛津');
    assert.equal(xl.stock, 125); // SKU 库口径
    assert.equal(xl.aged181, 40);
    assert.equal(xl.aisFee, 38);
    assert.equal(xl.lastMonthFee, 45); // 9 月两个仓库合计
    assert.equal(xl.feePerUnit, 0.38);
    assert.equal(xl.feePerSold, 5);
    assert.equal(xl.agedCharged, 27.5);
    assert.equal(xl.health, '冗余');
    assert.equal(xl.recommendedAction, '建议做促销');
    assert.equal(board.skus[0].sku, 'DOG-XL');
    assert.equal(board.totals.aisFee, 38);
    assert.equal(board.totals.lastMonthFee, 46.5);
    assert.equal(board.totals.transit, 200);
    assert.deepEqual(board.monthly.map((row) => [row.month, row.storageFee, row.agedCharged]),
      [['2026-08', 40, 0], ['2026-09', 46.5, 12.5], ['2026-10', null, 15]]);
    const titles = board.findings.map((item) => item.title).join('\n');
    assert.match(titles, /1 个 SKU 有超过 180 天的库存，共 40 件/);
    assert.match(titles, /91–180 天的库存.*共 60 件/);
    assert.match(titles, /库存冗余/);
    assert.match(titles, /旺季仓储费/);
    assert.equal(board.styles[0].style, '方窝牛津');

    const login = await fetch(`${backend.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pet-user', password: 'pet-test-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${backend.url}/api/storage?months=6&style=${encodeURIComponent('方窝牛津')}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.skus.length, 2);
    assert.equal(data.monthly.length, 6);
    delete process.env.PET_TODAY;
  });
});
