/**
 * 数据源工厂：解析已配置的平台，并为请求创建对应的表格客户端。
 */
import { AuthUser } from '../auth';
import { DataSourceInstance, ModuleConfig, getDataSource } from '../config/configStore';
import { getUserIdentityForProvider } from '../db';
import { DingTalkSheetClient } from '../dingtalk/client';
import { FeishuSheetClient } from './feishuClient';

/**
 * 解析实际生效的数据源实例，并返回对应平台的适配器。
 */
export async function getDataSourceClient(dataSourceId?: number, user?: AuthUser) {
  const dataSource = await getDataSource(dataSourceId);
  if (!dataSource) throw new Error('未找到可用的数据源实例');
  return createClient(await resolveRuntimeDataSource(dataSource, user));
}

export function createClient(dataSource: DataSourceInstance) {
  if (dataSource.platform === 'dingtalk') return new DingTalkSheetClient({ ...dataSource.config, dataSourceId: dataSource.id });
  if (dataSource.platform === 'feishu') return new FeishuSheetClient(dataSource.config);
  throw new Error(`暂不支持的数据源平台：${dataSource.platform}`);
}

// 企业钉钉用户优先使用自己的 userId 操作，本地兜底登录使用配置中的 operator。
async function resolveRuntimeDataSource(dataSource: DataSourceInstance, user?: AuthUser): Promise<DataSourceInstance> {
  if (!user || dataSource.platform !== 'dingtalk' || user.provider === 'local') return dataSource;
  const identity = await getUserIdentityForProvider(user.id, 'dingtalk');
  let raw: any = {};
  try {
    raw = identity?.raw_json ? JSON.parse(identity.raw_json) : {};
  } catch {
    raw = {};
  }
  const operatorId = raw?.userId || raw?.userid || dataSource.config.operatorId;
  if (!operatorId) return dataSource;
  return {
    ...dataSource,
    config: {
      ...dataSource.config,
      operatorId
    }
  };
}

export function moduleDataSourceId(module: ModuleConfig, selectedDataSourceId?: number) {
  return module.dataSourceId || selectedDataSourceId;
}
