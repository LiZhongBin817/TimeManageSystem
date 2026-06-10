/**
 * 后台调度器：在启动时和配置的每日时间触发钉钉同步。
 */
import { getDingTalkSyncSettings } from '../db';
import { syncDingTalkToLocal } from './dingtalkSync';
import { syncEnterpriseMembersForDingTalk } from './enterpriseMemberSync';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastSyncDate = '';
let lastScheduledAttemptAt = 0;
const SCHEDULED_RETRY_INTERVAL_MS = Number(process.env.DINGTALK_SYNC_RETRY_INTERVAL_MS || 10 * 60 * 1000);

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

// 启动同步、每日同步和重试轮询共用的调度入口。
async function runSync(reason: string) {
  if (running) return false;
  running = true;
  try {
    console.log(`[dingtalk-sync] starting ${reason}`);
    const sheetResult = await syncDingTalkToLocal();
    const memberResult = await syncEnterpriseMembersForDingTalk();
    console.log(
      `[dingtalk-sync] finished ${reason}: sheets success=${sheetResult.success}, failed=${sheetResult.failed}; ` +
      `members success=${memberResult.success}, failed=${memberResult.failed}, total=${memberResult.totalMembers}`
    );
    return sheetResult.failed === 0 && memberResult.failed === 0;
  } catch (error) {
    console.error('[dingtalk-sync] failed', error);
    return false;
  } finally {
    running = false;
  }
}

async function tick() {
  const settings = await getDingTalkSyncSettings();
  if (!settings.enabled) return;
  const today = todayInShanghai();
  const currentTime = timeInShanghai();
  if (lastSyncDate !== today && currentTime >= settings.scheduledTime) {
    const now = Date.now();
    if (lastScheduledAttemptAt && now - lastScheduledAttemptAt < SCHEDULED_RETRY_INTERVAL_MS) return;
    lastScheduledAttemptAt = now;
    const success = await runSync(`scheduled-${today}`);
    if (success) {
      lastSyncDate = today;
    }
  }
}

export function startDingTalkSyncScheduler() {
  if (timer) return;
  console.log('[dingtalk-sync] scheduler started');
  timer = setInterval(tick, 60 * 1000);
  getDingTalkSyncSettings()
    .then((settings) => {
      if (settings.enabled && settings.startupSyncEnabled) {
        setTimeout(async () => {
          const success = await runSync('startup');
          if (success && timeInShanghai() >= settings.scheduledTime) {
            lastSyncDate = todayInShanghai();
          }
        }, settings.startupDelayMs);
      }
    })
    .catch((error) => console.error('[dingtalk-sync] failed to load startup settings', error));
}
