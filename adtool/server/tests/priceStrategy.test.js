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
// 今天固定为 2026-09-22(太平洋时间);近 7 天 = 9/15–9/21
const ORDERS = tsv([
  ['amazon-order-id', 'purchase-date', 'order-status', 'sales-channel', 'sku', 'asin', 'item-status', 'quantity', 'item-price'],
  ['111-1', '2026-09-20T22:00:00+00:00', 'Shipped', 'Amazon.com', 'DOG-L', 'B000000001', 'Shipped', '3', '89.97'],
  ['111-0', '2026-09-14T20:00:00+00:00', 'Shipped', 'Amazon.com', 'DOG-L', 'B000000001', 'Shipped', '1', '29.99'],
  ['111-2', '2026-09-20T20:00:00+00:00', 'Cancelled', 'Amazon.com', 'DOG-L', 'B000000001', 'Cancelled', '5', ''],
  ['111-3', '2026-09-20T20:00:00+00:00', 'Shipped', 'Amazon.ca', 'DOG-L', 'B000000001', 'Shipped', '7', '1'],
  // 太平洋时间 9/22 凌晨:算今天,不进近 7 天,但进本月
  ['111-4', '2026-09-22T08:30:00+00:00', 'Pending', 'Amazon.com', 'DOG-XL', 'B000000002', 'Unshipped', '2', ''],
  // 太平洋时间 9/21 凌晨,待付款没有金额,按 Listing 价 49.99 估算
  ['111-5', '2026-09-21T08:30:00+00:00', 'Pending', 'Amazon.com', 'DOG-XL', 'B000000002', 'Unshipped', '2', ''],
  // 8 月的订单只进 8 月的每月数据
  ['111-6', '2026-08-10T20:00:00+00:00', 'Shipped', 'Amazon.com', 'DOG-L', 'B000000001', 'Shipped', '4', '100'],
]);

// Fee Preview:DOG-L 售价 39.99 时佣金 6.00(15%),DOG-XL 没有费用数据的行要跳过
const FEES = tsv([
  ['sku', 'asin', 'your-price', 'sales-price', 'product-size-tier', 'estimated-referral-fee-per-unit', 'expected-fulfillment-fee-per-unit'],
  ['DOG-L', 'B000000001', '39.99', '--', 'Large Standard', '6.00', '7.25'],
  ['DOG-XL', 'B000000002', '49.99', '--', 'Large Standard', '--', '--'],
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
      if (failOn && body.reportType.includes(failOn)) throw new Error('下载亚马逊报告失败 (403)');
      return body.reportType === 'GET_MERCHANT_LISTINGS_ALL_DATA' ? LISTINGS
        : body.reportType === 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA' ? FEES : ORDERS;
    },
  };
  return { gateway, calls, reports };
}

test('Amazon sync fills the SKU library and daily sales; the price board and stats are computed for today', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.PET_TODAY = '2026-09-22';
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const call = async (path, cookie, body, method = 'POST') => {
    const response = await fetch(`${backend.url}/api${path}`, { method: body === undefined ? 'GET' : method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await call('/auth/login', null, { username: 'pet-owner', password: 'pet-test-password' })).cookie;
  const user = (await call('/auth/login', null, { username: 'pet-user', password: 'pet-test-password' })).cookie;
  // SKU 库已有 DOG-L,款式和尺码是人工填的
  assert.equal((await call('/sku/rows', owner, { rows: [{ sku: 'DOG-L', style: '圆形狗窝', size: 'L' }] })).status, 200);

  // 没配置凭证时不能同步
  const empty = (await call('/price-strategy', user)).data;
  assert.equal(empty.sync.configured, false);
  assert.equal(empty.today, '2026-09-22');
  assert.deepEqual([empty.days[0], empty.days[6]], ['2026-09-15', '2026-09-21']);
  assert.equal((await call('/price-strategy/sync', user, {})).status, 503);

  const { syncAmazonData, priceSyncStatus, orderSyncStart } = await import('../src/priceStrategySync.js');
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0;
  // 9/22 中午(太平洋时间)
  const now = () => new Date('2026-09-22T19:00:00Z');
  const amazon = fakeAmazon();
  // 同步过程中 /status 带进度:Listing、库存、尺码颜色、SKU 库、9 段订单、FBA 费用共 14 步
  const seen = [];
  const request = amazon.gateway.request;
  amazon.gateway.request = (...args) => { seen.push({ ...priceSyncStatus(ENV).progress }); return request(...args); };
  const result = await syncAmazonData(1, amazon.gateway, ENV, now);
  assert.equal(seen[0].total, 14);
  assert.deepEqual([seen[0].done, seen[0].step], [0, '读取 Listing']);
  const lastStep = seen.at(-1);
  assert.deepEqual([lastStep.done, lastStep.step], [13, '读取 FBA 费用']);
  assert.ok(seen.some((entry) => entry.step === '读取订单报告 9/9（2026-08-29 起）' && entry.done === 12 && entry.stage === 'processing'));
  assert.equal(priceSyncStatus(ENV).progress, null, '同步完清掉进度');
  assert.equal(result.from, '2026-01-01', '第一次回填到年初');
  assert.deepEqual([result.listings, result.inventorySkus, result.skuAdded, result.skuUpdated], [2, 2, 1, 1]);

  // 订单报告按 30 天一段,从 1/1 太平洋 0 点到现在之前
  const orderReports = [...amazon.reports.values()].filter((body) => body.reportType.includes('ORDERS'));
  assert.equal(orderReports.length, 9);
  assert.equal(orderReports[0].dataStartTime, '2026-01-01T08:00:00.000Z');
  assert.equal(orderReports.at(-1).dataEndTime, '2026-09-22T18:55:00.000Z');
  // 假接口每段都返回同一批订单;只有落在该段日期内的才写入,不会重复计数
  const board = (await call('/price-strategy', user)).data;
  const dog = board.rows.find((row) => row.sku === 'DOG-L');
  const xl = board.rows.find((row) => row.sku === 'DOG-XL');
  assert.deepEqual(dog.daily, [0, 0, 0, 0, 0, 3, 0]);
  assert.equal(dog.sales7d, 3);
  assert.equal(dog.movement3d, 1);
  assert.equal(dog.speed7d, 0.43);
  assert.equal(dog.monthUnits, 4);
  assert.deepEqual([dog.stock, dog.transit, dog.price, dog.style, dog.size], [25, 5, 39.99, '圆形狗窝', 'L']);
  assert.equal(dog.stockDays, 58);
  assert.equal(dog.stockTransitDays, 70);
  assert.equal(dog.selloutDate, '2026-11-20');
  assert.deepEqual(xl.daily, [0, 0, 0, 0, 0, 0, 2]);
  assert.equal(xl.today, 2);
  assert.equal(xl.monthUnits, 4);
  assert.equal(xl.soldOut, true);
  assert.equal(xl.selloutDate, null);
  assert.equal(xl.stockTransitDays, 140);

  // FBA 费用:申请最近 4 天的 Fee Preview,写进费用表
  const feeReport = [...amazon.reports.values()].find((body) => body.reportType === 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA');
  assert.equal(feeReport.dataEndTime, '2026-09-22T18:55:00.000Z');
  assert.equal(feeReport.dataStartTime, '2026-09-18T18:55:00.000Z');
  assert.equal(result.feeSkus, 1);
  assert.equal((await call('/sku/costs', user, { rows: [{ sku: 'DOG-L', fob: '$12.50', firstLeg: '1.5', duty: '' }] })).status, 200);
  const bad = await call('/sku/costs', user, { rows: [{ sku: 'DOG-XL', fob: 'abc' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /FOB「abc」不是有效金额/);
  const skuRows = (await call('/sku', user)).data;
  const library = skuRows.items.find((row) => row.sku === 'DOG-L');
  // 39.99 − 14.00 − 7.25 − 6.00(15% 佣金按当前售价)= 12.74
  assert.deepEqual([library.landedCost, library.fbaFee, library.referralFee, library.profit, library.margin, library.breakEven],
    [14, 7.25, 6, 12.74, 31.86, 25]);
  assert.deepEqual(skuRows.items.find((row) => row.sku === 'DOG-XL').missing, ['成本', 'FBA 费', '佣金']);
  // 价格策略表同样带上单件毛利和毛利率
  const boardDog = (await call('/price-strategy', user)).data.rows.find((row) => row.sku === 'DOG-L');
  assert.deepEqual([boardDog.profit, boardDog.margin, boardDog.fob], [12.74, 31.86, undefined]);
  assert.equal(skuRows.fees.lastSuccess.skus, 1);

  const sales = backend.db.prepare("SELECT * FROM pet_daily_sales WHERE sku='DOG-XL' AND day='2026-09-21'").get();
  assert.deepEqual([sales.units, sales.orders, sales.sales, sales.estimated_sales], [2, 1, 99.98, 99.98]);

  // 再同步只重拉最近几天,不重复建 SKU、不再请求已有尺码颜色的目录
  assert.equal(orderSyncStart('2026-09-22', priceSyncStatus(ENV).coverage), '2026-09-13');
  const again = fakeAmazon();
  const second = await syncAmazonData(1, again.gateway, ENV, now);
  assert.deepEqual([second.from, second.skuAdded, second.skuUpdated], ['2026-09-13', 0, 0]);
  assert.equal(again.calls.filter((entry) => entry.path.includes('/catalog/')).length, 0);
  assert.equal((await call('/price-strategy', user)).data.rows.find((row) => row.sku === 'DOG-L').monthUnits, 4);

  // 销售统计:周销量按 ISO 周,每月数据合并人工目标
  assert.equal((await call('/price-strategy/targets/2026-09', user, { targetUnits: 10, targetSales: 400, actualProfit: -5, adSpend: 20 }, 'PUT')).status, 200);
  assert.equal((await call('/price-strategy/targets/2026-13', user, { targetUnits: 1 }, 'PUT')).status, 400);
  assert.equal((await call('/price-strategy/targets/2026-09', user, { targetUnits: 1.5 }, 'PUT')).status, 400);
  const stats = (await call('/price-strategy/stats?weeks=2', user)).data;
  assert.equal(stats.coveredFrom, '2026-01-01');
  assert.deepEqual(stats.weekly.map((week) => week.week), [38, 39]);
  assert.deepEqual(stats.weekly[0].days, [1, 0, 0, 0, 0, 0, 3]);
  assert.deepEqual(stats.weekly[1].days, [2, 2, null, null, null, null, null]);
  assert.equal(stats.weekly[1].current, true);
  const september = stats.monthly.months[8];
  assert.deepEqual([september.units, september.unitsRate, september.sales, september.estimatedSales],
    [8, 80, 319.92, 199.96]);
  assert.deepEqual([september.adRatio, september.margin, september.progress], [6.3, -1.6, 73.3]);
  assert.deepEqual([stats.monthly.months[7].units, stats.monthly.months[7].sales], [4, 100]);
  assert.equal(stats.monthly.months[9].units, null, '未来月份没有实际值');
  assert.equal(stats.monthly.total.units, 12);
  // 没手填实际利润的月份按成本和费用自动算:8 月 DOG-L 4 件 $100,毛利 100 − 4×(14+7.25) − 15% 佣金 = 0,再减广告花费 10
  assert.equal((await call('/price-strategy/targets/2026-08', user, { adSpend: 10 }, 'PUT')).status, 200);
  const august = (await call('/price-strategy/stats?weeks=2', user)).data.monthly.months[7];
  assert.deepEqual([august.profitSource, august.grossProfit, august.actualProfit, august.margin, august.coverage], ['auto', 0, -10, -10, 100]);
  assert.equal(september.profitSource, 'manual', '手填的实际利润额优先');
  // 9 月 DOG-XL 没有成本,不算进毛利,覆盖率低于 100%
  const septAuto = (await call('/price-strategy/stats?weeks=2', user)).data.monthly.months[8];
  assert.deepEqual(septAuto.missingCostSkus, ['DOG-XL']);

  // 自动同步一天内不重拉费用;费用报告失败不影响其他数据,只记错误,旧费用保留
  const { saveCosts } = await import('../src/petCosts.js');
  assert.equal(saveCosts(1, [{ sku: 'DOG-L', duty: '0.5' }]).saved, 1);
  assert.deepEqual(Object.values(backend.db.prepare('SELECT fob, first_leg, duty FROM pet_sku_costs').get()), [12.5, 1.5, 0.5], '没带的成本字段不动');
  // 库存变动:同步前 DOG-L 在库 0、DOG-XL 在库 5,亚马逊返回 25 和 0 → 一个补货、一个新断货
  backend.db.prepare("UPDATE sku_items SET stock=0 WHERE sku='DOG-L'").run();
  backend.db.prepare("UPDATE sku_items SET stock=5 WHERE sku='DOG-XL'").run();
  const auto = fakeAmazon({ failOn: 'FEES' });
  const changed = await syncAmazonData(null, auto.gateway, ENV, now);
  assert.equal(changed.feeSkus, null);
  assert.deepEqual([changed.newOutOfStock, changed.restocked], [1, 1]);
  const library2 = (await call('/sku', user)).data;
  assert.deepEqual([library2.stockSync.outOfStock.map((e) => e.sku), library2.stockSync.restocked.map((e) => e.sku)], [['DOG-XL'], ['DOG-L']]);
  assert.equal(library2.items.find((row) => row.sku === 'DOG-XL').stockEvent.kind, 'out');
  assert.equal(library2.items.find((row) => row.sku === 'DOG-L').stockEvent.kind, 'restock');
  assert.equal(library2.items.find((row) => row.sku === 'DOG-L').profit, 12.24, '库存标记和毛利同时挂上(关税已改成 0.5)');
  assert.equal([...auto.reports.values()].some((body) => body.reportType.includes('FEES')), false);
  const feeFail = await syncAmazonData(1, fakeAmazon({ failOn: 'FEES' }).gateway, ENV, now);
  assert.equal(feeFail.feeSkus, null);
  assert.match(priceSyncStatus(ENV).fees.lastError.message, /读取 FBA 费用/);
  assert.equal((await call('/sku', user)).data.items.find((row) => row.sku === 'DOG-L').fbaFee, 7.25);

  // 失败会记录阶段,已保存的数据不动
  await assert.rejects(syncAmazonData(1, fakeAmazon({ failOn: '/fba/inventory' }).gateway, ENV, now), /读取 FBA 库存.*403/);
  const status = priceSyncStatus(ENV);
  assert.match(status.lastError.message, /读取 FBA 库存/);
  assert.equal(status.lastSuccess.today, '2026-09-22');
  assert.equal((await call('/price-strategy', user)).data.rows.find((row) => row.sku === 'DOG-L').sales7d, 3);
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
