import axios from 'axios';
import crypto from 'crypto';
import { AuthUser } from '../auth';
import { all, get, run } from '../db';
import { buildDashboardSummary, ScheduleItem } from './dashboardSummary';

export interface NotificationSettings {
  enabled: boolean;
  webhookUrl: string;
  secret: string;
  keywords: string[];
  scheduledTime: string;
  lastScheduledDate?: string;
}

interface NotificationSettingsRow {
  enabled: number;
  webhook_url?: string;
  secret?: string;
  keyword_json?: string;
  scheduled_time?: string;
  last_scheduled_date?: string;
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
  return {
    enabled: Boolean(row?.enabled),
    webhookUrl: row?.webhook_url || '',
    secret: row?.secret || '',
    keywords: parseKeywords(row?.keyword_json),
    scheduledTime: row?.scheduled_time || '09:00',
    lastScheduledDate: row?.last_scheduled_date || ''
  };
}

export async function getNotificationSettings() {
  const row = await get<NotificationSettingsRow>('SELECT * FROM notification_settings WHERE id = 1');
  return normalizeSettings(row);
}

export async function saveNotificationSettings(input: NotificationSettings) {
  run(
    `INSERT INTO notification_settings (id, channel, enabled, webhook_url, secret, keyword_json, scheduled_time, updated_at)
     VALUES (1, 'dingtalk_robot', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       webhook_url = excluded.webhook_url,
       secret = excluded.secret,
       keyword_json = excluded.keyword_json,
       scheduled_time = excluded.scheduled_time,
       updated_at = CURRENT_TIMESTAMP`,
    [
      input.enabled ? 1 : 0,
      input.webhookUrl || '',
      input.secret || '',
      JSON.stringify((input.keywords || []).map((item) => item.trim()).filter(Boolean)),
      input.scheduledTime || '09:00'
    ]
  );
  return getNotificationSettings();
}

export async function listNotificationLogs() {
  return all('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 100');
}

function signWebhook(webhookUrl: string, secret: string) {
  if (!secret) return webhookUrl;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(crypto.createHmac('sha256', secret).update(stringToSign).digest('base64'));
  const separator = webhookUrl.includes('?') ? '&' : '?';
  return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${sign}`;
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

async function sendDingTalkMarkdown(settings: NotificationSettings, title: string, markdown: string) {
  if (!settings.webhookUrl) throw new Error('请先配置钉钉机器人 Webhook');
  const url = signWebhook(settings.webhookUrl, settings.secret);
  const { data } = await axios.post(url, {
    msgtype: 'markdown',
    markdown: { title, text: withKeywords(markdown, settings.keywords) }
  });
  if (data?.errcode && data.errcode !== 0) {
    throw new Error(data.errmsg || `钉钉机器人返回错误：${data.errcode}`);
  }
  return data;
}

function logNotification(action: string, status: 'success' | 'failed', message: string, payload?: unknown) {
  run('INSERT INTO notification_logs (channel, action, status, message, payload) VALUES (?, ?, ?, ?, ?)', [
    'dingtalk_robot',
    action,
    status,
    message,
    payload ? JSON.stringify(payload) : null
  ]);
}

export async function sendTestNotification() {
  const settings = await getNotificationSettings();
  try {
    const result = await sendDingTalkMarkdown(settings, '任务管理系统测试消息', '## 任务管理系统测试消息\n钉钉机器人配置成功。');
    logNotification('test', 'success', '测试消息发送成功', result);
    return result;
  } catch (error: any) {
    logNotification('test', 'failed', error.message || '测试消息发送失败');
    throw error;
  }
}

export async function pushDashboardNotification(user: AuthUser, action = 'manual') {
  const settings = await getNotificationSettings();
  try {
    const summary = await buildDashboardSummary(user);
    const message = buildDashboardMarkdown(summary);
    const result = await sendDingTalkMarkdown(settings, message.title, message.text);
    logNotification(action, 'success', '汇总消息发送成功', {
      developing: summary.inProgress.developing,
      testing: summary.inProgress.testing
    });
    return {
      result,
      summary: {
        developing: summary.inProgress.developing,
        testing: summary.inProgress.testing
      }
    };
  } catch (error: any) {
    logNotification(action, 'failed', error.message || '汇总消息发送失败');
    throw error;
  }
}

export async function markScheduledSent(date: string) {
  run('UPDATE notification_settings SET last_scheduled_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [date]);
}
