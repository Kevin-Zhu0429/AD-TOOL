import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const MARKET = 'ATVPDKIKX0DER';
const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};

/** 目录接口的一个商品 */
function catalogItem(asin, { parent, children, title = `Item ${asin}`, brand = 'Rival', bullets = ['Soft', 'Washable', 'Non-slip', 'Warm', 'Cozy'],
  size = null, color = null, type = 'PET_BED', bsr = 5000, sub = 300, images = 7, main = `https://img/${asin}.jpg` } = {}) {
  const relationships = parent ? [{ type: 'VARIATION', parentAsins: [parent] }] : children ? [{ type: 'VARIATION', childAsins: children }] : [];
  return {
    asin,
    summaries: [{ marketplaceId: MARKET, itemName: title, brand, size, color }],
    attributes: { bullet_point: bullets.map((value) => ({ value, marketplace_id: MARKET })) },
    images: [{ marketplaceId: MARKET, images: Array.from({ length: images }, (_, index) => ({
      variant: index ? `PT0${index}` : 'MAIN', link: index ? `https://img/${asin}-${index}.jpg` : main, width: 1000 })) }],
    salesRanks: [{ marketplaceId: MARKET, displayGroupRanks: bsr ? [{ title: 'Pet Supplies', rank: bsr }] : [],
      classificationRanks: sub ? [{ title: 'Dog Beds', rank: sub }] : [] }],
    relationships: [{ marketplaceId: MARKET, relationships }],
    productTypes: [{ marketplaceId: MARKET, productType: type }],
  };
}

function fakeAmazon(world) {
  const calls = [];
  const gateway = {
    async request(account, region, method, path, { query, body } = {}) {
      calls.push({ method, path, query, body });
      if (path === '/catalog/2022-04-01/items' && query.keywords) {
        world.searches = [...(world.searches ?? []), query.keywords];
        return { items: (world.search?.[query.keywords] ?? []).map((asin) => world.catalog[asin]).filter(Boolean) };
      }
      if (path === '/catalog/2022-04-01/items') {
        return { items: query.identifiers.split(',').map((asin) => world.catalog[asin]).filter(Boolean) };
      }
      if (path === '/batches/products/pricing/v0/itemOffers') {
        if (world.pricingDenied) throw Object.assign(new Error('亚马逊拒绝访问'), { status: 403, upstreamStatus: 403 });
        return { responses: body.requests.map((request) => {
          const asin = /items\/(\w+)\//.exec(request.uri)[1];
          const price = world.prices[asin];
          return { status: { statusCode: 200 }, request: { ...request, Identifier: asin }, body: { payload: { ASIN: asin,
            Summary: { TotalOfferCount: 1, ListPrice: { Amount: 49.99 },
              BuyBoxPrices: price == null ? [] : [{ condition: 'New', LandedPrice: { Amount: price }, ListingPrice: { Amount: price } }] } } } };
        }) };
      }
      if (path.startsWith('/listings/2021-08-01/items/')) {
        return { summaries: [{ marketplaceId: MARKET, asin: 'B0OWNS0001', productType: 'PET_BED' }],
          attributes: { generic_keyword: [{ value: world.backend ?? 'pet mat', marketplace_id: MARKET }] }, issues: world.issues ?? [] };
      }
      if (method === 'GET' && path === '/reports/2021-06-30/reports') return { reports: world.listed ?? [] };
      if (method === 'POST' && path === '/reports/2021-06-30/reports') {
        world.reports.push(body);
        return { reportId: `r${world.reports.length}` };
      }
      const report = /\/reports\/(r\d+)$/.exec(path);
      if (report) return { processingStatus: 'DONE', reportDocumentId: report[1], createdTime: '2026-10-02T10:00:00Z', processingEndTime: '2026-10-02T10:42:00Z' };
      const document = /\/documents\/(r\d+)$/.exec(path);
      if (document) return { url: document[1] };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async stream(document, onText, onBytes) {
      // 故意切成很碎的块,还在字符串里放括号,检查流式解析
      const text = JSON.stringify(world.searchTerms);
      for (let index = 0; index < text.length; index += 37) {
        onText(text.slice(index, index + 37));
        onBytes(Math.min(index + 37, text.length), text.length);
      }
    },
  };
  return { gateway, calls };
}

test('competitors are suggested from ABA, tracked daily, and changes are recorded', async (t) => {
  // 「本周要做」按规则生成改动时读 Listing 用的假亚马逊,等 world 建好再换上
  const changeDeps = { env: ENV };
  const backend = await startPetTestServer({ changeDeps });
  t.after(() => backend.close());
  const { db } = backend;
  const call = async (path, cookie, body, method) => {
    const response = await fetch(`${backend.url}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await call('/auth/login', null, { username: 'pet-owner', password: 'pet-test-password' })).cookie;
  const { reportTiming, pricingTiming } = await import('../src/petAmazon.js');
  const { spApiTiming } = await import('../src/spApi.js');
  Object.assign(reportTiming, { pollMs: 0, throttleMs: 0 });
  pricingTiming.batchGapMs = 0;
  spApiTiming.minIntervalMs = 0;
  const { suggestCompetitors, syncCompetitors } = await import('../src/petCompetitors.js');

  // 自家:方窝两个尺码(同一个父体),笼垫一个
  assert.equal((await call('/sku/rows', owner, { rows: [
    { sku: 'RR22002BKS', asin: 'B0OWNS0001', size: 'S', color: 'Black' },
    { sku: 'RR22002BKM', asin: 'B0OWNM0001', size: 'M', color: 'Black' },
    { sku: 'BM25001AG24', asin: 'B0OWNPAD01', size: '24 inch' },
  ] })).status, 200);
  db.prepare("INSERT INTO pet_listing_cache(sku,asin,price,status) VALUES('RR22002BKS','B0OWNS0001',29.99,'Active'),('RR22002BKM','B0OWNM0001',35.99,'Active')").run();
  db.prepare("INSERT INTO pet_daily_sales(day,sku,asin,units) VALUES('2026-09-25','RR22002BKS','B0OWNS0001',20),('2026-09-26','RR22002BKM','B0OWNM0001',5)").run();

  // ABA:两个自家 ASIN 都在 dog bed 上有点击(市场总量不能相加),cat bed 只有 S 码
  const report = db.prepare(`INSERT INTO aba_asin_reports(user_id, marketplace, asin, week_start, week_end, week_number, source_file, content_hash)
    VALUES(-1,'US',?,?,?,39,'Amazon SP-API','h') RETURNING id`);
  const query = db.prepare(`INSERT INTO aba_asin_queries VALUES(?,?,?,?,?,?,?,?,?)`);
  const s = report.get('B0OWNS0001', '2026-09-20', '2026-09-26').id;
  const m = report.get('B0OWNM0001', '2026-09-20', '2026-09-26').id;
  query.run(s, 'dog bed', 9000, 100000, 3000, 300, 2000, 60, 6);
  query.run(m, 'dog bed', 9000, 100000, 3000, 300, 1000, 30, 3);
  query.run(s, 'cat bed', 3000, 30000, 1000, 100, 800, 20, 2);
  query.run(s, 'dog crate', 5000, 50000, 2000, 500, 100, 0, 0);

  const world = {
    reports: [], backend: 'pet mat', prices: { B0RIVALS01: 27.99, B0RIVALM01: 33.99, B0SOLO0001: 31.99, B0CRATE001: 25.99, B0LUXURY01: 129 },
    catalog: {
      B0OWNS0001: catalogItem('B0OWNS0001', { parent: 'B0OWNPRNT1', brand: 'Miguel', title: 'Miguel Waterproof Oxford Dog Bed Rectangle Bolster', size: 'Small', images: 5 }),
      B0OWNM0001: catalogItem('B0OWNM0001', { parent: 'B0OWNPRNT1', brand: 'Miguel', title: 'Miguel Waterproof Oxford Dog Bed Rectangle Bolster', size: 'Medium' }),
      B0OWNPAD01: catalogItem('B0OWNPAD01', { brand: 'Miguel', title: 'Crate Pad', type: 'PET_SUPPLIES' }),
      B0RIVALS01: catalogItem('B0RIVALS01', { parent: 'B0RIVALPR1', title: 'Rival Waterproof Oxford Rectangle Dog Bed, Small', size: 'Small', bsr: 900 }),
      B0RIVALM01: catalogItem('B0RIVALM01', { parent: 'B0RIVALPR1', title: 'Rival Waterproof Oxford Rectangle Dog Bed, Medium', size: 'Medium', bsr: 1200 }),
      B0RIVALPR1: catalogItem('B0RIVALPR1', { children: ['B0RIVALS01', 'B0RIVALM01'], title: 'Rival Waterproof Oxford Rectangle Dog Bed Cat Bed', bsr: null, sub: null }),
      B0SOLO0001: catalogItem('B0SOLO0001', { title: 'Solo Waterproof Rectangle Bolster Dog Bed', brand: 'Solo', bsr: 4000 }),
      B0CRATE001: catalogItem('B0CRATE001', { title: 'Crate Kennel', type: 'PET_SUPPLIES' }),
      B0LUXURY01: catalogItem('B0LUXURY01', { title: 'Luxury Oxford Bolster Dog Bed', brand: 'Lux' }),
      B0PADMAT01: catalogItem('B0PADMAT01', { title: 'Fluffy Plush Crate Pad Mat for Kennel', brand: 'Padco' }),
    },
    searchTerms: { reportSpecification: { reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', reportOptions: { reportPeriod: 'WEEK' } },
      dataByDepartmentAndSearchTerm: [
        { departmentName: 'Amazon.com', searchTerm: 'dog bed', searchFrequencyRank: 50, clickedAsin: 'B0RIVALS01', clickedItemName: 'Rival {S}', clickShareRank: 1, clickShare: 0.2, conversionShare: 0.25 },
        { departmentName: 'Amazon.com', searchTerm: 'dog bed', searchFrequencyRank: 50, clickedAsin: 'B0OWNS0001', clickedItemName: 'ours', clickShareRank: 2, clickShare: 0.1, conversionShare: 0.1 },
        { departmentName: 'Amazon.com', searchTerm: 'dog bed', searchFrequencyRank: 50, clickedAsin: 'B0LUXURY01', clickedItemName: 'Lux', clickShareRank: 3, clickShare: 0.08, conversionShare: 0.05 },
        { departmentName: 'Amazon.com', searchTerm: 'cat bed', searchFrequencyRank: 300, clickedAsin: 'B0RIVALM01', clickedItemName: 'Rival M', clickShareRank: 1, clickShare: 0.15, conversionShare: 0.2 },
        { departmentName: 'Amazon.com', searchTerm: 'cat bed', searchFrequencyRank: 300, clickedAsin: 'B0SOLO0001', clickedItemName: 'Solo', clickShareRank: 2, clickShare: 0.1, conversionShare: 0.1 },
        { departmentName: 'Amazon.com', searchTerm: 'cat bed', searchFrequencyRank: 300, clickedAsin: 'B0PADMAT01', clickedItemName: 'Pad', clickShareRank: 3, clickShare: 0.09, conversionShare: 0.1 },
        { departmentName: 'Amazon.com', searchTerm: 'dog crate', searchFrequencyRank: 90, clickedAsin: 'B0CRATE001', clickedItemName: 'Crate', clickShareRank: 1, clickShare: 0.3, conversionShare: 0.3 },
        { departmentName: 'Amazon.com', searchTerm: 'unrelated term', searchFrequencyRank: 1, clickedAsin: 'B0NOISE001', clickedItemName: 'x', clickShareRank: 1, clickShare: 0.9, conversionShare: 0.9 },
      ] },
  };

  // 没配凭证不能同步
  assert.equal((await call('/competitors/sync', owner, { kind: 'suggest' })).status, 503);

  const suggestion = await suggestCompetitors(1, fakeAmazon(world).gateway, ENV, () => new Date('2026-10-02T18:00:00Z'));
  assert.equal(suggestion.week, '2026-09-26');
  // 记下各段耗时:亚马逊生成 42 分钟,扫过的行数
  assert.equal(suggestion.timing.amazonMin, 42);
  assert.equal(suggestion.timing.records, 8);
  assert.equal(world.reports[0].reportType, 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT');
  assert.equal(world.reports[0].dataStartTime.slice(0, 10), '2026-09-20');
  // dog crate 我们没有点击,不算核心词;无关的词不留
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_search_term_top').get().n, 6);
  const suggested = db.prepare("SELECT style_key, asin, score, evidence_json FROM pet_competitors WHERE status='suggested' ORDER BY score DESC").all();
  // 两个子体合成一个家族;自家 ASIN 不算;
  // 贵一倍以上的降权但仍然推荐
  assert.deepEqual(suggested.map((row) => row.asin), ['B0RIVALPR1', 'B0SOLO0001', 'B0LUXURY01']);
  assert.ok(suggested.every((row) => row.style_key === 'RR22002'));
  const rival = JSON.parse(suggested[0].evidence_json);
  assert.deepEqual(rival.terms.map((term) => term.term).sort(), ['cat bed', 'dog bed']);
  assert.equal(JSON.parse(suggested[2].evidence_json).priceFar, true);

  const overview = await call('/competitors/overview', owner);
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.styles.map((style) => [style.key, style.suggested]), [['RR22002', 3], ['BM25001', 0]]);

  // 接受一个推荐、忽略一个,再手动加一个子体 ASIN(同步时换成父 ASIN);自家 ASIN 不能加
  const ids = Object.fromEntries(db.prepare('SELECT asin, id FROM pet_competitors').all().map((row) => [row.asin, row.id]));
  assert.equal((await call(`/competitors/${ids.B0RIVALPR1}`, owner, { status: 'active' }, 'PUT')).status, 200);
  assert.equal((await call(`/competitors/${ids.B0LUXURY01}`, owner, { status: 'ignored' }, 'PUT')).status, 200);
  const added = await call('/competitors', owner, { styleKey: 'RR22002', asins: 'B0SOLO0001, b0ownm0001 https://amazon.com/dp/B0OTHER001' });
  assert.deepEqual(added.data, { added: ['B0SOLO0001', 'B0OTHER001'], skipped: ['B0OWNM0001'] });
  assert.equal((await call('/competitors', owner, { styleKey: 'NOPE', asins: 'B0SOLO0001' })).status, 400);
  world.catalog.B0OTHER001 = catalogItem('B0OTHER001', { parent: 'B0RIVALPR1' });

  // 重新推荐:亚马逊上这周的报告已经有了(比如上次跑到一半服务器重启),直接用,不再申请新的
  world.listed = [
    { reportId: 'r9', processingStatus: 'IN_PROGRESS', dataStartTime: '2026-09-20T00:00:00+00:00', dataEndTime: '2026-09-26T23:59:59+00:00' },
    { reportId: 'r1', processingStatus: 'DONE', dataStartTime: '2026-09-20T00:00:00+00:00', dataEndTime: '2026-09-26T23:59:59+00:00' },
    { reportId: 'r8', processingStatus: 'DONE', dataStartTime: '2026-09-13T00:00:00+00:00', dataEndTime: '2026-09-19T23:59:59+00:00' },
  ];
  const reused = fakeAmazon(world);
  // 已加入、已忽略的不再出现
  await suggestCompetitors(1, reused.gateway, ENV, () => new Date('2026-10-02T18:00:00Z'));
  assert.equal(world.reports.length, 1);
  assert.ok(reused.calls.some((entry) => entry.path === '/reports/2021-06-30/reports/r1'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pet_competitors WHERE status='suggested'").get().n, 0);

  // 第一天同步:没有「定价」角色也能同步目录,只记下原因
  world.pricingDenied = true;
  const day1 = await syncCompetitors(1, fakeAmazon(world).gateway, ENV, () => new Date('2026-10-01T18:00:00Z'));
  assert.equal(day1.prices, 0);
  assert.match((await call('/competitors/status', owner)).data.daily.pricingError.message, /拒绝访问/);
  // 手动加的子体换成了父 ASIN,和已有的合并
  assert.deepEqual(db.prepare("SELECT asin FROM pet_competitors WHERE status='active' ORDER BY asin").all().map((row) => row.asin), ['B0RIVALPR1', 'B0SOLO0001']);
  world.pricingDenied = false;
  const day1b = await syncCompetitors(1, fakeAmazon(world).gateway, ENV, () => new Date('2026-10-01T19:00:00Z'));
  assert.equal(day1b.prices, 3);
  assert.equal(day1b.changes, 0);

  // 第二天:降价、改标题、换主图、新增变体
  world.prices.B0RIVALS01 = 24.99;
  world.catalog.B0RIVALPR1 = catalogItem('B0RIVALPR1', { children: ['B0RIVALS01', 'B0RIVALM01', 'B0RIVALL01'], title: 'Rival Orthopedic Dog Bed', bsr: null, sub: null, main: 'https://img/new.jpg' });
  world.catalog.B0RIVALL01 = catalogItem('B0RIVALL01', { parent: 'B0RIVALPR1', size: 'Large', bsr: 3000 });
  world.prices.B0RIVALL01 = 39.99;
  world.prices.B0SOLO0001 = null;
  await syncCompetitors(1, fakeAmazon(world).gateway, ENV, () => new Date('2026-10-02T18:00:00Z'));
  const kinds = db.prepare("SELECT kind, asin, before_value, after_value FROM pet_competitor_changes WHERE day='2026-10-02' ORDER BY kind, asin").all();
  assert.deepEqual(kinds.map((row) => `${row.kind}:${row.asin}`), [
    'main_image:B0RIVALPR1', 'no_buybox:B0SOLO0001', 'price_down:B0RIVALS01', 'title:B0RIVALPR1', 'variants_added:B0RIVALPR1']);
  assert.deepEqual([kinds[2].before_value, kinds[2].after_value], ['27.99', '24.99']);

  // 卖家精灵数据:评分、评论、子体销量
  assert.equal((await call('/competitors/metrics', owner, { month: '2026-09', sourceFile: 'sellersprite.xlsx', rows: [
    { asin: 'B0RIVALS01', parentAsin: 'B0RIVALPR1', rating: '4.5', reviews: '1,234', units: '800', price: '$27.99' },
    { asin: 'B0RIVALM01', rating: 4.5, reviews: 1234, units: 300 },
  ] })).data.imported, 2);
  assert.equal((await call('/competitors/metrics', owner, { month: '2026-09', rows: [{ asin: 'B0RIVALS01', rating: 6 }] })).status, 400);

  process.env.PET_TODAY = '2026-10-02';
  t.after(() => { delete process.env.PET_TODAY; });
  const detail = (await call(`/competitors/style?key=${encodeURIComponent('RR22002')}`, owner)).data;
  assert.equal(detail.own.units30, 25);
  assert.equal(detail.terms[0].term, 'dog bed');
  // 两个自家 ASIN 的市场量取同一个数,我们的点击相加:90 / 3000
  assert.equal(detail.terms[0].marketPurchases, 300);
  assert.equal(detail.terms[0].clickShare, 0.03);
  const rivalFamily = detail.competitors.find((family) => family.asin === 'B0RIVALPR1');
  assert.equal(rivalFamily.children.length, 3);
  assert.equal(rivalFamily.priceMin, 24.99);
  assert.equal(rivalFamily.units, 1100);
  assert.equal(rivalFamily.reviews, 1234);
  assert.equal(rivalFamily.coverage['dog bed'], 'title');
  assert.equal(detail.own.coverage['cat bed'], null);
  assert.equal(rivalFamily.children.find((child) => child.asin === 'B0RIVALS01').sameSize, true);
  assert.equal(rivalFamily.children.find((child) => child.asin === 'B0RIVALL01').sameSize, false);
  assert.equal(detail.ignored, 1);

  const changes = (await call('/competitors/overview', owner)).data.changes;
  assert.ok(changes.some((change) => change.kind === 'price_down' && change.styleKey === 'RR22002' && change.label === '降价'));

  // Listing 体检:标题含品牌,但有量的 cat bed 没写(建议改)、图片少
  const health = (await call('/competitors/health', owner)).data.rows;
  const small = health.find((row) => row.asin === 'B0OWNS0001');
  assert.ok(small.checks.some((check) => check.level === 'yellow' && check.code === 'terms' && /cat bed/.test(check.text)));
  assert.ok(!small.checks.some((check) => check.level === 'red'));
  assert.ok(small.checks.some((check) => /图片 5 张/.test(check.text)));
  assert.ok(!small.checks.some((check) => /品牌/.test(check.text)));

  // 本周要做:断货、后台搜索词超字节(可一键生成改动)、有量的词没写、对手降价和没购物车
  db.prepare("UPDATE sku_items SET stock=0 WHERE sku='RR22002BKS'").run();
  db.prepare("UPDATE sku_items SET stock=40 WHERE sku='RR22002BKM'").run();
  const longBackend = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ') + ' waterproof oxford word1';
  db.prepare('UPDATE pet_catalog_items SET backend_terms=? WHERE asin=?').run(longBackend, 'B0OWNS0001');
  const weekly = (await call('/intel/actions', owner)).data;
  assert.deepEqual(weekly.styles.map((style) => style.key), ['RR22002']);
  const todo = Object.fromEntries(weekly.styles[0].actions.map((action) => [action.kind, action]));
  assert.match(todo.stockout.detail, /S Black（30 天卖 20 件，没有在途）/);
  assert.equal(todo.stockout.level, 'high');
  assert.deepEqual(todo.backend_bytes.fix, { type: 'rule', code: 'backend_trim', label: '生成瘦身改动', skus: ['RR22002BKS'] });
  assert.match(todo.term_missing.detail, /cat bed/);
  assert.match(todo.term_missing.fix.prompt, /RR22002/);
  assert.match(todo.competitor_price_down.detail, /\$27\.99 → \$24\.99/);
  assert.match(todo.competitor_out.title, /1 个对手没有购物车/);
  assert.equal(weekly.inactive, 1);
  // 一键生成:标题里已有的词、重复词去掉,截到 249 字节以内,放进待确认
  changeDeps.gateway = fakeAmazon(world).gateway;
  assert.equal((await call('/intel/fix', (await call('/auth/login', null, { username: 'pet-user', password: 'pet-test-password' })).cookie, { code: 'backend_trim', skus: ['RR22002BKS'] })).status, 403);
  const fixed = (await call('/intel/fix', owner, { code: 'backend_trim', skus: ['RR22002BKS'] })).data;
  assert.equal(fixed.created.length, 1);
  const proposal = db.prepare('SELECT after_json, source FROM pet_change_proposals WHERE id=?').get(fixed.created[0].id);
  assert.equal(proposal.source, 'intel');
  const trimmed = JSON.parse(proposal.after_json);
  assert.ok(Buffer.byteLength(trimmed) <= 249);
  assert.ok(!/waterproof|oxford/.test(trimmed));
  assert.equal(trimmed.split(' ').filter((word) => word === 'word1').length, 1);

  // 自动挑对手:目录搜出来的同类商品挂上;笼垫、自家的不要
  world.catalog.B0AUTO0001 = catalogItem('B0AUTO0001', { title: 'Autoz Waterproof Oxford Rectangle Bolster Dog Bed', brand: 'Autoz', bsr: 2000 });
  world.prices.B0AUTO0001 = 31.99;
  world.search = { 'dog bed': ['B0AUTO0001', 'B0PADMAT01', 'B0OWNS0001'] };
  const fresh = fakeAmazon(world);
  const day3 = await syncCompetitors(1, fresh.gateway, ENV, () => new Date('2026-10-03T18:00:00Z'));
  assert.equal(day3.autoAdded, 1);
  assert.deepEqual(world.searches.slice(-2), ['dog bed', 'cat bed']);
  const autoRow = db.prepare("SELECT status, source, evidence_json FROM pet_competitors WHERE asin='B0AUTO0001'").get();
  assert.deepEqual([autoRow.status, autoRow.source], ['active', 'auto']);
  assert.ok(JSON.parse(autoRow.evidence_json).relevance >= 0.25);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pet_competitors WHERE asin IN ('B0PADMAT01','B0OWNS0001')").get().n, 0);
  // 自动挂上的移出后记成忽略,不会再挂回来
  const autoId = db.prepare("SELECT id FROM pet_competitors WHERE asin='B0AUTO0001'").get().id;
  assert.equal((await call(`/competitors/${autoId}`, owner, undefined, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT status FROM pet_competitors WHERE id=?').get(autoId).status, 'ignored');
  await syncCompetitors(1, fresh.gateway, ENV, () => new Date('2026-10-04T18:00:00Z'));
  assert.equal(db.prepare("SELECT status FROM pet_competitors WHERE asin='B0AUTO0001'").get().status, 'ignored');

  // 忽略已加入的竞品、移出监控
  assert.equal((await call(`/competitors/${ids.B0SOLO0001}`, owner, { status: 'ignored' }, 'PUT')).status, 200);
  assert.equal((await call(`/competitors/${ids.B0RIVALPR1}`, owner, undefined, 'DELETE')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pet_competitors WHERE status='active'").get().n, 0);
});

test('stream scanner, scoring and text helpers', async () => {
  const { createArrayRecordScanner, offerSummary, catalogDetail } = await import('../src/petAmazon.js');
  const { scoreCandidates, termCovered, coverageOf, sizeLabel, styleKeyOf } = await import('../src/petCompetitors.js');

  const records = [];
  const scan = createArrayRecordScanner((record) => records.push(record));
  const text = JSON.stringify({ reportSpecification: { marketplaceIds: [MARKET], nested: { a: [1, { b: 2 }] } },
    dataByDepartmentAndSearchTerm: [{ searchTerm: 'dog {bed} "x"', clickedAsin: 'B000000001' }, { searchTerm: 'cat bed]', clickedAsin: 'B000000002' }] });
  for (let index = 0; index < text.length; index += 5) scan(text.slice(index, index + 5));
  assert.deepEqual(records.map((record) => record.searchTerm), ['dog {bed} "x"', 'cat bed]']);
  // keep 先看原文,不要的记录不解析
  const kept = [];
  const filtered = createArrayRecordScanner((record) => kept.push(record.clickedAsin), { keep: (raw) => raw.includes('cat bed') });
  filtered(text);
  assert.deepEqual(kept, ['B000000002']);

  // 同类商品:牛津布防水窝和笼垫、毛绒圆窝分得开
  const { relevance } = await import('../src/petCompetitors.js');
  const own = 'Miguel Outdoor Waterproof Cat Bed with Side, Oxford Durable Dog Bed for Small Dog Easy Clean, All Weather Rectangle Medium Pet Bed Bolster';
  assert.ok(relevance(own, 'Waterproof Outdoor Dog Bed with Bolster, Durable Oxford Fabric Rectangle Pet Bed with Removable Cover', 'miguel') >= 0.25);
  assert.ok(relevance(own, 'Waterproof Dog Crate Bed Pad, Washable Reversible Outdoor Wipeable Dog Bed', 'miguel') < 0.25);
  assert.equal(relevance(own, 'Calming Donut Cat Bed Round Fluffy Plush Faux Fur', 'miguel'), 0);
  const { trimBackend, brandTitle } = await import('../src/petIntelActions.js');
  assert.equal(trimBackend('Dog dog crate mat crate oxford', 'Oxford Dog Bed'), 'crate mat');
  assert.ok(Buffer.byteLength(trimBackend(Array.from({ length: 80 }, (_, index) => `kw${index}`).join(' '))) <= 249);
  assert.equal(brandTitle('Dog Bed', 'Miguel'), 'Miguel Dog Bed');
  assert.equal(brandTitle('Miguel Dog Bed', 'Miguel'), null);
  assert.equal(brandTitle('x'.repeat(195), 'Miguel'), null);

  assert.ok(termCovered('dog beds', 'Orthopedic Dog Bed for Large Dogs'));
  assert.ok(!termCovered('cat bed', 'Orthopedic Dog Bed'));
  assert.equal(coverageOf('washable', { title: 'Dog Bed', bullets: ['Machine washable cover'] }), 'bullets');
  assert.equal(coverageOf('calming', { title: 'Dog Bed', bullets: [], backend: 'calming donut' }), 'backend');
  assert.equal(sizeLabel('X-Large (36" x 27")'), 'XL');
  assert.equal(sizeLabel('Medium'), 'M');
  assert.equal(sizeLabel('42 inch'), '42 inch');
  assert.equal(styleKeyOf({ sku: 'RR22002BKM' }), 'RR22002');
  assert.equal(styleKeyOf({ sku: 'RR22002BKM', style: '方窝牛津' }), '方窝牛津');

  const scores = scoreCandidates(
    [{ term: 'dog bed', marketPurchases: 300 }, { term: 'cat bed', marketPurchases: 100 }],
    new Map([['dog bed', [{ asin: 'B0RIVAL001', rank: 1, clickShare: 0.2, conversionShare: 0.3 }, { asin: 'B0OWN00001', rank: 2, clickShare: 0.1, conversionShare: 0.1 }]],
      ['cat bed', [{ asin: 'B0RIVAL001', rank: 2, clickShare: 0.1, conversionShare: 0.1 }]]]),
    ['B0OWN00001']);
  assert.equal(scores.has('B0OWN00001'), false);
  assert.equal(Number(scores.get('B0RIVAL001').score.toFixed(4)), Number((0.75 * 0.25 + 0.25 * 0.1).toFixed(4)));
  assert.equal(scores.get('B0RIVAL001').terms.length, 2);

  assert.deepEqual(offerSummary({ Summary: { TotalOfferCount: 3, ListPrice: { Amount: 59.99 },
    BuyBoxPrices: [{ condition: 'New', LandedPrice: { Amount: 39.99 } }] } }), { price: 39.99, listPrice: 59.99, offers: 3 });
  assert.equal(offerSummary({ Summary: { LowestPrices: [{ condition: 'new', LandedPrice: { Amount: 31 } }, { condition: 'new', ListingPrice: { Amount: 29 } }] } }).price, 29);
  const detail = catalogDetail(catalogItem('B0CHILD001', { parent: 'B0PARENT01', size: 'Large', images: 3 }));
  assert.equal(detail.parentAsin, 'B0PARENT01');
  assert.equal(detail.imageCount, 3);
  assert.equal(detail.subCategory, 'Dog Beds');
});
