import { AuthUser } from '../auth';
import { get } from '../db';
import { getDataSource } from '../config/modules';
import { getNotificationSettings, markScheduledSent, pushDashboardNotification } from './notification';

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

async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = await getNotificationSettings();
    const today = todayInShanghai();
    if (!settings.enabled || !settings.webhookUrl || settings.lastScheduledDate === today) return;
    if (timeInShanghai() !== (settings.scheduledTime || '09:00')) return;
    const user = await buildSchedulerUser();
    if (!user) return;
    await pushDashboardNotification(user, 'scheduled');
    await markScheduledSent(today);
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
