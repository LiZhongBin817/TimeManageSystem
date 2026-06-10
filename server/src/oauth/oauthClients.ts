import axios from 'axios';
import http from 'http';
import https from 'https';
import { DataSourceInstance } from '../config/configStore';
import { IdentityProvider } from '../db';

const OAUTH_REQUEST_TIMEOUT = Number(process.env.OAUTH_REQUEST_TIMEOUT || 20000);
const oauthHttpAgent = new http.Agent({ family: 4 });
const oauthHttpsAgent = new https.Agent({ family: 4 });

interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

async function fetchJson(url: string, options: FetchJsonOptions = {}) {
  const startedAt = Date.now();
  try {
    const response = await axios.request({
      url,
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      data: options.body,
      timeout: OAUTH_REQUEST_TIMEOUT,
      httpAgent: oauthHttpAgent,
      httpsAgent: oauthHttpsAgent,
      validateStatus: () => true
    });
    console.log(`[oauth] ${options.method || 'GET'} ${url} -> ${response.status} in ${Date.now() - startedAt}ms`);
    if (response.status < 200 || response.status >= 300) {
      const data = response.data || {};
      const httpError = new Error(data?.message || data?.msg || response.statusText || 'OAuth request failed') as Error & {
        response?: { status: number; data: unknown };
      };
      httpError.response = { status: response.status, data };
      throw httpError;
    }
    return { data: response.data };
  } catch (error: any) {
    console.warn(`[oauth] ${options.method || 'GET'} ${url} failed in ${Date.now() - startedAt}ms: ${error?.code || error?.name || ''} ${error?.response?.status || ''} ${error?.message || error}`);
    if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) {
      const timeoutError = new Error('DingTalk/Feishu OAuth request timed out. Please retry later or check server network.') as Error & {
        code?: string;
        response?: unknown;
      };
      timeoutError.code = 'ECONNABORTED';
      timeoutError.response = error.response;
      throw timeoutError;
    }
    if (error?.message === 'fetch failed' || error?.name === 'TypeError') error.code = error.code || 'ERR_NETWORK';
    throw error;
  }
}
function isTransientOAuthError(error: any) {
  const status = error?.response?.status;
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return [429, 500, 502, 503, 504].includes(status)
    || ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET'].includes(code)
    || message.includes('timeout')
    || message.includes('network');
}

async function fetchJsonWithRetry(label: string, url: string, options: FetchJsonOptions = {}, attempts = 3) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (!isTransientOAuthError(error) || index === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 700 * (index + 1)));
    }
  }
  throw oauthError(label, lastError);
}

export interface OAuthIdentity {
  providerUserId: string;
  unionId?: string;
  openId?: string;
  name?: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  raw?: unknown;
}

function requireConfig(value: string | undefined, label: string) {
  if (!value) throw new Error(`缺少 OAuth 配置：${label}`);
  return value;
}

function oauthError(label: string, error: unknown) {
  if (axios.isAxiosError(error) || (error as any)?.response) {
    const status = (error as any).response?.status;
    const data = (error as any).response?.data;
    const message =
      data?.message ||
      data?.msg ||
      data?.error_description ||
      data?.error ||
      (error as any).message;
    const detail = typeof data === 'string' ? data : JSON.stringify(data || {});
    const timeoutMessage = (error as any).code === 'ETIMEDOUT' || (error as any).code === 'ECONNABORTED'
      ? '请求钉钉/飞书开放平台超时，请稍后重试或检查服务器网络'
      : message;
    return new Error(`${label}失败${status ? `（${status}）` : ''}：${timeoutMessage}${detail && detail !== '{}' ? `；${detail}` : ''}`);
  }
  return error instanceof Error ? error : new Error(`${label}失败`);
}

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_BASE_URL || 'http://localhost:4000';
}

export function callbackUri(provider: IdentityProvider, dataSource: DataSourceInstance) {
  return dataSource.config.redirectUri || `${publicBaseUrl()}/api/auth/oauth/${provider}/callback`;
}

export function frontendCallbackUrl(token: string) {
  const base = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
  return `${base}/oauth/callback?token=${encodeURIComponent(token)}`;
}

export function frontendLoginErrorUrl(message: string) {
  const base = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
  return `${base}/login?force=1&oauthError=${encodeURIComponent(message)}`;
}

export function authUrl(provider: IdentityProvider, dataSource: DataSourceInstance, redirectUri: string, state: string) {
  if (provider === 'dingtalk') {
    const appKey = requireConfig(dataSource.config.appKey, '钉钉 AppKey');
    const url = new URL('https://login.dingtalk.com/oauth2/auth');
    url.searchParams.set('client_id', appKey);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'consent');
    const corpId = dataSource.config.corpId || dataSource.config.realmCorpId;
    if (corpId) {
      url.searchParams.set('scope', 'openid corpid Contact.User.Read');
      url.searchParams.set('corpId', corpId);
      url.searchParams.set('realmCorpId', corpId);
    } else {
      url.searchParams.set('scope', 'openid Contact.User.Read');
    }
    return url.toString();
  }

  const appId = requireConfig(dataSource.config.appId, '飞书 AppId');
  const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  url.searchParams.set('app_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function fetchOAuthIdentity(provider: IdentityProvider, dataSource: DataSourceInstance, code: string): Promise<OAuthIdentity> {
  if (provider === 'dingtalk') return fetchDingTalkIdentity(dataSource, code);
  return fetchFeishuIdentity(dataSource, code);
}

async function fetchDingTalkIdentity(dataSource: DataSourceInstance, code: string): Promise<OAuthIdentity> {
  const appKey = requireConfig(dataSource.config.appKey, '钉钉 AppKey');
  const appSecret = requireConfig(dataSource.config.appSecret, '钉钉 AppSecret');
  const baseUrl = dataSource.config.baseUrl || 'https://api.dingtalk.com';

  const tokenResponse = await fetchJsonWithRetry('DingTalk user token', `${baseUrl}/v1.0/oauth2/userAccessToken`, {
    method: 'POST',
    body: {
      clientId: appKey,
      clientSecret: appSecret,
      code,
      grantType: 'authorization_code'
    }
  }).catch((error) => {
    throw oauthError('钉钉授权码换取用户 token', error);
  });
  const userAccessToken = tokenResponse.data?.accessToken;
  if (!userAccessToken) throw new Error('钉钉用户 accessToken 获取失败');

  const userResponse = await fetchJsonWithRetry('DingTalk current user', `${baseUrl}/v1.0/contact/users/me`, {
    headers: { 'x-acs-dingtalk-access-token': userAccessToken }
  }).catch((error) => {
    throw oauthError('钉钉获取当前用户信息', error);
  });
  const user = userResponse.data || {};
  const providerUserId = user.unionId || user.openId || user.userId;
  if (!providerUserId) throw new Error('钉钉未返回可识别的用户 ID');

  return {
    providerUserId,
    unionId: user.unionId,
    openId: user.openId,
    name: user.nick || user.name,
    avatar: user.avatarUrl,
    mobile: user.mobile,
    email: user.email,
    raw: user
  };
}

async function fetchFeishuIdentity(dataSource: DataSourceInstance, code: string): Promise<OAuthIdentity> {
  const appId = requireConfig(dataSource.config.appId, '飞书 AppId');
  const appSecret = requireConfig(dataSource.config.appSecret, '飞书 AppSecret');
  const baseUrl = dataSource.config.baseUrl || 'https://open.feishu.cn';

  const appTokenResponse = await fetchJson(`${baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    body: {
      app_id: appId,
      app_secret: appSecret
    }
  }).catch((error) => {
    throw oauthError('飞书获取 app_access_token', error);
  });
  const appAccessToken = appTokenResponse.data?.app_access_token;
  if (!appAccessToken) throw new Error(appTokenResponse.data?.msg || '飞书 app_access_token 获取失败');

  const tokenResponse = await fetchJson(`${baseUrl}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appAccessToken}` },
    body: {
      grant_type: 'authorization_code',
      code
    }
  }).catch((error) => {
    throw oauthError('飞书授权码换取用户 token', error);
  });
  const userAccessToken = tokenResponse.data?.data?.access_token || tokenResponse.data?.access_token;
  if (!userAccessToken) throw new Error(tokenResponse.data?.msg || '飞书用户 access_token 获取失败');

  const userResponse = await fetchJson(`${baseUrl}/open-apis/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userAccessToken}` }
  }).catch((error) => {
    throw oauthError('飞书获取当前用户信息', error);
  });
  const user = userResponse.data?.data || userResponse.data || {};
  const providerUserId = user.union_id || user.open_id || user.user_id;
  if (!providerUserId) throw new Error('飞书未返回可识别的用户 ID');

  return {
    providerUserId,
    unionId: user.union_id,
    openId: user.open_id,
    name: user.name || user.en_name,
    avatar: user.avatar_url || user.avatar_thumb,
    mobile: user.mobile,
    email: user.email,
    raw: user
  };
}
