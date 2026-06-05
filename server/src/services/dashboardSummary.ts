import { AuthUser } from '../auth';
import { ModuleConfig, listModules } from '../config/modules';
import { getModulePermission } from '../db';
import { getDataSourceClient, moduleDataSourceId } from '../dataSources';
import { filterProjectRowsForUser } from './rowAccess';

type ScheduleStatus = 'developing' | 'testing';

export interface ScheduleItem {
  id: unknown;
  moduleKey: string;
  moduleTitle: string;
  status: ScheduleStatus;
  name: string;
  branchName: unknown;
  content: unknown;
  zentaoLink: unknown;
  developer: unknown;
  productOwner: unknown;
  tester: unknown;
  plannedTestAt: unknown;
  actualTestAt: unknown;
  launchAt: unknown;
  remark: unknown;
}

interface DecoratedModule extends ModuleConfig {
  canView: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canEdit: boolean;
}

async function decorateModule(user: AuthUser, module: ModuleConfig): Promise<DecoratedModule> {
  const permission = await getModulePermission({
    userId: user.id,
    role: user.role,
    module: { key: module.key, enabled: module.enabled, editable: module.editable }
  });
  return {
    ...module,
    canView: permission.canView,
    canCreate: permission.canCreate,
    canUpdate: permission.canUpdate,
    canDelete: permission.canDelete,
    canEdit: permission.canCreate || permission.canUpdate || permission.canDelete
  };
}

async function readableProjectModules(user: AuthUser) {
  const modules = await listModules({ category: 'project', enabledOnly: true, dataSourceId: user.dataSourceId });
  const decorated = await Promise.all(modules.map((module) => decorateModule(user, module)));
  return decorated.filter((module) => module.canView);
}

async function getClientForModule(module: ModuleConfig, selectedDataSourceId?: number) {
  return getDataSourceClient(moduleDataSourceId(module, selectedDataSourceId));
}

export async function buildDashboardSummary(user: AuthUser) {
  const projectModules = await readableProjectModules(user);
  const moduleStats: Array<{
    key: string;
    title: string;
    total: number;
    done: number;
    unfinished: number;
    developing: number;
    testing: number;
    completionRate: number;
    progressText: string;
    developingVersions: string[];
    testingVersions: string[];
    developingItems: ScheduleItem[];
    testingItems: ScheduleItem[];
    error?: string;
    editable: boolean;
  }> = [];
  const developerNames = new Set<string>();
  const developerRows: Record<string, Record<string, { total: number; done: number; unfinished: number }>> = {};
  const isDone = (value: unknown) => ['是', '已完成', '完成', 'true'].includes(String(value || '').trim().toLowerCase());
  const versionName = (row: Record<string, unknown>) => String(row.name || row.content || row.branchName || '').trim();
  const scheduleItem = (module: ModuleConfig, row: Record<string, unknown>, status: ScheduleStatus): ScheduleItem => ({
    id: row.id,
    moduleKey: module.key,
    moduleTitle: module.title,
    status,
    name: versionName(row) || '-',
    branchName: row.branchName || '-',
    content: row.content || '-',
    zentaoLink: row.zentaoLink || '',
    developer: row.developer || '-',
    productOwner: row.productOwner || '-',
    tester: row.tester || '-',
    plannedTestAt: row.plannedTestAt || '',
    actualTestAt: row.actualTestAt || '',
    launchAt: row.launchAt || '',
    remark: row.remark || ''
  });
  const isTesting = (row: Record<string, unknown>) => {
    const name = String(row.name || '').trim();
    if (name.includes('（开发）') || name.includes('(开发)')) return false;
    if (name.includes('（测试）') || name.includes('(测试)')) return true;
    const text = `${row.content || ''} ${row.remark || ''}`.toLowerCase();
    return text.includes('测试') || text.includes('test');
  };
  const pushDeveloperStat = (name: string, moduleTitle: string, done: boolean) => {
    const cleanName = name.trim();
    if (!cleanName || cleanName === '-') return;
    developerNames.add(cleanName);
    developerRows[cleanName] ||= {};
    developerRows[cleanName][moduleTitle] ||= { total: 0, done: 0, unfinished: 0 };
    developerRows[cleanName][moduleTitle].total += 1;
    if (done) developerRows[cleanName][moduleTitle].done += 1;
    else developerRows[cleanName][moduleTitle].unfinished += 1;
  };

  for (const module of projectModules) {
    let rows: Record<string, unknown>[] = [];
    let error: string | undefined;
    try {
      const client = await getClientForModule(module, user.dataSourceId);
      rows = filterProjectRowsForUser(user, await client.getRows(module));
    } catch (failure: any) {
      error = failure.response?.data?.message || failure.message || '读取失败';
    }
    const done = rows.filter((row) => isDone(row.isCompleted)).length;
    const unfinishedRows = rows.filter((row) => !isDone(row.isCompleted));
    const testingRows = unfinishedRows.filter((row) => isTesting(row));
    const developingRows = unfinishedRows.filter((row) => !isTesting(row));
    for (const row of rows) {
      String(row.developer || '')
        .split(/[、，,]/)
        .forEach((name) => pushDeveloperStat(name, module.title, isDone(row.isCompleted)));
    }
    const completionRate = rows.length ? Math.round((done / rows.length) * 100) : 0;
    moduleStats.push({
      key: module.key,
      title: module.title,
      total: rows.length,
      done,
      unfinished: rows.length - done,
      developing: developingRows.length,
      testing: testingRows.length,
      completionRate,
      progressText: '☆'.repeat(Math.max(1, Math.round(completionRate / 10))),
      developingVersions: developingRows.map(versionName).filter(Boolean),
      testingVersions: testingRows.map(versionName).filter(Boolean),
      developingItems: developingRows.map((row) => scheduleItem(module, row, 'developing')),
      testingItems: testingRows.map((row) => scheduleItem(module, row, 'testing')),
      error,
      editable: module.canEdit
    });
  }

  const totalRows = moduleStats.reduce((sum, item) => sum + item.total, 0);
  const totalDone = moduleStats.reduce((sum, item) => sum + item.done, 0);
  const overallRate = totalRows ? Math.round((totalDone / totalRows) * 100) : 0;
  const developingItems = moduleStats.flatMap((item) => item.developingItems);
  const testingItems = moduleStats.flatMap((item) => item.testingItems);
  return {
    source: user.platform,
    currentDate: new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    cards: [
      { label: '项目模块', value: moduleStats.length },
      { label: '总需求数', value: totalRows },
      { label: '总已完成数', value: totalDone },
      { label: '整体完成率', value: `${overallRate}%` }
    ],
    overview: { totalRows, totalDone, overallRate },
    inProgress: {
      total: developingItems.length + testingItems.length,
      developing: developingItems.length,
      testing: testingItems.length,
      developingItems,
      testingItems
    },
    moduleStats,
    developerStats: Array.from(developerNames).map((name) => ({
      name,
      modules: moduleStats.map((module) => ({
        title: module.title,
        ...(developerRows[name]?.[module.title] || { total: 0, done: 0, unfinished: 0 })
      }))
    })),
    trend: moduleStats.map((item) => ({ name: item.title, total: item.total, done: item.done, unfinished: item.unfinished }))
  };
}
