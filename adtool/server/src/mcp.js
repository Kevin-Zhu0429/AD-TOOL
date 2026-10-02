// Claude 连接器(MCP)入口:只在宠物版、且配置了网站公网地址 MCP_PUBLIC_URL 时开启。
// 地址:<MCP_PUBLIC_URL>/mcp。Claude 第一次连接会被 401 引到 OAuth 流程,在网站登录页授权后才能调用工具。
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isPet } from './profile.js';
import { createOAuthProvider, MCP_SCOPE } from './mcpAuth.js';
import { createPetMcpServer } from './mcpTools.js';

/** 公网地址只取协议和域名;不是 https 时只允许本机调试 */
export function mcpUrls(publicUrl) {
  const raw = String(publicUrl ?? '').trim();
  if (!raw) return null;
  const origin = new URL(raw).origin;
  const issuerUrl = new URL(origin);
  if (issuerUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(issuerUrl.hostname)) {
    throw new Error(`MCP_PUBLIC_URL 必须是 https 地址：${raw}`);
  }
  return { issuerUrl, resourceUrl: new URL('/mcp', origin) };
}

export function mountMcp(app, { publicUrl = process.env.MCP_PUBLIC_URL, deps = {} } = {}) {
  if (!isPet) return null;
  let urls;
  try {
    urls = mcpUrls(publicUrl);
  } catch (error) {
    console.error('[mcp]', error.message);
  }
  if (!urls) {
    app.all('/mcp', (req, res) => res.status(503).json({ error: 'Claude 连接器未开启：服务器 .env 需要设置 MCP_PUBLIC_URL（网站的 https 地址）' }));
    return null;
  }
  const { issuerUrl, resourceUrl } = urls;
  const provider = createOAuthProvider({ resourceUrl });
  app.use(mcpAuthRouter({
    provider, issuerUrl, resourceServerUrl: resourceUrl, scopesSupported: [MCP_SCOPE], resourceName: 'AD-TOOL 宠物版',
    // 登录页也走这个限流:同一 IP 15 分钟最多 30 次
    authorizationOptions: { rateLimit: { max: 30 } },
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
  // 无状态:每个请求新建一个 MCP 服务和传输,直接返回 JSON,不开 SSE 长连接,反向代理不用改配置
  app.post('/mcp', bearer, async (req, res, next) => {
    try {
      const server = createPetMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });
  app.all('/mcp', bearer, (req, res) => res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
  console.log(`[mcp] Claude 连接器地址 ${resourceUrl.href}`);
  return { issuerUrl, resourceUrl };
}
