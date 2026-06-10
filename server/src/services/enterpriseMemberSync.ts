/**
 * 企业成员同步服务：拉取钉钉用户，并新增或更新本地账号身份。
 */
import { listDataSources } from '../config/modules';
import { getDataSourceClient } from '../dataSources';
import { listUsers, logEnterpriseMemberSync, upsertEnterpriseMembers } from '../db';

export interface EnterpriseMemberSyncResult {
  dataSourceId: number;
  provider: string;
  total: number;
  created: number;
  updated: number;
  status: 'success' | 'failed';
  message?: string;
}

/**
 * 为单个数据源拉取钉钉部门用户，并新增或更新本地身份/账号。
 */
export async function syncEnterpriseMembersForDataSource(dataSourceId: number): Promise<EnterpriseMemberSyncResult> {
  const dataSource = (await listDataSources(undefined, true)).find((item) => item.id === dataSourceId && item.enabled);
  if (!dataSource?.id) {
    throw new Error('数据源不可用');
  }

  const client = await getDataSourceClient(dataSource.id) as any;
  if (typeof client.listEnterpriseMembers !== 'function') {
    throw new Error('当前数据源暂不支持企业成员同步');
  }

  try {
    const members = await client.listEnterpriseMembers();
    const result = await upsertEnterpriseMembers(members.map((member: any) => ({
      provider: dataSource.platform,
      providerUserId: member.providerUserId,
      unionId: member.unionId,
      openId: member.openId,
      name: member.name,
      avatar: member.avatar,
      mobile: member.mobile,
      email: member.email,
      department: member.department,
      raw: member.raw
    })));
    logEnterpriseMemberSync({
      provider: dataSource.platform,
      dataSourceId: dataSource.id,
      status: 'success',
      total: result.total,
      created: result.created,
      updated: result.updated,
      message: 'sync'
    });
    return {
      dataSourceId: dataSource.id,
      provider: dataSource.platform,
      status: 'success',
      total: result.total,
      created: result.created,
      updated: result.updated
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEnterpriseMemberSync({
      provider: dataSource.platform,
      dataSourceId: dataSource.id,
      status: 'failed',
      message
    });
    return {
      dataSourceId: dataSource.id,
      provider: dataSource.platform,
      status: 'failed',
      total: 0,
      created: 0,
      updated: 0,
      message
    };
  }
}

export async function syncEnterpriseMembersForDingTalk(options: { dataSourceId?: number } = {}) {
  const dataSources = (await listDataSources('dingtalk', false))
    .filter((item) => item.id && (!options.dataSourceId || item.id === options.dataSourceId));
  const results: EnterpriseMemberSyncResult[] = [];

  for (const dataSource of dataSources) {
    results.push(await syncEnterpriseMembersForDataSource(dataSource.id!));
  }

  return {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    totalMembers: results.reduce((sum, item) => sum + item.total, 0),
    created: results.reduce((sum, item) => sum + item.created, 0),
    updated: results.reduce((sum, item) => sum + item.updated, 0),
    results
  };
}

export async function syncEnterpriseMembersForDataSourceWithUsers(dataSourceId: number) {
  const result = await syncEnterpriseMembersForDataSource(dataSourceId);
  if (result.status === 'failed') {
    throw new Error(result.message || '企业成员同步失败');
  }
  const users = await listUsers();
  return { ...result, users };
}
