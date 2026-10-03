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

/** 大报告分段并行下载:每段多大、同时几段、一段最多试几次、一段多久没下完算卡住 */
export const downloadTiming = { chunkBytes: 8 * 1048576, parallel: 8, attempts: 6, chunkTimeoutMs: 10 * 60_000, retryMs: 3_000 };

/**
 * 边下载边解码报告,每收到一段文字调一次 onText。只用于 UTF-8 的 JSON 报告。
 * 品牌分析搜索词报告整个美国站一周有几个 GB,不能像小报告那样整份读进内存。
 * 服务器在国内时,单个连接从亚马逊 S3 下载很慢、还会断,所以按 Range 分段、同时下几段,
 * 按顺序交给解压;某段断了只重下那一段。下载链接 5 分钟过期,过期(403)时用 refresh 换新链接。
 * 不支持分段的(返回 200)就退回单连接整份下载。
 */
export async function streamReportDocument(document, onText, onBytes = () => {}, refresh = null) {
  let url = document.url;
  let renewing = null;
  // 几段同时发现链接过期时只换一次
  const renew = (stale) => {
    if (!refresh) return Promise.resolve(false);
    if (url !== stale) return Promise.resolve(true);
    renewing ??= refresh().then((fresh) => { url = clean(fresh?.url) || url; return url !== stale; }).finally(() => { renewing = null; });
    return renewing;
  };
  const failed = (error) => new Error(`下载亚马逊报告失败：${clean(error?.message) || '网络错误'}`);
  let probe;
  try {
    probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (probe.status === 403 && await renew(document.url)) probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  } catch (error) { throw failed(error); }
  if (!probe.ok) throw new Error(`下载亚马逊报告失败 (${probe.status})`);
  const total = probe.status === 206 ? Number(/\/(\d+)\s*$/.exec(probe.headers.get('content-range') ?? '')?.[1]) || null : null;
  let received = 0;
  const count = (bytes) => { received += bytes; onBytes(received, total ?? (Number(probe.headers.get('content-length')) || null)); };
  let stream;
  if (total) {
    await probe.body?.cancel();
    const { chunkBytes, parallel } = downloadTiming;
    const chunks = Math.ceil(total / chunkBytes);
    const fetchChunk = async (index) => {
      const from = index * chunkBytes, to = Math.min(total, from + chunkBytes) - 1;
      for (let attempt = 1; ; attempt += 1) {
        const used = url;
        let got = 0;
        try {
          const response = await fetch(used, { headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(downloadTiming.chunkTimeoutMs) });
          if (response.status === 403 && attempt < downloadTiming.attempts && await renew(used)) continue;
          if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
          const parts = [];
          for await (const part of response.body) { parts.push(part); got += part.byteLength; count(part.byteLength); }
          const buffer = Buffer.concat(parts);
          if (buffer.length !== to - from + 1) throw new Error('分段不完整');
          return buffer;
        } catch (error) {
          count(-got);
          if (attempt >= downloadTiming.attempts) throw failed(error);
          await sleep(downloadTiming.retryMs * attempt);
        }
      }
    };
    const pending = new Map();
    let next = 0, emitted = 0;
    const fill = () => { while (next < chunks && next < emitted + parallel) { const index = next++; const task = fetchChunk(index); task.catch(() => {}); pending.set(index, task); } };
    stream = new ReadableStream({
      async pull(controller) {
        if (emitted >= chunks) return controller.close();
        fill();
        const buffer = await pending.get(emitted);
        pending.delete(emitted);
        emitted += 1;
        fill();
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
      },
    });
  } else {
    if (!probe.body) throw new Error(`下载亚马逊报告失败 (${probe.status})`);
    stream = probe.body.pipeThrough(new TransformStream({ transform(chunk, controller) { count(chunk.byteLength); controller.enqueue(chunk); } }));
  }
  if (clean(document.compressionAlgorithm).toUpperCase() === 'GZIP') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  for await (const text of stream.pipeThrough(new TextDecoderStream('utf-8'))) onText(text);
}

export const amazonGateway = { request: spApiRequest, download: downloadReportDocument, stream: streamReportDocument };

/**
 * 从流式 JSON 里逐条取出「根对象里某个数组」的元素对象,不把整个文件拼成一个字符串。
 * 只认根对象下一层数组里的对象(品牌分析报告的 dataByDepartmentAndSearchTerm),字符串里的括号不算。
 */
export function createArrayRecordScanner(onRecord, { keep = () => true } = {}) {
  const stack = [];
  let inString = false, escaped = false, pieces = null;
  return (text) => {
    let start = pieces ? 0 : -1;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) inString = false;
        continue;
      }
      if (code === 34) inString = true;
      else if (code === 123 || code === 91) {
        if (code === 123 && stack.length === 2 && stack[0] === 123 && stack[1] === 91) { pieces = []; start = index; }
        stack.push(code);
      } else if (code === 125 || code === 93) {
        stack.pop();
        if (pieces && code === 125 && stack.length === 2) {
          pieces.push(text.slice(start, index + 1));
          const raw = pieces.join('');
          pieces = null; start = -1;
          // keep 先看原文,不要的记录不做 JSON.parse(整站报告几千万行,解析是大头)
          if (keep(raw)) onRecord(JSON.parse(raw));
        }
      }
    }
    if (pieces) pieces.push(text.slice(start));
  };
}

/** 报告接口被限流(429)时等一会再试;等的时候 onProgress 收到 { stage: 'throttled', retryAt },恢复后收到 stage */
async function waitOutThrottle(call, onProgress, stage) {
  for (let wait = 0; ; wait += 1) {
    try {
      const result = await call();
      if (wait) onProgress({ stage });
      return result;
    } catch (error) {
      if (error?.upstreamStatus !== 429 || wait >= reportTiming.maxThrottleWaits) throw error;
      onProgress({ stage: 'throttled', retryAt: new Date(Date.now() + reportTiming.throttleMs).toISOString(), waits: wait + 1 });
      await sleep(reportTiming.throttleMs);
    }
  }
}

/**
 * 申请一份报告、等它生成完、下载并解析。没有数据(CANCELLED)返回 parse 的空结果。
 * 平面文件默认按 TSV 解析;品牌分析这类 JSON 报告传 parse: JSON.parse。
 * onProgress 依次收到 stage: creating → throttled(被限流时)→ processing → downloading
 */
export async function runReport(account, reportType, { start, end, options, parse = parseTsv, onDocument, onProgress = () => {},
  maxWaitMs = null, reuse = false } = {}, gateway = amazonGateway) {
  const body = { reportType, marketplaceIds: [US_MARKETPLACE] };
  if (options) body.reportOptions = options;
  if (start) body.dataStartTime = start.toISOString();
  if (end) body.dataEndTime = end.toISOString();
  onProgress({ stage: 'creating' });
  // 很慢的报告:先找最近 3 天里同类型、同时间段已经申请过的,接着等它或直接下载,不重新排队
  let reportId = reuse ? await findRecentReport(account, reportType, start, end, gateway, onProgress) : '';
  if (!reportId) {
    const created = await waitOutThrottle(() => gateway.request(account, REGION, 'POST', '/reports/2021-06-30/reports', { body }), onProgress, 'creating');
    reportId = clean(created?.reportId);
  }
  if (!reportId) throw new Error(`亚马逊没有返回报告编号（${reportType}）`);
  const startedAt = Date.now();
  onProgress({ stage: 'processing', waitedMs: 0 });
  const deadline = maxWaitMs ?? reportTiming.pollMs * reportTiming.maxPolls;
  for (let poll = 0; ; poll += 1) {
    const report = await waitOutThrottle(() => gateway.request(account, REGION, 'GET', `/reports/2021-06-30/reports/${reportId}`), onProgress, 'processing');
    const status = clean(report?.processingStatus);
    if (status === 'DONE') {
      // 亚马逊自己生成这份报告用了多久(从申请到完成)
      const generated = Date.parse(report.processingEndTime) - Date.parse(report.createdTime);
      onProgress({ stage: 'downloading', amazonMs: Number.isFinite(generated) && generated >= 0 ? generated : null });
      const getDocument = () => waitOutThrottle(() => gateway.request(account, REGION, 'GET',
        `/reports/2021-06-30/documents/${clean(report.reportDocumentId)}`), onProgress, 'downloading');
      const document = await getDocument();
      // 太大的报告(品牌分析搜索词报告有几个 GB)由 onDocument 边下载边处理,不整份读进内存;
      // 第二个参数用来在下载链接过期后换新链接
      return onDocument ? onDocument(document, getDocument) : parse(await gateway.download(document));
    }
    // 亚马逊对没有数据的时间段直接取消报告
    if (status === 'CANCELLED') return parse === parseTsv && !onDocument ? [] : null;
    if (status === 'FATAL') throw new Error(`亚马逊生成报告失败（${reportType}）`);
    if (poll + 1 >= reportTiming.maxPolls && Date.now() - startedAt + reportTiming.pollMs > deadline) break;
    await sleep(reportTiming.pollMs);
    onProgress({ stage: 'processing', waitedMs: Date.now() - startedAt });
  }
  throw new Error(`亚马逊报告长时间未生成完（${reportType}），请稍后再同步`);
}

/** 最近 3 天申请过、时间段相同、还没失败的报告;有已完成的优先 */
async function findRecentReport(account, reportType, start, end, gateway, onProgress) {
  const payload = await waitOutThrottle(() => gateway.request(account, REGION, 'GET', '/reports/2021-06-30/reports', { query: {
    reportTypes: reportType, processingStatuses: 'IN_QUEUE,IN_PROGRESS,DONE', marketplaceIds: US_MARKETPLACE, pageSize: 100,
    createdSince: new Date(Date.now() - 3 * DAY_MS).toISOString(),
  } }), onProgress, 'creating').catch(() => null);
  const day = (value) => clean(value).slice(0, 10);
  const same = (payload?.reports ?? []).filter((report) => (!start || day(report.dataStartTime) === day(start.toISOString()))
    && (!end || day(report.dataEndTime) === day(end.toISOString())));
  const pick = same.find((report) => report.processingStatus === 'DONE') ?? same.find((report) => report.processingStatus !== 'DONE');
  return clean(pick?.reportId);
}

// ---------- 数据 ----------

/** 店铺全部 Listing:SKU、ASIN、标题、价格、状态 */
export async function fetchListings(account, gateway = amazonGateway, onProgress = () => {}) {
  const rows = await runReport(account, 'GET_MERCHANT_LISTINGS_ALL_DATA', { onProgress }, gateway);
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
export async function fetchOrderLines(account, start, end, gateway = amazonGateway, onProgress = () => {}) {
  const lines = [];
  for (let from = start; from < end;) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + REPORT_WINDOW_DAYS * DAY_MS));
    const rows = await runReport(account, 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', { start: from, end: to, onProgress }, gateway);
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

const moneyOf = (value) => {
  const text = clean(value);
  const number = Number(text);
  return text && text !== '--' && Number.isFinite(number) && number >= 0 ? number : null;
};

/**
 * Fee Preview 报告:每个在售 FBA SKU 的预估配送费和佣金。亚马逊至少每 72 小时更新一次,
 * 申请时开始时间要早于现在 72 小时以上、结束时间比开始晚 72 小时以上,所以取最近 4 天。
 */
export async function fetchFeePreview(account, now = new Date(), gateway = amazonGateway, onProgress = () => {}) {
  const end = new Date(now.getTime() - 5 * 60_000);
  const rows = await runReport(account, 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA',
    { start: new Date(end.getTime() - 4 * DAY_MS), end, onProgress }, gateway);
  const fees = new Map();
  for (const row of rows) {
    const sku = clean(row.sku);
    const fbaFee = moneyOf(row['expected-fulfillment-fee-per-unit']);
    const referralFee = moneyOf(row['estimated-referral-fee-per-unit']);
    if (!sku || (fbaFee == null && referralFee == null)) continue;
    const price = moneyOf(row['sales-price']) || moneyOf(row['your-price']);
    fees.set(sku.toLowerCase(), {
      sku, asin: validAsin(row.asin), fbaFee, referralFee, price: price || null,
      referralRate: referralFee != null && price ? Number((referralFee / price).toFixed(4)) : null,
      sizeTier: clean(row['product-size-tier']) || null,
    });
  }
  return [...fees.values()];
}

// ---------- 产品情报:竞品目录、价格 ----------

const textValues = (attributes, name) => (attributes?.[name] ?? [])
  .filter((entry) => !entry?.marketplace_id || entry.marketplace_id === US_MARKETPLACE)
  .map((entry) => clean(entry?.value)).filter(Boolean);

/** 目录接口一个商品 → 产品情报要用的字段。图片按位置(MAIN、PT01…)去重计数 */
export function catalogDetail(item) {
  const forUs = (list) => (list ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? list?.[0] ?? {};
  const summary = forUs(item.summaries);
  const ranks = forUs(item.salesRanks);
  const relations = forUs(item.relationships).relationships ?? [];
  const images = forUs(item.images).images ?? [];
  const variants = new Map();
  for (const image of images) {
    const current = variants.get(image.variant);
    if (!current || Math.abs((image.width ?? 0) - 1000) < Math.abs((current.width ?? 0) - 1000)) variants.set(image.variant, image);
  }
  const display = (ranks.displayGroupRanks ?? [])[0];
  const classification = (ranks.classificationRanks ?? [])[0];
  const variation = relations.filter((relation) => relation.type === 'VARIATION');
  return {
    asin: validAsin(item.asin),
    parentAsin: validAsin(variation.flatMap((relation) => relation.parentAsins ?? [])[0]),
    children: [...new Set(variation.flatMap((relation) => relation.childAsins ?? []).map(validAsin).filter(Boolean))],
    title: clean(summary.itemName) || textValues(item.attributes, 'item_name')[0] || null,
    brand: clean(summary.brand ?? summary.brandName) || textValues(item.attributes, 'brand')[0] || null,
    bullets: textValues(item.attributes, 'bullet_point'),
    size: clean(summary.size) || null, color: clean(summary.color) || null,
    productType: clean(forUs(item.productTypes).productType) || null,
    mainImage: variants.get('MAIN')?.link ?? null, imageCount: variants.size,
    bsr: display?.rank ?? null, bsrCategory: clean(display?.title) || null,
    subBsr: classification?.rank ?? null, subCategory: clean(classification?.title) || null,
  };
}

/** 目录详情(标题、五点、图片、排名、变体关系)。每次最多 20 个 ASIN;找不到的 ASIN 不在结果里 */
export async function fetchCatalogDetails(account, asins, gateway = amazonGateway, onBatch = () => {}) {
  const result = new Map();
  const list = [...new Set(asins.map(validAsin).filter(Boolean))];
  for (let index = 0; index < list.length; index += 20) {
    const payload = await gateway.request(account, REGION, 'GET', '/catalog/2022-04-01/items', { query: {
      identifiers: list.slice(index, index + 20).join(','), identifiersType: 'ASIN', marketplaceIds: US_MARKETPLACE,
      includedData: 'summaries,attributes,images,salesRanks,relationships,productTypes', pageSize: 20,
    } });
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      const detail = catalogDetail(item);
      if (detail.asin) result.set(detail.asin, detail);
    }
    onBatch(Math.min(list.length, index + 20), list.length);
  }
  return result;
}

/**
 * 竞品价格接口(getItemOffersBatch)每 10 秒 1 次,一次 20 个 ASIN。测试调成 0。
 */
export const pricingTiming = { batchGapMs: 10_500 };

const amountOf = (money) => {
  const number = Number(money?.Amount);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/** 一条 getItemOffers 结果 → 购物车价、最低价、划线价、卖家数 */
export function offerSummary(payload) {
  const summary = payload?.Summary ?? {};
  const isNew = (entry) => /^new$/i.test(clean(entry?.condition));
  const buyBox = (summary.BuyBoxPrices ?? []).find(isNew);
  const lowest = (summary.LowestPrices ?? []).filter(isNew)
    .map((entry) => amountOf(entry.LandedPrice) ?? amountOf(entry.ListingPrice)).filter((value) => value != null);
  return {
    price: amountOf(buyBox?.LandedPrice) ?? amountOf(buyBox?.ListingPrice) ?? (lowest.length ? Math.min(...lowest) : null),
    listPrice: amountOf(summary.ListPrice),
    offers: Number.isInteger(summary.TotalOfferCount) ? summary.TotalOfferCount : null,
  };
}

/** 一批 ASIN 的当前价格。返回 Map(asin → { price, listPrice, offers });亚马逊没给结果的 ASIN 不在里面 */
export async function fetchItemOffers(account, asins, gateway = amazonGateway, onBatch = () => {}) {
  const result = new Map();
  const list = [...new Set(asins.map(validAsin).filter(Boolean))];
  for (let index = 0; index < list.length; index += 20) {
    if (index) await sleep(pricingTiming.batchGapMs);
    const batch = list.slice(index, index + 20);
    const payload = await gateway.request(account, REGION, 'POST', '/batches/products/pricing/v0/itemOffers', { body: {
      requests: batch.map((asin) => ({ uri: `/products/pricing/v0/items/${asin}/offers`, method: 'GET',
        MarketplaceId: US_MARKETPLACE, ItemCondition: 'New', CustomerType: 'Consumer' })),
    } });
    for (const [position, response] of (payload?.responses ?? []).entries()) {
      const body = response?.body?.payload;
      const asin = validAsin(body?.ASIN ?? response?.request?.Identifier ?? /items\/([A-Z0-9]{10})\//.exec(response?.request?.uri ?? '')?.[1] ?? batch[position]);
      if (!asin || Number(response?.status?.statusCode) >= 400 || !body) continue;
      result.set(asin, offerSummary(body));
    }
    onBatch(Math.min(list.length, index + 20), list.length);
  }
  return result;
}

/** 自家 Listing 的后台搜索词和亚马逊报的问题(Listings Items API) */
export async function fetchOwnListing(account, sku, gateway = amazonGateway) {
  const payload = await gateway.request(account, REGION, 'GET',
    `/listings/2021-08-01/items/${encodeURIComponent(account.sellerId)}/${encodeURIComponent(sku)}`, { query: {
      marketplaceIds: US_MARKETPLACE, includedData: 'attributes,issues', issueLocale: 'en_US',
    } });
  return {
    backendTerms: textValues(payload?.attributes, 'generic_keyword').join(' '),
    issues: (payload?.issues ?? []).map((issue) => ({ severity: clean(issue.severity), message: clean(issue.message).slice(0, 300) })),
  };
}
