// Listing 管理(内测,只给超级管理员):选「品牌 - 站点」,把这个站点下所有 SKU 的商品信息
// 从 Listings Items API 拉下来缓存到本地,页面上改完再用 patchListingsItem 传回亚马逊。
// 上传默认只走 VALIDATION_PREVIEW(亚马逊只校验、不改 Listing);服务器 .env 设
// LISTINGS_LIVE_SUBMIT=true 之后,页面上的「提交到亚马逊」才会真正改线上 Listing。
// 按要求这一块暂时不写操作日志。
import express from 'express';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { db } from './db.js';
import { requireRole } from './auth.js';
import { AMAZON_MARKETPLACES, readSpApiConfig, spApiAccounts, spApiRequest } from './spApi.js';

const API = '/listings/2021-08-01/items';
const ROLE = '商品发布 (Product Listing)';
const INCLUDED = 'summaries,attributes,issues,offers,fulfillmentAvailability,relationships,productTypes';
const PAGE_SIZE = 20;
/** searchListingsItems 最多只能翻到 1000 个 SKU,再多的要靠「所有商品」报告补全 */
export const SEARCH_LIMIT = 1000;
const REPORT_TYPE = 'GET_MERCHANT_LISTINGS_ALL_DATA';
const REPORT_MAX_BYTES = 100 * 1024 * 1024;
/** 报告排队最长等 30 分钟 */
const REPORT_MAX_POLLS = 120;
export const listingTiming = { reportPollMs: 15_000 };
const ISSUE_LOCALE = 'zh_CN';

export const listingsRouter = express.Router();
listingsRouter.use(requireRole('owner'));

const clean = (value) => String(value ?? '').trim();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const httpError = (status, message) => Object.assign(new Error(message), { status });
const liveSubmitEnabled = () => process.env.LISTINGS_LIVE_SUBMIT === 'true';

/** 能选的「品牌 - 站点」:每个配置完整的卖家账号管的站点 */
function storeOptions() {
  const stores = [];
  for (const account of spApiAccounts()) {
    for (const country of account.markets) {
      if (stores.some((row) => row.brand === account.brand && row.country === country)) continue;
      stores.push({ brand: account.brand, country, sellerId: account.sellerId });
    }
  }
  return stores;
}

function accountFor(brand, country) {
  const account = spApiAccounts().find((row) => (
    row.brand.toLowerCase() === clean(brand).toLowerCase() && row.markets.includes(clean(country).toUpperCase())
  ));
  if (!account) throw httpError(400, `${clean(brand) || '这个品牌'} 没有 ${clean(country) || '这个站点'} 的亚马逊授权`);
  return account;
}

function storeOf(req) {
  const source = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const country = clean(source.country).toUpperCase();
  const account = accountFor(source.brand, country);
  return { account, country, marketplaceId: AMAZON_MARKETPLACES[country].id, region: AMAZON_MARKETPLACES[country].region };
}

/**
 * 调 Listings 接口。issueLocale 用中文,问题说明能直接看懂;
 * 万一亚马逊不认这个语言(400),去掉它再试一次。
 */
async function listingCall(store, path, options = {}) {
  const call = (query) => spApiRequest(store.account, store.region, path, {
    ...options, role: ROLE, rateKey: 'listings-items',
    query: { marketplaceIds: store.marketplaceId, ...options.query, ...query },
  });
  try {
    return await call({ issueLocale: ISSUE_LOCALE });
  } catch (error) {
    if (error.upstreamStatus !== 400) throw error;
    return call({});
  }
}

const skuPath = (store, sku) => `${API}/${encodeURIComponent(store.account.sellerId)}/${encodeURIComponent(sku)}`;

export function fetchListing(store, sku) {
  return listingCall(store, skuPath(store, sku), { query: { includedData: INCLUDED } });
}

// ---------- 「所有商品」报告:只用来拿完整的 SKU 列表 ----------

/** 报告表头的几种写法(个别站点会本地化),认不出时按亚马逊固定的列位置兜底 */
const REPORT_COLUMNS = {
  sku: ['seller-sku', 'sku', 'seller sku'],
  name: ['item-name', 'item name'],
  asin: ['asin1', 'asin'],
  price: ['price'],
  quantity: ['quantity'],
  status: ['status'],
  fulfillment: ['fulfillment-channel'],
  openDate: ['open-date'],
  listingId: ['listing-id'],
};

/** 报告的 TSV → [{ sku, name, asin, price, quantity, status, fulfillment, openDate, listingId }] */
export function parseListingsReport(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t').map((cell) => cell.trim().toLowerCase());
  const index = Object.fromEntries(Object.entries(REPORT_COLUMNS)
    .map(([key, names]) => [key, header.findIndex((cell) => names.includes(cell))]));
  if (index.sku < 0) index.sku = 3;
  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const pick = (key) => (index[key] >= 0 ? clean(cells[index[key]]) : '');
    const sku = pick('sku');
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    rows.push({
      sku, name: pick('name'), asin: pick('asin'), price: pick('price'), quantity: pick('quantity'),
      status: pick('status'), fulfillment: pick('fulfillment'), openDate: pick('openDate'), listingId: pick('listingId'),
    });
  }
  return rows;
}

async function downloadReport(document) {
  let url;
  try { url = new URL(document.url); } catch { throw new Error('亚马逊没有返回有效的报告下载地址'); }
  if (url.protocol !== 'https:') throw new Error('亚马逊报告下载地址必须使用 HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) throw new Error(`报告下载失败（HTTP ${response.status}）`);
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > REPORT_MAX_BYTES) throw new Error('报告文件超过 100 MB');
  if (document.compressionAlgorithm === 'GZIP') bytes = gunzipSync(bytes, { maxOutputLength: REPORT_MAX_BYTES });
  // 欧洲站的这份报告常是 Windows-1252 编码,按响应头里的 charset 解码
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(bytes);
}

async function fetchReportRows(store, onProgress) {
  const call = (path, options = {}) => spApiRequest(store.account, store.region, path, { ...options, role: ROLE });
  const created = await call('/reports/2021-06-30/reports', {
    method: 'POST', body: { reportType: REPORT_TYPE, marketplaceIds: [store.marketplaceId] },
  });
  const reportId = clean(created.reportId);
  if (!reportId) throw new Error('亚马逊没有返回报告编号');
  for (let poll = 0; poll < REPORT_MAX_POLLS; poll += 1) {
    onProgress({ phase: 'report', current: `等待亚马逊生成商品报告（已等 ${poll} 次）` });
    const report = await call(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const status = clean(report.processingStatus);
    if (status === 'DONE') {
      const document = await call(`/reports/2021-06-30/documents/${encodeURIComponent(clean(report.reportDocumentId))}`);
      return parseListingsReport(await downloadReport(document));
    }
    // 店铺里一个商品都没有时亚马逊会直接 CANCELLED
    if (status === 'CANCELLED') return [];
    if (status === 'FATAL') throw new Error('亚马逊生成商品报告失败');
    await sleep(listingTiming.reportPollMs);
  }
  throw new Error('亚马逊商品报告等了 30 分钟还没生成，请稍后重试');
}

// ---------- 整店拉取 ----------

/**
 * 先用 searchListingsItems 一页 20 个往下翻;店铺超过 1000 个 SKU 时翻不完,
 * 再拉「所有商品」报告拿全 SKU 列表,没翻到的逐个 getListingsItem 补上。
 */
export async function pullStore(store, onProgress = () => {}) {
  const items = new Map();
  let total = 0;
  let pageToken;
  do {
    const page = await listingCall(store, `${API}/${encodeURIComponent(store.account.sellerId)}`, {
      query: { includedData: INCLUDED, pageSize: PAGE_SIZE, sortBy: 'sku', sortOrder: 'ASC', pageToken },
    });
    total = Math.max(total, Number(page.numberOfResults) || 0);
    for (const item of Array.isArray(page.items) ? page.items : []) {
      if (clean(item?.sku)) items.set(item.sku, item);
    }
    onProgress({ phase: 'search', done: items.size, total: Math.min(total, SEARCH_LIMIT) || items.size });
    pageToken = clean(page.pagination?.nextToken) || undefined;
  } while (pageToken && items.size < SEARCH_LIMIT);

  let reportRows = null;
  let complete = true;
  const warnings = [];
  if (total > items.size || items.size >= SEARCH_LIMIT) {
    try {
      reportRows = await fetchReportRows(store, onProgress);
    } catch (error) {
      // 报告失败不丢掉已经翻到的 1000 个,只是这次不能确认全店清单
      complete = false;
      reportRows = [];
      warnings.push(`商品报告拉取失败，只拉到前 ${items.size} 个 SKU：${clean(error.message)}`);
    }
    const missing = reportRows.filter((row) => !items.has(row.sku));
    for (const [position, row] of missing.entries()) {
      onProgress({ phase: 'detail', done: position, total: missing.length, current: row.sku });
      try {
        items.set(row.sku, await fetchListing(store, row.sku));
      } catch (error) {
        warnings.push(`${row.sku}：${clean(error.message) || '读取失败'}`);
      }
    }
  }
  const reportBySku = new Map((reportRows ?? []).map((row) => [row.sku, row]));
  return { items: [...items.values()], reportBySku, total: Math.max(total, items.size), warnings, complete };
}

const summaryOf = (item, marketplaceId) => (
  (item.summaries ?? []).find((row) => row.marketplaceId === marketplaceId) ?? item.summaries?.[0] ?? {}
);

function saveItems(store, items, reportBySku, { replaceAll }) {
  const at = Date.now();
  const upsert = db.prepare(
    `INSERT INTO listing_items (seller_id, country, sku, brand, asin, product_type, item_name, data_json, report_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (seller_id, country, sku) DO UPDATE SET
       brand = excluded.brand, asin = excluded.asin, product_type = excluded.product_type,
       item_name = excluded.item_name, data_json = excluded.data_json,
       report_json = COALESCE(excluded.report_json, listing_items.report_json), fetched_at = excluded.fetched_at`
  );
  db.transaction(() => {
    if (replaceAll) {
      db.prepare('DELETE FROM listing_items WHERE seller_id = ? AND country = ?').run(store.account.sellerId, store.country);
    }
    for (const item of items) {
      const summary = summaryOf(item, store.marketplaceId);
      const report = reportBySku?.get(item.sku);
      upsert.run(
        store.account.sellerId, store.country, item.sku, store.account.brand,
        clean(summary.asin) || report?.asin || null, clean(summary.productType) || null,
        clean(summary.itemName) || report?.name || null,
        JSON.stringify(item), report ? JSON.stringify(report) : null, at,
      );
    }
  })();
}

// ---------- 列表 / 详情给页面看的样子 ----------

const amountOf = (money) => (money && money.amount !== undefined ? { amount: Number(money.amount), currency: clean(money.currencyCode ?? money.currency) } : null);

/** 一条缓存 → 列表里一行 */
export function listRow(row, marketplaceId) {
  const item = JSON.parse(row.data_json);
  const report = row.report_json ? JSON.parse(row.report_json) : null;
  const summary = summaryOf(item, marketplaceId);
  const offer = (item.offers ?? []).find((o) => o.offerType === 'B2C' && (!o.marketplaceId || o.marketplaceId === marketplaceId))
    ?? item.offers?.[0];
  const fulfillment = item.fulfillmentAvailability ?? [];
  const merchant = fulfillment.find((f) => f.fulfillmentChannelCode === 'DEFAULT');
  const issues = item.issues ?? [];
  const relationships = (item.relationships ?? []).flatMap((r) => r.relationships ?? []);
  const parentSkus = relationships.flatMap((r) => r.parentSkus ?? []);
  const childSkus = relationships.flatMap((r) => r.childSkus ?? []);
  return {
    sku: row.sku,
    asin: row.asin,
    fnSku: clean(summary.fnSku) || null,
    itemName: row.item_name,
    productType: row.product_type,
    condition: clean(summary.conditionType) || null,
    status: Array.isArray(summary.status) ? summary.status : [],
    image: clean(summary.mainImage?.link) || null,
    price: amountOf(offer?.price),
    channel: fulfillment.length && !merchant ? 'FBA' : merchant ? 'FBM' : (report?.fulfillment ? (report.fulfillment === 'DEFAULT' ? 'FBM' : 'FBA') : null),
    quantity: merchant ? Number(merchant.quantity ?? 0) : null,
    issues: {
      error: issues.filter((i) => i.severity === 'ERROR').length,
      warning: issues.filter((i) => i.severity === 'WARNING').length,
    },
    parent: parentSkus.length ? parentSkus[0] : null,
    childCount: childSkus.length,
    createdDate: clean(summary.createdDate) || null,
    lastUpdatedDate: clean(summary.lastUpdatedDate) || null,
    fetchedAt: row.fetched_at,
  };
}

// ---------- 改动 → JSON Patch ----------

const ATTRIBUTE_NAME = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * 页面提交的是「改了的属性 → 新值」,新值是亚马逊属性格式的数组;null 表示删掉这个属性。
 * 删除时带上原值的 marketplace_id / language_tag,只删这个站点、这个语言的值。
 */
export function buildPatches(changes, original = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw httpError(400, '没有要提交的改动');
  const entries = Object.entries(changes);
  if (!entries.length) throw httpError(400, '没有要提交的改动');
  if (entries.length > 100) throw httpError(400, '一次最多提交 100 个属性的改动');
  return entries.map(([name, value]) => {
    if (!ATTRIBUTE_NAME.test(name)) throw httpError(400, `属性名不对：${name}`);
    if (value === null) {
      const keys = (original[name] ?? []).map((entry) => Object.fromEntries(
        ['marketplace_id', 'language_tag'].filter((key) => entry?.[key]).map((key) => [key, entry[key]])
      ));
      return { op: 'delete', path: `/attributes/${name}`, ...(keys.length ? { value: keys } : {}) };
    }
    if (!Array.isArray(value) || !value.length || !value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      throw httpError(400, `${name} 的值格式不对，应该是一组对象`);
    }
    return { op: 'replace', path: `/attributes/${name}`, value };
  });
}

// ---------- 拉取任务(后台跑,页面轮询进度) ----------

const jobs = new Map();

function publicJob(job) {
  if (!job) return null;
  const { id, status, progress, result, error, startedAt, finishedAt } = job;
  return { id, status, progress, result, error, startedAt, finishedAt };
}

function startPull(store) {
  const key = `${store.account.sellerId}:${store.country}`;
  const current = jobs.get(key);
  if (current?.status === 'running') return current;
  const job = {
    id: randomUUID(), status: 'running', progress: { phase: 'search', done: 0, total: 0, current: '' },
    result: null, error: null, startedAt: Date.now(), finishedAt: null,
  };
  jobs.set(key, job);
  pullStore(store, (progress) => { job.progress = { ...job.progress, ...progress }; })
    .then(({ items, reportBySku, total, warnings, complete }) => {
      job.progress = { ...job.progress, phase: 'save', current: '' };
      // 拿到了全店 SKU 才把亚马逊上已经删掉的 SKU 清出缓存
      saveItems(store, items, reportBySku, { replaceAll: complete });
      job.result = { count: items.length, total, warnings: warnings.slice(0, 50), warningCount: warnings.length };
      job.status = 'done';
    })
    .catch((error) => {
      console.error('[listings-pull]', error);
      job.error = clean(error.message) || '拉取失败';
      job.status = 'error';
    })
    .finally(() => { job.finishedAt = Date.now(); });
  return job;
}

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const status = error.status ?? (error.upstreamStatus ? 502 : 500);
    if (status === 500) console.error('[listings]', error);
    res.status(status).json({ error: clean(error.message) || '请求失败' });
  }
};

listingsRouter.get('/stores', (req, res) => {
  const { issues } = readSpApiConfig();
  res.json({ stores: storeOptions(), configIssues: issues, liveSubmit: liveSubmitEnabled() });
});

listingsRouter.get('/pull', wrap((req, res) => {
  const store = storeOf(req);
  res.json({ job: publicJob(jobs.get(`${store.account.sellerId}:${store.country}`)) });
}));

listingsRouter.post('/pull', wrap((req, res) => {
  const store = storeOf(req);
  res.status(202).json({ job: publicJob(startPull(store)) });
}));

listingsRouter.get('/items', wrap((req, res) => {
  const store = storeOf(req);
  const rows = db.prepare('SELECT * FROM listing_items WHERE seller_id = ? AND country = ? ORDER BY sku')
    .all(store.account.sellerId, store.country);
  res.json({
    items: rows.map((row) => listRow(row, store.marketplaceId)),
    fetchedAt: rows.reduce((max, row) => Math.max(max, row.fetched_at), 0) || null,
  });
}));

function cachedItem(store, sku) {
  const row = db.prepare('SELECT * FROM listing_items WHERE seller_id = ? AND country = ? AND sku = ?')
    .get(store.account.sellerId, store.country, sku);
  return row ? { row, item: JSON.parse(row.data_json), report: row.report_json ? JSON.parse(row.report_json) : null } : null;
}

listingsRouter.get('/item', wrap(async (req, res) => {
  const store = storeOf(req);
  const sku = clean(req.query.sku);
  if (!sku) throw httpError(400, '缺少 SKU');
  if (req.query.refresh === '1') {
    const item = await fetchListing(store, sku);
    saveItems(store, [{ ...item, sku: item.sku || sku }], null, { replaceAll: false });
  }
  const cached = cachedItem(store, sku);
  if (!cached) throw httpError(404, '本地还没有这个 SKU，请先拉取');
  res.json({ item: cached.item, report: cached.report, row: listRow(cached.row, store.marketplaceId), marketplaceId: store.marketplaceId });
}));

/**
 * 上传改动。live 不为 true,或服务器没开 LISTINGS_LIVE_SUBMIT,都只让亚马逊校验(VALIDATION_PREVIEW),
 * 不会改线上 Listing。
 */
listingsRouter.post('/item/submit', wrap(async (req, res) => {
  const store = storeOf(req);
  const sku = clean(req.body?.sku);
  if (!sku) throw httpError(400, '缺少 SKU');
  const cached = cachedItem(store, sku);
  if (!cached) throw httpError(404, '本地还没有这个 SKU，请先拉取');
  const live = req.body?.live === true;
  if (live && !liveSubmitEnabled()) {
    throw httpError(403, '服务器还没有开启正式提交（.env 里 LISTINGS_LIVE_SUBMIT=true），这次只能校验');
  }
  const productType = clean(req.body?.productType) || clean(summaryOf(cached.item, store.marketplaceId).productType)
    || clean(cached.item.productTypes?.[0]?.productType);
  if (!productType) throw httpError(400, '不知道这个 SKU 的商品类型（productType），请先刷新这个 SKU');
  const patches = buildPatches(req.body?.changes, cached.item.attributes ?? {});
  const result = await listingCall(store, skuPath(store, sku), {
    method: 'PATCH',
    query: { includedData: 'issues,identifiers', ...(live ? {} : { mode: 'VALIDATION_PREVIEW' }) },
    body: { productType, patches },
  });
  res.json({
    mode: live ? 'live' : 'preview',
    status: clean(result.status),
    submissionId: clean(result.submissionId) || null,
    issues: Array.isArray(result.issues) ? result.issues : [],
    patches,
  });
}));
