// ChatGPT / Claude 连接器(MCP):只在宠物版、且配置了 MCP_PUBLIC_URL 时开启。
// 地址:<MCP_PUBLIC_URL>/mcp。首次连接通过 OAuth 登录授权后才能调用工具。
import { createOAuthMetadata, mcpAuthMetadataRouter, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
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
    app.all('/mcp', (req, res) => res.status(503).json({ error: 'AI 连接器未开启：服务器 .env 需要设置 MCP_PUBLIC_URL（网站的 https 地址）' }));
    return null;
  }
  const { issuerUrl, resourceUrl } = urls;
  const provider = createOAuthProvider({ resourceUrl });
  const authOptions = {
    provider, issuerUrl, resourceServerUrl: resourceUrl, scopesSupported: [MCP_SCOPE], resourceName: 'AD-TOOL 宠物版',
    // 登录页也走这个限流:同一 IP 15 分钟最多 30 次
    authorizationOptions: { rateLimit: { max: 30 } },
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  };
  // RFC 9207: ChatGPT uses its stable callback only when discovery and every
  // authorization redirect identify the same issuer (including its trailing slash).
  const oauthMetadata = { ...createOAuthMetadata(authOptions), authorization_response_iss_parameter_supported: true };
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: resourceUrl,
    scopesSupported: [MCP_SCOPE], resourceName: 'AD-TOOL 宠物版' }));
  app.use('/authorize', (req, res, next) => {
    const redirect = res.redirect.bind(res);
    // Include SDK-generated OAuth errors as well as successful authorization codes.
    // The SDK validates the registered redirect URI before either path redirects.
    res.redirect = (statusOrUrl, url) => {
      const target = new URL(typeof statusOrUrl === 'number' ? url : statusOrUrl);
      target.searchParams.set('iss', issuerUrl.href);
      return redirect(typeof statusOrUrl === 'number' ? statusOrUrl : 302, target.href);
    };
    next();
  });
  app.use(mcpAuthRouter(authOptions));
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
  // 无状态:每个请求新建一个 MCP 服务和传输,直接返回 JSON,不开 SSE 长连接,反向代理不用改配置
  app.post('/mcp', bearer, async (req, res, next) => {
    try {
      const server = createPetMcpServer({ ...deps, siteUrl: issuerUrl.href });
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
  console.log(`[mcp] AI 连接器地址 ${resourceUrl.href}`);
  return { issuerUrl, resourceUrl };
}
