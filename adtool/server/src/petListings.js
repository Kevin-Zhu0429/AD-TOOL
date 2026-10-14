// 「Listing」板块:读取店铺所有 SKU 在亚马逊上的完整 Listing 属性,店主在网站上改完直接上传(SP-API Listings Items)。
// 上传复用待确认改动的执行流程:先让亚马逊预检、再提交、每 20 分钟核对是否生效,每一步记进改动日志,
// 所以每日分析的冷却期和第 7、14、28 天复盘都能看到这些改动。Claude 通过连接器提的修改仍然先进待确认队列。
import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, requireRole } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { amazonGateway, pacificDay, petSpConfig, US_MARKETPLACE } from './petAmazon.js';
import { COOLDOWN_DAYS } from './petAgent.js';
import { attributeKey, checkBatch, checkListingValue, checkReason, currentValue, kickQueue, kindLabelOf, LISTING_FIELDS, log, patchFor,
  readListing, saveProposals, shape, skuDirectory, update } from './petChanges.js';
import { cachedSchema, catalogPackage, DEDICATED_ATTRS, entryText, measuredPackage, packageMismatch, productTypeSchema, READ_ONLY_ATTRS, sellerPackage,
  usEntries } from './listingAttrs.js';

const clean = (value) => String(value ?? '').trim();
const lowerKey = (value) => clean(value).toLowerCase();
const parseJson = (text, fallback = null) => {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
};
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const nowLocal = () => db.prepare("SELECT datetime('now','localtime') AS t").get().t;
const defaultDeps = { gateway: amazonGateway, env: process.env };
// 上传后最多等这么久把亚马逊的受理结果带回页面,超时就让页面自己刷新
const SUBMIT_WAIT_MS = 25_000;
export const listingTiming = { gapMs: 250 };

function requireAccount(env) {
  const { account, issues } = petSpConfig(env);
  if (!account) throw Object.assign(new Error(issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证(PET_SP_*)'), { status: 503 });
  return account;
}

// ---------- 同步 ----------

function saveItem(item) {
  db.prepare(`INSERT INTO pet_listing_items (sku, asin, product_type, item_name, status_json, attributes_json, issues_json, amazon_updated, synced_at)
    VALUES (@sku, @asin, @productType, @itemName, @status, @attributes, @issues, @lastUpdated, datetime('now','localtime'))
    ON CONFLICT(sku) DO UPDATE SET asin=excluded.asin, product_type=excluded.product_type, item_name=excluded.item_name, status_json=excluded.status_json,
      attributes_json=excluded.attributes_json, issues_json=excluded.issues_json, amazon_updated=excluded.amazon_updated, synced_at=excluded.synced_at`)
    .run({ sku: item.sku, asin: item.asin ?? null, productType: item.productType ?? null,
      itemName: usEntries(item.attributes, 'item_name')[0]?.value ?? item.itemName ?? null, status: JSON.stringify(item.status ?? []),
      attributes: JSON.stringify(item.attributes ?? {}), issues: JSON.stringify(item.issues ?? []), lastUpdated: item.lastUpdated ?? null });
}

function fromSearch(raw) {
  const summary = (raw?.summaries ?? []).find((entry) => entry.marketplaceId === US_MARKETPLACE) ?? raw?.summaries?.[0] ?? {};
  return { sku: raw.sku, asin: summary.asin ?? null, productType: summary.productType ?? null, itemName: summary.itemName ?? null,
    status: summary.status ?? [], lastUpdated: summary.lastUpdatedDate ?? null, attributes: raw.attributes ?? {}, issues: raw.issues ?? [] };
}

let running = false, progress = null, lastError = null;

/**
 * 读全店 Listing:先用 searchListingsItems 一页 20 个整店翻;SKU 库里有但没翻到的(或这个接口用不了时全部)再一个个读。
 * 成功翻完整店后,亚马逊上已经没有的 SKU 从表里删掉。
 */
export async function syncListingItems({ gateway = amazonGateway, env = process.env } = {}) {
  const account = requireAccount(env);
  if (running) throw Object.assign(new Error('Listing 正在同步'), { status: 409 });
  running = true; lastError = null; progress = { done: 0, total: null, stage: '整店读取' };
  try {
    const seen = new Set();
    let complete = false, pageToken = null, searchError = null;
    try {
      for (let page = 0; page < 200; page += 1) {
        const payload = await gateway.request(account, account.region, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(account.sellerId)}`, { query: {
          marketplaceIds: US_MARKETPLACE, includedData: 'summaries,attributes,issues', issueLocale: 'en_US', pageSize: 20, pageToken } });
        for (const raw of payload?.items ?? []) {
          if (!raw?.sku) continue;
          saveItem(fromSearch(raw));
          seen.add(lowerKey(raw.sku));
        }
        progress = { done: seen.size, total: payload?.numberOfResults ?? null, stage: '整店读取' };
        pageToken = payload?.pagination?.nextToken ?? null;
        if (!pageToken) { complete = true; break; }
        await sleep(listingTiming.gapMs);
      }
    } catch (error) {
      searchError = error.message;
    }
    const missing = [...skuDirectory().values()].filter((item) => !seen.has(lowerKey(item.sku)));
    let failed = 0;
    for (const [index, item] of missing.entries()) {
      progress = { done: seen.size, total: seen.size + missing.length - index, stage: '逐个读取' };
      try {
        saveItem(await readListing(account, item.sku, gateway));
        seen.add(lowerKey(item.sku));
      } catch (error) {
        // 亚马逊上已经删掉的 SKU 读不到,不算失败
        if (!/找不到/.test(error.message)) failed += 1;
      }
      await sleep(listingTiming.gapMs);
    }
    let removed = 0;
    if (complete && !searchError) {
      for (const row of db.prepare('SELECT sku FROM pet_listing_items').all()) {
        if (!seen.has(lowerKey(row.sku))) { db.prepare('DELETE FROM pet_listing_items WHERE sku=?').run(row.sku); removed += 1; }
      }
    }
    // 每种商品类型的属性定义顺手拉一次(一天内有缓存就不重复拉)
    for (const { product_type: productType } of db.prepare('SELECT DISTINCT product_type FROM pet_listing_items WHERE product_type IS NOT NULL').all()) {
      await productTypeSchema(account, productType, { gateway });
    }
    if (searchError && !seen.size) throw new Error(searchError);
    return { synced: seen.size, removed, failed, searchError };
  } catch (error) {
    lastError = error.message;
    throw error;
  } finally { running = false; progress = null; }
}

export function listingSyncStatus(env = process.env) {
  const { account, issues } = petSpConfig(env);
  const last = db.prepare('SELECT MAX(synced_at) AS at, COUNT(*) AS n FROM pet_listing_items').get();
  return { configured: !!account, issues, running, progress, lastError, lastSyncedAt: last.at, total: last.n };
}

/** 启动 5 分钟后同步一次,之后每 12 小时一次 */
export function startListingSyncScheduler() {
  if (!isPet || process.env.NODE_ENV === 'test') return;
  const run = () => {
    if (!listingSyncStatus().configured || running) return;
    void syncListingItems().catch((error) => console.error('[listing-sync]', error.message));
  };
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, 12 * 3600_000).unref();
}

// ---------- 包装尺寸对照 ----------

/** 库里 FBA 费用报告的实测值和尺寸分段,按 SKU */
function feeMeasures() {
  return new Map(db.prepare('SELECT sku, size_tier, measured_json, updated_at FROM pet_sku_fees').all()
    .map((row) => [lowerKey(row.sku), { sizeTier: row.size_tier, measured: parseJson(row.measured_json), updatedAt: row.updated_at }]));
}

/** 亚马逊目录里在用的单件包装尺寸(Catalog Items API) */
async function readCatalogDimensions(account, asin, gateway) {
  const payload = await gateway.request(account, account.region, 'GET', `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, {
    query: { marketplaceIds: US_MARKETPLACE, includedData: 'dimensions' } });
  return payload?.dimensions ?? [];
}

/** 一个 SKU 的三套包装数据:卖家填的、亚马逊目录在用的(有 catalog 时)、FBA 实测和尺寸分段 */
function packaging(attributes, fee, catalog) {
  const seller = sellerPackage(attributes);
  const fba = fee ? measuredPackage(fee.measured, fee.sizeTier) : null;
  const amazon = catalog ?? (fba?.standard != null ? fba : null);
  return { seller, catalog: catalog ?? null, fba: fba ? { ...fba, updatedAt: fee.updatedAt } : null, warning: packageMismatch(seller, amazon) };
}

// ---------- 读给页面 ----------

const statusText = (list) => (list.includes('BUYABLE') ? '可售' : list.includes('DISCOVERABLE') ? '可搜到' : list.length ? list.join('/') : '不可售');

/** 每个 SKU 最近一次 Listing 改动的执行时间(冷却期用)和还没处理完的改动数 */
function changeState() {
  const recent = new Map(), open = new Map();
  for (const row of db.prepare(`SELECT kind, status, target_json, executed_at FROM pet_change_proposals WHERE kind LIKE 'listing_%'
    AND status IN ('pending','queued','running','submitted','applied','failed')`).all()) {
    const sku = lowerKey(parseJson(row.target_json, {}).sku);
    if (['pending', 'queued', 'running', 'submitted', 'failed'].includes(row.status)) open.set(sku, (open.get(sku) ?? 0) + 1);
    if (row.executed_at && (!recent.has(sku) || row.executed_at > recent.get(sku))) recent.set(sku, row.executed_at);
  }
  return { recent, open };
}

function cooldownOf(executedAt, today = pacificDay(new Date())) {
  if (!executedAt) return null;
  // 库里的时间是服务器本地时间,换成太平洋时间的日期(和每日分析的冷却期算法一样)
  const seconds = db.prepare("SELECT CAST(strftime('%s', ?, 'utc') AS INTEGER) AS s").get(executedAt)?.s;
  const day = seconds ? pacificDay(new Date(seconds * 1000)) : executedAt.slice(0, 10);
  const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  return age < COOLDOWN_DAYS ? { lastChangeDay: day, daysLeft: COOLDOWN_DAYS - age } : null;
}

/** 全店 Listing 一览:每个 SKU 一行 */
export function listingBoard({ q = '', env = process.env } = {}) {
  const library = new Map(db.prepare("SELECT sku, style, size, color, stock FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID)
    .map((row) => [lowerKey(row.sku), row]));
  const { recent, open } = changeState();
  const fees = feeMeasures();
  const term = lowerKey(q);
  const rows = db.prepare('SELECT * FROM pet_listing_items ORDER BY sku').all().map((row) => {
    const attributes = parseJson(row.attributes_json, {});
    const issues = parseJson(row.issues_json, []);
    const extra = library.get(lowerKey(row.sku)) ?? {};
    const status = parseJson(row.status_json, []);
    return {
      sku: row.sku, asin: row.asin, productType: row.product_type, title: row.item_name, style: extra.style ?? null, size: extra.size ?? null,
      color: extra.color ?? null, stock: extra.stock ?? null, status, statusText: statusText(status),
      bullets: usEntries(attributes, 'bullet_point').length, searchTermBytes: Buffer.byteLength(usEntries(attributes, 'generic_keyword').map((entry) => entry.value ?? '').join(' '), 'utf8'),
      hasDescription: usEntries(attributes, 'product_description').length > 0, attributeCount: Object.keys(attributes).length,
      errors: issues.filter((issue) => issue.severity === 'ERROR').length, warnings: issues.filter((issue) => issue.severity === 'WARNING').length,
      openChanges: open.get(lowerKey(row.sku)) ?? 0, packaging: packaging(attributes, fees.get(lowerKey(row.sku)), null), cooldown: cooldownOf(recent.get(lowerKey(row.sku))),
      amazonUpdated: row.amazon_updated, syncedAt: row.synced_at,
    };
  }).filter((row) => !term || [row.sku, row.asin, row.title, row.style, row.size, row.color].some((field) => lowerKey(field).includes(term)));
  return { rows, sync: listingSyncStatus(env), cooldownDays: COOLDOWN_DAYS };
}

/** 导出:每个 SKU 一行,每个属性一列(值拼成文字) */
export function listingExport() {
  const rows = db.prepare('SELECT * FROM pet_listing_items ORDER BY sku').all();
  const columns = new Set();
  const records = rows.map((row) => {
    const attributes = parseJson(row.attributes_json, {});
    const record = { sku: row.sku, asin: row.asin, product_type: row.product_type };
    for (const name of Object.keys(attributes)) {
      columns.add(name);
      record[name] = usEntries(attributes, name).map(entryText).join(' | ');
    }
    return record;
  });
  return { columns: ['sku', 'asin', 'product_type', ...[...columns].sort()], rows: records };
}

const pendingFor = (sku) => db.prepare(`SELECT * FROM pet_change_proposals WHERE kind LIKE 'listing_%' AND status IN ('pending','queued','running','submitted','failed')
  AND target_key LIKE ? ORDER BY id DESC`).all(`listing:${lowerKey(sku)}:%`).map(shape);

/** 某个 SKU 的完整 Listing(实时读亚马逊,顺便更新缓存),带上属性定义、冷却期和还没处理完的改动 */
export async function listingDetail(sku, { gateway = amazonGateway, env = process.env } = {}) {
  const account = requireAccount(env);
  const known = skuDirectory().get(lowerKey(sku));
  const target = known?.sku ?? db.prepare('SELECT sku FROM pet_listing_items WHERE sku=?').get(clean(sku))?.sku ?? clean(sku);
  if (!target) throw Object.assign(new Error('请提供 SKU'), { status: 400 });
  const listing = await readListing(account, target, gateway);
  saveItem(listing);
  const schema = await productTypeSchema(account, listing.productType, { gateway });
  const { recent } = changeState();
  let catalog = null, catalogError = null;
  if (listing.asin) {
    try { catalog = catalogPackage(await readCatalogDimensions(account, listing.asin, gateway)); } catch (error) { catalogError = error.message; }
  }
  return {
    sku: listing.sku, asin: listing.asin, productType: listing.productType, status: listing.status, statusText: statusText(listing.status),
    lastUpdated: listing.lastUpdated, style: known?.style ?? null, size: known?.size ?? null, color: known?.color ?? null,
    attributes: listing.attributes, issues: listing.issues,
    price: currentValue('listing_price', listing.attributes), sale: currentValue('listing_sale_price', listing.attributes),
    schema: { version: schema?.version ?? null, error: schema?.error ?? null, stale: !!schema?.stale, attributes: schema?.attributes ?? {} },
    readOnly: READ_ONLY_ATTRS, dedicated: DEDICATED_ATTRS,
    cooldown: cooldownOf(recent.get(lowerKey(listing.sku))), cooldownDays: COOLDOWN_DAYS, pending: pendingFor(listing.sku),
    packaging: { ...packaging(listing.attributes, feeMeasures().get(lowerKey(listing.sku)), catalog), catalogError },
  };
}

// ---------- 店主在网站上直接改 ----------

/**
 * 把页面上的修改整理成改动:标题、五点、后台搜索词、售价、促销价走专门的检查,其它属性走通用检查。
 * 每条 { attribute, value } 或 { field: 'price'|'sale_price', value, saleStart, saleEnd }
 */
function buildItems(listing, known, changes, info) {
  const items = [], rejected = [];
  const seen = new Set();
  for (const [index, change] of (Array.isArray(changes) ? changes : []).entries()) {
    const attribute = clean(change?.attribute) || null;
    const field = clean(change?.field) || null;
    const reject = (error) => rejected.push({ index, attribute, field, error });
    let kind, raw = change?.value;
    if (field === 'price' || field === 'sale_price') {
      kind = LISTING_FIELDS[field];
      if (field === 'sale_price') raw = { price: change.value, start: change.saleStart, end: change.saleEnd };
    } else if (attribute && DEDICATED_ATTRS[attribute]) {
      kind = DEDICATED_ATTRS[attribute];
      // 页面给的是条目数组,换成这几种改动要的文字 / 文字列表
      const texts = (Array.isArray(raw) ? raw : [raw]).map((entry) => (entry && typeof entry === 'object' ? entry.value : entry)).filter((value) => value != null);
      raw = kind === 'listing_bullets' ? texts.map(String) : texts.map(String).join(' ');
    } else if (attribute) {
      kind = 'listing_attribute';
    } else { reject('没有指明改哪个属性'); continue; }
    const target = { attribute: kind === 'listing_attribute' ? attribute : undefined };
    const targetKey = attributeKey(listing.sku, kind, attribute);
    if (seen.has(targetKey)) { reject('同一个属性改了两次'); continue; }
    const before = currentValue(kind, listing.attributes, target);
    const checked = checkListingValue(kind, raw, before, { sku: listing.sku, attributes: listing.attributes, attribute, info: info(attribute) });
    if (checked.errors.length) { reject(`${kindLabelOf(kind, { attribute, attributeTitle: info(attribute)?.title })}：${checked.errors.join('；')}`); continue; }
    seen.add(targetKey);
    items.push({ kind, targetKey, before, after: checked.value, warnings: checked.warnings,
      target: { sku: listing.sku, asin: listing.asin ?? known?.asin ?? null, productType: listing.productType, style: known?.style ?? null,
        size: known?.size ?? null, color: known?.color ?? null,
        ...(kind === 'listing_attribute' ? { attribute, attributeTitle: info(attribute)?.title ?? attribute } : {}), ...checked.extra } });
  }
  return { items, rejected };
}

async function prepare(sku, changes, { gateway, env }) {
  const account = requireAccount(env);
  if (!Array.isArray(changes) || !changes.length) throw Object.assign(new Error('没有修改'), { status: 400 });
  if (changes.length > 40) throw Object.assign(new Error('一次最多改 40 个属性'), { status: 400 });
  const known = skuDirectory().get(lowerKey(sku));
  const listing = await readListing(account, known?.sku ?? clean(sku), gateway);
  if (!listing.productType) throw Object.assign(new Error('亚马逊没有返回这个 SKU 的商品类型，没法提交修改'), { status: 400 });
  const schema = await productTypeSchema(account, listing.productType, { gateway });
  const { items, rejected } = buildItems(listing, known, changes, (attribute) => (attribute ? schema?.attributes?.[attribute] ?? null : null));
  return { account, listing, known, items, rejected };
}

/** 预检:把修改一次性交给亚马逊 VALIDATION_PREVIEW,不保存、不提交 */
export async function previewListingEdit(sku, changes, { gateway = amazonGateway, env = process.env } = {}) {
  const { account, listing, items, rejected } = await prepare(sku, changes, { gateway, env });
  if (!items.length) return { ok: false, rejected, issues: [], warnings: [] };
  const result = await validateAll(account, listing, items, gateway);
  return { ...result, ok: result.valid && !rejected.length, rejected };
}

/** 整批修改合成一次 VALIDATION_PREVIEW */
async function validateAll(account, listing, items, gateway) {
  // 原价和促销价在同一个属性里,一起改时要合成一条
  const offer = items.filter((item) => item.kind === 'listing_price' || item.kind === 'listing_sale_price');
  const patches = items.filter((item) => !offer.includes(item)).map((item) => patchFor(item.kind, item.after, listing.attributes, [], item.target));
  if (offer.length) patches.push(patchFor(offer.at(-1).kind, offer.at(-1).after, listing.attributes, offer.slice(0, -1), offer.at(-1).target));
  const preview = await gateway.request(account, account.region, 'PATCH',
    `/listings/2021-08-01/items/${encodeURIComponent(account.sellerId)}/${encodeURIComponent(listing.sku)}`,
    { query: { marketplaceIds: US_MARKETPLACE, mode: 'VALIDATION_PREVIEW', issueLocale: 'en_US' }, body: { productType: listing.productType, patches } });
  const issues = (preview?.issues ?? []).map((issue) => ({ severity: issue.severity, code: issue.code ?? null, message: clean(issue.message), attributes: issue.attributeNames ?? [] }));
  return { valid: preview?.status !== 'INVALID' && !issues.some((issue) => issue.severity === 'ERROR'), status: preview?.status ?? null,
    issues, warnings: items.flatMap((item) => item.warnings.map((warning) => `${kindLabelOf(item.kind, item.target)}：${warning}`)) };
}

/**
 * 上传:店主在网站上改的直接记成「已确认」排队提交,和待确认队列确认后的执行完全一样
 * (预检 → 提交 → 每 20 分钟核对),改动日志里记作店主在 Listing 板块修改。
 * 有一条检查不过就整批不提交,免得只改了一半。
 */
export async function submitListingEdit(sku, { changes, reason } = {}, { userId, gateway = amazonGateway, env = process.env, wait = SUBMIT_WAIT_MS } = {}) {
  const { account, listing, items, rejected } = await prepare(sku, changes, { gateway, env });
  if (rejected.length) return { submitted: [], rejected };
  // 先整批预检一次:队列里是一条一条提交的,不先整批查,前面的改上去了后面的才被亚马逊拒
  const check = await validateAll(account, listing, items, gateway);
  if (!check.valid) return { submitted: [], rejected: [], issues: check.issues };
  const note = checkReason(reason);
  const why = note.error ? '店主在 Listing 板块直接修改' : note.text;
  const fields = items.map((item) => kindLabelOf(item.kind, item.target));
  const { title, summary } = checkBatch({ title: `Listing 板块修改：${listing.sku} 的${fields.slice(0, 3).join('、')}${fields.length > 3 ? ` 等 ${fields.length} 项` : ''}`,
    summary: why, changes: items });
  const saved = saveProposals({ title, summary, source: 'listing', userId, items: items.map((item) => ({ ...item, reason: why })) });
  const now = nowLocal();
  db.transaction(() => {
    for (const id of saved.ids) {
      update(id, { status: 'queued', decided_by: userId ?? null, decided_at: now, error: null });
      log(id, saved.batchId, 'user', userId, 'approved', { via: 'listing' });
    }
  })();
  audit(userId, 'US', 'listing_edit', 'pet_change_proposals', null, { sku: listing.sku, ids: saved.ids });
  const queue = kickQueue({ gateway, env });
  if (wait > 0) await Promise.race([queue, sleep(wait)]);
  const rows = saved.ids.map((id) => shape(db.prepare('SELECT * FROM pet_change_proposals WHERE id=?').get(id)));
  return { batchId: saved.batchId, submitted: rows, rejected: [], superseded: saved.superseded };
}

// ---------- 给连接器 ----------

const DEFAULT_ATTRS = ['item_name', 'bullet_point', 'generic_keyword', 'product_description', 'brand', 'item_type_keyword', 'color', 'size', 'material',
  'item_dimensions', 'item_package_dimensions', 'item_weight', 'special_feature', 'recommended_uses_for_product', 'target_audience_keyword'];

const stripEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry;
  const { marketplace_id: _m, language_tag: _l, ...rest } = entry;
  return Object.keys(rest).length === 1 && 'value' in rest ? rest.value : rest;
};

/**
 * 连接器读 Listing 属性:不给 SKU 时看全店(库里同步好的,默认只给常用属性);给 SKU 时给全部属性。
 * live 时实时读亚马逊(最多 10 个 SKU)。includeSchema 时附上属性定义,包括还没填的属性。
 */
export async function listingAttributesForAgent({ skus = [], style, attributes = [], live = false, includeSchema = false, limit = 200 } = {},
  { gateway = amazonGateway, env = process.env } = {}) {
  const directory = skuDirectory();
  let list = skus.map((sku) => directory.get(lowerKey(sku))?.sku ?? clean(sku)).filter(Boolean);
  if (style) {
    const wanted = lowerKey(style);
    list.push(...db.prepare("SELECT sku FROM sku_items WHERE user_id=? AND country='US' AND lower(style) LIKE ?").all(PET_SHOP_ID, `%${wanted}%`).map((row) => row.sku));
  }
  list = [...new Set(list)];
  // 指定了 SKU 或款式但一个都没对上,返回空,不能当成「看全店」
  const filtered = skus.length > 0 || !!style;
  const named = attributes.length ? new Set(attributes) : filtered ? null : new Set(DEFAULT_ATTRS);
  let rows;
  if (live) {
    if (!list.length || list.length > 10) throw new Error('实时读取要指定 1–10 个 SKU');
    const account = requireAccount(env);
    rows = [];
    for (const sku of list) {
      const listing = await readListing(account, sku, gateway);
      saveItem(listing);
      let catalog = null;
      if (listing.asin) { try { catalog = catalogPackage(await readCatalogDimensions(account, listing.asin, gateway)); } catch { catalog = null; } }
      rows.push({ sku: listing.sku, asin: listing.asin, product_type: listing.productType, status: listing.status, attributes: listing.attributes,
        issues: listing.issues, synced_at: '刚刚实时读取', catalog });
    }
  } else {
    const all = db.prepare('SELECT * FROM pet_listing_items ORDER BY sku').all();
    const wanted = new Set(list.map(lowerKey));
    rows = all.filter((row) => !filtered || wanted.has(lowerKey(row.sku))).slice(0, limit).map((row) => ({ sku: row.sku, asin: row.asin,
      product_type: row.product_type, status: parseJson(row.status_json, []), attributes: parseJson(row.attributes_json, {}), issues: parseJson(row.issues_json, []),
      synced_at: row.synced_at }));
  }
  const library = new Map(db.prepare("SELECT sku, style, size, color FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID).map((row) => [lowerKey(row.sku), row]));
  const fees = feeMeasures();
  const items = rows.map((row) => {
    const out = {};
    for (const name of Object.keys(row.attributes).sort()) {
      if (named && !named.has(name)) continue;
      const values = usEntries(row.attributes, name).map(stripEntry);
      out[name] = values.length === 1 ? values[0] : values;
    }
    const info = library.get(lowerKey(row.sku)) ?? {};
    return { sku: row.sku, asin: row.asin, productType: row.product_type, style: info.style ?? null, size: info.size ?? null, color: info.color ?? null,
      status: statusText(row.status), syncedAt: row.synced_at, packaging: packaging(row.attributes, fees.get(lowerKey(row.sku)), row.catalog ?? null), attributes: out,
      issues: (row.issues ?? []).map((issue) => ({ severity: issue.severity, message: clean(issue.message).slice(0, 300), attributes: issue.attributeNames ?? [] })) };
  });
  const result = { total: items.length, items, sync: listingSyncStatus(env) };
  if (includeSchema) {
    const account = petSpConfig(env).account;
    result.schemas = {};
    for (const productType of [...new Set(items.map((item) => item.productType).filter(Boolean))]) {
      const schema = account ? await productTypeSchema(account, productType, { gateway }) : { attributes: cachedSchema(productType)?.attributes ?? {} };
      result.schemas[productType] = Object.fromEntries(Object.entries(schema?.attributes ?? {}).filter(([name]) => !named || named.has(name))
        .map(([name, info]) => [name, { title: info.title, required: info.required || undefined, simple: info.simple, valueType: info.valueType,
          options: info.options?.length ? info.options.slice(0, 40).map((option) => option.value) : undefined, maxLength: info.maxLength ?? undefined,
          maxItems: info.maxItems ?? undefined, fields: info.fields, readOnly: READ_ONLY_ATTRS[name] ?? undefined }]));
    }
  }
  result.notes = [
    '属性值里去掉了 marketplace_id、language_tag;只有一个 value 的条目直接给值。',
    `不给 SKU 时只列常用属性(${DEFAULT_ATTRS.join('、')}),要别的用 attributes 指定;给 SKU 时列全部属性。`,
    '改属性用 propose_listing_changes:标题/五点/后台词/价格用对应 field;其它属性 field=attribute 并填 attribute 属性名,value 填值(文字、数字、文字数组,或和这里一样结构的对象数组)。',
    `同步是每 12 小时一次,syncedAt 是这条数据读取的时间;要最新的用 live。`,
    'packaging 是单件包装尺寸(英寸、磅,三边从长到短):seller 是卖家在 Listing 里填的,catalog 是亚马逊目录在用的(只有 live 时才读),fba 是 FBA 预估费用报告的实测值和尺寸分段;standard=false 是大件(超过 18×14×8 英寸或 20 磅)。亚马逊按自己在用的尺寸算入库和配送费,和卖家填的不一致时改 Listing 不会生效,要开 case 申请复测。',
  ];
  return result;
}

// ---------- 接口 ----------

export function createListingRouter(deps = defaultDeps) {
  const router = express.Router();
  router.use((req, res, next) => (isPet ? next() : res.status(404).json({ error: '只有宠物版有 Listing 板块' })));
  router.use(requireLogin);
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (error) { res.status(error.status ?? error.upstreamStatus ?? 400).json({ error: error.message }); }
  };
  router.get('/', handle((req) => listingBoard({ q: req.query.q, env: deps.env })));
  router.get('/status', handle(() => listingSyncStatus(deps.env)));
  router.get('/export', handle(() => listingExport()));
  router.post('/sync', requireRole('owner'), (req, res) => {
    const status = listingSyncStatus(deps.env);
    if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
    if (status.running) return res.status(409).json({ error: 'Listing 正在同步' });
    void syncListingItems(deps).catch((error) => console.error('[listing-sync]', error.message));
    res.status(202).json({ accepted: true });
  });
  router.get('/item/:sku', handle((req) => listingDetail(req.params.sku, deps)));
  router.post('/item/:sku/preview', requireRole('owner'), handle((req) => previewListingEdit(req.params.sku, req.body?.changes, deps)));
  router.post('/item/:sku/submit', requireRole('owner'), handle((req) => submitListingEdit(req.params.sku, req.body ?? {}, { ...deps, userId: req.session.user.id })));
  return router;
}

