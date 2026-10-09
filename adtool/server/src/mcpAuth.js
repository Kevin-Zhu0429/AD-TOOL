// AI 连接器(MCP)的 OAuth 授权:网站自己当授权服务器,协议细节交给 MCP SDK 的 mcpAuthRouter。
// 流程:客户端注册 → /authorize 超级管理员登录授权 → 授权码换访问令牌(1 小时)和刷新令牌(30 天)。
// 只允许 ChatGPT/Claude 的精确回调和本机回环地址;刷新令牌每次使用后轮换。
// OAuth 错误说明会放进 WWW-Authenticate 响应头,只能用英文(响应头不能有中文)。
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { db, audit } from './db.js';

export const MCP_SCOPE = 'pet:read';
const CODE_TTL_S = 10 * 60;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

// ChatGPT 的固定回调配合 mcp.js 中的 RFC 9207 issuer 标识。不要放行整个域名或任意回调路径。
export const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const HOSTED_CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', CHATGPT_CALLBACK]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedRedirectUri(value) {
  if (HOSTED_CALLBACKS.has(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');

/** 只有在用的超级管理员能授权;每次用令牌都重新查,停用或降级后立即失效 */
function authorizedUser(userId) {
  const row = db.prepare('SELECT id, username, role, is_active FROM users WHERE id=?').get(userId);
  return row && row.is_active && row.role === 'owner' ? row : null;
}

function issueTokens(clientId, userId, scopes, resource) {
  const access = newSecret();
  const refresh = newSecret();
  const insert = db.prepare(`INSERT INTO mcp_oauth_tokens(token_hash,kind,client_id,user_id,scopes,resource,expires_at)
    VALUES(?,?,?,?,?,?,?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM mcp_oauth_tokens WHERE expires_at<?').run(now());
    insert.run(digest(access), 'access', clientId, userId, scopes.join(' '), resource ?? null, now() + ACCESS_TTL_S);
    insert.run(digest(refresh), 'refresh', clientId, userId, scopes.join(' '), resource ?? null, now() + REFRESH_TTL_S);
  })();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function loginPage({ client, params, error }) {
  const hidden = {
    response_type: 'code', client_id: client.client_id, redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge, code_challenge_method: 'S256',
    state: params.state, scope: params.scopes?.join(' '), resource: params.resource?.href,
  };
  const fields = Object.entries(hidden).filter(([, value]) => value)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('');
  const target = new URL(params.redirectUri);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 AI 连接宠物广告工作台</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f4;color:#1c1917;font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(380px,calc(100% - 32px));background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:28px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 16px;color:#57534e}ul{margin:0 0 18px;padding-left:20px;color:#57534e}
label{display:block;font-size:13px;margin:12px 0 4px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #d6d3d1;border-radius:8px;font:inherit}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:8px;background:#1c1917;color:#fff;font:inherit;cursor:pointer}
.err{color:#b91c1c;background:#fef2f2;border-radius:8px;padding:8px 10px}.small{font-size:12px;color:#78716c;margin-top:14px}
</style></head><body><main>
<h1>授权 AI 连接宠物广告工作台</h1>
<p><b>${escapeHtml(client.client_name || 'AI 客户端')}</b> 请求连接本网站。授权后它可以：</p>
<ul><li>查看 SKU、库存、销量、流量、价格、利润和 ABA 搜索词</li><li>查看亚马逊上的 Listing、图片、竞品信息和改动效果</li><li>向网站提交 Listing 和广告改动提议；店主在「待确认改动」页确认后才会执行</li></ul>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">${fields}
<label for="u">网站用户名</label><input id="u" type="text" name="username" autocomplete="username" required autofocus>
<label for="p">密码</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<button type="submit">登录并授权</button></form>
<p class="small">授权后会跳回 ${escapeHtml(target.host)}。只有超级管理员账号可以授权。</p>
</main></body></html>`;
}

const clientsStore = {
  getClient(clientId) {
    const row = db.prepare('SELECT data_json FROM mcp_oauth_clients WHERE client_id=?').get(String(clientId));
    return row ? JSON.parse(row.data_json) : undefined;
  },
  registerClient(client) {
    const uris = client.redirect_uris ?? [];
    if (!uris.length || !uris.every(allowedRedirectUri)) {
      throw new InvalidClientMetadataError('redirect_uris must be approved ChatGPT or Claude callbacks, or loopback addresses');
    }
    db.prepare('INSERT INTO mcp_oauth_clients(client_id,data_json) VALUES(?,?)').run(client.client_id, JSON.stringify(client));
    return client;
  },
};

const trimSlash = (href) => String(href).replace(/\/+$/, '');

/**
 * resourceUrl 是 /mcp 的公网地址。客户端带了 resource 参数时必须指向它,令牌不能拿去别的服务用。
 * @returns {import('@modelcontextprotocol/sdk/server/auth/provider.js').OAuthServerProvider}
 */
export function createOAuthProvider({ resourceUrl }) {
  const checkResource = (resource) => {
    if (resource && trimSlash(resource.href) !== trimSlash(resourceUrl.href)) throw new InvalidTargetError(`resource must be ${resourceUrl.href}`);
  };
  return {
  get clientsStore() { return clientsStore; },

  // GET 显示登录页;登录页 POST 回同一个地址,SDK 已经重新校验过客户端和回调地址
  async authorize(client, params, res) {
    const req = res.req;
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
    checkResource(params.resource);
    const { username, password } = req.method === 'POST' ? req.body ?? {} : {};
    if (!username && !password) return void res.type('html').send(loginPage({ client, params }));
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? '').trim());
    if (!row || !bcrypt.compareSync(String(password ?? ''), row.password_hash)) {
      return void res.status(401).type('html').send(loginPage({ client, params, error: '用户名或密码错误' }));
    }
    if (!authorizedUser(row.id)) {
      return void res.status(403).type('html').send(loginPage({ client, params, error: '只有在用的超级管理员账号可以授权 AI 连接' }));
    }
    const code = newSecret();
    db.transaction(() => {
      db.prepare('DELETE FROM mcp_oauth_codes WHERE expires_at<?').run(now());
      db.prepare(`INSERT INTO mcp_oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,scopes,resource,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(digest(code), client.client_id, row.id, params.redirectUri, params.codeChallenge,
        MCP_SCOPE, params.resource?.href ?? null, now() + CODE_TTL_S);
    })();
    audit(row.id, 'US', 'authorize', 'mcp_client', null, { client: client.client_name ?? client.client_id, redirect: new URL(params.redirectUri).host });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    res.redirect(302, target.href);
  },

  async challengeForAuthorizationCode(client, code) {
    const row = db.prepare('SELECT code_challenge FROM mcp_oauth_codes WHERE code_hash=? AND client_id=? AND expires_at>=?')
      .get(digest(code), client.client_id, now());
    if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const row = db.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash=? AND client_id=?').get(digest(code), client.client_id);
    // 授权码只能用一次
    db.prepare('DELETE FROM mcp_oauth_codes WHERE code_hash=?').run(digest(code));
    if (!row || row.expires_at < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource does not match the authorization request');
    if (!authorizedUser(row.user_id)) throw new InvalidGrantError('The authorizing account is disabled or no longer an owner');
    return issueTokens(client.client_id, row.user_id, row.scopes.split(' '), row.resource);
  },

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    const hash = digest(refreshToken);
    const row = db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=? AND kind='refresh' AND client_id=?").get(hash, client.client_id);
    if (!row || row.expires_at < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource does not match the authorization request');
    if (!authorizedUser(row.user_id)) throw new InvalidGrantError('The authorizing account is disabled or no longer an owner');
    db.prepare('DELETE FROM mcp_oauth_tokens WHERE token_hash=?').run(hash);
    return issueTokens(client.client_id, row.user_id, row.scopes.split(' '), row.resource);
  },

  async verifyAccessToken(token) {
    const row = db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=? AND kind='access'").get(digest(token));
    if (!row || row.expires_at < now()) throw new InvalidTokenError('Invalid or expired access token');
    if (!authorizedUser(row.user_id)) throw new InvalidTokenError('The authorizing account is disabled or no longer an owner');
    const client = clientsStore.getClient(row.client_id);
    const source = client?.redirect_uris?.includes(CHATGPT_CALLBACK) ? 'chatgpt' : 'claude';
    return { token, clientId: row.client_id, scopes: row.scopes.split(' '), expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined, extra: { userId: row.user_id, source } };
  },

  async revokeToken(client, { token }) {
    db.prepare('DELETE FROM mcp_oauth_tokens WHERE token_hash=? AND client_id=?').run(digest(token), client.client_id);
  },
  };
}
