/**
 * 后台调度器：在启动时和配置的每日时间触发多平台表格同步。
 */
import { getDingTalkSyncSettings } from '../db';
import { syncEnterpriseMembersForDingTalk } from './enterpriseMemberSync';
import { syncPlatformsToLocal } from './platformSync';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastSyncDate = '';
let lastScheduledAttemptAt = 0;
const SCHEDULED_RETRY_INTERVAL_MS = Number(process.env.PLATFORM_SYNC_RETRY_INTERVAL_MS || process.env.DINGTALK_SYNC_RETRY_INTERVAL_MS || 10 * 60 * 1000);

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
    const settings = await getDingTalkSyncSettings();
    const platforms = [
      settings.dingtalkEnabled ? 'dingtalk' : '',
      settings.feishuEnabled ? 'feishu' : ''
    ].filter(Boolean) as Array<'dingtalk' | 'feishu'>;
    if (!platforms.length) {
      console.log(`[platform-sync] skipped ${reason}: no platform enabled`);
      return true;
    }

    console.log(`[platform-sync] starting ${reason}: platforms=${platforms.join(',')}`);
    const sheetResult = await syncPlatformsToLocal({ platforms });
    const memberResult = settings.dingtalkEnabled
      ? await syncEnterpriseMembersForDingTalk()
      : { success: 0, failed: 0, totalMembers: 0 };
    console.log(
      `[platform-sync] finished ${reason}: sheets success=${sheetResult.success}, failed=${sheetResult.failed}; ` +
      `members success=${memberResult.success}, failed=${memberResult.failed}, total=${memberResult.totalMembers}`
    );
    return sheetResult.failed === 0 && memberResult.failed === 0;
  } catch (error) {
    console.error('[platform-sync] failed', error);
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
  console.log('[platform-sync] scheduler started');
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
    .catch((error) => console.error('[platform-sync] failed to load startup settings', error));
}
