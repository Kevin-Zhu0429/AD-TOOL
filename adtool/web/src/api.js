import { splitAgedFeeRows } from './agedStorageUpload.js';

let readNonce = 0;

async function request(path, options = {}) {
  const method = options.method || 'GET';
  // A unique URL also bypasses stale API entries already held by a proxy.
  const url = `/api${path}${method === 'GET' ? `${path.includes('?') ? '&' : '?'}_=${Date.now()}-${++readNonce}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
    cache: method === 'GET' ? 'no-store' : undefined,
    signal: options.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || (res.status === 413 ? '导入内容超过服务器单次请求限制，请刷新页面后重试' : `请求失败 (${res.status})`));
    error.status = res.status;
    throw error;
  }
  return data;
}

async function importAgedFees(rows, date, scenario, sourceFile, onProgress) {
  const chunks = splitAgedFeeRows(rows);
  let uploadId;
  try {
    ({ uploadId } = await request('/aged-fees/import/start', { method: 'POST', body: { date, scenario, sourceFile, rowCount: rows.length } }));
  } catch (error) {
    // 前端已更新而后端仍为旧版时，紧凑数据可继续使用原导入接口。
    if (error.status === 404) return request('/aged-fees/import', { method: 'POST', body: { rows, date, scenario, sourceFile } });
    throw error;
  }
  try {
    for (const chunk of chunks) {
      await request(`/aged-fees/import/${uploadId}/rows`, { method: 'POST', body: chunk });
      onProgress?.(chunk.offset + chunk.rows.length, rows.length);
    }
    return await request(`/aged-fees/import/${uploadId}/finish`, { method: 'POST' });
  } catch (error) {
    await request(`/aged-fees/import/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

const SYNC_POLL_MS = 1500;

/**
 * 库存同步在服务器后台跑:start 时先 POST 开始(已经在跑就接着看),之后每 1.5 秒问一次进度,
 * 跑完返回结果。不 start 时只接着看正在跑的任务(页面刷新后用),没有在跑的返回 null。
 * signal 取消后不再轮询,服务器上的同步照样跑完。
 */
async function followSyncJob(path, { start = false, onProgress, signal } = {}) {
  let { job } = await request(path, start ? { method: 'POST', signal } : { signal });
  if (!job || (!start && job.status !== 'running')) return null;
  while (job.status === 'running') {
    onProgress?.(job.progress);
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
    ({ job } = await request(path, { signal }));
    if (!job) throw new Error('同步任务找不到了（服务器可能重启过），请重新同步');
  }
  if (job.status === 'error') throw new Error(job.error || '同步失败');
  return job.result;
}

/** 同步进度的一句话:先按店铺数读亚马逊,读完再写 SKU 库 */
export function syncProgressText(progress) {
  if (progress?.phase === 'apply') return '店铺已读完，正在写入 SKU 库…';
  if (!progress?.total) return '正在同步亚马逊库存…';
  return `正在读取亚马逊库存 ${progress.done}/${progress.total} 家店铺`
    + (progress.current ? `（刚完成 ${progress.current}）` : '');
}

/** 操作明细的筛选和翻页参数;all / 空值不带,自定义时间才带 from / to */
function auditQuery({ userId, action, entity, days, from, to, before } = {}) {
  const q = new URLSearchParams();
  if (userId && userId !== 'all') q.set('userId', userId);
  if (action && action !== 'all') q.set('action', action);
  if (entity && entity !== 'all') q.set('entity', entity);
  if (days) q.set('days', days);
  if (days === 'custom') {
    if (from) q.set('from', from);
    if (to) q.set('to', to);
  }
  if (before) q.set('before', before);
  return q.toString();
}

export const api = {
  agedFees: (batchId) => request(`/aged-fees${batchId ? `?batchId=${encodeURIComponent(batchId)}` : ''}`),
  importAgedFees,
  updateAgedFeeRow: (id, correction) => request(`/aged-fees/rows/${id}`, { method: 'PATCH', body: correction }),
  abaAsin: (params, signal) => request(`${params.publicReport === '1' ? '/aba-public/asin' : '/aba/asin'}?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined))}`, { signal }),
  abaPublicStatus: (signal) => request('/aba-public/status', { signal }),
  syncPublicAba: (signal) => request('/aba-public/sync', { method: 'POST', signal }),
  importAbaAsin: (marketplace, files) => request('/aba/asin/import', { method: 'POST', body: { marketplace, files } }),
  aba: (params, signal) => request(`/aba?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined))}`, { signal }),
  importAba: (marketplace, files) => request('/aba/import', { method: 'POST', body: { marketplace, files } }),
  me: () => request('/auth/me'),
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  updateProfile: (displayName) =>
    request('/auth/profile', { method: 'PATCH', body: { displayName } }),
  changePassword: (oldPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } }),
  // 记下这个人看过的更新日志版本,下次登录不再自动弹同一版
  seenVersion: (version) =>
    request('/auth/seen-version', { method: 'POST', body: { version } }),

  listUsers: () => request('/auth/users'),
  createUser: (body) => request('/auth/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/auth/users/${id}`, { method: 'PATCH', body }),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id, newPassword) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),
  // 统计 + 第一页明细和汇总;filters: { userId, action, entity, days, from, to }
  audit: (filters = {}) => request(`/auth/audit?${auditQuery(filters)}`),
  auditLogs: (filters = {}, before) => request(`/auth/audit/logs?${auditQuery({ ...filters, before })}`),
  recordActivity: (module, action, marketplace, detail) =>
    request('/auth/audit/events', {
      method: 'POST', body: { module, action, marketplace: marketplace || '', detail },
    }),

  library: (marketplace) => request(`/neg?marketplace=${encodeURIComponent(marketplace)}`),
  // 整段文本批量加(单列词库一行一个词,多列词库从 Excel 复制过来,列之间是 Tab)
  addText: (marketplace, lib, text, replace = false) =>
    request('/neg/bulk', { method: 'POST', body: { marketplace, lib, text, replace } }),
  // 结构化批量加,Excel 导入时按列名映射好再发
  addRows: (marketplace, lib, rows, replace = false) =>
    request('/neg/rows', { method: 'POST', body: { marketplace, lib, rows, replace } }),
  updateRow: (id, body) => request(`/neg/${id}`, { method: 'PATCH', body }),
  deleteRows: (ids) => request('/neg/delete', { method: 'POST', body: { ids } }),
  setLibConfig: (marketplace, body) =>
    request('/neg/config', { method: 'POST', body: { marketplace, ...body } }),

  // ---------- SKU 库(每个账号各存各的) ----------
  skus: ({ marketplace, scope } = {}) => {
    const q = new URLSearchParams();
    if (marketplace) q.set('marketplace', marketplace);
    if (scope) q.set('scope', scope);
    return request(`/sku${q.toString() ? `?${q}` : ''}`);
  },
  addSkuText: (text, replace = false) =>
    request('/sku/bulk', { method: 'POST', body: { text, replace } }),
  addSkuRows: (rows, replace = false) =>
    request('/sku/rows', { method: 'POST', body: { rows, replace } }),
  updateSku: (id, body) => request(`/sku/${id}`, { method: 'PATCH', body }),
  deleteSkus: (ids) => request('/sku/delete', { method: 'POST', body: { ids } }),

  // ---------- 亚马逊 SP-API 库存同步(接口路径沿用 captain) ----------
  captainStatus: () => request('/captain/status'),
  syncCaptainInventory: (options) => followSyncJob('/captain/sync', { ...options, start: true }),
  resumeCaptainSync: (options) => followSyncJob('/captain/sync', options),
  captainAdmin: () => request('/captain/admin'),
  discoverCaptainChannels: () => request('/captain/discover', { method: 'POST' }),
  saveCaptainBinding: (body) => request('/captain/bindings', { method: 'POST', body }),
  toggleCaptainBinding: (id, enabled) =>
    request(`/captain/bindings/${id}`, { method: 'PATCH', body: { enabled } }),
  toggleCaptainAssignment: (id, enabled) =>
    request(`/captain/assignments/${id}`, { method: 'PATCH', body: { enabled } }),
  syncAllCaptainInventory: (options) => followSyncJob('/captain/sync-all', { ...options, start: true }),
  resumeCaptainSyncAll: (options) => followSyncJob('/captain/sync-all', options),

  // ---------- 广告组合库（每个账号、每个站点各一份） ----------
  portfolios: (marketplace) => request(`/portfolio?marketplace=${encodeURIComponent(marketplace)}`),
  addPortfolioRows: (marketplace, rows, replace = false) =>
    request('/portfolio/rows', { method: 'POST', body: { marketplace, rows, replace } }),
  updatePortfolio: (id, body) => request(`/portfolio/${id}`, { method: 'PATCH', body }),
  deletePortfolios: (ids) => request('/portfolio/delete', { method: 'POST', body: { ids } }),

  // ---------- 分市场产品库与竞品分析 ----------
  products: (marketplace, dataMonth = '') => {
    const q = new URLSearchParams({ marketplace });
    if (dataMonth) q.set('dataMonth', dataMonth);
    return request(`/products?${q}`);
  },
  importProducts: (marketplace, products, dataMonth, sourceFile = '') =>
    request('/products/import', {
      method: 'POST', body: { marketplace, products, dataMonth, sourceFile },
    }),
  importAllProducts: (productsByMarketplace, dataMonth, sourceFile = '') =>
    request('/products/import-all', {
      method: 'POST', body: { productsByMarketplace, dataMonth, sourceFile },
    }),
  updateProduct: (marketplace, dataMonth, asin, changes) =>
    request(`/products/${encodeURIComponent(asin)}`, {
      method: 'PATCH', body: { marketplace, dataMonth, changes },
    }),
  deleteProducts: (marketplace, dataMonth, asins) =>
    request('/products/delete', { method: 'POST', body: { marketplace, dataMonth, asins } }),
  deleteProductMonth: (marketplace, dataMonth) =>
    request('/products/delete-month', { method: 'POST', body: { marketplace, dataMonth } }),
  productSettings: (marketplace, ownBrand, minSales) =>
    request('/products/settings', {
      method: 'POST', body: { marketplace, ownBrand, minSales },
    }),
};
