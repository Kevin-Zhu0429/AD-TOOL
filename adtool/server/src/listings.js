// Listing 管理(内测,只给超级管理员):选「品牌 - 站点」,把这个站点下所有 SKU 的商品信息
// 从 Listings Items API 拉下来缓存到本地,页面上改完再用 patchListingsItem 传回亚马逊。
// 「校验」只走 VALIDATION_PREVIEW(亚马逊只校验、不改 Listing);「提交到亚马逊」先自动校验一遍,
// 没有错误才真正改线上 Listing。出问题时可以在 .env 设 LISTINGS_LIVE_SUBMIT=false 临时关掉正式提交。
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
const liveSubmitEnabled = () => process.env.LISTINGS_LIVE_SUBMIT !== 'false';

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
  const theme = relationships.find((r) => r.variationTheme)?.variationTheme;
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
    parent: parentSkus[0] ?? (clean(item.attributes?.child_parent_sku_relationship?.[0]?.parent_sku) || null),
    childCount: childSkus.length,
    childSkus,
    parentage: clean(item.attributes?.parentage_level?.[0]?.value) || (childSkus.length ? 'parent' : parentSkus.length ? 'child' : null),
    variationTheme: clean(theme?.theme) || clean(item.attributes?.variation_theme?.[0]?.name) || null,
    themeAttributes: Array.isArray(theme?.attributes) ? theme.attributes : [],
    createdDate: clean(summary.createdDate) || null,
    lastUpdatedDate: clean(summary.lastUpdatedDate) || null,
    fetchedAt: row.fetched_at,
  };
}

// ---------- 改动 → JSON Patch ----------

/** 目前只开放这几个属性:标题、五点、描述、搜索词、价格(含促销价和日期)、打印页数 */
export const EDITABLE_ATTRIBUTES = new Set([
  'item_name', 'bullet_point', 'product_description', 'generic_keyword', 'purchasable_offer', 'page_yield',
]);

/**
 * 页面提交的是「改了的属性 → 新值」,新值是亚马逊属性格式的数组;null 表示删掉这个属性。
 * 删除时带上原值的 marketplace_id / language_tag,只删这个站点、这个语言的值。
 */
export function buildPatches(changes, original = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw httpError(400, '没有要提交的改动');
  const entries = Object.entries(changes);
  if (!entries.length) throw httpError(400, '没有要提交的改动');
  return entries.map(([name, value]) => {
    if (!EDITABLE_ATTRIBUTES.has(name)) throw httpError(400, `${name} 目前不开放修改`);
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

/** 正式提交被接收后,把改动写进本地缓存,页面马上显示新值;亚马逊真正生效以「从亚马逊刷新」为准 */
function applyToCache(store, cached, patches) {
  const attributes = { ...(cached.item.attributes ?? {}) };
  for (const { op, path, value } of patches) {
    const name = path.replace('/attributes/', '');
    if (op === 'delete') delete attributes[name];
    else attributes[name] = value;
  }
  const item = { ...cached.item, attributes };
  // 改了变体关系时,亚马逊返回的旧关系已经不准,先按提交的属性显示,刷新后再以亚马逊为准
  if (patches.some((p) => p.path === '/attributes/child_parent_sku_relationship')) delete item.relationships;
  const title = attributes.item_name?.[0]?.value;
  db.prepare('UPDATE listing_items SET data_json = ?, item_name = COALESCE(?, item_name) WHERE seller_id = ? AND country = ? AND sku = ?')
    .run(JSON.stringify(item), title ? clean(title) : null, store.account.sellerId, store.country, cached.row.sku);
}

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

function productTypeOf(store, cached) {
  const productType = clean(summaryOf(cached.item, store.marketplaceId).productType)
    || clean(cached.item.productTypes?.[0]?.productType);
  if (!productType) throw httpError(400, `不知道 ${cached.row.sku} 的商品类型（productType），请先刷新这个 SKU`);
  return productType;
}

function sendPatch(store, sku, productType, patches, preview) {
  return listingCall(store, skuPath(store, sku), {
    method: 'PATCH',
    query: { includedData: 'issues,identifiers', ...(preview ? { mode: 'VALIDATION_PREVIEW' } : {}) },
    body: { productType, patches },
  });
}

const isBlocked = (result) => clean(result.status) !== 'VALID'
  || (result.issues ?? []).some((issue) => issue?.severity === 'ERROR');

const submissionOf = (result) => ({
  status: clean(result.status),
  submissionId: clean(result.submissionId) || null,
  issues: Array.isArray(result.issues) ? result.issues : [],
});

function requireLive(live) {
  if (live && !liveSubmitEnabled()) {
    throw httpError(403, '服务器关闭了正式提交（.env 里 LISTINGS_LIVE_SUBMIT=false），这次只能校验');
  }
}

/**
 * 上传改动。live 不为 true 时只让亚马逊校验(VALIDATION_PREVIEW),不改线上 Listing。
 * live 为 true 时先校验,校验不通过就停下把问题返回;通过了才正式提交,并把改动写进本地缓存。
 */
listingsRouter.post('/item/submit', wrap(async (req, res) => {
  const store = storeOf(req);
  const sku = clean(req.body?.sku);
  if (!sku) throw httpError(400, '缺少 SKU');
  const cached = cachedItem(store, sku);
  if (!cached) throw httpError(404, '本地还没有这个 SKU，请先拉取');
  const live = req.body?.live === true;
  requireLive(live);
  const productType = productTypeOf(store, cached);
  const patches = buildPatches(req.body?.changes, cached.item.attributes ?? {});
  const reply = (mode, result, extra = {}) => res.json({ mode, ...submissionOf(result), patches, ...extra });

  const preview = await sendPatch(store, sku, productType, patches, true);
  if (!live || isBlocked(preview)) return reply('preview', preview, live ? { blocked: true } : {});

  const result = await sendPatch(store, sku, productType, patches, false);
  if (clean(result.status) === 'ACCEPTED') applyToCache(store, cached, patches);
  reply('live', result);
}));

// ---------- 变体合并(跨站借评) ----------
// 把子体 SKU 挂到同一卖家账号、同一站点里已有的父体 SKU 下面,评论在整个变体家族里共享。
// 每个子体要写 parentage_level=child、child_parent_sku_relationship 指向父体、variation_theme 和父体一致,
// 还要带上变体主题对应的属性值(比如主题 COLOR 就要有 color),同一家族里这些值不能重复。

const MAX_CHILDREN = 50;
/** 子体可以随合并一起改的属性:变体主题会用到的那几个 */
const THEME_ATTRIBUTE = /^[a-z][a-z0-9_]{0,59}$/;

/** 合并一个子体的 patch:关系三件套 + 变体属性值(文字值带上原有或默认的 language_tag) */
export function variationPatches({ parentSku, theme, marketplaceId, values = {}, attributes = {}, languageTag }) {
  const patches = [
    { op: 'replace', path: '/attributes/parentage_level', value: [{ marketplace_id: marketplaceId, value: 'child' }] },
    { op: 'replace', path: '/attributes/child_parent_sku_relationship', value: [
      { marketplace_id: marketplaceId, child_relationship_type: 'variation', parent_sku: parentSku },
    ] },
    { op: 'replace', path: '/attributes/variation_theme', value: [{ name: theme }] },
  ];
  for (const [name, raw] of Object.entries(values)) {
    if (!THEME_ATTRIBUTE.test(name)) throw httpError(400, `变体属性名不对：${name}`);
    const text = clean(raw);
    if (!text) continue;
    const base = attributes[name]?.[0] ?? {};
    const tag = base.language_tag ?? languageTag;
    patches.push({ op: 'replace', path: `/attributes/${name}`, value: [
      { ...(tag ? { language_tag: tag } : {}), value: text, marketplace_id: base.marketplace_id ?? marketplaceId },
    ] });
  }
  return patches;
}

/** 移出变体:删掉关系三件套,子体变回独立 Listing */
export function detachPatches(marketplaceId) {
  return ['parentage_level', 'child_parent_sku_relationship', 'variation_theme'].map((name) => (
    { op: 'delete', path: `/attributes/${name}`, ...(name === 'variation_theme' ? {} : { value: [{ marketplace_id: marketplaceId }] }) }
  ));
}

const languageOf = (item) => Object.values(item.attributes ?? {}).flat().find((entry) => entry?.language_tag)?.language_tag;

/**
 * 父体的分类写在哪个属性:美国站模板用 item_type_keyword(如 inkjet-printer-ink-cartridges),
 * 欧洲站模板没有这一列,用 recommended_browse_nodes(西班牙墨盒是 34285014031)。
 */
export const categoryAttribute = (country) => (['ES', 'DE', 'FR', 'IT', 'UK'].includes(country) ? 'recommended_browse_nodes' : 'item_type_keyword');

/**
 * 新建父体的属性,和卖家后台模板里父体那一行一致:父体标记、变体主题、标题、品牌、分类。
 * 父体不卖货,没有价格、库存和 UPC。
 */
export function parentAttributes({ theme, itemName, brand, category, country, marketplaceId, languageTag }) {
  const text = (value) => [{ ...(languageTag ? { language_tag: languageTag } : {}), value, marketplace_id: marketplaceId }];
  return {
    parentage_level: [{ marketplace_id: marketplaceId, value: 'parent' }],
    variation_theme: [{ name: theme }],
    item_name: text(itemName),
    brand: text(brand),
    ...(category ? { [categoryAttribute(country)]: [{ value: category, marketplace_id: marketplaceId }] } : {}),
  };
}

function sendPut(store, sku, productType, attributes, preview) {
  return listingCall(store, skuPath(store, sku), {
    method: 'PUT',
    query: { includedData: 'issues,identifiers', ...(preview ? { mode: 'VALIDATION_PREVIEW' } : {}) },
    body: { productType, requirements: 'LISTING_PRODUCT_ONLY', attributes },
  });
}

/**
 * 合并:children = [{ sku, values: { set_name: '67xl Black' } }]。
 * 挂到已有父体:所有子体先逐个校验,有一个不通过就整批不提交;live 时全部通过才逐个正式提交。
 * 新建父体(newParent = { sku, itemName, brand, category }):父体还不存在,子体的校验可能报「找不到父体」,
 * 所以 live 时先校验并建好父体,再校验子体,全部通过才挂子体。
 */
listingsRouter.post('/variation/merge', wrap(async (req, res) => {
  const store = storeOf(req);
  const live = req.body?.live === true;
  requireLive(live);
  const newParent = req.body?.newParent && typeof req.body.newParent === 'object' ? req.body.newParent : null;
  const parentSku = clean(newParent ? newParent.sku : req.body?.parentSku);
  const theme = clean(req.body?.theme);
  const children = Array.isArray(req.body?.children) ? req.body.children : [];
  if (!parentSku) throw httpError(400, newParent ? '请填新父体的 SKU' : '请选择父体 SKU');
  if (!theme) throw httpError(400, '缺少变体主题（variation_theme）');
  if (!children.length) throw httpError(400, '请选择要合并进来的子体 SKU');
  if (children.length > MAX_CHILDREN) throw httpError(400, `一次最多合并 ${MAX_CHILDREN} 个子体`);
  const parent = newParent ? null : cachedItem(store, parentSku);
  if (!newParent && !parent) throw httpError(404, `本地没有父体 ${parentSku}，请先拉取`);
  if (newParent && cachedItem(store, parentSku)) throw httpError(400, `${parentSku} 已经存在，请直接在「已有父体」里选它`);

  const cachedChildren = children.map((child) => {
    const sku = clean(child?.sku);
    if (!sku || sku === parentSku) throw httpError(400, '子体 SKU 不能为空，也不能是父体自己');
    const cached = cachedItem(store, sku);
    if (!cached) throw httpError(404, `本地没有 ${sku}，请先拉取`);
    return { sku, cached, productType: productTypeOf(store, cached), child };
  });
  // 同一个变体家族必须是同一个商品类型,不一样的先拦下,不发给亚马逊;新父体用子体的类型
  const parentType = parent ? productTypeOf(store, parent) : cachedChildren[0].productType;
  const languageTag = languageOf(parent?.item ?? {}) ?? cachedChildren.map((row) => languageOf(row.cached.item)).find(Boolean);
  const plans = cachedChildren.map(({ sku, cached, productType, child }) => {
    if (productType !== parentType) {
      throw httpError(400, `${sku} 的商品类型是 ${productType}，${parent ? '父体' : `${cachedChildren[0].sku}`}是 ${parentType}，不同类型不能合并成一个变体`);
    }
    const values = child?.values && typeof child.values === 'object' && !Array.isArray(child.values) ? child.values : {};
    return { sku, cached, productType, patches: variationPatches({
      parentSku, theme, marketplaceId: store.marketplaceId, values,
      attributes: cached.item.attributes ?? {}, languageTag: languageOf(cached.item) ?? languageTag,
    }) };
  });
  const seen = new Set();
  for (const plan of plans) {
    if (seen.has(plan.sku)) throw httpError(400, `${plan.sku} 重复了`);
    seen.add(plan.sku);
  }

  let parentResult = null;
  let parentAttrs = null;
  if (newParent) {
    const itemName = clean(newParent.itemName);
    const brand = clean(newParent.brand);
    if (!itemName || !brand) throw httpError(400, '新父体要填标题和品牌');
    parentAttrs = parentAttributes({
      theme, itemName, brand, category: clean(newParent.category), country: store.country,
      marketplaceId: store.marketplaceId, languageTag,
    });
    const preview = await sendPut(store, parentSku, parentType, parentAttrs, true);
    parentResult = { sku: parentSku, mode: 'preview', ...submissionOf(preview), blocked: isBlocked(preview), parent: true };
    if (live && parentResult.blocked) return res.json({ mode: 'preview', blocked: true, parent: parentResult, results: [] });
    if (live) {
      const created = await sendPut(store, parentSku, parentType, parentAttrs, false);
      parentResult = { sku: parentSku, mode: 'live', ...submissionOf(created), parent: true };
      if (parentResult.status !== 'ACCEPTED') return res.json({ mode: 'live', blocked: true, parent: parentResult, results: [] });
      // 先放进本地缓存,页面上马上能当父体选;亚马逊处理完以重新拉取为准
      saveItems(store, [{
        sku: parentSku,
        summaries: [{ marketplaceId: store.marketplaceId, productType: parentType, itemName, status: [] }],
        attributes: parentAttrs,
      }], null, { replaceAll: false });
    }
  }

  const results = [];
  for (const plan of plans) {
    const preview = await sendPatch(store, plan.sku, plan.productType, plan.patches, true);
    results.push({ sku: plan.sku, mode: 'preview', ...submissionOf(preview), blocked: isBlocked(preview), patches: plan.patches });
  }
  const blocked = results.some((row) => row.blocked);
  if (!live || blocked) return res.json({ mode: 'preview', blocked: live && blocked, parent: parentResult, results });

  for (const [index, plan] of plans.entries()) {
    const result = await sendPatch(store, plan.sku, plan.productType, plan.patches, false);
    if (clean(result.status) === 'ACCEPTED') applyToCache(store, plan.cached, plan.patches);
    results[index] = { sku: plan.sku, mode: 'live', ...submissionOf(result), patches: plan.patches };
  }
  res.json({ mode: 'live', parent: parentResult, results });
}));

/** 把一个子体移出变体家族,同样先校验再提交 */
listingsRouter.post('/variation/detach', wrap(async (req, res) => {
  const store = storeOf(req);
  const live = req.body?.live === true;
  requireLive(live);
  const sku = clean(req.body?.sku);
  const cached = sku ? cachedItem(store, sku) : null;
  if (!cached) throw httpError(404, '本地没有这个 SKU，请先拉取');
  const productType = productTypeOf(store, cached);
  const patches = detachPatches(store.marketplaceId);
  const preview = await sendPatch(store, sku, productType, patches, true);
  if (!live || isBlocked(preview)) {
    return res.json({ mode: 'preview', ...submissionOf(preview), blocked: live && isBlocked(preview), patches });
  }
  const result = await sendPatch(store, sku, productType, patches, false);
  if (clean(result.status) === 'ACCEPTED') applyToCache(store, cached, patches);
  res.json({ mode: 'live', ...submissionOf(result), patches });
}));
