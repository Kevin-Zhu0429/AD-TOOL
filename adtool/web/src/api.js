import { isPet, emptyLibrary } from './profile.js';
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
    signal: options.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// 待确认改动有变化(确认、拒绝、撤回)时发这个事件,导航栏刷新角标
export const CHANGES_EVENT = 'adtool:changes';

export const api = {
  priceStrategy: () => request('/price-strategy'),
  changes: (view) => request(`/changes?view=${encodeURIComponent(view)}`),
  changeCounts: () => request('/changes/counts'),
  changeLog: () => request('/changes/log'),
  editChange: (id, value) => request(`/changes/${id}`, { method: 'PUT', body: { value } }),
  changeAction: (action, ids) => request(`/changes/${action}`, { method: 'POST', body: { ids } }),
  revertChange: (id) => request(`/changes/${id}/revert`, { method: 'POST', body: {} }),
  competitorOverview: () => request('/competitors/overview'),
  competitorStyle: (key) => request(`/competitors/style?key=${encodeURIComponent(key)}`),
  competitorHealth: () => request('/competitors/health'),
  competitorStatus: () => request('/competitors/status'),
  syncCompetitors: (kind) => request('/competitors/sync', { method: 'POST', body: { kind } }),
  addCompetitors: (styleKey, asins) => request('/competitors', { method: 'POST', body: { styleKey, asins } }),
  updateCompetitor: (id, body) => request(`/competitors/${id}`, { method: 'PUT', body }),
  removeCompetitor: (id) => request(`/competitors/${id}`, { method: 'DELETE' }),
  importCompetitorMetrics: (month, rows, sourceFile) => request('/competitors/metrics', { method: 'POST', body: { month, rows, sourceFile } }),
  salesStats: ({ year, weeks }) => request(`/price-strategy/stats?year=${encodeURIComponent(year)}&weeks=${encodeURIComponent(weeks)}`),
  saveMonthlyTarget: (month, values) => request(`/price-strategy/targets/${month}`, { method: 'PUT', body: values }),
  priceSyncStatus: () => request('/price-strategy/status'),
  syncPriceStrategy: () => request('/price-strategy/sync', { method: 'POST', body: {} }),
  abaAsin: (params, signal) => request(`/aba/asin?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined))}`, { signal }),
  abaAmazonStatus: (marketplace) => request(`/aba/asin/amazon/status?marketplace=${encodeURIComponent(marketplace)}`),
  syncAbaAmazon: (marketplace, weeks) => request('/aba/asin/amazon/sync', { method: 'POST', body: { marketplace, weeks } }),
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
  audit: () => request('/auth/audit'),
  recordActivity: (module, action, marketplace, detail) =>
    request('/auth/audit/events', {
      method: 'POST', body: { module, action, marketplace: marketplace || '', detail },
    }),

  library: (marketplace) => isPet ? Promise.resolve(emptyLibrary()) : request(`/neg?marketplace=${encodeURIComponent(marketplace)}`),
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
  saveSkuCosts: (rows) => request('/sku/costs', { method: 'POST', body: { rows } }),

  // ---------- 船长 BI 库存同步 ----------
  captainStatus: () => request('/captain/status'),
  syncCaptainInventory: () => request('/captain/sync', { method: 'POST' }),
  captainAdmin: () => request('/captain/admin'),
  discoverCaptainChannels: () => request('/captain/discover', { method: 'POST' }),
  saveCaptainBinding: (body) => request('/captain/bindings', { method: 'POST', body }),
  toggleCaptainBinding: (id, enabled) =>
    request(`/captain/bindings/${id}`, { method: 'PATCH', body: { enabled } }),
  toggleCaptainAssignment: (id, enabled) =>
    request(`/captain/assignments/${id}`, { method: 'PATCH', body: { enabled } }),
  syncAllCaptainInventory: () => request('/captain/sync-all', { method: 'POST' }),

  // ---------- 广告组合库（每个账号、每个站点各一份） ----------
  portfolios: (marketplace) => request(`/portfolio?marketplace=${encodeURIComponent(marketplace)}`),
  addPortfolioRows: (marketplace, rows, replace = false) =>
    request('/portfolio/rows', { method: 'POST', body: { marketplace, rows, replace } }),
  updatePortfolio: (id, body) => request(`/portfolio/${id}`, { method: 'PATCH', body }),
  deletePortfolios: (ids) => request('/portfolio/delete', { method: 'POST', body: { ids } }),

  // ---------- 分市场产品库与竞品分析 ----------
  products: (marketplace, dataMonth = '', signal) => {
    const q = new URLSearchParams({ marketplace });
    if (dataMonth) q.set('dataMonth', dataMonth);
    return request(`/products?${q}`, { signal });
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
