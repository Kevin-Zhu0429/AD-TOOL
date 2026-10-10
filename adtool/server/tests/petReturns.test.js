import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};
const HEAD = ['return-date', 'order-id', 'sku', 'asin', 'fnsku', 'product-name', 'quantity', 'fulfillment-center-id',
  'detailed-disposition', 'reason', 'status', 'license-plate-number', 'customer-comments'];
const line = (at, sku, reason, comment = '', disposition = 'SELLABLE', quantity = 1) =>
  [at, `111-${Math.random().toString().slice(2, 9)}`, sku, sku === 'DOG-S' ? 'B000000001' : 'B000000002', 'X00', 'Dog Bed', quantity, 'LGB8',
    disposition, reason, 'Unit returned to inventory', 'LPN1', comment].join('\t');

/** 假的退货报告:按申请的时间段返回 rows 里落在段内的行 */
function fakeAmazon(rows, { denied = false } = {}) {
  const created = [];
  const gateway = {
    async request(account, region, method, path, { body } = {}) {
      if (method === 'POST') {
        if (denied) throw Object.assign(new Error('亚马逊接口请求失败 (403)'), { upstreamStatus: 403 });
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
      const inside = rows.filter((row) => {
        const at = Date.parse(row.split('\t')[0]);
        return at >= Date.parse(body.dataStartTime) && at <= Date.parse(body.dataEndTime);
      });
      return [HEAD.join('\t'), ...inside].join('\n');
    },
  };
  return { gateway, created };
}

test('returns sync from the FBA customer returns report and analyse by SKU, style and reason', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const { db } = backend;
  const { reportTiming } = await import('../src/petAmazon.js');
  reportTiming.pollMs = 0; reportTiming.throttleMs = 0;
  const returns = await import('../src/petReturns.js');
  const sku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, dedupe) VALUES (-1, 'US', ?, ?, '方窝牛津', ?, 'Black', ?)");
  sku.run('DOG-S', 'B000000001', 'S', 'us|dog-s');
  sku.run('DOG-XL', 'B000000002', 'XL', 'us|dog-xl');
  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  sale.run('2026-09-20', 'DOG-S', 'B000000001', 20, 20, 500);
  sale.run('2026-09-25', 'DOG-XL', 'B000000002', 40, 40, 2000);
  sale.run('2026-08-01', 'DOG-S', 'B000000001', 99, 99, 2000); // 窗口外

  await t.test('windows: first run backfills 180 days in 30-day reports, later runs refresh the last 30 days', () => {
    const first = returns.windowsToFetch('2026-10-10', null);
    assert.equal(first.length, 6);
    assert.deepEqual(first[0], { from: '2026-09-11', to: '2026-10-10' });
    assert.deepEqual(first.at(-1), { from: '2026-04-14', to: '2026-05-13' });
    assert.deepEqual(returns.windowsToFetch('2026-10-10', { from: '2026-04-14', to: '2026-10-09' }), [{ from: '2026-09-11', to: '2026-10-10' }]);
    // 上次失败只拉到了最近 60 天:先刷新最近一段,再接着往前回填
    assert.deepEqual(returns.windowsToFetch('2026-10-10', { from: '2026-08-12', to: '2026-10-10' }, 90),
      [{ from: '2026-09-11', to: '2026-10-10' }, { from: '2026-07-13', to: '2026-08-11' }]);
  });

  await t.test('rule-based reason and comment grouping', () => {
    assert.deepEqual(returns.reasonInfo('APPAREL_TOO_SMALL'), { code: 'APPAREL_TOO_SMALL', label: '尺寸偏小', category: 'size' });
    assert.equal(returns.reasonInfo('SOMETHING_NEW').category, 'other');
    assert.deepEqual(returns.commentThemes('Way too small for my lab, and the seam ripped'), ['too_small', 'quality']);
    assert.deepEqual(returns.commentThemes('My dog would not lay on it. It is very thin'), ['thin', 'pet_refused']);
    assert.deepEqual(returns.commentThemes('Not waterproof at all, pee soaked through'), ['waterproof']);
    assert.deepEqual(returns.commentThemes(''), []);
  });

  await t.test('sync saves rows by Pacific return day and survives a re-pull without duplicates', async () => {
    const rows = [
      line('2026-10-05T18:00:00+00:00', 'DOG-S', 'APPAREL_TOO_SMALL', 'Too small for my dog'),
      line('2026-10-04T18:00:00+00:00', 'DOG-S', 'APPAREL_TOO_SMALL', 'runs small, size up'),
      line('2026-10-03T18:00:00+00:00', 'DOG-S', 'NOT_AS_DESCRIBED', 'Not waterproof, pee leaked through', 'CUSTOMER_DAMAGED'),
      line('2026-10-02T18:00:00+00:00', 'DOG-S', 'DEFECTIVE', 'seam ripped after a week', 'DEFECTIVE'),
      // 太平洋时间是 10-01 晚上
      line('2026-10-02T03:00:00+00:00', 'DOG-XL', 'APPAREL_TOO_LARGE', 'too big for our corgi'),
      line('2026-09-28T18:00:00+00:00', 'DOG-XL', 'UNWANTED_ITEM', ''),
      line('2026-07-01T18:00:00+00:00', 'DOG-XL', 'DAMAGED_BY_CARRIER', '', 'CARRIER_DAMAGED'),
    ];
    const amazon = fakeAmazon(rows);
    const result = await returns.syncReturns({}, amazon.gateway, ENV, '2026-10-10');
    assert.equal(amazon.created.length, 6);
    assert.equal(amazon.created[0].reportType, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA');
    assert.equal(amazon.created[1].dataStartTime, '2026-08-12T07:00:00.000Z');
    assert.equal(amazon.created[1].dataEndTime, '2026-09-11T06:59:59.000Z');
    assert.equal(result.saved, 7);
    assert.deepEqual(returns.returnsCoverage(), { from: '2026-04-14', to: '2026-10-10' });
    assert.equal(db.prepare("SELECT day FROM pet_returns WHERE reason='APPAREL_TOO_LARGE'").get().day, '2026-10-01');
    await returns.syncReturns({}, fakeAmazon(rows).gateway, ENV, '2026-10-10');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_returns').get().n, 7);
  });

  await t.test('30-day return rate per SKU, reasons, themes, style size split and findings', () => {
    const report = returns.returnsAnalysis({ days: 30, today: '2026-10-10' });
    assert.equal(report.from, '2026-09-11');
    assert.deepEqual([report.total.sold, report.total.returned, report.total.rate, report.total.sellable], [60, 6, 10, 4]);
    const small = report.skus.find((row) => row.sku === 'DOG-S');
    assert.deepEqual([small.sold, small.returned, small.rate, small.sellableShare], [20, 4, 20, 50]);
    assert.deepEqual(small.reasons.map((item) => [item.label, item.count]), [['尺寸偏小', 2], ['有缺陷/坏了', 1], ['与描述不符', 1]]);
    assert.deepEqual(small.themes.map((item) => item.key).sort(), ['quality', 'too_small', 'waterproof']);
    assert.equal(small.comments.length, 4);
    const style = report.styles[0];
    assert.equal(style.style, '方窝牛津');
    assert.deepEqual(style.sizes.map((item) => [item.size, item.small, item.large]), [['S', 2, 0], ['XL', 0, 1]]);
    const titles = report.findings.map((item) => item.title);
    assert.match(titles[0], /全店退货率 10%/);
    assert.match(titles[1], /DOG-S.*退货率 20%/);
    assert.ok(titles.some((title) => /方窝牛津：尺寸问题占退货的 50%/.test(title)));
    assert.match(report.findings.find((item) => /尺寸问题/.test(item.title)).detail, /S 码多是嫌小，XL 码多是嫌大/);
    assert.ok(titles.some((title) => /2 件退回后不可售/.test(title)));
    assert.equal(returns.returnsAnalysis({ days: 30, today: '2026-10-10', style: '别的款' }).total.returned, 0);
    const records = returns.returnRecords({ sku: 'dog-s', days: 30, today: '2026-10-10' });
    assert.deepEqual(records.map((row) => row.day), ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
    assert.equal(records[2].disposition, '买家损坏');
  });

  await t.test('missing Amazon Fulfillment role gives a clear message', async () => {
    db.prepare("DELETE FROM pet_price_sync_state WHERE key='returns_coverage'").run();
    await assert.rejects(returns.syncReturns({}, fakeAmazon([], { denied: true }).gateway, ENV, '2026-10-10'), /Amazon Fulfillment/);
    assert.match(returns.returnsSyncStatus(ENV).lastError.message, /重新授权/);
  });
});
