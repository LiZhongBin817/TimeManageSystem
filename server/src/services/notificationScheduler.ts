import { AuthUser } from '../auth';
import { all, get } from '../db';
import { getDataSource } from '../config/modules';
import { getNotificationSettings, markScheduledSent, markUserScheduledSent, pushDashboardNotification } from './notification';

let timer: NodeJS.Timeout | undefined;
let running = false;

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

async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = await getNotificationSettings();
    const today = todayInShanghai();
    const currentTime = timeInShanghai();
    if (!settings.webhookUrl) return;

    if (settings.enabled && settings.lastScheduledDate !== today && currentTime === (settings.scheduledTime || '09:00')) {
      const user = await buildSchedulerUser();
      if (user) {
        await pushDashboardNotification(user, 'scheduled');
        await markScheduledSent(today);
      }
    }

    const users = await buildUserSchedulerUsers(currentTime, today);
    for (const user of users) {
      try {
        await pushDashboardNotification(user, `scheduled:user:${user.id}`);
        await markUserScheduledSent(user.id, today);
      } catch (error) {
        console.error(`Scheduled user notification failed for user ${user.id}`, error);
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
  timer = setInterval(tick, 60 * 1000);
  tick();
}
