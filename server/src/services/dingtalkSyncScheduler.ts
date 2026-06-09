import { getDingTalkSyncSettings } from '../db';
import { syncDingTalkToLocal } from './dingtalkSync';
import { syncEnterpriseMembersForDingTalk } from './enterpriseMemberSync';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastSyncDate = '';

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

async function runSync(reason: string) {
  if (running) return;
  running = true;
  try {
    console.log(`[dingtalk-sync] starting ${reason}`);
    const [sheetResult, memberResult] = await Promise.all([
      syncDingTalkToLocal(),
      syncEnterpriseMembersForDingTalk()
    ]);
    console.log(
      `[dingtalk-sync] finished ${reason}: sheets success=${sheetResult.success}, failed=${sheetResult.failed}; ` +
      `members success=${memberResult.success}, failed=${memberResult.failed}, total=${memberResult.totalMembers}`
    );
  } catch (error) {
    console.error('[dingtalk-sync] failed', error);
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
    lastSyncDate = today;
    await runSync(`scheduled-${today}`);
  }
}

export function startDingTalkSyncScheduler() {
  if (timer) return;
  console.log('[dingtalk-sync] scheduler started');
  timer = setInterval(tick, 60 * 1000);
  getDingTalkSyncSettings()
    .then((settings) => {
      if (settings.enabled && settings.startupSyncEnabled) {
        setTimeout(() => runSync('startup'), settings.startupDelayMs);
      }
    })
    .catch((error) => console.error('[dingtalk-sync] failed to load startup settings', error));
  tick();
}
