import { DataSourceInstance, ModuleConfig, getDataSource } from '../config/configStore';
import { DingTalkSheetClient } from '../dingtalk/client';
import { FeishuSheetClient } from './feishuClient';

export async function getDataSourceClient(dataSourceId?: number) {
  const dataSource = await getDataSource(dataSourceId);
  if (!dataSource) throw new Error('未找到可用的数据源实例');
  return createClient(dataSource);
}

export function createClient(dataSource: DataSourceInstance) {
  if (dataSource.platform === 'dingtalk') return new DingTalkSheetClient(dataSource.config);
  if (dataSource.platform === 'feishu') return new FeishuSheetClient(dataSource.config);
  throw new Error(`暂不支持的数据源平台：${dataSource.platform}`);
}

export function moduleDataSourceId(module: ModuleConfig, selectedDataSourceId?: number) {
  return module.dataSourceId || selectedDataSourceId;
}
