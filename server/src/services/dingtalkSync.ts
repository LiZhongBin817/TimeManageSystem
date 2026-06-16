/**
 * 钉钉到本地的同步服务：同步模块行并记录同步任务状态。
 */
import { listDataSources, listModules } from '../config/modules';
import { createSyncJob, finishSyncJob } from '../db';
import { DingTalkSheetClient } from '../dingtalk/client';
import { moduleDataSourceId } from '../dataSources';

let syncing = false;

/**
 * 把钉钉工作表行拉取到本地存储，并记录同步任务状态供管理员查看。
 */
export async function syncDingTalkToLocal(options: { dataSourceId?: number; moduleKey?: string } = {}) {
  if (syncing) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      results: [{ dataSourceId: options.dataSourceId || 0, moduleKey: options.moduleKey || 'all', rows: 0, status: 'skipped', message: 'sync already running' }]
    };
  }
  syncing = true;
  try {
  const dataSources = (await listDataSources('dingtalk', false))
    .filter((item) => !options.dataSourceId || item.id === options.dataSourceId);
  const results: Array<{ dataSourceId: number; moduleKey: string; rows: number; status: string; message?: string }> = [];

  for (const dataSource of dataSources) {
    const modules = (await listModules({ enabledOnly: true, dataSourceId: dataSource.id }))
      .filter((module) => (!options.moduleKey || module.key === options.moduleKey) && moduleDataSourceId(module, dataSource.id) === dataSource.id);
    const client = new DingTalkSheetClient({ ...dataSource.config, dataSourceId: dataSource.id });

    for (const module of modules) {
      const pushJobId = await createSyncJob({
        platform: 'dingtalk',
        dataSourceId: dataSource.id,
        moduleKey: module.key,
        direction: 'push'
      });
      let pushFailed = false;
      try {
        const pushed = await client.syncPendingLocalChanges(module);
        finishSyncJob({
          id: pushJobId,
          status: pushed.failed ? 'failed' : 'success',
          totalRows: pushed.total,
          message: `pending pushed: success=${pushed.success}, failed=${pushed.failed}`
        });
        pushFailed = pushed.failed > 0;
      } catch (error: any) {
        pushFailed = true;
        const message = error?.response?.data?.message || error?.message || 'push failed';
        finishSyncJob({ id: pushJobId, status: 'failed', message });
      }
      if (pushFailed) {
        results.push({ dataSourceId: dataSource.id, moduleKey: module.key, rows: 0, status: 'failed', message: 'pending push failed, skipped pull' });
        continue;
      }

      const jobId = await createSyncJob({
        platform: 'dingtalk',
        dataSourceId: dataSource.id,
        moduleKey: module.key,
        direction: 'pull'
      });
      try {
        const result = await client.syncModuleFromRemote(module);
        finishSyncJob({ id: jobId, status: 'success', totalRows: result.rows, message: 'synced' });
        results.push({ dataSourceId: dataSource.id, moduleKey: module.key, rows: result.rows, status: 'success' });
      } catch (error: any) {
        const message = error?.response?.data?.message || error?.message || 'sync failed';
        finishSyncJob({ id: jobId, status: 'failed', message });
        results.push({ dataSourceId: dataSource.id, moduleKey: module.key, rows: 0, status: 'failed', message });
      }
    }
  }

  return {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results
  };
  } finally {
    syncing = false;
  }
}

export function isDingTalkSyncRunning() {
  return syncing;
}
