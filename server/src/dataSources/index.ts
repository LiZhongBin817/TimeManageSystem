/**
 * 数据源工厂：根据数据源配置创建对应平台的表格客户端。
 */
import { AuthUser } from '../auth';
import { DataSourceInstance, ModuleConfig, getDataSource } from '../config/configStore';
import { getUserIdentityForProvider } from '../db';
import { DingTalkSheetClient } from '../dingtalk/client';
import { FeishuSheetClient } from './feishuClient';

export async function getDataSourceClient(dataSourceId?: number, user?: AuthUser) {
  const dataSource = await getDataSource(dataSourceId);
  if (!dataSource) throw new Error('未找到可用的数据源实例');
  return createClient(await resolveRuntimeDataSource(dataSource, user));
}

export function createClient(dataSource: DataSourceInstance) {
  if (dataSource.platform === 'dingtalk') return new DingTalkSheetClient({ ...dataSource.config, dataSourceId: dataSource.id });
  if (dataSource.platform === 'feishu') return new FeishuSheetClient({ ...dataSource.config, dataSourceId: dataSource.id });
  throw new Error(`暂不支持的数据源平台：${dataSource.platform}`);
}

// 钉钉数据操作优先使用当前系统账号绑定的钉钉身份；未绑定时才回退到数据源备用 operator。
async function resolveRuntimeDataSource(dataSource: DataSourceInstance, user?: AuthUser): Promise<DataSourceInstance> {
  if (!user || dataSource.platform !== 'dingtalk') return dataSource;

  const identity = await getUserIdentityForProvider(user.id, 'dingtalk');
  let raw: Record<string, unknown> = {};
  try {
    raw = identity?.raw_json ? JSON.parse(identity.raw_json) : {};
  } catch {
    raw = {};
  }

  const operatorId = String(
    raw.unionId
      || raw.unionid
      || identity?.union_id
      || identity?.provider_user_id
      || raw.userId
      || raw.userid
      || dataSource.config.operatorId
      || ''
  ).trim();
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
