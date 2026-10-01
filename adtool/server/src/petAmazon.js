// 宠物版读亚马逊 SP-API:店铺 Listing、FBA 库存、订单报告和商品目录属性。
// 凭证只放环境变量 PET_SP_*,不读墨盒的 BRAND<n>_ 配置,避免同一份服务器 .env 把墨盒店铺读进宠物版。
import { gunzipSync } from 'node:zlib';
import { AMAZON_MARKETPLACES, spApiRequest } from './spApi.js';

export const US_MARKETPLACE = AMAZON_MARKETPLACES.US.id;
const REGION = AMAZON_MARKETPLACES.US.region;
const PACIFIC = 'America/Los_Angeles';
const DAY_MS = 86400000;
// FBA 库存每页 50 条;防止接口一直给 nextToken 死循环
const MAX_PAGES = 2000;
// 订单报告单次最多 30 天
const REPORT_WINDOW_DAYS = 30;

/**
 * 报告轮询节奏。测试会调成 0。
 * 创建报告的限额是所有报告共用的:一次最多连发 15 份,之后每分钟恢复 1 份。
 * 被限流就等 throttleMs 再试,最多等 maxThrottleWaits 次,同步多几分钟也比直接失败好。
 */
export const reportTiming = { pollMs: 15_000, maxPolls: 80, throttleMs: 60_000, maxThrottleWaits: 15 };

const clean = (value) => String(value ?? '').trim();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
const validAsin = (value) => {
  const asin = clean(value).toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
};

/**
 * 读宠物店铺的 SP-API 凭证:
 *   PET_SP_LWA_CLIENT_ID / PET_SP_LWA_CLIENT_SECRET  开发者应用
 *   PET_SP_LWA_REFRESH_TOKEN / PET_SP_SELLER_ID      北美卖家账号授权
 *   PET_SP_BRAND                                      选填,新 SKU 写进 SKU 库时的品牌
 */
export function petSpConfig(env = process.env) {
  const read = (key) => clean(env[`PET_SP_${key}`]);
  const values = {
    clientId: read('LWA_CLIENT_ID'), clientSecret: read('LWA_CLIENT_SECRET'),
    refreshToken: read('LWA_REFRESH_TOKEN'), sellerId: read('SELLER_ID').toUpperCase(),
  };
  const names = { clientId: 'PET_SP_LWA_CLIENT_ID', clientSecret: 'PET_SP_LWA_CLIENT_SECRET',
    refreshToken: 'PET_SP_LWA_REFRESH_TOKEN', sellerId: 'PET_SP_SELLER_ID' };
  const missing = Object.keys(values).filter((key) => !values[key]).map((key) => names[key]);
  if (missing.length === 4) return { account: null, issues: [] };
  if (missing.length) return { account: null, issues: [`亚马逊 SP-API 配置缺少 ${missing.join('、')}`] };
  return { account: { ...values, brand: read('BRAND'), slot: 'na', region: REGION, markets: ['US'] }, issues: [] };
}

// ---------- 日期:美国站报表按太平洋时间切日 ----------

/** 某个时间点在太平洋时间是哪一天 */
export function pacificDay(value) {
  const time = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(time.getTime())) return '';
  return time.toLocaleDateString('sv-SE', { timeZone: PACIFIC });
}

/** 太平洋时间某天 0 点对应的 UTC 时间 */
export function pacificMidnight(day) {
  const guess = new Date(`${day}T08:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, timeZoneName: 'longOffset' })
    .formatToParts(guess).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : -480;
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000);
}

export const shiftDay = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ---------- 报告 ----------

/** 亚马逊平面文件:第一行表头,Tab 分隔 */
export function parseTsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, clean(cells[index])]));
  });
}

/** 下载报告文件。亚马逊给的是预签名地址,不带授权头;可能 gzip 压缩,美国站文件常用 Cp1252 编码 */
export async function downloadReportDocument(document) {
  let response;
  try {
    response = await fetch(document.url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new Error(`下载亚马逊报告失败：${clean(error.message) || '网络错误'}`);
  }
  if (!response.ok) throw new Error(`下载亚马逊报告失败 (${response.status})`);
  let bytes = Buffer.from(await response.arrayBuffer());
  if (clean(document.compressionAlgorithm).toUpperCase() === 'GZIP') bytes = gunzipSync(bytes);
  const charset = /charset=([^;]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.trim().toLowerCase();
  const encoding = !charset ? 'utf-8' : /^(cp1252|windows-1252)$/.test(charset) ? 'windows-1252'
    : /^(iso-8859-1|latin1)$/.test(charset) ? 'latin1' : charset;
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export const amazonGateway = { request: spApiRequest, download: downloadReportDocument };

/** 报告接口被限流(429)时等一会再试 */
async function waitOutThrottle(call) {
  for (let wait = 0; ; wait += 1) {
    try {
      return await call();
    } catch (error) {
      if (error?.upstreamStatus !== 429 || wait >= reportTiming.maxThrottleWaits) throw error;
      await sleep(reportTiming.throttleMs);
    }
  }
}

/**
 * 申请一份报告、等它生成完、下载并解析。没有数据(CANCELLED)返回 parse 的空结果。
 * 平面文件默认按 TSV 解析;品牌分析这类 JSON 报告传 parse: JSON.parse
 */
export async function runReport(account, reportType, { start, end, options, parse = parseTsv } = {}, gateway = amazonGateway) {
  const body = { reportType, marketplaceIds: [US_MARKETPLACE] };
  if (options) body.reportOptions = options;
  if (start) body.dataStartTime = start.toISOString();
  if (end) body.dataEndTime = end.toISOString();
  const created = await waitOutThrottle(() => gateway.request(account, REGION, 'POST', '/reports/2021-06-30/reports', { body }));
  const reportId = clean(created?.reportId);
  if (!reportId) throw new Error(`亚马逊没有返回报告编号（${reportType}）`);
  for (let poll = 0; poll < reportTiming.maxPolls; poll += 1) {
    const report = await waitOutThrottle(() => gateway.request(account, REGION, 'GET', `/reports/2021-06-30/reports/${reportId}`));
    const status = clean(report?.processingStatus);
    if (status === 'DONE') {
      const document = await waitOutThrottle(() => gateway.request(account, REGION, 'GET',
        `/reports/2021-06-30/documents/${clean(report.reportDocumentId)}`));
      return parse(await gateway.download(document));
    }
    // 亚马逊对没有数据的时间段直接取消报告
    if (status === 'CANCELLED') return parse === parseTsv ? [] : null;
    if (status === 'FATAL') throw new Error(`亚马逊生成报告失败（${reportType}）`);
    await sleep(reportTiming.pollMs);
  }
  throw new Error(`亚马逊报告长时间未生成完（${reportType}），请稍后再同步`);
}

// ---------- 数据 ----------

/** 店铺全部 Listing:SKU、ASIN、标题、价格、状态 */
export async function fetchListings(account, gateway = amazonGateway) {
  const rows = await runReport(account, 'GET_MERCHANT_LISTINGS_ALL_DATA', {}, gateway);
  const listings = new Map();
  for (const row of rows) {
    const sku = clean(row['seller-sku']);
    if (!sku) continue;
    const price = Number(row.price);
    listings.set(sku.toLowerCase(), {
      sku, asin: validAsin(row.asin1), title: clean(row['item-name']), status: clean(row.status),
      price: Number.isFinite(price) && price > 0 ? price : null,
    });
  }
  return [...listings.values()];
}

/** 美国站全部 FBA 库存。在途 = 已发货 + 接收中 + 处理中,和墨盒版口径一致 */
export async function fetchInventory(account, gateway = amazonGateway) {
  const latest = new Map();
  let nextToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await gateway.request(account, REGION, 'GET', '/fba/inventory/v1/summaries', { query: {
      details: 'true', granularityType: 'Marketplace', granularityId: US_MARKETPLACE,
      marketplaceIds: US_MARKETPLACE, nextToken,
    } });
    const rows = payload?.payload?.inventorySummaries;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const sku = clean(raw?.sellerSku);
      if (!sku) continue;
      const details = raw.inventoryDetails ?? {};
      latest.set(sku.toLowerCase(), {
        sku, asin: validAsin(raw.asin),
        stock: intOf(details.fulfillableQuantity),
        transit: intOf(details.inboundShippedQuantity) + intOf(details.inboundReceivingQuantity)
          + intOf(details.inboundWorkingQuantity),
      });
    }
    nextToken = clean(payload?.pagination?.nextToken);
    if (!nextToken) return [...latest.values()];
  }
  throw new Error('亚马逊库存分页超过安全上限，请联系管理员检查接口数据');
}

/**
 * 订单明细行(按下单时间)。超过 30 天的区间拆成几份报告。
 * 取消的订单行不算;待付款(Pending)和卖家后台「已订购商品数量」一样计入。
 */
export async function fetchOrderLines(account, start, end, gateway = amazonGateway) {
  const lines = [];
  for (let from = start; from < end;) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + REPORT_WINDOW_DAYS * DAY_MS));
    const rows = await runReport(account, 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', { start: from, end: to }, gateway);
    for (const row of rows) {
      const sku = clean(row.sku);
      const orderId = clean(row['amazon-order-id']);
      if (!sku || !orderId) continue;
      if (/cancel/i.test(row['order-status']) || /cancel/i.test(row['item-status'])) continue;
      const channel = clean(row['sales-channel']);
      if (channel && !/^amazon\.com$/i.test(channel)) continue;
      const day = pacificDay(row['purchase-date']);
      const quantity = intOf(row.quantity);
      if (!day || !quantity) continue;
      // item-price 是这一行的商品金额(已乘数量、不含税);待付款订单亚马逊还没给金额,留空
      const amount = Number(row['item-price']);
      lines.push({ orderId, day, sku, asin: validAsin(row.asin), quantity,
        amount: clean(row['item-price']) && Number.isFinite(amount) ? amount : null });
    }
    from = to;
  }
  return lines;
}

/** 商品目录里的尺码、颜色。每次最多 20 个 ASIN */
export async function fetchCatalogAttributes(account, asins, gateway = amazonGateway) {
  const result = new Map();
  const list = [...new Set(asins.map(validAsin).filter(Boolean))];
  for (let index = 0; index < list.length; index += 20) {
    const batch = list.slice(index, index + 20);
    const payload = await gateway.request(account, REGION, 'GET', '/catalog/2022-04-01/items', { query: {
      identifiers: batch.join(','), identifiersType: 'ASIN', marketplaceIds: US_MARKETPLACE,
      includedData: 'summaries', pageSize: 20,
    } });
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      const summary = (item.summaries ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? item.summaries?.[0];
      const asin = validAsin(item.asin);
      if (!asin || !summary) continue;
      result.set(asin, { size: clean(summary.size) || null, color: clean(summary.color) || null });
    }
  }
  return result;
}
