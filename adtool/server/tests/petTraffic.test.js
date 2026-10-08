import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};

const asinRow = (child, parent, sessions, units, sales, buyBox = 100) => ({ parentAsin: parent, childAsin: child,
  salesByAsin: { unitsOrdered: units, orderedProductSales: { amount: sales, currencyCode: 'USD' }, totalOrderItems: units },
  trafficByAsin: { browserSessions: sessions - Math.floor(sessions / 2), mobileAppSessions: Math.floor(sessions / 2), sessions,
    pageViews: sessions * 2, buyBoxPercentage: buyBox, unitSessionPercentage: units / sessions * 100 } });

/** 假的业务报告:每天 B000000001 有 50 访问 5 单,B000000002 有 20 访问 1 单(购物车 80%) */
function fakeAmazon({ cancelled = [], denied = false, twoDays = false, shifted = false } = {}) {
  const created = [];
  const gateway = {
    async request(account, region, method, path, { body } = {}) {
      if (method === 'POST') {
        if (denied) throw Object.assign(new Error('亚马逊接口请求失败 (403)'), { upstreamStatus: 403 });
        created.push(body);
        return { reportId: `r${created.length}` };
      }
      const report = /\/reports\/(r\d+)$/.exec(path);
      if (report) {
        const day = created[Number(report[1].slice(1)) - 1].dataStartTime.slice(0, 10);
        return cancelled.includes(day) ? { processingStatus: 'CANCELLED' } : { processingStatus: 'DONE', reportDocumentId: report[1] };
      }
      const document = /\/documents\/(r\d+)$/.exec(path);
      if (document) return { url: document[1] };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async download(document) {
      const day = created[Number(document.url.slice(1)) - 1].dataStartTime.slice(0, 10);
      const byDate = (date) => ({ date, salesByDate: { unitsOrdered: 6, orderedProductSales: { amount: 180, currencyCode: 'USD' } },
        trafficByDate: { sessions: 70, pageViews: 140 } });
      return JSON.stringify({ reportSpecification: { reportType: 'GET_SALES_AND_TRAFFIC_REPORT' },
        salesAndTrafficByDate: twoDays ? [byDate(day), byDate('2026-09-01')] : [byDate(shifted ? '2026-09-01' : day)],
        salesAndTrafficByAsin: [asinRow('B000000001', 'B00000000P', 50, 5, 150), asinRow('B000000002', 'B00000000P', 20, 1, 30, 80)] });
    },
  };
  return { gateway, created };
}

test('sessions and conversion sync day by day from the Sales and Traffic report', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const { db } = backend;
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0; reportTiming.throttleMs = 0;
  const traffic = await import('../src/petTraffic.js');
  const sku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', ?, ?, ?, ?, 'Black', ?)");
  sku.run('DOG-L', 'B000000001', '方窝牛津', 'L', 'us|dog-l');
  sku.run('DOG-XL', 'B000000002', '方窝牛津', 'XL', 'us|dog-xl');

  await t.test('one report per day, newest first; a day without data waits for next time', async () => {
    const amazon = fakeAmazon({ cancelled: ['2026-10-06'] });
    const result = await traffic.syncTraffic({ backfill: 5 }, amazon.gateway, ENV, '2026-10-08');
    assert.deepEqual(amazon.created.map((body) => body.dataStartTime.slice(0, 10)), ['2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
    assert.deepEqual([amazon.created[0].dataStartTime, amazon.created[0].dataEndTime], ['2026-10-06T08:00:00.000Z', '2026-10-06T23:59:59.000Z']);
    assert.deepEqual(amazon.created[0].reportOptions, { dateGranularity: 'DAY', asinGranularity: 'CHILD' });
    assert.equal(amazon.created[0].reportType, 'GET_SALES_AND_TRAFFIC_REPORT');
    assert.deepEqual([result.saved, result.notReady, result.newest], [4, ['2026-10-06'], '2026-10-05']);
    assert.deepEqual(traffic.trafficCoverage(), { from: '2026-10-02', to: '2026-10-05', days: 4 });
    const row = db.prepare("SELECT * FROM pet_traffic_daily WHERE day='2026-10-03' AND asin='B000000001'").get();
    assert.deepEqual([row.sessions, row.page_views, row.units, row.sales, row.mobile_sessions, row.parent_asin], [50, 100, 5, 150, 25, 'B00000000P']);
  });

  await t.test('recent days are fetched again until they settle, at most once a day', () => {
    const set = db.prepare('UPDATE pet_traffic_days SET fetched_at=? WHERE day=?');
    set.run('2026-10-09T12:00:00.000Z', '2026-10-02'); // 拉到时已过 4 天以上:定了
    set.run('2026-10-05T12:00:00.000Z', '2026-10-03'); // 才过 2 天:再拉
    set.run('2026-10-08T12:00:00.000Z', '2026-10-04'); // 正好过 4 天:定了
    set.run('2026-10-08T12:00:00.000Z', '2026-10-05'); // 才过 3 天:再拉
    db.prepare("INSERT INTO pet_traffic_days (day, fetched_at) VALUES ('2026-10-07', '2026-10-10T12:00:00.000Z')").run(); // 今天刚拉过
    assert.deepEqual(traffic.daysToFetch('2026-10-10', 7), ['2026-10-08', '2026-10-06', '2026-10-05', '2026-10-03']);
    db.prepare("DELETE FROM pet_traffic_days WHERE day='2026-10-07'").run();
  });

  await t.test('the connector query groups by ASIN, style, week or day', () => {
    const byAsin = traffic.trafficReport({ from: '2026-10-02', to: '2026-10-05' });
    assert.equal(byAsin.daysWithData, 4);
    assert.deepEqual(byAsin.rows.map((row) => [row.asin, row.skus, row.size, row.sessions, row.units, row.conversion, row.buyBox]),
      [['B000000001', ['DOG-L'], 'L', 200, 20, 10, 100], ['B000000002', ['DOG-XL'], 'XL', 80, 4, 5, 80]]);
    const style = traffic.trafficReport({ style: '方窝牛津', from: '2026-10-02', to: '2026-10-05', groupBy: 'style' });
    assert.deepEqual(style.rows.map((row) => [row.style, row.asins, row.sessions, row.conversion, row.buyBox]), [['方窝牛津', 2, 280, 8.6, 94.3]]);
    const days = traffic.trafficReport({ sku: 'DOG-XL', days: 2, groupBy: 'day' });
    assert.deepEqual(days.rows.map((row) => [row.day, row.sessions, row.units]), [['2026-10-04', 20, 1], ['2026-10-05', 20, 1]]);
    const week = traffic.trafficReport({ from: '2026-09-28', to: '2026-10-05', groupBy: 'week' });
    assert.deepEqual(week.rows.map((row) => [row.weekStart, row.days, row.sessions]), [['2026-09-28', 3, 210], ['2026-10-05', 1, 70]]);
    assert.equal(week.missingDays, 4);
    assert.throws(() => traffic.trafficReport({ sku: 'NOPE' }), /找不到/);
  });

  await t.test('a report covering more than one day is refused instead of being stored as one day', async () => {
    db.prepare('DELETE FROM pet_traffic_days WHERE day=?').run('2026-10-03');
    await assert.rejects(traffic.syncTraffic({ backfill: 7 }, fakeAmazon({ twoDays: true }).gateway, ENV, '2026-10-10'), /多天的数据/);
    await assert.rejects(traffic.syncTraffic({ backfill: 7 }, fakeAmazon({ shifted: true }).gateway, ENV, '2026-10-10'), /返回的是 2026-09-01/);
  });

  await t.test('a missing Brand Analytics role says what to fix', async () => {
    await assert.rejects(traffic.syncTraffic({ backfill: 3 }, fakeAmazon({ denied: true }).gateway, ENV, '2026-10-10'), /品牌分析/);
    assert.match(traffic.trafficSyncStatus(ENV).lastError.message, /Brand Analytics/);
  });

  await t.test('change impact compares sales, traffic and search share before and after a change', () => changeImpactCase(db));
});

// 同一个测试进程里数据库只能开一次,改动效果对比接在流量测试后面跑,先清掉流量数据
async function changeImpactCase(db) {
  const { changeImpact } = await import('../src/petImpact.js');
  db.exec('DELETE FROM pet_traffic_daily; DELETE FROM pet_traffic_days;');
  const day = (offset) => new Date(Date.UTC(2026, 9, 1 + offset)).toISOString().slice(0, 10);
  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  const visit = db.prepare('INSERT INTO pet_traffic_daily (day, asin, sessions, page_views, units, sales, buy_box_pct) VALUES (?, ?, ?, ?, ?, ?, 100)');
  const fetched = db.prepare("INSERT INTO pet_traffic_days (day, sessions, fetched_at) VALUES (?, 0, '2026-10-20T00:00:00Z')");
  // 10/1 改标题:之前每天 2 单、40 访问;之后每天 3 单、50 访问
  for (let offset = -14; offset <= 6; offset += 1) {
    if (offset === 0) continue;
    const after = offset > 0;
    sale.run(day(offset), 'DOG-L', 'B000000001', after ? 3 : 2, after ? 3 : 2, after ? 90 : 60);
    visit.run(day(offset), 'B000000001', after ? 50 : 40, 80, after ? 3 : 2, after ? 90 : 60);
    fetched.run(day(offset));
  }
  const report = db.prepare(`INSERT INTO aba_asin_reports (user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash)
    VALUES (-1, 'US', 'B000000001', ?, ?, 1, 'test', ?)`);
  const query = db.prepare(`INSERT INTO aba_asin_queries (report_id, query, query_volume, market_impressions, market_clicks, market_purchases,
    asin_impressions, asin_clicks, asin_purchases) VALUES (?, 'dog bed', 1000, 10000, 1000, 100, ?, ?, ?)`);
  for (const [start, end, impressions, clicks, purchases] of [['2026-09-20', '2026-09-26', 500, 20, 2], ['2026-09-27', '2026-10-03', 900, 40, 4],
    ['2026-10-04', '2026-10-10', 800, 30, 3]]) {
    query.run(Number(report.run(start, end, end).lastInsertRowid), impressions, clicks, purchases);
  }
  const batch = Number(db.prepare("INSERT INTO pet_change_batches (title, source) VALUES ('t', 'claude')").run().lastInsertRowid);
  const change = db.prepare(`INSERT INTO pet_change_proposals (batch_id, kind, target_key, target_json, before_json, after_json, reason, status, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'r', ?, ?)`);
  const target = JSON.stringify({ sku: 'DOG-L', asin: 'B000000001' });
  const title = Number(change.run(batch, 'listing_title', 'listing:dog-l:listing_title', target, '"Old"', '"New"', 'applied', '2026-10-01 20:00:00').lastInsertRowid);
  change.run(batch, 'listing_bullets', 'listing:dog-l:listing_bullets', target, '["a"]', '["b"]', 'submitted', '2026-10-04 20:00:00');
  change.run(batch, 'listing_search_terms', 'listing:dog-l:listing_search_terms', target, '"x"', '"y"', 'pending', null);
  const sync = Number(db.prepare('INSERT INTO sku_stock_syncs (user_id) VALUES (-1)').run().lastInsertRowid);
  db.prepare(`INSERT INTO sku_stock_events (sync_id, user_id, country, sku, sku_key, kind, stock, created_at)
    VALUES (?, -1, 'US', 'DOG-L', 'dog-l', 'out', 0, '2026-09-25 20:00:00')`).run(sync);

  const result = changeImpact({ id: title, days: 14 }, { today: '2026-10-08' });
  const item = result.items[0];
  assert.equal(item.executedDay, '2026-10-01');
  assert.deepEqual([item.sales.before.from, item.sales.before.to, item.sales.before.unitsPerDay], ['2026-09-17', '2026-09-30', 2]);
  // 订单只到昨天(10/7),流量到有数据的最后一天(10/7)
  assert.deepEqual([item.sales.after.from, item.sales.after.to, item.sales.after.unitsPerDay, item.sales.unitsPerDayChangePct], ['2026-10-02', '2026-10-07', 3, 50]);
  assert.deepEqual([item.traffic.before.sessionsPerDay, item.traffic.after.sessionsPerDay, item.traffic.sessionsPerDayChangePct], [40, 50, 25]);
  assert.deepEqual([item.traffic.before.conversion, item.traffic.after.conversion, item.traffic.conversionChangePoints], [5, 6, 1]);
  // 执行那周(9/27–10/3)不算
  assert.deepEqual([item.searchShare.before.weeks, item.searchShare.before.clickShare, item.searchShare.after.weeks, item.searchShare.after.clickShare],
    [['2026-09-26'], 2, ['2026-10-10'], 3]);
  assert.deepEqual(item.otherChangesNearby.map((other) => [other.kind, other.day]), [['五点描述', '2026-10-04']]);
  assert.deepEqual(item.stockEvents, [{ event: '断货', day: '2026-09-25', stock: 0 }]);
  assert.match(item.caution, /只有 6 天/);
  // 按 SKU 看:只有执行过的
  assert.deepEqual(changeImpact({ sku: 'dog-l' }, { today: '2026-10-08' }).items.map((entry) => entry.kind), ['五点描述', '标题']);
  assert.throws(() => changeImpact({ id: title + 2 }), /还没执行/);
  assert.throws(() => changeImpact({ id: 999 }), /没有第 999 条/);
}
