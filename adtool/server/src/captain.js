import { isPet, businessUserId } from './profile.js';
import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, requireRole } from './auth.js';
import { MARKETPLACES, REGIONS } from './libs.js';

const DEFAULT_BASE = 'https://openapi.captainbi.com';
const PAGE_SIZE = 100;
const WINDOW_SECONDS = 30 * 24 * 60 * 60;
const SYNC_OVERLAP_SECONDS = 5 * 60;
const EU_MARKETS = REGIONS.find((region) => region.id === 'EU')?.markets ?? [];
const CONTINENTAL_EU_MARKETS = EU_MARKETS.filter((country) => country !== 'UK');
const runningUsers = new Set();

let tokenCache = null;

export const captainRouter = express.Router();
captainRouter.use(requireLogin);

const clean = (value) => String(value ?? '').trim();
const keyOf = (value) => clean(value).toLowerCase();
const countryOf = (value) => {
  const country = clean(value).toUpperCase();
  return country === 'GB' ? 'UK' : country;
};
const intOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};

function config() {
  return {
    base: clean(process.env.CAPTAIN_API_BASE) || DEFAULT_BASE,
    clientId: clean(process.env.CAPTAIN_CLIENT_ID),
    clientSecret: clean(process.env.CAPTAIN_CLIENT_SECRET),
  };
}

function isConfigured() {
  const value = config();
  return !!(value.clientId && value.clientSecret);
}

function requireConfigured() {
  if (!isConfigured()) {
    const error = new Error('船长 API 还没有配置，请先在服务器 .env 填写 APPID 和密钥');
    error.status = 503;
    throw error;
  }
}

function apiError(payload, fallback) {
  return clean(payload?.msg || payload?.message || payload?.error_description || payload?.error) || fallback;
}

async function readJson(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(apiError(payload, `船长 API 请求失败 (${response.status})`));
    error.status = response.status;
    throw error;
  }
  if (!payload || typeof payload !== 'object') throw new Error('船长 API 返回了无法识别的数据');
  if (payload.code !== undefined && Number(payload.code) !== 200) {
    throw new Error(apiError(payload, `船长 API 返回错误码 ${payload.code}`));
  }
  return payload;
}

async function accessToken(force = false) {
  requireConfigured();
  if (!force && tokenCache?.expiresAt > Date.now() + 30_000) return tokenCache.value;

  const { base, clientId, clientSecret } = config();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'all',
  });
  const response = await fetch(`${base.replace(/\/$/, '')}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readJson(response);
  const value = clean(payload.access_token ?? payload.data?.access_token);
  if (!value) throw new Error('船长 API 没有返回 access_token，请核对 APPID 和密钥');
  const expiresIn = Math.max(60, intOf(payload.expires_in ?? payload.data?.expires_in) || 3600);
  tokenCache = { value, expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
  return value;
}

async function captainGet(path, query = {}, extraHeaders = {}) {
  const { base } = config();
  const url = new URL(`${base.replace(/\/$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(attempt > 0);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      signal: AbortSignal.timeout(30_000),
    });
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      tokenCache = null;
      continue;
    }
    return readJson(response);
  }
  throw new Error('船长 API 授权失败，请重新生成 APPID 和密钥');
}

export async function paged(path, query, headers = {}) {
  const items = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const payload = await captainGet(path, { ...query, page, rows: PAGE_SIZE }, headers);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    items.push(...rows);
    const total = intOf(payload.max_result);
    if (!rows.length || rows.length < PAGE_SIZE || (total && items.length >= total)) return items;
  }
  throw new Error('船长 API 分页超过安全上限，请联系管理员检查接口数据');
}

export async function discoverChannels() {
  const sitePayload = await captainGet('/v1/open_user/get_site_list');
  const sites = new Map((Array.isArray(sitePayload.data) ? sitePayload.data : []).map((site) => [
    Number(site.site_id), countryOf(site.code),
  ]));
  const channels = await paged('/v1/open_user/get_channel_list', {});
  const availableChannels = channels
    .map((channel) => ({
      openChannelId: clean(channel.open_channel_id),
      channelName: clean(channel.title) || '未命名店铺',
      siteId: Number(channel.site_id) || null,
      country: sites.get(Number(channel.site_id)) || '',
      status: Number(channel.status) === 1 ? 1 : 0,
    }))
    .filter((channel) => channel.openChannelId && channel.status && MARKETPLACES.includes(channel.country))
    .sort((a, b) => `${a.country}:${a.channelName}`.localeCompare(`${b.country}:${b.channelName}`, 'zh-CN'));

  const groups = new Map();
  for (const channel of availableChannels) {
    const countrySuffix = new RegExp(`([_-])${channel.country}$`, 'i');
    const strippedName = channel.channelName.replace(countrySuffix, '');
    const isContinentalEurope = CONTINENTAL_EU_MARKETS.includes(channel.country)
      && strippedName !== channel.channelName
      && /(?:^|[_-])EU$/i.test(strippedName);
    const groupName = isContinentalEurope ? strippedName : channel.channelName;
    const scope = isContinentalEurope ? 'EU' : channel.country;
    const groupKey = `${keyOf(groupName)}:${scope}`;
    const group = groups.get(groupKey) ?? {
      groupKey,
      groupName,
      scope,
      countries: [],
      channels: [],
    };
    group.channels.push(channel);
    if (!group.countries.includes(channel.country)) group.countries.push(channel.country);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      countries: group.countries.sort((a, b) => MARKETPLACES.indexOf(a) - MARKETPLACES.indexOf(b)),
      channels: group.channels.sort((a, b) => MARKETPLACES.indexOf(a.country) - MARKETPLACES.indexOf(b.country)),
    }))
    .sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-CN'));
}

function skuCoverage() {
  const rows = db.prepare(
    `SELECT user_id, country, trim(brand) AS brand
       FROM sku_items
      WHERE trim(COALESCE(brand, '')) <> ''
      GROUP BY user_id, country, lower(trim(brand))
      ORDER BY user_id, country, brand COLLATE NOCASE`
  ).all();
  return rows.map((row) => ({ userId: row.user_id, country: row.country, brand: row.brand }));
}

function splitWindows(start, end) {
  const windows = [];
  let cursor = Math.max(0, Math.floor(start));
  const finish = Math.max(cursor, Math.floor(end));
  while (cursor < finish) {
    const until = Math.min(finish, cursor + WINDOW_SECONDS);
    windows.push([cursor, until]);
    cursor = until;
  }
  return windows.length ? windows : [[finish - 60, finish]];
}

function normalizeInventory(item) {
  const sku = clean(item?.SKU ?? item?.sku);
  if (!sku) return null;
  const asin = clean(item?.asin).toUpperCase();
  const deleted = Number(item?.is_delete ?? 0) !== 0;
  return {
    sku,
    skuKey: keyOf(sku),
    asin: /^[A-Z0-9]{10}$/.test(asin) ? asin : null,
    stock: deleted ? 0 : intOf(item?.fulfillable_quantity),
    transit: deleted ? 0 : intOf(item?.inbound_shipped_quantity)
      + intOf(item?.inbound_receiving_quantity)
      + intOf(item?.inbound_working_quantity),
    isDeleted: deleted ? 1 : 0,
  };
}

async function fetchBindingInventory(binding, now) {
  const lookback = Math.min(1095, Math.max(1, intOf(process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS) || 365));
  const start = binding.last_sync_at
    ? Math.min(now - 60, Math.max(0, Number(binding.last_sync_at) - SYNC_OVERLAP_SECONDS))
    : now - lookback * 24 * 60 * 60;
  const latest = new Map();
  for (const [from, to] of splitWindows(start, now)) {
    const rows = await paged('/v1/open_fba/inventory_list', {
      start_modified_time: from,
      end_modified_time: to,
    }, { OpenChannelId: binding.open_channel_id });
    for (const raw of rows) {
      const item = normalizeInventory(raw);
      if (item) latest.set(item.skuKey, item);
    }
  }
  return [...latest.values()];
}

const upsertSnapshot = db.prepare(
  `INSERT INTO captain_inventory_snapshots
     (binding_id, sku_key, sku, asin, stock, transit, is_deleted)
   VALUES (@bindingId, @skuKey, @sku, @asin, @stock, @transit, @isDeleted)
   ON CONFLICT (binding_id, sku_key) DO UPDATE SET
     sku = excluded.sku, asin = COALESCE(excluded.asin, captain_inventory_snapshots.asin),
     stock = excluded.stock, transit = excluded.transit, is_deleted = excluded.is_deleted,
     updated_at = datetime('now', 'localtime')`
);

const updateSkuCountry = db.prepare(
  `UPDATE sku_items SET
     stock = @stock, transit = @transit,
     asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
     updated_at = datetime('now', 'localtime')
   WHERE user_id = @userId AND country = @country
     AND lower(trim(COALESCE(brand, ''))) = @brandKey
     AND lower(trim(sku)) = @skuKey`
);

function applyAssignedSnapshots(userId = null) {
  const assignments = db.prepare(
    `SELECT a.user_id, a.country, g.group_key, g.brand_key
       FROM captain_channel_assignments a
       JOIN captain_channel_groups g ON g.group_key = a.group_key
      WHERE a.enabled = 1 AND g.enabled = 1
        AND (? IS NULL OR a.user_id = ?)`
  ).all(userId, userId);
  const groupKeys = [...new Set(assignments.map((row) => row.group_key))];
  if (!groupKeys.length) return { updated: 0, unmatched: 0, inventorySkus: 0 };

  // 大陆欧洲的详细站点返回的是同一份共享 FBA 库存，不可把 DE/ES/FR/IT 再相加。
  // 每个店铺组、每个 SKU 只采用最近更新的一份快照；同秒更新时固定取较小 binding_id。
  const placeholders = groupKeys.map(() => '?').join(',');
  const snapshots = db.prepare(
    `SELECT g.group_key, g.brand_key, b.id AS binding_id,
            s.sku_key, s.asin, s.stock, s.transit, s.updated_at
       FROM captain_channel_groups g
       JOIN captain_channel_group_members m ON m.group_key = g.group_key
       JOIN captain_channel_bindings b ON b.open_channel_id = m.open_channel_id
       JOIN captain_inventory_snapshots s ON s.binding_id = b.id
      WHERE g.group_key IN (${placeholders}) AND b.enabled = 1
      ORDER BY s.updated_at DESC, b.id ASC`
  ).all(...groupKeys);
  const sharedSnapshots = new Map();
  for (const row of snapshots) {
    const key = `${row.group_key}\u0000${row.sku_key}`;
    if (!sharedSnapshots.has(key)) sharedSnapshots.set(key, row);
  }

  const totals = new Map();
  for (const assignment of assignments) {
    for (const snapshot of sharedSnapshots.values()) {
      if (snapshot.group_key !== assignment.group_key) continue;
      const key = `${assignment.user_id}\u0000${assignment.country}\u0000${assignment.group_key}\u0000${snapshot.sku_key}`;
      totals.set(key, {
        userId: assignment.user_id,
        country: assignment.country,
        brandKey: assignment.brand_key,
        skuKey: snapshot.sku_key,
        stock: intOf(snapshot.stock),
        transit: intOf(snapshot.transit),
        asin: snapshot.asin || null,
      });
    }
  }

  let updated = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const total of totals.values()) {
      const changes = updateSkuCountry.run({
        ...total,
        asin: total.asin,
      }).changes;
      updated += changes;
      if (!changes) unmatched += 1;
    }
  })();
  return { updated, unmatched, inventorySkus: totals.size };
}

function applyLegacySnapshots(userId) {
  const snapshots = db.prepare(
    `SELECT b.id AS binding_id, b.brand_key, b.country,
            s.sku_key, s.asin, s.stock, s.transit, s.updated_at
       FROM captain_channel_bindings b
       JOIN captain_inventory_snapshots s ON s.binding_id = b.id
      WHERE b.user_id = ? AND b.enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM captain_channel_group_members m
           WHERE m.open_channel_id = b.open_channel_id
        )
      ORDER BY s.updated_at DESC, b.id ASC`
  ).all(userId);
  const totals = new Map();
  for (const row of snapshots) {
    const scope = EU_MARKETS.includes(row.country) ? 'EU' : row.country;
    const key = `${row.brand_key}\u0000${scope}\u0000${row.sku_key}`;
    // 旧版绑定也可能保存了四个欧洲详细站点；它们是同一份共享库存，只取最近快照。
    if (scope === 'EU' && totals.has(key)) continue;
    const total = totals.get(key) ?? {
      brandKey: row.brand_key, scope, skuKey: row.sku_key, stock: 0, transit: 0, asins: new Set(),
    };
    total.stock = scope === 'EU' ? intOf(row.stock) : total.stock + intOf(row.stock);
    total.transit = scope === 'EU' ? intOf(row.transit) : total.transit + intOf(row.transit);
    if (row.asin) total.asins.add(row.asin);
    totals.set(key, total);
  }
  const updateEurope = db.prepare(
    `UPDATE sku_items SET stock = @stock, transit = @transit,
       asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
       updated_at = datetime('now', 'localtime')
     WHERE user_id = @userId
       AND country IN (${EU_MARKETS.map((country) => `'${country}'`).join(',')})
       AND lower(trim(COALESCE(brand, ''))) = @brandKey
       AND lower(trim(sku)) = @skuKey`
  );
  let updated = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const total of totals.values()) {
      const params = {
        userId, brandKey: total.brandKey, skuKey: total.skuKey,
        stock: total.stock, transit: total.transit,
        asin: total.asins.size === 1 ? [...total.asins][0] : null,
      };
      const changes = total.scope === 'EU'
        ? updateEurope.run(params).changes
        : updateSkuCountry.run({ ...params, country: total.scope }).changes;
      updated += changes;
      if (!changes) unmatched += 1;
    }
  })();
  return { updated, unmatched, inventorySkus: totals.size };
}

export function applyInventorySnapshots(userId) {
  const assigned = applyAssignedSnapshots(userId);
  const legacy = applyLegacySnapshots(userId);
  return {
    updated: assigned.updated + legacy.updated,
    unmatched: assigned.unmatched + legacy.unmatched,
    inventorySkus: assigned.inventorySkus + legacy.inventorySkus,
  };
}

function legacyBindingsForUser(userId) {
  return db.prepare(
    `SELECT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail
       FROM captain_channel_bindings b
      WHERE b.user_id = ? AND NOT EXISTS (
        SELECT 1 FROM captain_channel_group_members m WHERE m.open_channel_id = b.open_channel_id
      )
      ORDER BY b.brand COLLATE NOCASE, b.country, b.channel_name`
  ).all(userId);
}

function assignedSourcesForUser(userId) {
  return db.prepare(
    `SELECT DISTINCT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail
       FROM captain_channel_assignments a
       JOIN captain_channel_groups g ON g.group_key = a.group_key
       JOIN captain_channel_group_members m ON m.group_key = a.group_key
       JOIN captain_channel_bindings b ON b.open_channel_id = m.open_channel_id
      WHERE a.user_id = ? AND a.enabled = 1 AND g.enabled = 1 AND b.enabled = 1`
  ).all(userId);
}

function sourcesForUser(userId) {
  const sources = [...assignedSourcesForUser(userId), ...legacyBindingsForUser(userId).filter((row) => row.enabled)];
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

function allActiveSources() {
  return db.prepare(
    `SELECT DISTINCT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail
       FROM captain_channel_bindings b
      WHERE b.enabled = 1 AND (
        EXISTS (
          SELECT 1 FROM captain_channel_group_members m
          JOIN captain_channel_groups g ON g.group_key = m.group_key AND g.enabled = 1
          JOIN captain_channel_assignments a ON a.group_key = g.group_key AND a.enabled = 1
          WHERE m.open_channel_id = b.open_channel_id
        ) OR NOT EXISTS (
          SELECT 1 FROM captain_channel_group_members m WHERE m.open_channel_id = b.open_channel_id
        )
      )
      ORDER BY b.id`
  ).all();
}

async function refreshSources(sources) {
  const now = Math.floor(Date.now() / 1000);
  const errors = [];
  let fetched = 0;
  let succeeded = 0;
  for (const source of sources) {
    try {
      const items = await fetchBindingInventory(source, now);
      db.transaction(() => {
        for (const item of items) upsertSnapshot.run({ bindingId: source.id, ...item });
        db.prepare(
          `UPDATE captain_channel_bindings SET last_sync_at = ?, last_sync_status = 'ok',
                  last_sync_detail = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
        ).run(now, `读取 ${items.length} 个 SKU`, source.id);
      })();
      fetched += items.length;
      succeeded += 1;
    } catch (error) {
      const message = clean(error.message).slice(0, 300) || '同步失败';
      errors.push(`${source.channel_name}：${message}`);
      db.prepare(
        `UPDATE captain_channel_bindings SET last_sync_status = 'error', last_sync_detail = ?,
                updated_at = datetime('now', 'localtime') WHERE id = ?`
      ).run(message, source.id);
    }
  }
  return { sources: sources.length, succeeded, failed: errors.length, fetched, errors };
}

async function syncUser(userId, actorId = userId) {
  if (runningUsers.has(userId)) {
    const error = new Error('这个账号正在同步，请稍后再试');
    error.status = 409;
    throw error;
  }
  const sources = sourcesForUser(userId);
  if (!sources.length) {
    const error = new Error('这个账号还没有分配船长库存国家，请联系超级管理员');
    error.status = 400;
    throw error;
  }
  runningUsers.add(userId);
  try {
    const refreshed = await refreshSources(sources);
    const applied = refreshed.succeeded
      ? applyInventorySnapshots(userId)
      : { updated: 0, unmatched: 0, inventorySkus: 0 };
    audit(actorId, null, refreshed.errors.length ? 'sync_partial' : 'sync', 'captain_inventory', null, {
      targetUserId: userId, ...refreshed, ...applied, errors: refreshed.errors.slice(0, 10),
    });
    return { bindings: sources.length, ...refreshed, ...applied };
  } finally {
    runningUsers.delete(userId);
  }
}

function assignmentSummaries(userId = null) {
  const rows = db.prepare(
    `SELECT a.id, a.group_key, a.country, a.user_id, a.enabled,
            g.group_name, g.brand, g.scope, u.display_name AS owner_name
       FROM captain_channel_assignments a
       JOIN captain_channel_groups g ON g.group_key = a.group_key
       JOIN users u ON u.id = a.user_id
      WHERE (? IS NULL OR a.user_id = ?)
      ORDER BY g.brand COLLATE NOCASE, a.country, u.display_name`
  ).all(userId, userId);
  const sourcesByGroup = new Map();
  for (const source of db.prepare(
    `SELECT m.group_key, b.last_sync_at, b.last_sync_status, b.last_sync_detail
       FROM captain_channel_group_members m
       JOIN captain_channel_bindings b ON b.open_channel_id = m.open_channel_id`
  ).all()) {
    const sources = sourcesByGroup.get(source.group_key) ?? [];
    sources.push(source);
    sourcesByGroup.set(source.group_key, sources);
  }
  return rows.map((row) => {
    const sources = sourcesByGroup.get(row.group_key) ?? [];
    const failed = sources.filter((source) => source.last_sync_status === 'error');
    const succeeded = sources.filter((source) => source.last_sync_status === 'ok');
    const lastSyncAt = Math.max(0, ...sources.map((source) => Number(source.last_sync_at) || 0)) || null;
    return {
      ...row,
      channel_name: row.group_name,
      last_sync_at: lastSyncAt,
      last_sync_status: failed.length ? 'error' : succeeded.length ? 'ok' : null,
      last_sync_detail: failed.length
        ? `${failed.length}/${sources.length} 个库存来源失败`
        : succeeded.length ? `${succeeded.length}/${sources.length} 个库存来源已读取` : null,
    };
  });
}

function legacyAdminBindings(userId = null) {
  return db.prepare(
    `SELECT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail,
            u.display_name AS owner_name, 1 AS legacy
       FROM captain_channel_bindings b JOIN users u ON u.id = b.user_id
      WHERE (? IS NULL OR b.user_id = ?) AND NOT EXISTS (
        SELECT 1 FROM captain_channel_group_members m WHERE m.open_channel_id = b.open_channel_id
      )
      ORDER BY b.brand COLLATE NOCASE, b.country, b.channel_name`
  ).all(userId, userId);
}

captainRouter.get('/status', (req, res) => {
  const userId = businessUserId(req.session.user.id);
  const assignments = assignmentSummaries(userId).map((row) => ({ ...row, id: `assignment-${row.id}` }));
  const legacy = legacyAdminBindings(userId).map((row) => ({ ...row, id: `legacy-${row.id}` }));
  res.json({ configured: isConfigured(), bindings: [...assignments, ...legacy] });
});

captainRouter.get('/admin', requireRole('owner'), (req, res) => {
  const bindings = db.prepare(
    `SELECT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail,
            u.display_name AS owner_name
       FROM captain_channel_bindings b JOIN users u ON u.id = b.user_id
      ORDER BY b.brand COLLATE NOCASE, b.country, b.channel_name`
  ).all();
  res.json({
    configured: isConfigured(),
    bindings,
    assignments: assignmentSummaries(),
    legacyBindings: legacyAdminBindings(),
    skuCoverage: skuCoverage(),
  });
});

captainRouter.post('/discover', requireRole('owner'), async (req, res) => {
  try {
    res.json({ groups: await discoverChannels() });
  } catch (error) {
    const status = error.status && error.status < 500 ? error.status : 502;
    res.status(status).json({ error: error.message || '读取船长店铺失败' });
  }
});

captainRouter.post('/bindings', requireRole('owner'), (req, res) => {
  const requestedBrand = clean(req.body?.brand);
  if (!requestedBrand || requestedBrand.length > 120) {
    return res.status(400).json({ error: '请选择 SKU 库中的品牌' });
  }

  const sourceChannels = Array.isArray(req.body?.channels) ? req.body.channels : [req.body];
  if (!sourceChannels.length || sourceChannels.length > 50) {
    return res.status(400).json({ error: '店铺组为空或店铺数量超出限制，请重新读取店铺' });
  }
  const channels = sourceChannels.map((channel) => ({
    country: countryOf(channel?.country),
    openChannelId: clean(channel?.openChannelId),
    channelName: clean(channel?.channelName),
    siteId: Number(channel?.siteId) || null,
  }));
  if (channels.some((channel) => !MARKETPLACES.includes(channel.country))) {
    return res.status(400).json({ error: '店铺组包含网站不支持的国家' });
  }
  if (channels.some((channel) => !channel.openChannelId || !channel.channelName)) {
    return res.status(400).json({ error: '店铺信息不完整，请重新读取店铺' });
  }
  if (new Set(channels.map((channel) => channel.openChannelId)).size !== channels.length) {
    return res.status(400).json({ error: '店铺组包含重复店铺，请重新读取店铺' });
  }

  const groupName = clean(req.body?.groupName);
  const scope = countryOf(req.body?.scope) || clean(req.body?.scope).toUpperCase();
  const groupKey = clean(req.body?.groupKey);
  if (!groupName || !groupKey || groupKey !== `${keyOf(groupName)}:${scope}`) {
    return res.status(400).json({ error: '店铺组信息不完整，请重新读取船长店铺' });
  }
  const countries = [...new Set(channels.map((channel) => channel.country))];
  if (scope === 'EU' && countries.some((country) => !CONTINENTAL_EU_MARKETS.includes(country))) {
    return res.status(400).json({ error: '欧洲共享店铺组包含了非欧洲大陆站点' });
  }
  if (scope !== 'EU' && (countries.length !== 1 || countries[0] !== scope)) {
    return res.status(400).json({ error: '店铺组范围与真实站点不一致，请重新读取店铺' });
  }

  const rawAssignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  const assignments = rawAssignments.map((item) => ({
    country: countryOf(item?.country), userId: businessUserId(Number(item?.userId)),
  }));
  if (!assignments.length || assignments.length > countries.length
      || new Set(assignments.map((item) => item.country)).size !== assignments.length
      || assignments.some((item) => !countries.includes(item.country))) {
    return res.status(400).json({ error: '请至少选择一个国家负责人，且同一国家不能重复分配' });
  }
  let brand = requestedBrand;
  for (const assignment of assignments) {
    if (!isPet && !db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(assignment.userId)) {
      return res.status(400).json({ error: `${assignment.country} 请选择有效的网站账号` });
    }
    const row = db.prepare(
      `SELECT trim(brand) AS brand FROM sku_items
        WHERE user_id = ? AND country = ?
          AND lower(trim(COALESCE(brand, ''))) = ? LIMIT 1`
    ).get(assignment.userId, assignment.country, keyOf(requestedBrand));
    if (!row) {
      return res.status(400).json({
        error: `${assignment.country} 所选账号的 SKU 库中没有品牌 ${requestedBrand}`,
      });
    }
    brand = row.brand;
  }

  const saveBinding = db.prepare(
    `INSERT INTO captain_channel_bindings
       (user_id, brand, brand_key, country, open_channel_id, channel_name, site_id, enabled)
     VALUES (@userId, @brand, @brandKey, @country, @openChannelId, @channelName, @siteId, 1)
     ON CONFLICT (open_channel_id) DO UPDATE SET
       user_id = excluded.user_id, brand = excluded.brand, brand_key = excluded.brand_key,
       country = excluded.country, channel_name = excluded.channel_name, site_id = excluded.site_id,
       enabled = 1, updated_at = datetime('now', 'localtime')`
  );
  const ids = db.transaction(() => {
    const previous = db.prepare(
      'SELECT open_channel_id FROM captain_channel_group_members WHERE group_key = ?'
    ).all(groupKey).map((row) => row.open_channel_id);
    db.prepare(
      `INSERT INTO captain_channel_groups (group_key, group_name, scope, brand, brand_key, enabled)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (group_key) DO UPDATE SET
         group_name = excluded.group_name, scope = excluded.scope,
         brand = excluded.brand, brand_key = excluded.brand_key, enabled = 1,
         updated_at = datetime('now', 'localtime')`
    ).run(groupKey, groupName, scope, brand, keyOf(brand));
    db.prepare('DELETE FROM captain_channel_assignments WHERE group_key = ?').run(groupKey);
    db.prepare('DELETE FROM captain_channel_group_members WHERE group_key = ?').run(groupKey);

    const result = channels.map((channel) => {
      // 真实来源仍保存整组；未分配国家沿用组内任一用户仅满足旧表兼容，实际写入以 assignments 为准。
      const userId = assignments.find((item) => item.country === channel.country)?.userId
        ?? assignments[0].userId;
      saveBinding.run({ userId, brand, brandKey: keyOf(brand), ...channel });
      db.prepare(
        `INSERT INTO captain_channel_group_members (group_key, open_channel_id)
         VALUES (?, ?)
         ON CONFLICT (open_channel_id) DO UPDATE SET group_key = excluded.group_key`
      ).run(groupKey, channel.openChannelId);
      return db.prepare('SELECT id FROM captain_channel_bindings WHERE open_channel_id = ?')
        .get(channel.openChannelId).id;
    });
    const saveAssignment = db.prepare(
      `INSERT INTO captain_channel_assignments (group_key, country, user_id, enabled)
       VALUES (?, ?, ?, 1)`
    );
    for (const assignment of assignments) {
      saveAssignment.run(groupKey, assignment.country, assignment.userId);
    }
    for (const openChannelId of previous.filter((id) => !channels.some((row) => row.openChannelId === id))) {
      db.prepare(
        `UPDATE captain_channel_bindings SET enabled = 0, updated_at = datetime('now', 'localtime')
          WHERE open_channel_id = ? AND NOT EXISTS (
            SELECT 1 FROM captain_channel_group_members m WHERE m.open_channel_id = ?
          )`
      ).run(openChannelId, openChannelId);
    }
    return result;
  })();
  audit(req.session.user.id, channels.length === 1 ? channels[0].country : null,
    'bind', 'captain_channel_group', null,
    { groupKey, brand, assignments, channels: channels.map((channel) => channel.channelName) });
  res.json({ ids, count: ids.length, assignments: assignments.length });
});

captainRouter.patch('/assignments/:id', requireRole('owner'), (req, res) => {
  const id = Number(req.params.id);
  const assignment = db.prepare(
    `SELECT a.*, g.group_name FROM captain_channel_assignments a
      JOIN captain_channel_groups g ON g.group_key = a.group_key WHERE a.id = ?`
  ).get(id);
  if (!assignment) return res.status(404).json({ error: '国家负责人绑定不存在' });
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare(
    `UPDATE captain_channel_assignments SET enabled = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(enabled, id);
  audit(req.session.user.id, assignment.country, enabled ? 'enable' : 'disable',
    'captain_channel_assignment', id, { groupName: assignment.group_name, userId: assignment.user_id });
  res.json({ ok: true });
});

captainRouter.patch('/bindings/:id', requireRole('owner'), (req, res) => {
  const id = Number(req.params.id);
  const binding = db.prepare('SELECT * FROM captain_channel_bindings WHERE id = ?').get(id);
  if (!binding) return res.status(404).json({ error: '店铺绑定不存在' });
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare(
    `UPDATE captain_channel_bindings SET enabled = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(enabled, id);
  audit(req.session.user.id, binding.country, enabled ? 'enable' : 'disable', 'captain_channel', id, {
    channelName: binding.channel_name,
  });
  res.json({ ok: true });
});

captainRouter.post('/sync', async (req, res, next) => {
  try {
    requireConfigured();
    res.json(await syncUser(businessUserId(req.session.user.id), req.session.user.id));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

captainRouter.post('/sync-all', requireRole('owner'), async (req, res, next) => {
  try {
    requireConfigured();
    const userIds = db.prepare(
      `SELECT DISTINCT user_id FROM captain_channel_assignments WHERE enabled = 1
       UNION
       SELECT DISTINCT b.user_id FROM captain_channel_bindings b
        WHERE b.enabled = 1 AND NOT EXISTS (
          SELECT 1 FROM captain_channel_group_members m WHERE m.open_channel_id = b.open_channel_id
        )
       ORDER BY user_id`
    ).all().map((row) => row.user_id);
    if (userIds.some((userId) => runningUsers.has(userId))) {
      return res.status(409).json({ error: '有账号正在同步，请稍后再试' });
    }
    userIds.forEach((userId) => runningUsers.add(userId));
    try {
      const refreshed = await refreshSources(allActiveSources());
      const results = userIds.map((userId) => ({
        userId,
        ...(refreshed.succeeded
          ? applyInventorySnapshots(userId)
          : { updated: 0, unmatched: 0, inventorySkus: 0 }),
      }));
      const totals = results.reduce((sum, row) => ({
        updated: sum.updated + row.updated,
        unmatched: sum.unmatched + row.unmatched,
        inventorySkus: sum.inventorySkus + row.inventorySkus,
      }), { updated: 0, unmatched: 0, inventorySkus: 0 });
      audit(req.session.user.id, null, refreshed.failed ? 'sync_partial' : 'sync',
        'captain_inventory_all', null, { users: userIds.length, ...refreshed, ...totals });
      res.json({ users: userIds.length, results, ...refreshed, ...totals });
    } finally {
      userIds.forEach((userId) => runningUsers.delete(userId));
    }
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});
