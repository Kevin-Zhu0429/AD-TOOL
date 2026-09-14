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

async function paged(path, query, headers = {}) {
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

async function discoverChannels() {
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

function brandOptions() {
  const rows = db.prepare(
    `SELECT user_id, trim(brand) AS brand
       FROM sku_items
      WHERE trim(COALESCE(brand, '')) <> ''
      GROUP BY user_id, lower(trim(brand))
      ORDER BY user_id, brand COLLATE NOCASE`
  ).all();
  const byUser = new Map();
  for (const row of rows) {
    const brands = byUser.get(row.user_id) ?? [];
    brands.push(row.brand);
    byUser.set(row.user_id, brands);
  }
  return [...byUser].map(([userId, brands]) => ({ userId, brands }));
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

/**
 * 把已缓存的店铺库存应用到某个网站账号。
 * 欧洲同品牌、同 SKU 的所有店铺相加，并写到该品牌全部欧洲国家行；其他区域按国家写入。
 */
export function applyInventorySnapshots(userId) {
  const snapshots = db.prepare(
    `SELECT b.brand_key, b.country, s.sku_key, s.asin, s.stock, s.transit
       FROM captain_channel_bindings b
       JOIN captain_inventory_snapshots s ON s.binding_id = b.id
      WHERE b.user_id = ? AND b.enabled = 1`
  ).all(userId);

  const totals = new Map();
  for (const row of snapshots) {
    const scope = EU_MARKETS.includes(row.country) ? 'EU' : row.country;
    const key = `${row.brand_key}\u0000${scope}\u0000${row.sku_key}`;
    const total = totals.get(key) ?? {
      brandKey: row.brand_key, scope, skuKey: row.sku_key, stock: 0, transit: 0, asins: new Set(),
    };
    total.stock += intOf(row.stock);
    total.transit += intOf(row.transit);
    if (row.asin) total.asins.add(row.asin);
    totals.set(key, total);
  }

  const updateEurope = db.prepare(
    `UPDATE sku_items SET
       stock = @stock, transit = @transit,
       asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
       updated_at = datetime('now', 'localtime')
     WHERE user_id = @userId
       AND country IN (${EU_MARKETS.map((country) => `'${country}'`).join(',')})
       AND lower(trim(COALESCE(brand, ''))) = @brandKey
       AND lower(trim(sku)) = @skuKey`
  );
  const updateCountry = db.prepare(
    `UPDATE sku_items SET
       stock = @stock, transit = @transit,
       asin = CASE WHEN @asin IS NOT NULL THEN @asin ELSE asin END,
       updated_at = datetime('now', 'localtime')
     WHERE user_id = @userId AND country = @country
       AND lower(trim(COALESCE(brand, ''))) = @brandKey
       AND lower(trim(sku)) = @skuKey`
  );

  let updated = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const total of totals.values()) {
      const params = {
        userId,
        brandKey: total.brandKey,
        skuKey: total.skuKey,
        stock: total.stock,
        transit: total.transit,
        asin: total.asins.size === 1 ? [...total.asins][0] : null,
      };
      const changes = total.scope === 'EU'
        ? updateEurope.run(params).changes
        : updateCountry.run({ ...params, country: total.scope }).changes;
      updated += changes;
      if (!changes) unmatched += 1;
    }
  })();
  return { updated, unmatched, inventorySkus: totals.size };
}

function bindingsForUser(userId) {
  return db.prepare(
    `SELECT id, user_id, brand, country, open_channel_id, channel_name, site_id, enabled,
            last_sync_at, last_sync_status, last_sync_detail
       FROM captain_channel_bindings WHERE user_id = ?
      ORDER BY brand COLLATE NOCASE, country, channel_name`
  ).all(userId);
}

async function syncUser(userId, actorId = userId) {
  if (runningUsers.has(userId)) {
    const error = new Error('这个账号正在同步，请稍后再试');
    error.status = 409;
    throw error;
  }
  const bindings = bindingsForUser(userId).filter((binding) => binding.enabled);
  if (!bindings.length) {
    const error = new Error('这个账号还没有绑定船长店铺，请联系超级管理员');
    error.status = 400;
    throw error;
  }

  runningUsers.add(userId);
  const now = Math.floor(Date.now() / 1000);
  const errors = [];
  let fetched = 0;
  let succeeded = 0;
  try {
    for (const binding of bindings) {
      try {
        const items = await fetchBindingInventory(binding, now);
        db.transaction(() => {
          for (const item of items) upsertSnapshot.run({ bindingId: binding.id, ...item });
          db.prepare(
            `UPDATE captain_channel_bindings SET last_sync_at = ?, last_sync_status = 'ok',
                    last_sync_detail = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
          ).run(now, `读取 ${items.length} 个 SKU`, binding.id);
        })();
        fetched += items.length;
        succeeded += 1;
      } catch (error) {
        const message = clean(error.message).slice(0, 300) || '同步失败';
        errors.push(`${binding.channel_name}：${message}`);
        db.prepare(
          `UPDATE captain_channel_bindings SET last_sync_status = 'error', last_sync_detail = ?,
                  updated_at = datetime('now', 'localtime') WHERE id = ?`
        ).run(message, binding.id);
      }
    }
    const applied = succeeded ? applyInventorySnapshots(userId) : { updated: 0, unmatched: 0, inventorySkus: 0 };
    audit(actorId, null, errors.length ? 'sync_partial' : 'sync', 'captain_inventory', null, {
      targetUserId: userId, bindings: bindings.length, succeeded, fetched, ...applied,
      errors: errors.slice(0, 10),
    });
    return { bindings: bindings.length, succeeded, failed: errors.length, fetched, ...applied, errors };
  } finally {
    runningUsers.delete(userId);
  }
}

captainRouter.get('/status', (req, res) => {
  const bindings = bindingsForUser(req.session.user.id).map((binding) => ({
    id: binding.id,
    brand: binding.brand,
    country: binding.country,
    channel_name: binding.channel_name,
    enabled: binding.enabled,
    last_sync_at: binding.last_sync_at,
    last_sync_status: binding.last_sync_status,
    last_sync_detail: binding.last_sync_detail,
  }));
  res.json({ configured: isConfigured(), bindings });
});

captainRouter.get('/admin', requireRole('owner'), (req, res) => {
  const bindings = db.prepare(
    `SELECT b.id, b.user_id, b.brand, b.country, b.open_channel_id, b.channel_name,
            b.site_id, b.enabled, b.last_sync_at, b.last_sync_status, b.last_sync_detail,
            u.display_name AS owner_name
       FROM captain_channel_bindings b JOIN users u ON u.id = b.user_id
      ORDER BY b.brand COLLATE NOCASE, b.country, b.channel_name`
  ).all();
  res.json({ configured: isConfigured(), bindings, brandOptions: brandOptions() });
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
  const userId = Number(req.body?.userId);
  if (!db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId)) {
    return res.status(400).json({ error: '请选择有效的网站账号' });
  }
  const requestedBrand = clean(req.body?.brand);
  if (!requestedBrand || requestedBrand.length > 120) {
    return res.status(400).json({ error: '请选择该账号 SKU 库中的品牌' });
  }
  const brandRow = db.prepare(
    `SELECT trim(brand) AS brand FROM sku_items
      WHERE user_id = ? AND lower(trim(COALESCE(brand, ''))) = ? LIMIT 1`
  ).get(userId, keyOf(requestedBrand));
  if (!brandRow) return res.status(400).json({ error: '所选账号的 SKU 库中没有这个品牌，请重新选择' });
  const brand = brandRow.brand;

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

  const saveBinding = db.prepare(
    `INSERT INTO captain_channel_bindings
       (user_id, brand, brand_key, country, open_channel_id, channel_name, site_id, enabled)
     VALUES (@userId, @brand, @brandKey, @country, @openChannelId, @channelName, @siteId, 1)
     ON CONFLICT (open_channel_id) DO UPDATE SET
       user_id = excluded.user_id, brand = excluded.brand, brand_key = excluded.brand_key,
       country = excluded.country, channel_name = excluded.channel_name, site_id = excluded.site_id,
       enabled = 1, updated_at = datetime('now', 'localtime')`
  );
  const ids = db.transaction(() => channels.map((channel) => {
    saveBinding.run({ userId, brand, brandKey: keyOf(brand), ...channel });
    return db.prepare('SELECT id FROM captain_channel_bindings WHERE open_channel_id = ?')
      .get(channel.openChannelId).id;
  }))();
  audit(req.session.user.id, channels.length === 1 ? channels[0].country : null,
    'bind', 'captain_channel_group', null,
    { userId, brand, channels: channels.map((channel) => channel.channelName) });
  res.json({ ids, count: ids.length });
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
    res.json(await syncUser(req.session.user.id));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

captainRouter.post('/sync-all', requireRole('owner'), async (req, res, next) => {
  try {
    requireConfigured();
    const userIds = db.prepare(
      'SELECT DISTINCT user_id FROM captain_channel_bindings WHERE enabled = 1 ORDER BY user_id'
    ).all().map((row) => row.user_id);
    const results = [];
    for (const userId of userIds) {
      try {
        results.push({ userId, ...(await syncUser(userId, req.session.user.id)) });
      } catch (error) {
        results.push({ userId, error: error.message });
      }
    }
    res.json({ users: results.length, results });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});
