/**
 * 通知服务：保存配置、生成看板 Markdown、签名 webhook、发送消息并记录日志。
 */
import axios from 'axios';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { AuthUser } from '../auth';
import { all, get, logApiCall, run } from '../db';
import { buildDashboardSummary, ScheduleItem } from './dashboardSummary';

export interface NotificationSettings {
  channel: 'dingtalk_robot' | 'feishu_robot';
  enabled: boolean;
  dingtalkEnabled: boolean;
  feishuEnabled: boolean;
  webhookUrl: string;
  secret: string;
  dingtalkWebhookUrl: string;
  dingtalkSecret: string;
  feishuWebhookUrl: string;
  feishuSecret: string;
  keywords: string[];
  scheduledTime: string;
  lastScheduledDate?: string;
}

export interface NotificationUserSettings {
  enabled: boolean;
  scheduledTime: string;
  lastScheduledDate?: string;
}

interface NotificationSettingsRow {
  channel?: string;
  enabled: number;
  dingtalk_enabled?: number | null;
  feishu_enabled?: number | null;
  webhook_url?: string;
  secret?: string;
  feishu_webhook_url?: string;
  feishu_secret?: string;
  keyword_json?: string;
  scheduled_time?: string;
  last_scheduled_date?: string;
}

interface NotificationUserSettingsRow {
  enabled: number;
  scheduled_time?: string;
  last_scheduled_date?: string;
}

const NOTIFICATION_REQUEST_TIMEOUT = Number(process.env.NOTIFICATION_REQUEST_TIMEOUT || 15000);
const NOTIFICATION_REQUEST_RETRIES = Number(process.env.NOTIFICATION_REQUEST_RETRIES || 3);
const notificationHttpAgent = new http.Agent({ family: 4 });
const notificationHttpsAgent = new https.Agent({ family: 4 });

function firstEnvValue(...keys: string[]) {
  return keys.map((key) => process.env[key]).find((value) => String(value || '').trim())?.trim() || '';
}

function envNotificationDefaults() {
  const channel = (firstEnvValue('NOTIFICATION_CHANNEL') || 'dingtalk_robot') as NotificationSettings['channel'];
  const legacyEnabled = firstEnvValue('NOTIFICATION_ENABLED') === 'true';
  const dingtalkEnabled = firstEnvValue('DINGTALK_ROBOT_ENABLED') === 'true';
  const feishuEnabled = firstEnvValue('FEISHU_ROBOT_ENABLED') === 'true';
  return {
    channel,
    enabled: legacyEnabled || dingtalkEnabled || feishuEnabled,
    dingtalkEnabled: dingtalkEnabled || (legacyEnabled && channel === 'dingtalk_robot'),
    feishuEnabled: feishuEnabled || (legacyEnabled && channel === 'feishu_robot'),
    dingtalkWebhookUrl: firstEnvValue('DINGTALK_ROBOT_WEBHOOK_URL', 'NOTIFICATION_WEBHOOK_URL'),
    dingtalkSecret: firstEnvValue('DINGTALK_ROBOT_SECRET', 'NOTIFICATION_SECRET'),
    feishuWebhookUrl: firstEnvValue('FEISHU_ROBOT_WEBHOOK_URL'),
    feishuSecret: firstEnvValue('FEISHU_ROBOT_SECRET'),
    scheduledTime: firstEnvValue('NOTIFICATION_SCHEDULED_TIME', 'DINGTALK_ROBOT_SCHEDULED_TIME') || '09:00'
  };
}

function isTransientNotificationError(error: any) {
  const status = error?.response?.status;
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return [429, 500, 502, 503, 504].includes(status)
    || ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ERR_NETWORK'].includes(code)
    || message.includes('timeout')
    || message.includes('network');
}

// Webhook 发送会重试临时网络/平台故障，但永久错误会立即抛出。
async function withRetry<T>(request: () => Promise<T>, attempts = NOTIFICATION_REQUEST_RETRIES) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isTransientNotificationError(error) || index === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (index + 1)));
    }
  }
  throw lastError;
}

function parseKeywords(value?: string) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeSettings(row?: NotificationSettingsRow): NotificationSettings {
  const envDefaults = envNotificationDefaults();
  const channel = row?.channel === 'feishu_robot' ? 'feishu_robot' : envDefaults.channel === 'feishu_robot' ? 'feishu_robot' : 'dingtalk_robot';
  const dingtalkWebhookUrl = row?.webhook_url || envDefaults.dingtalkWebhookUrl;
  const dingtalkSecret = row?.secret || envDefaults.dingtalkSecret;
  const feishuWebhookUrl = row?.feishu_webhook_url || envDefaults.feishuWebhookUrl;
  const feishuSecret = row?.feishu_secret || envDefaults.feishuSecret;
  const webhookUrl = channel === 'feishu_robot' ? feishuWebhookUrl : dingtalkWebhookUrl;
  const secret = channel === 'feishu_robot' ? feishuSecret : dingtalkSecret;
  const dingtalkEnabled = row?.dingtalk_enabled === null || row?.dingtalk_enabled === undefined
    ? channel === 'dingtalk_robot' || envDefaults.dingtalkEnabled
    : Boolean(row.dingtalk_enabled);
  const feishuEnabled = row?.feishu_enabled === null || row?.feishu_enabled === undefined
    ? channel === 'feishu_robot' || envDefaults.feishuEnabled
    : Boolean(row.feishu_enabled);

  return {
    channel,
    enabled: Boolean(row?.enabled) || envDefaults.enabled,
    dingtalkEnabled,
    feishuEnabled,
    webhookUrl,
    secret,
    dingtalkWebhookUrl,
    dingtalkSecret,
    feishuWebhookUrl,
    feishuSecret,
    keywords: parseKeywords(row?.keyword_json),
    scheduledTime: row?.scheduled_time || envDefaults.scheduledTime,
    lastScheduledDate: row?.last_scheduled_date || ''
  };
}

export async function getNotificationSettings() {
  const row = await get<NotificationSettingsRow>('SELECT * FROM notification_settings WHERE id = 1');
  return normalizeSettings(row);
}

function normalizeUserSettings(row?: NotificationUserSettingsRow): NotificationUserSettings {
  return {
    enabled: Boolean(row?.enabled),
    scheduledTime: row?.scheduled_time || '09:00',
    lastScheduledDate: row?.last_scheduled_date || ''
  };
}

export async function getNotificationUserSettings(userId: number) {
  const row = await get<NotificationUserSettingsRow>('SELECT * FROM notification_user_settings WHERE user_id = ?', [userId]);
  return normalizeUserSettings(row);
}

export async function saveNotificationUserSettings(userId: number, input: NotificationUserSettings) {
  run(
    `INSERT INTO notification_user_settings (user_id, enabled, scheduled_time, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       scheduled_time = excluded.scheduled_time,
       last_scheduled_date = CASE
         WHEN notification_user_settings.enabled <> excluded.enabled
           OR notification_user_settings.scheduled_time <> excluded.scheduled_time
         THEN NULL
         ELSE notification_user_settings.last_scheduled_date
       END,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, input.enabled ? 1 : 0, input.scheduledTime || '09:00']
  );
  return getNotificationUserSettings(userId);
}

export async function saveNotificationSettings(input: NotificationSettings) {
  const existing = await getNotificationSettings();
  const channel = input.feishuEnabled && !input.dingtalkEnabled ? 'feishu_robot' : 'dingtalk_robot';
  const dingtalkWebhookUrl = String(input.dingtalkWebhookUrl || '').trim() || existing.dingtalkWebhookUrl;
  const dingtalkSecret = String(input.dingtalkSecret || '').trim() || existing.dingtalkSecret;
  const feishuWebhookUrl = String(input.feishuWebhookUrl || '').trim() || existing.feishuWebhookUrl;
  const feishuSecret = String(input.feishuSecret || '').trim() || existing.feishuSecret;

  run(
    `INSERT INTO notification_settings (id, channel, enabled, dingtalk_enabled, feishu_enabled, webhook_url, secret, feishu_webhook_url, feishu_secret, keyword_json, scheduled_time, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       channel = excluded.channel,
       enabled = excluded.enabled,
       dingtalk_enabled = excluded.dingtalk_enabled,
       feishu_enabled = excluded.feishu_enabled,
       webhook_url = excluded.webhook_url,
       secret = excluded.secret,
       feishu_webhook_url = excluded.feishu_webhook_url,
       feishu_secret = excluded.feishu_secret,
       keyword_json = excluded.keyword_json,
       scheduled_time = excluded.scheduled_time,
       last_scheduled_date = CASE
         WHEN notification_settings.enabled <> excluded.enabled
           OR notification_settings.dingtalk_enabled <> excluded.dingtalk_enabled
           OR notification_settings.feishu_enabled <> excluded.feishu_enabled
           OR notification_settings.scheduled_time <> excluded.scheduled_time
         THEN NULL
         ELSE notification_settings.last_scheduled_date
       END,
       updated_at = CURRENT_TIMESTAMP`,
    [
      channel,
      input.enabled ? 1 : 0,
      input.dingtalkEnabled ? 1 : 0,
      input.feishuEnabled ? 1 : 0,
      dingtalkWebhookUrl,
      dingtalkSecret,
      feishuWebhookUrl,
      feishuSecret,
      JSON.stringify((input.keywords || []).map((item) => item.trim()).filter(Boolean)),
      input.scheduledTime || '09:00'
    ]
  );
  return getNotificationSettings();
}

function formatShanghaiTime(value?: string) {
  if (!value) return '';
  const isoValue = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function formatNotificationAction(action: string) {
  if (action === 'manual') return '手动推送';
  if (action === 'scheduled') return '自动推送';
  if (action.startsWith('scheduled:user:')) return '个人自动推送';
  if (action === 'test') return '测试消息';
  return action;
}

function normalizeNotificationLogs(logs: any[]) {
  return logs.map((log) => ({
    ...log,
    actionText: formatNotificationAction(String(log.action || '')),
    createdAtText: formatShanghaiTime(log.created_at)
  }));
}

export async function listNotificationLogs(user?: AuthUser) {
  const logs = user?.role === 'admin'
    ? await all('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100')
    : await all('SELECT * FROM notification_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100', [user?.id ?? 0]);
  return normalizeNotificationLogs(logs);
}

function signWebhook(webhookUrl: string, secret: string) {
  if (!secret) return webhookUrl;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(crypto.createHmac('sha256', secret).update(stringToSign).digest('base64'));
  const separator = webhookUrl.includes('?') ? '&' : '?';
  return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${sign}`;
}

function feishuSign(secret: string, timestamp: number) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).digest('base64');
}

function text(value: unknown) {
  const content = String(value || '').trim();
  return content && content !== '-' ? content : '-';
}

function dateText(value: unknown) {
  const content = text(value);
  return content === '-' ? '未填' : content;
}

function itemLine(item: ScheduleItem, index: number) {
  const link = text(item.zentaoLink);
  const name = link.startsWith('http') ? `[${text(item.name)}](${link})` : text(item.name);
  return [
    `${index + 1}. 【${text(item.moduleTitle)}】${name}`,
    `研发：${text(item.developer)}，测试：${text(item.tester)}，产品：${text(item.productOwner)}`,
    `计划提测：${dateText(item.plannedTestAt)}，实际提测：${dateText(item.actualTestAt)}，上线：${dateText(item.launchAt)}`
  ].join('\n   ');
}

// 把看板摘要格式化为钉钉 Markdown，用紧凑分区支持每日查看。
export function buildDashboardMarkdown(summary: Awaited<ReturnType<typeof buildDashboardSummary>>) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const developingItems = summary.inProgress.developingItems as ScheduleItem[];
  const testingItems = summary.inProgress.testingItems as ScheduleItem[];
  const developingText = developingItems.length
    ? developingItems.map(itemLine).join('\n\n')
    : '暂无开发中任务';
  const testingText = testingItems.length
    ? testingItems.map(itemLine).join('\n\n')
    : '暂无测试中任务';
  return {
    title: `任务管理系统进行中汇总 ${now}`,
    text: [
      `## 任务管理系统进行中汇总`,
      `时间：${now}`,
      '',
      `### 总览`,
      `- 开发中：${developingItems.length}`,
      `- 测试中：${testingItems.length}`,
      '',
      `### 开发中汇总`,
      developingText,
      '',
      `### 测试中汇总`,
      testingText
    ].join('\n')
  };
}

function withKeywords(markdown: string, keywords: string[]) {
  const uniqueKeywords = Array.from(new Set((keywords || []).map((item) => String(item || '').trim()).filter(Boolean)));
  if (!uniqueKeywords.length) return markdown;
  return [`关键词：${uniqueKeywords.join('、')}`, '', markdown].join('\n');
}

// 配置密钥时先应用钉钉机器人签名，再发送 Markdown 载荷。
async function sendDingTalkMarkdown(settings: NotificationSettings, title: string, markdown: string) {
  if (!settings.webhookUrl) throw new Error('请先配置钉钉机器人 Webhook');
  const url = signWebhook(settings.webhookUrl, settings.secret);
  const startedAt = Date.now();
  let data: any;
  try {
    const response = await withRetry(() =>
      axios.post(url, {
        msgtype: 'markdown',
        markdown: { title, text: withKeywords(markdown, settings.keywords) }
      }, {
        timeout: NOTIFICATION_REQUEST_TIMEOUT,
        httpAgent: notificationHttpAgent,
        httpsAgent: notificationHttpsAgent
      })
    );
    data = response.data;
    logApiCall({
      platform: 'dingtalk',
      capability: 'robot.webhook',
      path: 'robot.webhook',
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      success: !data?.errcode
    });
  } catch (error: any) {
    logApiCall({
      platform: 'dingtalk',
      capability: 'robot.webhook',
      path: 'robot.webhook',
      statusCode: error?.response?.status,
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: String(error?.response?.data?.errcode || error?.code || error?.message || 'unknown').slice(0, 120)
    });
    throw error;
  }
  if (data?.errcode && data.errcode !== 0) {
    throw new Error(data.errmsg || `钉钉机器人返回错误：${data.errcode}`);
  }
  return data;
}

async function sendFeishuMarkdown(settings: NotificationSettings, title: string, markdown: string) {
  if (!settings.webhookUrl) throw new Error('请先配置飞书机器人 Webhook');
  const timestamp = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();
  const content = withKeywords([title, '', markdown].join('\n'), settings.keywords);
  let data: any;
  try {
    const response = await withRetry(() =>
      axios.post(settings.webhookUrl, {
        msg_type: 'text',
        content: { text: content },
        ...(settings.secret ? { timestamp: String(timestamp), sign: feishuSign(settings.secret, timestamp) } : {})
      }, {
        timeout: NOTIFICATION_REQUEST_TIMEOUT,
        httpAgent: notificationHttpAgent,
        httpsAgent: notificationHttpsAgent
      })
    );
    data = response.data;
    logApiCall({
      platform: 'feishu',
      capability: 'robot.webhook',
      path: 'robot.webhook',
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      success: !data?.code
    });
  } catch (error: any) {
    logApiCall({
      platform: 'feishu',
      capability: 'robot.webhook',
      path: 'robot.webhook',
      statusCode: error?.response?.status,
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: String(error?.response?.data?.code || error?.code || error?.message || 'unknown').slice(0, 120)
    });
    throw error;
  }
  if (data?.code && data.code !== 0) {
    if (data.code === 19024) {
      throw new Error('飞书机器人关键词校验未通过，请确认消息关键词包含在飞书机器人安全设置中');
    }
    throw new Error(data.msg || `飞书机器人返回错误：${data.code}`);
  }
  return data;
}

async function sendRobotMarkdown(settings: NotificationSettings, title: string, markdown: string) {
  if (settings.channel === 'feishu_robot') return sendFeishuMarkdown(settings, title, markdown);
  return sendDingTalkMarkdown(settings, title, markdown);
}

export function notificationChannelForUser(user: Pick<AuthUser, 'platform'>): NotificationSettings['channel'] {
  return user.platform === 'feishu' ? 'feishu_robot' : 'dingtalk_robot';
}

function isChannelEnabled(settings: NotificationSettings, channel: NotificationSettings['channel']) {
  return channel === 'feishu_robot' ? settings.feishuEnabled : settings.dingtalkEnabled;
}

function enabledNotificationChannels(settings: NotificationSettings, channel?: NotificationSettings['channel']) {
  if (channel) return isChannelEnabled(settings, channel) ? [channel] : [];
  return [
    settings.dingtalkEnabled ? 'dingtalk_robot' : '',
    settings.feishuEnabled ? 'feishu_robot' : ''
  ].filter(Boolean) as NotificationSettings['channel'][];
}

function channelLabel(channel: NotificationSettings['channel']) {
  return channel === 'feishu_robot' ? '飞书' : '钉钉';
}

function noEnabledChannelMessage(channel?: NotificationSettings['channel']) {
  return channel ? `请先启用${channelLabel(channel)}机器人推送` : '请先启用至少一个消息机器人';
}

function withNotificationChannel(settings: NotificationSettings, channel?: NotificationSettings['channel']): NotificationSettings {
  if (!channel || channel === settings.channel) return settings;
  return {
    ...settings,
    channel,
    webhookUrl: channel === 'feishu_robot' ? settings.feishuWebhookUrl : settings.dingtalkWebhookUrl,
    secret: channel === 'feishu_robot' ? settings.feishuSecret : settings.dingtalkSecret
  };
}

function logNotification(settings: NotificationSettings, action: string, status: 'success' | 'failed', message: string, payload?: unknown, user?: AuthUser) {
  run('INSERT INTO notification_logs (channel, action, status, user_id, user_display_name, message, payload) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    settings.channel,
    action,
    status,
    user?.id ?? null,
    user?.displayName || user?.username || null,
    message,
    payload ? JSON.stringify(payload) : null
  ]);
}

export async function sendTestNotification(user?: AuthUser, channel?: NotificationSettings['channel']) {
  const baseSettings = await getNotificationSettings();
  const channels = enabledNotificationChannels(baseSettings, channel);
  if (!channels.length) throw new Error(noEnabledChannelMessage(channel));
  const results = [];
  for (const item of channels) {
    const settings = withNotificationChannel(baseSettings, item);
    try {
      const result = await sendRobotMarkdown(settings, '任务管理系统测试消息', `## 任务管理系统测试消息\n${settings.channel === 'feishu_robot' ? '飞书' : '钉钉'}机器人配置成功。`);
      logNotification(settings, 'test', 'success', '测试消息发送成功', result, user);
      results.push({ channel: settings.channel, status: 'success', result });
    } catch (error: any) {
      const message = error.message || '测试消息发送失败';
      logNotification(settings, 'test', 'failed', message, undefined, user);
      results.push({ channel: settings.channel, status: 'failed', message });
    }
  }
  if (results.every((item) => item.status === 'failed')) {
    throw new Error(results.map((item) => `${item.channel}: ${item.message || '发送失败'}`).join('；'));
  }
  return { results };
}

export async function pushDashboardNotification(user: AuthUser, action = 'manual', channel?: NotificationSettings['channel']) {
  const baseSettings = await getNotificationSettings();
  const channels = enabledNotificationChannels(baseSettings, channel);
  if (!channels.length) throw new Error(noEnabledChannelMessage(channel));
  const summary = await buildDashboardSummary(user);
  const message = buildDashboardMarkdown(summary);
  const payload = {
    developing: summary.inProgress.developing,
    testing: summary.inProgress.testing
  };
  const results = [];
  for (const item of channels) {
    const settings = withNotificationChannel(baseSettings, item);
    try {
      const result = await sendRobotMarkdown(settings, message.title, message.text);
      logNotification(settings, action, 'success', '汇总消息发送成功', payload, user);
      results.push({ channel: settings.channel, status: 'success', result });
    } catch (error: any) {
      const errorMessage = error.message || '汇总消息发送失败';
      logNotification(settings, action, 'failed', errorMessage, undefined, user);
      results.push({ channel: settings.channel, status: 'failed', message: errorMessage });
    }
  }
  if (results.every((item) => item.status === 'failed')) {
    throw new Error(results.map((item) => `${item.channel}: ${item.message || '发送失败'}`).join('；'));
  }
  return {
    results,
    summary: payload
  };
}

export async function markScheduledSent(date: string) {
  run('UPDATE notification_settings SET last_scheduled_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [date]);
}

export async function markUserScheduledSent(userId: number, date: string) {
  run('UPDATE notification_user_settings SET last_scheduled_date = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [
    date,
    userId
  ]);
}
