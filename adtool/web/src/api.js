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

  listUsers: () => request('/auth/users'),
  createUser: (body) => request('/auth/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/auth/users/${id}`, { method: 'PATCH', body }),
  resetPassword: (id, newPassword) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),
  audit: () => request('/auth/audit'),

  library: (marketplace) => request(`/neg?marketplace=${encodeURIComponent(marketplace)}`),
  addTerms: (marketplace, cat, text) =>
    request('/neg/bulk', { method: 'POST', body: { marketplace, cat, text } }),
  updateTerm: (id, body) => request(`/neg/${id}`, { method: 'PATCH', body }),
  deleteTerms: (ids) => request('/neg/delete', { method: 'POST', body: { ids } }),
  setCatConfig: (marketplace, body) =>
    request('/neg/config', { method: 'POST', body: { marketplace, ...body } }),
};
