// AI 连接器(MCP)的 OAuth 授权:网站自己当授权服务器,协议细节交给 MCP SDK 的 mcpAuthRouter。
// 流程:客户端注册 → /authorize 网站账号登录授权 → 授权码换访问令牌(1 小时)和刷新令牌(30 天)。
// 只允许 ChatGPT/Claude 的精确回调和本机回环地址;刷新令牌每次使用后轮换。
// OAuth 错误说明会放进 WWW-Authenticate 响应头,只能用英文(响应头不能有中文)。
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { db, audit } from './db.js';

export const MCP_SCOPE = 'ink:read';
export const MCP_WRITE_SCOPE = 'ink:write';
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

/** 在用账号能授权；每次调用工具按最新角色、站点与功能权限校验。 */
function authorizedUser(userId) {
  const row = db.prepare('SELECT id, username, role, is_active FROM users WHERE id=?').get(userId);
  return row && row.is_active ? row : null;
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

function loginPage({ client, params, error, username = '', nonce }) {
  const hidden = {
    response_type: 'code', client_id: client.client_id, redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge, code_challenge_method: 'S256',
    state: params.state, scope: params.scopes?.join(' '), resource: params.resource?.href,
  };
  const fields = Object.entries(hidden).filter(([, value]) => value)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('');
  const target = new URL(params.redirectUri);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 AI 连接墨盒广告工作台</title><link rel="stylesheet" href="/mcp-auth.css">
<style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.6 var(--font)}
main{box-sizing:border-box;width:min(440px,calc(100% - 32px));background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;margin:16px 0}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 16px;color:var(--text-dim)}ul{margin:0 0 18px;padding-left:20px;color:var(--text-dim)}
label{display:block;font-size:13px;margin:12px 0 4px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font:inherit;background:var(--panel-2);color:var(--text)}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.65;cursor:wait}
.err{color:var(--red-text);background:var(--red-soft);border-radius:8px;padding:8px 10px}.small{font-size:12px;color:var(--text-dim);margin-top:14px}
.reveal{margin:6px 0 0;width:auto;padding:4px 0;background:transparent;color:var(--accent-text)}
</style></head><body><main>
<h1>授权 AI 连接墨盒广告工作台</h1>
<p><b>${escapeHtml(client.client_name || 'AI 客户端')}</b> 请求连接本网站。授权后它可以：</p>
<ul><li>按你的账号权限查看 SKU、库存、词库、产品情报、广告组合、ABA 报告和 Listing</li><li>生成广告批量表、分析广告数据、计算仓储费</li>${params.scopes?.includes(MCP_WRITE_SCOPE) ? '<li><b>读写授权：允许导入、编辑和删除网站数据，启动同步任务；超级管理员可提交 Listing 修改及变体关系到亚马逊，仍受网站权限限制</b></li>' : '<li>只读授权：仅查询和计算，不允许维护或删除网站数据</li>'}</ul>
<p class="err" id="auth-error" role="alert" ${error ? '' : 'hidden'}>${escapeHtml(error)}</p>
<form method="post" action="/authorize" novalidate>${fields}
<label for="u">网站用户名</label><input id="u" type="text" name="username" autocomplete="username" value="${escapeHtml(username)}" required ${error ? 'aria-invalid="true" aria-describedby="auth-error"' : 'autofocus'}>
<label for="p">密码</label><input id="p" type="password" name="password" autocomplete="current-password" required ${error ? 'autofocus aria-invalid="true" aria-describedby="auth-error"' : ''}>
<button type="button" class="reveal" aria-controls="p" aria-pressed="false" id="reveal">显示密码</button>
<button type="submit" id="submit">登录并授权</button></form>
<p class="small">授权后会跳回 ${escapeHtml(target.host)}。只访问你有权限的数据，私有资料归属当前账号。</p>
</main><script nonce="${nonce}">
const form=document.querySelector('form'), username=document.getElementById('u'), password=document.getElementById('p'), error=document.getElementById('auth-error'), button=document.getElementById('submit');
document.getElementById('reveal').addEventListener('click', function(){ const show=password.type==='password'; password.type=show?'text':'password'; this.textContent=show?'隐藏密码':'显示密码'; this.setAttribute('aria-pressed',String(show)); });
form.addEventListener('submit',function(event){
  if(button.disabled){event.preventDefault();return;}
  if(!username.value.trim()||!password.value){event.preventDefault();error.hidden=false;error.textContent='请填写网站用户名和密码';const field=!username.value.trim()?username:password;field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby','auth-error');field.focus();return;}
  button.disabled=true;button.textContent='正在授权…';form.setAttribute('aria-busy','true');
});
window.addEventListener('pageshow',function(){button.disabled=false;button.textContent='登录并授权';form.removeAttribute('aria-busy');});
</script></body></html>`;
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
    const nonce = randomBytes(16).toString('base64');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https://chatgpt.com https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'`);
    checkResource(params.resource);
    const scopes = params.scopes?.length ? params.scopes : [MCP_SCOPE, MCP_WRITE_SCOPE];
    if (!scopes.includes(MCP_SCOPE) || scopes.some((scope) => ![MCP_SCOPE, MCP_WRITE_SCOPE].includes(scope))) {
      throw new InvalidTargetError('Request ink:read and optionally ink:write');
    }
    params.scopes = scopes;
    const { username, password } = req.method === 'POST' ? req.body ?? {} : {};
    if (req.method !== 'POST') return void res.type('html').send(loginPage({ client, params, nonce }));
    if (!username || !password) return void res.status(400).type('html').send(loginPage({ client, params, nonce, username, error: '请填写网站用户名和密码' }));
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? '').trim());
    if (!row || !bcrypt.compareSync(String(password ?? ''), row.password_hash)) {
      return void res.status(401).type('html').send(loginPage({ client, params, nonce, username, error: '用户名或密码错误' }));
    }
    if (!authorizedUser(row.id)) {
      return void res.status(403).type('html').send(loginPage({ client, params, nonce, username, error: '账号已停用，无法授权 AI 连接' }));
    }
    const code = newSecret();
    db.transaction(() => {
      db.prepare('DELETE FROM mcp_oauth_codes WHERE expires_at<?').run(now());
      db.prepare(`INSERT INTO mcp_oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,scopes,resource,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(digest(code), client.client_id, row.id, params.redirectUri, params.codeChallenge,
        scopes.join(' '), resourceUrl.href, now() + CODE_TTL_S);
    })();
    audit(row.id, null, 'authorize', 'mcp_client', null, { client: client.client_name ?? client.client_id, scopes, redirect: new URL(params.redirectUri).host });
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
    checkResource(resource);
    return db.transaction(() => {
      const row = db.prepare('DELETE FROM mcp_oauth_codes WHERE code_hash=? AND client_id=? RETURNING *').get(digest(code), client.client_id);
      if (!row || row.expires_at <= now()) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource does not match the authorization request');
      if (!authorizedUser(row.user_id)) throw new InvalidGrantError('The authorizing account is disabled or deleted');
      return issueTokens(client.client_id, row.user_id, row.scopes.split(' '), row.resource);
    })();
  },

  async exchangeRefreshToken(client, refreshToken, requestedScopes, resource) {
    checkResource(resource);
    const hash = digest(refreshToken);
    const row = db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=? AND kind='refresh' AND client_id=?").get(hash, client.client_id);
    if (!row || row.expires_at < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError('resource does not match the authorization request');
    if (!authorizedUser(row.user_id)) throw new InvalidGrantError('The authorizing account is disabled or deleted');
    const scopes = requestedScopes ?? row.scopes.split(' ');
    if (!scopes.includes(MCP_SCOPE) || scopes.some((scope) => !row.scopes.split(' ').includes(scope))) {
      throw new InvalidScopeError('Refresh scopes must be a subset of the authorized scopes and include ink:read');
    }
    return db.transaction(() => {
      if (!db.prepare('DELETE FROM mcp_oauth_tokens WHERE token_hash=?').run(hash).changes) throw new InvalidGrantError('Refresh token already used');
      return issueTokens(client.client_id, row.user_id, scopes, row.resource);
    })();
  },

  async verifyAccessToken(token) {
    const row = db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=? AND kind='access'").get(digest(token));
    if (!row || row.expires_at < now()) throw new InvalidTokenError('Invalid or expired access token');
    if (!authorizedUser(row.user_id)) throw new InvalidTokenError('The authorizing account is disabled or deleted');
    checkResource(row.resource ? new URL(row.resource) : undefined);
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
