// 宠物版亚马逊广告 API(Sponsored Products v3)写入:改状态、竞价、预算,加否定。
// 广告 API 还没批下来时不配置也没关系:待确认改动页会把确认过的广告改动生成批量表,人工上传。
// 凭证只放环境变量:
//   PET_ADS_REFRESH_TOKEN  广告 API 授权后拿到的 refresh token(必填)
//   PET_ADS_PROFILE_ID     美国站广告账户的 profile ID(必填)
//   PET_ADS_CLIENT_ID / PET_ADS_CLIENT_SECRET  广告 API 用的 LWA 应用;和 SP-API 是同一个应用时可以不填,沿用 PET_SP_LWA_*
import { accessToken } from './spApi.js';

const ADS_HOST = 'https://advertising-api.amazon.com';
const clean = (value) => String(value ?? '').trim();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
export const adsTiming = { retryBaseMs: 1000 };
const MAX_RETRIES = 4;

export function petAdsConfig(env = process.env) {
  const read = (key) => clean(env[key]);
  const refreshToken = read('PET_ADS_REFRESH_TOKEN');
  const profileId = read('PET_ADS_PROFILE_ID');
  const clientId = read('PET_ADS_CLIENT_ID') || read('PET_SP_LWA_CLIENT_ID');
  const clientSecret = read('PET_ADS_CLIENT_SECRET') || read('PET_SP_LWA_CLIENT_SECRET');
  if (!refreshToken && !profileId) return { account: null, issues: [] };
  const missing = [!refreshToken && 'PET_ADS_REFRESH_TOKEN', !profileId && 'PET_ADS_PROFILE_ID',
    !clientId && 'PET_ADS_CLIENT_ID', !clientSecret && 'PET_ADS_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) return { account: null, issues: [`亚马逊广告 API 配置缺少 ${missing.join('、')}`] };
  if (!/^\d+$/.test(profileId)) return { account: null, issues: ['PET_ADS_PROFILE_ID 应该是一串数字'] };
  return { account: { refreshToken, profileId, clientId, clientSecret }, issues: [] };
}

class AdsApiError extends Error {}

/** 广告 API 的错误信息藏在不同层级,统一找第一个 message / details */
function firstMessage(value) {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['message', 'details', 'description']) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  for (const child of Object.values(value)) {
    const found = firstMessage(child);
    if (found) return found;
  }
  return '';
}

async function adsRequest(account, method, path, body, mediaType) {
  for (let attempt = 0; ; attempt += 1) {
    const token = await accessToken(account);
    let response;
    try {
      response = await fetch(`${ADS_HOST}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'Amazon-Advertising-API-ClientId': account.clientId,
          'Amazon-Advertising-API-Scope': account.profileId, 'content-type': mediaType, accept: mediaType },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt < MAX_RETRIES) { await sleep(adsTiming.retryBaseMs * 2 ** attempt); continue; }
      throw new AdsApiError(`连不上亚马逊广告接口：${clean(error.message) || '网络错误'}`);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(adsTiming.retryBaseMs * 2 ** attempt);
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      throw new AdsApiError(`亚马逊广告接口拒绝访问 (${response.status})：请确认广告 API 已开通、PET_ADS_PROFILE_ID 是美国站的广告账户${firstMessage(payload) ? `（${firstMessage(payload)}）` : ''}`);
    }
    if (!response.ok) throw new AdsApiError(`亚马逊广告接口请求失败 (${response.status})${firstMessage(payload) ? `：${firstMessage(payload)}` : ''}`);
    return payload ?? {};
  }
}

export const adsGateway = { request: adsRequest };

// 每种实体对应的 v3 接口:路径、媒体类型、请求体里的列表名、编号字段
const ENTITY_API = {
  campaign: { path: '/sp/campaigns', media: 'application/vnd.spCampaign.v3+json', list: 'campaigns', id: 'campaignId' },
  adGroup: { path: '/sp/adGroups', media: 'application/vnd.spAdGroup.v3+json', list: 'adGroups', id: 'adGroupId' },
  keyword: { path: '/sp/keywords', media: 'application/vnd.spKeyword.v3+json', list: 'keywords', id: 'keywordId' },
  productTarget: { path: '/sp/targets', media: 'application/vnd.spTargetingClause.v3+json', list: 'targetingClauses', id: 'targetId' },
  productAd: { path: '/sp/productAds', media: 'application/vnd.spProductAd.v3+json', list: 'productAds', id: 'adId' },
};
const NEGATIVE_API = {
  adGroupKeyword: { path: '/sp/negativeKeywords', media: 'application/vnd.spNegativeKeyword.v3+json', list: 'negativeKeywords' },
  campaignKeyword: { path: '/sp/campaignNegativeKeywords', media: 'application/vnd.spCampaignNegativeKeyword.v3+json', list: 'campaignNegativeKeywords' },
  asin: { path: '/sp/negativeTargets', media: 'application/vnd.spNegativeTargetingClause.v3+json', list: 'negativeTargetingClauses' },
};

/** 一条改动 -> 广告 API 请求 { method, path, media, body, list } */
export function adsRequestFor(kind, target, after) {
  if (kind === 'ad_negative') {
    const api = after.matchType === 'asin' ? NEGATIVE_API.asin : target.level === 'campaign' ? NEGATIVE_API.campaignKeyword : NEGATIVE_API.adGroupKeyword;
    const match = after.matchType === 'exact' ? 'NEGATIVE_EXACT' : 'NEGATIVE_PHRASE';
    const item = after.matchType === 'asin'
      ? { campaignId: target.campaignId, adGroupId: target.adGroupId, expression: [{ type: 'ASIN_SAME_AS', value: after.text }], state: 'ENABLED' }
      : target.level === 'campaign'
        ? { campaignId: target.campaignId, keywordText: after.text, matchType: match, state: 'ENABLED' }
        : { campaignId: target.campaignId, adGroupId: target.adGroupId, keywordText: after.text, matchType: match, state: 'ENABLED' };
    return { method: 'POST', path: api.path, media: api.media, list: api.list, body: { [api.list]: [item] } };
  }
  const api = ENTITY_API[target.entity];
  if (!api) throw new Error(`不认识的广告实体：${target.entity}`);
  const item = { [api.id]: target.entityId };
  if (kind === 'ad_state') item.state = after.state === 'paused' ? 'PAUSED' : 'ENABLED';
  else if (kind === 'ad_bid') item[target.entity === 'adGroup' ? 'defaultBid' : 'bid'] = after.bid;
  else if (kind === 'ad_budget') item.budget = { budget: after.budget, budgetType: 'DAILY' };
  else throw new Error(`不认识的广告改动：${kind}`);
  return { method: 'PUT', path: api.path, media: api.media, list: api.list, body: { [api.list]: [item] } };
}

/** 执行一条广告改动。成功返回亚马逊给的编号,失败抛出带原因的错误 */
export async function executeAdChange(account, { kind, target, after }, gateway = adsGateway) {
  const call = adsRequestFor(kind, target, after);
  const payload = await gateway.request(account, call.method, call.path, call.body, call.media);
  const result = payload?.[call.list] ?? {};
  const error = (result.error ?? [])[0];
  if (error) throw new AdsApiError(`亚马逊广告接口拒绝了这条改动：${firstMessage(error) || JSON.stringify(error).slice(0, 300)}`);
  const success = (result.success ?? [])[0];
  if (!success) throw new AdsApiError('亚马逊广告接口没有返回结果，请到广告后台核对');
  const { index: _index, ...ids } = success;
  return { request: { method: call.method, path: call.path }, response: ids };
}
