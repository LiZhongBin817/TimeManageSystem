/**
 * 多平台表格同步服务：按数据源平台推送本地待同步数据，再拉取远端表格镜像到本地。
 */
import { listDataSources, listModules } from '../config/modules';
import { createSyncJob, finishSyncJob } from '../db';
import { createClient, moduleDataSourceId } from '../dataSources';

type SyncPlatform = 'dingtalk' | 'feishu';

interface SyncOptions {
  dataSourceId?: number;
  moduleKey?: string;
  platforms?: SyncPlatform[];
}

interface SyncClient {
  syncPendingLocalChanges(module: any): Promise<{ total: number; success: number; failed: number }>;
  syncModuleFromRemote(module: any): Promise<{ rows: number }>;
}

let syncing = false;

function enabledPlatforms(platforms?: SyncPlatform[]) {
  return platforms?.length ? platforms : ['dingtalk', 'feishu'] as SyncPlatform[];
}

export async function syncPlatformsToLocal(options: SyncOptions = {}) {
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
    const results: Array<{ platform: SyncPlatform; dataSourceId: number; moduleKey: string; rows: number; status: string; message?: string }> = [];

    for (const platform of enabledPlatforms(options.platforms)) {
      const dataSources = (await listDataSources(platform, false))
        .filter((item) => !options.dataSourceId || item.id === options.dataSourceId);

      for (const dataSource of dataSources) {
        const modules = (await listModules({ enabledOnly: true, dataSourceId: dataSource.id }))
          .filter((module) => (!options.moduleKey || module.key === options.moduleKey) && moduleDataSourceId(module, dataSource.id) === dataSource.id);
        const client = createClient(dataSource) as SyncClient;

        for (const module of modules) {
          const pushJobId = await createSyncJob({
            platform,
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
            results.push({ platform, dataSourceId: dataSource.id, moduleKey: module.key, rows: 0, status: 'failed', message: 'pending push failed, skipped pull' });
            continue;
          }

          const pullJobId = await createSyncJob({
            platform,
            dataSourceId: dataSource.id,
            moduleKey: module.key,
            direction: 'pull'
          });
          try {
            const result = await client.syncModuleFromRemote(module);
            finishSyncJob({ id: pullJobId, status: 'success', totalRows: result.rows, message: 'synced' });
            results.push({ platform, dataSourceId: dataSource.id, moduleKey: module.key, rows: result.rows, status: 'success' });
          } catch (error: any) {
            const message = error?.response?.data?.message || error?.message || 'sync failed';
            finishSyncJob({ id: pullJobId, status: 'failed', message });
            results.push({ platform, dataSourceId: dataSource.id, moduleKey: module.key, rows: 0, status: 'failed', message });
          }
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

export function isPlatformSyncRunning() {
  return syncing;
}
