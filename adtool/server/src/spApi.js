// 亚马逊 SP-API 客户端:用 refresh token 换 access token、按区域选接口地址、限速和重试。
// 凭证只放环境变量。一个开发者应用(CLIENT_ID / SECRET)可以挂多个卖家账号:
// 第一个账号用 SPAPI_REFRESH_TOKEN / SPAPI_SELLER_ID,之后的加 _2、_3 … 后缀。
// 2023 年 10 月起 SP-API 不再需要 AWS 签名,请求头带 x-amz-access-token 即可。

const LWA_URL = 'https://api.amazon.com/auth/o2/token';

export const REGION_HOSTS = {
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  na: 'https://sellingpartnerapi-na.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

/** 网站支持的站点 → 亚马逊 marketplaceId 和它所在的接口区域 */
export const AMAZON_MARKETPLACES = {
  ES: { id: 'A1RKKUPIHCS9HS', region: 'eu' },
  DE: { id: 'A1PA6795UKMFR9', region: 'eu' },
  FR: { id: 'A13V1IB3VIYZZH', region: 'eu' },
  IT: { id: 'APJ6JRA9NG5V4', region: 'eu' },
  UK: { id: 'A1F83G8C2ARO7P', region: 'eu' },
  AE: { id: 'A2VIGQ35RCS4UG', region: 'eu' },
  US: { id: 'ATVPDKIKX0DER', region: 'na' },
  CA: { id: 'A2EUQ1WTGCTBG2', region: 'na' },
  AU: { id: 'A39IBJ37TRP1C6', region: 'fe' },
};

const COUNTRY_BY_MARKETPLACE = new Map(
  Object.entries(AMAZON_MARKETPLACES).map(([country, marketplace]) => [marketplace.id, country])
);

export function countryOfMarketplace(marketplaceId) {
  return COUNTRY_BY_MARKETPLACE.get(marketplaceId) ?? null;
}

/**
 * 限速节奏。FBA 库存接口默认每秒 2 次,留一点余量;
 * 限流(429)和亚马逊 5xx 按 1s、2s、4s、8s 退避重试。测试会把这两个数调成 0。
 */
export const spApiTiming = { minIntervalMs: 550, retryBaseMs: 1000 };
const MAX_RETRIES = 4;

const clean = (value) => String(value ?? '').trim();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** .env 里配置完整的卖家账号(缺 refresh token 或卖家编号的跳过) */
export function spApiAccounts(env = process.env) {
  const clientId = clean(env.SPAPI_CLIENT_ID);
  const clientSecret = clean(env.SPAPI_CLIENT_SECRET);
  if (!clientId || !clientSecret) return [];
  const suffixes = Object.keys(env)
    .map((key) => /^SPAPI_REFRESH_TOKEN(?:_(\d+))?$/.exec(key))
    .filter(Boolean)
    .map((match) => (match[1] ? Number(match[1]) : 1))
    .sort((a, b) => a - b);
  const accounts = [];
  const names = new Set();
  for (const number of new Set(suffixes)) {
    const suffix = number === 1 ? '' : `_${number}`;
    const refreshToken = clean(env[`SPAPI_REFRESH_TOKEN${suffix}`]);
    const sellerId = clean(env[`SPAPI_SELLER_ID${suffix}`]).toUpperCase();
    if (!refreshToken || !sellerId) continue;
    const region = clean(env[`SPAPI_REGION${suffix}`]).toLowerCase();
    let name = clean(env[`SPAPI_STORE_NAME${suffix}`]) || sellerId;
    // 店铺名拼进店铺组名,重名会把两个卖家的库存混进同一组
    if (names.has(name.toLowerCase())) name = `${name}-${sellerId}`;
    names.add(name.toLowerCase());
    accounts.push({
      sellerId,
      name,
      region: REGION_HOSTS[region] ? region : '',
      refreshToken,
      clientId,
      clientSecret,
    });
  }
  return accounts;
}

/** 同一个卖家编号在不同区域各有一个 refresh token 时,优先用填了对应 SPAPI_REGION 的那个 */
export function findSpApiAccount(sellerId, region) {
  const candidates = spApiAccounts().filter((account) => account.sellerId === sellerId);
  return candidates.find((account) => account.region === region)
    ?? candidates.find((account) => !account.region)
    ?? null;
}

// 亚马逊的 HTTP 状态放在 upstreamStatus,不叫 status:路由会把 error.status 原样回给浏览器
class SpApiError extends Error {
  constructor(message, { status = 0, lwa = false } = {}) {
    super(message);
    this.upstreamStatus = status;
    this.lwa = lwa;
  }
}

function lwaMessage(payload, status) {
  const code = clean(payload?.error);
  if (code === 'invalid_client') return '亚马逊拒绝了 SPAPI_CLIENT_ID / SPAPI_CLIENT_SECRET，请核对开发者应用的 LWA 凭证';
  if (code === 'invalid_grant') return 'Refresh Token 无效或已失效，请在卖家后台重新授权应用后更新 .env';
  const detail = clean(payload?.error_description || code);
  return `亚马逊授权失败 (${status})${detail ? `：${detail}` : ''}`;
}

function spApiMessage(payload, status) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const detail = clean(first?.message || payload?.message);
  if (status === 403) {
    return '亚马逊拒绝访问：请确认开发者应用勾选了「亚马逊物流 (Amazon Fulfillment)」角色，'
      + '并在卖家后台重新授权后更新 Refresh Token' + (detail ? `（${detail}）` : '');
  }
  if (status === 429) return '亚马逊接口限流，请稍后再试';
  return `亚马逊接口请求失败 (${status})${detail ? `：${detail}` : ''}`;
}

const tokenCache = new Map();

async function accessToken(account) {
  const cached = tokenCache.get(account.refreshToken);
  if (cached?.expiresAt > Date.now() + 30_000) return cached.value;
  let response;
  try {
    response = await fetch(LWA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        client_id: account.clientId,
        client_secret: account.clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SpApiError(`连不上亚马逊授权服务器：${clean(error.message) || '网络错误'}`, { lwa: true });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new SpApiError(lwaMessage(payload, response.status), { status: response.status, lwa: true });
  const value = clean(payload?.access_token);
  if (!value) throw new SpApiError('亚马逊授权服务器没有返回 access_token', { lwa: true });
  const expiresIn = Math.max(60, Number(payload.expires_in) || 3600);
  tokenCache.set(account.refreshToken, { value, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
  return value;
}

// 按「卖家 + 区域 + 接口」排队,保证两次请求之间至少隔 minIntervalMs
const nextSlot = new Map();
async function waitTurn(key) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, at + spApiTiming.minIntervalMs);
  await sleep(at - now);
}

/**
 * GET 一个 SP-API 接口,返回解析后的 JSON。
 * access token 过期(401/403)会换一次新 token 重试;429、5xx 和网络错误退避重试。
 */
export async function spApiGet(account, region, path, query = {}) {
  const host = REGION_HOSTS[region];
  if (!host) throw new SpApiError(`未知的亚马逊接口区域：${region}`);
  const url = new URL(`${host}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let refreshedToken = false;
  for (let attempt = 0; ; attempt += 1) {
    const token = await accessToken(account);
    await waitTurn(`${account.sellerId}:${region}:${path}`);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'x-amz-access-token': token,
          'user-agent': 'AD-TOOL/2.0 (Language=JavaScript; Platform=Node.js)',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        await sleep(spApiTiming.retryBaseMs * 2 ** attempt);
        continue;
      }
      throw new SpApiError(`连不上亚马逊接口：${clean(error.message) || '网络错误'}`);
    }
    if ((response.status === 401 || response.status === 403) && !refreshedToken) {
      refreshedToken = true;
      tokenCache.delete(account.refreshToken);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(spApiTiming.retryBaseMs * 2 ** attempt);
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new SpApiError(spApiMessage(payload, response.status), { status: response.status });
    if (!payload || typeof payload !== 'object') throw new SpApiError('亚马逊接口返回了无法识别的数据');
    return payload;
  }
}
