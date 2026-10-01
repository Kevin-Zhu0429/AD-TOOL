import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};

const entry = (asin, query, numbers) => ({
  startDate: '2026-08-23', endDate: '2026-08-29', asin,
  searchQueryData: { searchQuery: query, searchQueryScore: 1, searchQueryVolume: numbers[0] },
  impressionData: { totalQueryImpressionCount: numbers[1], asinImpressionCount: numbers[4], asinImpressionShare: 0.1 },
  clickData: { totalClickCount: numbers[2], asinClickCount: numbers[5], totalMedianClickPrice: { amount: 29.99, currencyCode: 'USD' } },
  purchaseData: { totalPurchaseCount: numbers[3], asinPurchaseCount: numbers[6] },
});

function fakeAmazon({ cancelled = false } = {}) {
  const created = [];
  const gateway = {
    async request(account, region, method, path, { body } = {}) {
      if (method === 'POST') { created.push(body); return { reportId: `r${created.length}` }; }
      const report = /\/reports\/(r\d+)$/.exec(path);
      if (report) return cancelled ? { processingStatus: 'CANCELLED' } : { processingStatus: 'DONE', reportDocumentId: report[1] };
      const document = /\/documents\/(r\d+)$/.exec(path);
      if (document) return { url: document[1] };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async download(document) {
      const body = created[Number(document.url.slice(1)) - 1];
      const asins = body.reportOptions.asin.split(' ');
      return JSON.stringify({ reportSpecification: { reportType: body.reportType }, dataByAsin: [
        entry('B000000001', 'dog bed', [9000, 120000, 3000, 400, 5000, 200, 30]),
        entry('B000000001', 'large dog bed', [4000, 60000, 1500, 150, 2000, 90, 12]),
        entry('B000000002', 'dog bed', [9000, 120000, 3000, 400, 1000, 40, 4]),
      ].filter((row) => asins.includes(row.asin)) });
    },
  };
  return { gateway, created };
}

test('ASIN view syncs from Amazon into the same tables as uploaded reports', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const call = async (path, cookie, body) => {
    const response = await fetch(`${backend.url}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await call('/auth/login', null, { username: 'pet-owner', password: 'pet-test-password' })).cookie;
  const { syncAbaAsin, abaSyncStatus } = await import('../src/petAbaSync.js');
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0;

  assert.equal((await call('/aba/asin/amazon/status?marketplace=US', owner)).data.configured, false);
  assert.equal((await call('/aba/asin/amazon/sync', owner, { marketplace: 'US' })).status, 503);
  await assert.rejects(syncAbaAsin({}, 1, fakeAmazon().gateway, ENV, '2026-09-02'), /SKU 库里还没有 ASIN/);

  assert.equal((await call('/sku/rows', owner, { rows: [
    { sku: 'DOG-L', asin: 'B000000001', style: '圆形狗窝', size: 'L' },
    { sku: 'DOG-L-2', asin: 'B000000001' },
    { sku: 'DOG-XL', asin: 'B000000002', style: '圆形狗窝', size: 'XL' },
  ] })).status, 200);

  const amazon = fakeAmazon();
  const result = await syncAbaAsin({ weeks: 1 }, 1, amazon.gateway, ENV, '2026-09-02');
  assert.deepEqual([result.added, result.updated, result.requested], [2, 0, 1]);
  assert.equal(amazon.created.length, 1);
  assert.deepEqual(amazon.created[0], {
    reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', marketplaceIds: ['ATVPDKIKX0DER'],
    dataStartTime: '2026-08-23T00:00:00.000Z', dataEndTime: '2026-08-29T00:00:00.000Z',
    reportOptions: { reportPeriod: 'WEEK', asin: 'B000000001 B000000002' },
  });

  const view = (await call('/aba/asin?marketplace=US&asin=B000000001&weeks=2026-08-29&merge=0', owner)).data;
  assert.deepEqual(view.weeks.map((week) => [week.week_end, week.week_number]), [['2026-08-29', 35]]);
  const dogBed = view.items.find((row) => row.query === 'dog bed');
  assert.deepEqual([dogBed.market_impressions, dogBed.market_clicks, dogBed.market_purchases, dogBed.asin_impressions, dogBed.asin_clicks, dogBed.asin_purchases],
    [120000, 3000, 400, 5000, 200, 30]);
  assert.equal(view.items.length, 2);

  // 已有的 ASIN×周不再请求;refresh 时重拉但内容没变
  const again = fakeAmazon();
  assert.equal((await syncAbaAsin({ weeks: 1 }, 1, again.gateway, ENV, '2026-09-02')).requested, 0);
  const refreshed = await syncAbaAsin({ weeks: 1, refresh: true }, 1, again.gateway, ENV, '2026-09-02');
  assert.deepEqual([refreshed.requested, refreshed.unchanged], [1, 2]);

  // 新一周数据还没出(报告被取消):跳过,不报错
  const pending = await syncAbaAsin({ weeks: 2 }, 1, fakeAmazon({ cancelled: true }).gateway, ENV, '2026-09-09');
  assert.deepEqual(pending.notReady, ['2026-09-05']);
  assert.equal(abaSyncStatus(ENV).lastSuccess.notReady[0], '2026-09-05');
});

test('weeks follow Amazon Sunday–Saturday weeks and Seller Central week numbers', async () => {
  const { completeWeeks, weekNumber, asinBatches } = await import('../src/petAbaSync.js');
  // 9/2(周三)往前推 3 天是 8/30,最近过完的周是 8/23–8/29
  assert.deepEqual(completeWeeks('2026-09-02', 2), [
    { week_start: '2026-08-23', week_end: '2026-08-29', week_number: 35 },
    { week_start: '2026-08-16', week_end: '2026-08-22', week_number: 34 },
  ]);
  assert.equal(completeWeeks('2026-09-01', 1)[0].week_end, '2026-08-29', '周二时 8/29 已过 3 天');
  assert.equal(completeWeeks('2026-08-31', 1)[0].week_end, '2026-08-22', '周一时上周数据还没出齐');
  assert.equal(weekNumber('2026-01-03'), 1);
  assert.equal(weekNumber('2026-01-10'), 2);
  assert.equal(weekNumber('2027-01-02'), 1);
  const batches = asinBatches(Array.from({ length: 40 }, (_, i) => `B${String(i).padStart(9, '0')}`));
  assert.deepEqual(batches.map((batch) => batch.length), [18, 18, 4]);
  assert.ok(batches.every((batch) => batch.join(' ').length <= 200));
});
