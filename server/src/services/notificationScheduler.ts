/**
 * 后台调度器：负责全局和个人看板通知。
 */
import { AuthUser } from '../auth';
import { all, get } from '../db';
import { getDataSource } from '../config/modules';
import { getNotificationSettings, markScheduledSent, markUserScheduledSent, notificationChannelForUser, pushDashboardNotification } from './notification';

let timer: NodeJS.Timeout | undefined;
let running = false;
const MAX_RETRY_COUNT = Number(process.env.NOTIFICATION_SCHEDULED_MAX_RETRIES || 5);
const RETRY_DELAYS_MS = [5, 10, 30, 60, 120].map((minute) => minute * 60 * 1000);

interface RetryState {
  date: string;
  attempts: number;
  nextRetryAt: number;
}

const retryStates = new Map<string, RetryState>();

function errorSummary(error: unknown) {
  const detail = error as any;
  return {
    message: detail?.message || String(error),
    code: detail?.code,
    status: detail?.response?.status,
    responseCode: detail?.response?.data?.errcode,
    responseMessage: detail?.response?.data?.errmsg
  };
}

function todayInShanghai() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function timeInShanghai() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const hour = parts.find((part) => part.type === 'hour')?.value || '00';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  return `${hour}:${minute}`;
}

function hasReachedTime(currentTime: string, scheduledTime = '09:00') {
  return currentTime >= scheduledTime;
}

function hasEnabledWebhook(settings: Awaited<ReturnType<typeof getNotificationSettings>>) {
  return Boolean(
    (settings.dingtalkEnabled && settings.dingtalkWebhookUrl)
    || (settings.feishuEnabled && settings.feishuWebhookUrl)
  );
}

function retryKey(scope: 'global' | 'user', id = 'default') {
  return `${scope}:${id}`;
}

function canRetry(key: string, today: string) {
  const state = retryStates.get(key);
  return !state || state.date !== today || Date.now() >= state.nextRetryAt;
}

async function handleScheduledFailure(key: string, today: string, markDone: () => Promise<void>) {
  const current = retryStates.get(key);
  const attempts = current?.date === today ? current.attempts + 1 : 1;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  retryStates.set(key, {
    date: today,
    attempts,
    nextRetryAt: Date.now() + delay
  });
  if (attempts >= MAX_RETRY_COUNT) {
    await markDone();
    retryStates.delete(key);
    console.error(`[notification-scheduler] reached retry limit for ${key}, stop retrying today`);
  }
}

function clearRetry(key: string) {
  retryStates.delete(key);
}

async function buildSchedulerUser(): Promise<AuthUser | undefined> {
  const user = await get<any>("SELECT * FROM users WHERE role = 'admin' AND enabled = 1 ORDER BY id LIMIT 1");
  if (!user) return undefined;
  const dataSource = await getDataSource();
  if (!dataSource || !dataSource.enabled) return undefined;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    dataSourceId: dataSource.id,
    platform: dataSource.platform,
    dataSourceName: dataSource.name,
    provider: 'local'
  };
}

async function buildUserSchedulerUsers(scheduledTime: string, today: string): Promise<AuthUser[]> {
  const defaultDataSource = await getDataSource();
  const rows = await all<any>(
    `SELECT
       u.id,
       u.username,
       u.role,
       u.display_name,
       COALESCE(p.data_source_id, ?) as data_source_id,
       d.platform,
       d.name as data_source_name
     FROM notification_user_settings n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN user_data_source_preferences p ON p.user_id = u.id
     LEFT JOIN data_source_instances d ON d.id = COALESCE(p.data_source_id, ?)
     WHERE n.enabled = 1
       AND n.scheduled_time = ?
       AND COALESCE(n.last_scheduled_date, '') <> ?
       AND u.enabled = 1
       AND d.enabled = 1`,
    [defaultDataSource?.id ?? null, defaultDataSource?.id ?? null, scheduledTime, today]
  );

  return rows.map((user) => ({
    id: Number(user.id),
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    dataSourceId: Number(user.data_source_id),
    platform: user.platform,
    dataSourceName: user.data_source_name,
    provider: 'local'
  }));
}

// 轮询时按上海本地日期和时间检查全局及个人通知计划。
async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = await getNotificationSettings();
    const today = todayInShanghai();
    const currentTime = timeInShanghai();
    if (!hasEnabledWebhook(settings)) return;

    if (settings.enabled && settings.lastScheduledDate !== today && hasReachedTime(currentTime, settings.scheduledTime || '09:00')) {
      const user = await buildSchedulerUser();
      if (user) {
        const key = retryKey('global');
        if (canRetry(key, today)) {
          try {
            console.log(`[notification-scheduler] pushing global dashboard summary at ${currentTime}`);
            await pushDashboardNotification(user, 'scheduled');
            await markScheduledSent(today);
            clearRetry(key);
          } catch (error) {
            console.error('Scheduled global notification failed', errorSummary(error));
            await handleScheduledFailure(key, today, () => markScheduledSent(today));
          }
        }
      }
    }

    const personalRows = await all<any>(
      `SELECT scheduled_time
       FROM notification_user_settings
       WHERE enabled = 1
         AND COALESCE(last_scheduled_date, '') <> ?
       GROUP BY scheduled_time`,
      [today]
    );
    const duePersonalTimes = personalRows
      .map((row) => String(row.scheduled_time || '09:00'))
      .filter((scheduledTime) => hasReachedTime(currentTime, scheduledTime));

    const users = (await Promise.all(duePersonalTimes.map((scheduledTime) => buildUserSchedulerUsers(scheduledTime, today)))).flat();
    for (const user of users) {
      const key = retryKey('user', String(user.id));
      if (!canRetry(key, today)) continue;
      try {
        console.log(`[notification-scheduler] pushing personal dashboard summary for user ${user.id} at ${currentTime}`);
        await pushDashboardNotification(user, `scheduled:user:${user.id}`, notificationChannelForUser(user));
        await markUserScheduledSent(user.id, today);
        clearRetry(key);
      } catch (error) {
        console.error(`Scheduled user notification failed for user ${user.id}`, errorSummary(error));
        await handleScheduledFailure(key, today, () => markUserScheduledSent(user.id, today));
      }
    }
  } catch (error) {
    console.error('Scheduled notification failed', error);
  } finally {
    running = false;
  }
}

export function startNotificationScheduler() {
  if (timer) return;
  console.log('[notification-scheduler] started');
  timer = setInterval(tick, 60 * 1000);
  tick();
}
