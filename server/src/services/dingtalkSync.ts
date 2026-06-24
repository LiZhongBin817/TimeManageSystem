/**
 * 旧钉钉同步入口兼容层：内部委托给多平台同步服务，只同步钉钉平台。
 */
import { isPlatformSyncRunning, syncPlatformsToLocal } from './platformSync';

export async function syncDingTalkToLocal(options: { dataSourceId?: number; moduleKey?: string } = {}) {
  return syncPlatformsToLocal({ ...options, platforms: ['dingtalk'] });
}

export function isDingTalkSyncRunning() {
  return isPlatformSyncRunning();
}
