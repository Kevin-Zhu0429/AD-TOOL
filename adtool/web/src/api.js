async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
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
  resetPassword: (id, newPassword) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),
  audit: () => request('/auth/audit'),

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
