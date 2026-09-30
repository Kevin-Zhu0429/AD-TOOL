// 亚马逊 SP-API 客户端:用 refresh token 换 access token、按区域选接口地址、限速和重试。
// 凭证只放环境变量,按品牌编号配置(BRAND1_…、BRAND2_…),每个品牌有自己的开发者应用,
// 欧洲 / 北美 / 澳洲账号各一套 Refresh Token 和卖家编号,写法见 server/.env.example。
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

/**
 * 一个品牌下可以配的卖家账号,各管各的站点,互不重叠。region 决定走哪个接口地址:
 * AE 是单独的卖家账号,但亚马逊把它的接口放在欧洲区;AU 在亚马逊的远东区(FE),
 * 变量后缀写 _AU 或 _FE 都认。每组后缀的第一个是文档里写的。
 */
const ACCOUNT_SLOTS = [
  { slot: 'eu', label: '欧洲', region: 'eu', suffixes: ['EU'], markets: ['ES', 'DE', 'FR', 'IT', 'UK'] },
  { slot: 'na', label: '北美', region: 'na', suffixes: ['NA'], markets: ['US', 'CA'] },
  { slot: 'ae', label: '中东', region: 'eu', suffixes: ['AE'], markets: ['AE'] },
  { slot: 'au', label: '澳洲', region: 'fe', suffixes: ['AU', 'FE'], markets: ['AU'] },
];
export const SLOT_LABELS = Object.fromEntries(ACCOUNT_SLOTS.map((item) => [item.slot, item.label]));
const slotOfMarket = (market) => ACCOUNT_SLOTS.find((def) => def.markets.includes(market));
const KNOWN_BRAND_KEYS = new Set(['NAME', 'MARKETS', 'LWA_CLIENT_ID', 'LWA_CLIENT_SECRET',
  ...ACCOUNT_SLOTS.flatMap((item) => item.suffixes).flatMap((suffix) => [`LWA_REFRESH_TOKEN_${suffix}`, `SELLER_ID_${suffix}`])]);

/** 市场列表:逗号、空格都能分隔,GB 当 UK */
function parseMarkets(value) {
  return [...new Set(clean(value).toUpperCase().split(/[\s,，、;；]+/).filter(Boolean)
    .map((market) => (market === 'GB' ? 'UK' : market)))];
}

/**
 * 读 .env 里的品牌配置。
 *   BRAND<n>_NAME                     品牌名,要和 SKU 库里的品牌一致(如 CC)
 *   BRAND<n>_MARKETS                  读取店铺时列出哪些站点,如 ES,DE,FR,IT,UK,US,CA;不填 = 全部
 *   BRAND<n>_LWA_CLIENT_ID / _SECRET  这个品牌开发者应用的 LWA 凭证
 *   BRAND<n>_LWA_REFRESH_TOKEN_<EU|NA|AE|AU> + BRAND<n>_SELLER_ID_<EU|NA|AE|AU>  各账号的授权
 * 每组后缀是一个卖家账号。填得不完整的不猜,原因放进 issues 给超级管理员看。
 */
export function readSpApiConfig(env = process.env) {
  const numbers = [...new Set(Object.keys(env)
    .map((key) => /^BRAND(\d+)_/.exec(key)?.[1])
    .filter(Boolean)
    .map(Number))].sort((a, b) => a - b);
  const brands = [];
  const accounts = [];
  const issues = [];
  const names = new Set();
  for (const number of numbers) {
    const prefix = `BRAND${number}_`;
    const read = (key) => clean(env[prefix + key]);
    const name = read('NAME');
    const label = name || `BRAND${number}`;
    if (!name) {
      issues.push(`${prefix}NAME 没有填，BRAND${number} 的配置先不用`);
      continue;
    }
    if (names.has(name.toLowerCase())) {
      issues.push(`${prefix}NAME 和前面的品牌重名（${name}），BRAND${number} 的配置先不用`);
      continue;
    }
    names.add(name.toLowerCase());

    // 写错的变量名(比如按国家写成 _US、_UK)不会被读到,点名提示而不是悄悄忽略
    const unknownKeys = Object.keys(env)
      .filter((key) => key.startsWith(prefix) && !KNOWN_BRAND_KEYS.has(key.slice(prefix.length)));
    if (unknownKeys.length) {
      issues.push(`${label} 的 ${unknownKeys.join('、')} 不认识，已忽略（账号后缀只能是 EU / NA / AE / AU）`);
    }

    const clientId = read('LWA_CLIENT_ID');
    const clientSecret = read('LWA_CLIENT_SECRET');
    const missingApp = [!clientId && `${prefix}LWA_CLIENT_ID`, !clientSecret && `${prefix}LWA_CLIENT_SECRET`].filter(Boolean);
    if (missingApp.length) {
      issues.push(`${label} 缺少 ${missingApp.join('、')}`);
      continue;
    }

    const requested = parseMarkets(read('MARKETS'));
    const unknown = requested.filter((market) => !AMAZON_MARKETPLACES[market]);
    if (unknown.length) issues.push(`${label} 的 ${prefix}MARKETS 里 ${unknown.join('、')} 网站不支持，已忽略`);
    const markets = requested.filter((market) => AMAZON_MARKETPLACES[market]);

    const filled = [];
    let incomplete = false;
    for (const def of ACCOUNT_SLOTS) {
      const pick = (key) => def.suffixes.map((item) => read(`${key}_${item}`)).find(Boolean) ?? '';
      const refreshToken = pick('LWA_REFRESH_TOKEN');
      const sellerId = pick('SELLER_ID').toUpperCase();
      // 提示缺哪个变量时沿用用户已经在用的后缀
      const suffix = def.suffixes.find((item) => read(`LWA_REFRESH_TOKEN_${item}`) || read(`SELLER_ID_${item}`))
        ?? def.suffixes[0];
      if (!refreshToken && !sellerId) continue;
      if (!refreshToken || !sellerId) {
        const missing = refreshToken ? `${prefix}SELLER_ID_${suffix}` : `${prefix}LWA_REFRESH_TOKEN_${suffix}`;
        issues.push(`${label} ${def.label}账号缺少 ${missing}`);
        incomplete = true;
        continue;
      }
      filled.push({ def, refreshToken, sellerId });
    }
    if (!filled.length) {
      if (!incomplete) issues.push(`${label} 还没有填任何账号的 Refresh Token 和卖家编号`);
      continue;
    }

    const brandAccounts = [];
    for (const item of filled) {
      const accountMarkets = markets.length
        ? item.def.markets.filter((market) => markets.includes(market))
        : item.def.markets;
      if (markets.length && !accountMarkets.length) {
        issues.push(`${label} 填了${item.def.label}账号，但 ${prefix}MARKETS 里没有它管的站点，这个账号不会读取`);
      }
      brandAccounts.push({
        brand: name, slot: item.def.slot, region: item.def.region, sellerId: item.sellerId,
        refreshToken: item.refreshToken, clientId, clientSecret,
        markets: accountMarkets,
        allMarkets: !markets.length,
      });
    }

    const uncovered = markets.filter((market) => !filled.some((item) => item.def === slotOfMarket(market)));
    if (uncovered.length) {
      const slots = [...new Set(uncovered.map(slotOfMarket))];
      const needed = slots.map((def) => (
        `${prefix}LWA_REFRESH_TOKEN_${def.suffixes[0]} 和 ${prefix}SELLER_ID_${def.suffixes[0]}`
      )).join('；');
      issues.push(`${label} 的 ${uncovered.join('、')} 没有对应的${slots.map((def) => def.label).join('、')}账号授权`
        + `（要填 ${needed}），读取店铺时会跳过`);
    }
    brands.push({ name, markets, accounts: brandAccounts.map(({ slot, sellerId }) => ({ slot, sellerId })) });
    accounts.push(...brandAccounts);
  }
  return { brands, accounts, issues };
}

/** 配置完整的卖家账号 */
export function spApiAccounts(env = process.env) {
  return readSpApiConfig(env).accounts;
}

/** 同步时按店铺编号里的卖家和站点找回账号;MARKETS 后来删了这个站点也照样能找到 */
export function findSpApiAccount(sellerId, country) {
  const region = AMAZON_MARKETPLACES[country]?.region;
  const candidates = spApiAccounts().filter((account) => account.sellerId === sellerId && account.region === region);
  return candidates.find((account) => account.markets.includes(country)) ?? candidates[0] ?? null;
}

// 亚马逊的 HTTP 状态放在 upstreamStatus,不叫 status:路由会把 error.status 原样回给浏览器
class SpApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.upstreamStatus = status;
  }
}

function lwaMessage(payload, status) {
  const code = clean(payload?.error);
  if (code === 'invalid_client') return '亚马逊拒绝了 LWA Client ID / Client Secret，请核对这个品牌开发者应用的凭证';
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
    throw new SpApiError(`连不上亚马逊授权服务器：${clean(error.message) || '网络错误'}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new SpApiError(lwaMessage(payload, response.status), response.status);
  const value = clean(payload?.access_token);
  if (!value) throw new SpApiError('亚马逊授权服务器没有返回 access_token');
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
    if (!response.ok) throw new SpApiError(spApiMessage(payload, response.status), response.status);
    if (!payload || typeof payload !== 'object') throw new SpApiError('亚马逊接口返回了无法识别的数据');
    return payload;
  }
}
