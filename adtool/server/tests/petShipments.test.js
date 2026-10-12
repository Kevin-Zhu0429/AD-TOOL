import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

const ENV = {
  PET_SP_LWA_CLIENT_ID: 'pet-client', PET_SP_LWA_CLIENT_SECRET: 'pet-secret',
  PET_SP_LWA_REFRESH_TOKEN: 'Atzr|pet', PET_SP_SELLER_ID: 'APETSELLER',
};

/** 假的货件接口:shipments 是 { ShipmentId, ShipmentStatus, ... },items 按货件编号给明细 */
function fakeAmazon(world, { denied = false } = {}) {
  const calls = [];
  const gateway = {
    async request(account, region, method, path, { query = {} } = {}) {
      calls.push({ path, query });
      if (denied) throw Object.assign(new Error('亚马逊接口请求失败 (403)'), { upstreamStatus: 403 });
      if (path === '/fba/inbound/v0/shipments') {
        if (query.QueryType === 'NEXT_TOKEN') return { payload: { ShipmentData: world.shipments.filter((item) => item.page2) } };
        let list = world.shipments.filter((item) => !item.page2);
        if (query.ShipmentStatusList) list = list.filter((item) => query.ShipmentStatusList.split(',').includes(item.ShipmentStatus));
        if (query.ShipmentIdList) list = world.shipments.filter((item) => query.ShipmentIdList.split(',').includes(item.ShipmentId));
        if (query.QueryType === 'DATE_RANGE') list = list.filter((item) => item.updatedAt >= query.LastUpdatedAfter && item.updatedAt <= query.LastUpdatedBefore);
        const more = query.QueryType === 'SHIPMENT' && !query.ShipmentIdList && world.shipments.some((item) => item.page2);
        return { payload: { ShipmentData: list, ...(more ? { NextToken: 'next' } : {}) } };
      }
      const items = /\/shipments\/([^/]+)\/items$/.exec(path);
      if (items) return { payload: { ItemData: world.items[items[1]] ?? [] } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { gateway, calls };
}

const item = (sku, shipped, received, inCase = 10) => ({ SellerSKU: sku, FulfillmentNetworkSKU: `X-${sku}`, QuantityShipped: shipped, QuantityReceived: received, QuantityInCase: inCase });
const shipment = (id, status, extra = {}) => ({ ShipmentId: id, ShipmentStatus: status, ShipmentName: `FBA STA (09/20/2026 10:00)-${id}`,
  DestinationFulfillmentCenterId: 'ONT8', ShipFromAddress: { City: 'Ningbo', CountryCode: 'CN' }, updatedAt: '2026-10-01T00:00:00.000Z', ...extra });

test('inbound shipments sync, reconcile with inventory and flag problems', async (t) => {
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const { db } = backend;
  const shipments = await import('../src/petShipments.js');
  shipments.inboundTiming.gapMs = 0;
  const sku = db.prepare("INSERT INTO sku_items (user_id, country, sku, asin, style, size, color, stock, transit, dedupe) VALUES (-1, 'US', ?, ?, '方窝牛津', ?, 'Black', ?, ?, ?)");
  sku.run('DOG-S', 'B000000001', 'S', 20, 70, 'us|dog-s');
  sku.run('DOG-M', 'B000000002', 'M', 5, 0, 'us|dog-m');
  sku.run('DOG-L', 'B000000003', 'L', 0, 30, 'us|dog-l');
  const detail = db.prepare('INSERT INTO pet_inventory_detail (sku, asin, available, transshipment, receiving, working, shipped) VALUES (?, ?, ?, 0, ?, ?, ?)');
  detail.run('DOG-S', 'B000000001', 12, 8, 30, 40);
  detail.run('DOG-M', 'B000000002', 5, 0, 0, 0);
  detail.run('DOG-L', 'B000000003', 0, 25, 0, 0); // 货件里是 30
  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']) {
    sale.run(day, 'DOG-S', 'B000000001', 2, 2, 50);
    sale.run(day, 'DOG-M', 'B000000002', 1, 1, 30);
    sale.run(day, 'DOG-L', 'B000000003', 1, 1, 40);
  }

  await t.test('name dates and query windows', () => {
    assert.equal(shipments.nameDay('FBA STA (10/05/2026 10:23)-ONT8'), '2026-10-05');
    assert.equal(shipments.nameDay('补货 2026.9.3 海运'), '2026-09-03');
    assert.equal(shipments.nameDay('FBA (9/5/26 3:21 PM)'), '2026-09-05');
    assert.equal(shipments.nameDay('no date'), null);
    const now = new Date('2026-10-12T00:00:00Z');
    assert.equal(shipments.rangesToFetch(now, null).length, 7);
    const later = shipments.rangesToFetch(now, '2026-10-11T12:00:00Z');
    assert.equal(later.length, 1);
    assert.equal(later[0].from.toISOString(), '2026-10-10T12:00:00.000Z');
  });

  const world = {
    shipments: [
      shipment('FBA1WORK', 'WORKING'),
      shipment('FBA2SHIP', 'IN_TRANSIT'),
      shipment('FBA3RECV', 'RECEIVING'),
      shipment('FBA4DONE', 'CLOSED', { updatedAt: '2026-09-25T00:00:00.000Z' }),
      shipment('FBA5PAGE', 'SHIPPED', { page2: true, ShipmentName: 'second page' }),
    ],
    items: {
      FBA1WORK: [item('DOG-S', 30, 0)],
      FBA2SHIP: [item('DOG-S', 25, 0)],
      FBA5PAGE: [item('DOG-S', 15, 0)],
      FBA3RECV: [item('DOG-S', 20, 12), item('DOG-L', 40, 10)],
      FBA4DONE: [item('DOG-M', 50, 46)],
    },
  };

  await t.test('first sync pulls open shipments, recent history and items', async () => {
    const amazon = fakeAmazon(world);
    const result = await shipments.syncShipments({}, amazon.gateway, ENV, () => new Date('2026-10-01T10:00:00Z'));
    assert.deepEqual([result.shipments, result.open, result.itemsFetched], [5, 4, 5]);
    assert.ok(amazon.calls.some((call) => call.query.QueryType === 'NEXT_TOKEN'));
    assert.ok(amazon.calls.every((call) => call.query.MarketplaceId === 'ATVPDKIKX0DER'));
    const row = db.prepare("SELECT * FROM pet_inbound_shipments WHERE shipment_id='FBA2SHIP'").get();
    assert.deepEqual([row.created_day, row.destination, row.ship_from, row.shipped_at], ['2026-09-20', 'ONT8', 'Ningbo, CN', '2026-10-01T10:00:00.000Z']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_inbound_shipment_items').get().n, 6);
  });

  await t.test('later sync: closed shipments are not re-fetched, status changes are recorded', async () => {
    world.shipments[0].ShipmentStatus = 'SHIPPED';
    world.shipments[2].ShipmentStatus = 'CLOSED';
    world.shipments[2].updatedAt = '2026-10-11T00:00:00.000Z';
    world.items.FBA3RECV = [item('DOG-S', 20, 20), item('DOG-L', 40, 38)];
    const amazon = fakeAmazon(world);
    const result = await shipments.syncShipments({}, amazon.gateway, ENV, () => new Date('2026-10-11T10:00:00Z'));
    const fetched = amazon.calls.filter((call) => call.path.endsWith('/items')).map((call) => call.path.split('/')[5]).sort();
    // FBA4DONE 已完成且拉过明细,不再拉
    assert.deepEqual(fetched, ['FBA1WORK', 'FBA2SHIP', 'FBA3RECV', 'FBA5PAGE']);
    assert.equal(result.open, 3);
    const row = db.prepare("SELECT * FROM pet_inbound_shipments WHERE shipment_id='FBA3RECV'").get();
    assert.deepEqual([row.status, row.closed_at, row.status_changed_at], ['CLOSED', '2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00.000Z']);
    // 回到上一轮的状态,方便后面看板的断言
    world.shipments[0].ShipmentStatus = 'WORKING';
    world.shipments[2].ShipmentStatus = 'RECEIVING';
    world.items.FBA3RECV = [item('DOG-S', 20, 12), item('DOG-L', 40, 10)];
    await shipments.syncShipments({}, fakeAmazon(world).gateway, ENV, () => new Date('2026-10-11T11:00:00Z'));
    // 已经走到已完成又退回(测试里人为的)时间不会被清掉,但状态以亚马逊为准
    assert.equal(db.prepare("SELECT status FROM pet_inbound_shipments WHERE shipment_id='FBA3RECV'").get().status, 'RECEIVING');
    db.prepare("UPDATE pet_inbound_shipments SET receiving_at='2026-09-20T00:00:00.000Z', status_changed_at='2026-09-20T00:00:00.000Z' WHERE shipment_id='FBA3RECV'").run();
  });

  await t.test('board: per-shipment progress, per-SKU reconciliation and findings', () => {
    const board = shipments.shipmentsBoard({ today: '2026-10-12', nowMs: Date.parse('2026-10-12T10:00:00Z') });
    assert.deepEqual(board.shipments.map((item) => item.shipmentId), ['FBA1WORK', 'FBA5PAGE', 'FBA2SHIP', 'FBA3RECV', 'FBA4DONE']);
    const recv = board.shipments.find((item) => item.shipmentId === 'FBA3RECV');
    assert.deepEqual([recv.statusLabel, recv.shipped, recv.received, recv.outstanding, recv.daysInStatus], ['接收中', 60, 22, 38, 22]);
    assert.deepEqual(recv.items.map((row) => [row.sku, row.soldOut, row.stockDays]), [['DOG-L', true, 0], ['DOG-S', false, 10]]);
    const done = board.shipments.find((item) => item.shipmentId === 'FBA4DONE');
    assert.deepEqual([done.shortfall, done.outstanding], [4, 0]);
    assert.deepEqual([board.totals.open, board.totals.working, board.totals.shipped, board.totals.receiving], [4, 30, 40, 38]);

    const dogS = board.skus.find((row) => row.sku === 'DOG-S');
    assert.deepEqual(dogS.fromShipments, { working: 30, shipped: 40, receiving: 8 });
    assert.equal(dogS.matched, true);
    assert.equal(dogS.shipments.length, 4);
    const dogL = board.skus.find((row) => row.sku === 'DOG-L');
    assert.deepEqual([dogL.matched, dogL.gaps], [false, ['receiving']]);
    // 可售天数少的排前面:DOG-L 已断货,DOG-M 5 天
    assert.deepEqual(board.skus.slice(0, 2).map((row) => row.sku), ['DOG-L', 'DOG-M']);

    const titles = board.findings.map((item) => item.title);
    assert.match(titles[0], /1 个已完成的货件少收了 4 件/);
    assert.ok(titles.some((title) => /1 个 SKU 30 天内卖完，没有在途货件/.test(title)));
    assert.match(board.findings.find((item) => /没有在途货件/.test(item.title)).detail, /DOG-M/);
    assert.ok(titles.some((title) => /接收中超过 14 天/.test(title)));
    assert.ok(titles.some((title) => /DOG-L|1 个 SKU 货件件数和库存接口对不上/.test(title)));
    assert.ok(board.findings.find((item) => /对不上/.test(item.title)).detail.includes('正在接收 货件 30 / 库存 25'));
  });

  await t.test('API route and missing role message', async () => {
    db.prepare("DELETE FROM pet_price_sync_state WHERE key='shipments_last_success'").run();
    await assert.rejects(shipments.syncShipments({}, fakeAmazon(world, { denied: true }).gateway, ENV), /Amazon Fulfillment/);
    assert.match(shipments.shipmentsSyncStatus(ENV).lastError.message, /重新授权/);
  });
});
