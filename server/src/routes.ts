import { Router } from 'express';
import { z } from 'zod';
import { login, loginWithOAuth, requireAuth, signOAuthState, verifyOAuthState } from './auth';
import {
  ModuleConfig,
  ModuleField,
  canConfigure,
  findModule,
  listDataSources,
  listModules,
  replaceModuleFields,
  saveDataSource,
  saveModule,
  updateModuleSheetId
} from './config/modules';
import {
  PermissionSubjectType,
  addAuditLog,
  all,
  getModulePermission,
  listModulePermissions,
  listUsers,
  replaceModulePermissions,
  run,
  upsertEnterpriseMembers,
  updateUser
} from './db';
import { getDataSourceClient, moduleDataSourceId } from './dataSources';
import { authUrl, callbackUri, fetchOAuthIdentity, frontendCallbackUrl, frontendLoginErrorUrl } from './oauth/oauthClients';
import { buildDashboardSummary } from './services/dashboardSummary';
import {
  getNotificationSettings,
  listNotificationLogs,
  pushDashboardNotification,
  saveNotificationSettings,
  sendTestNotification
} from './services/notification';
import {
  assertOwnDeveloperPayload,
  filterProjectRowsForUser,
  forceOwnDeveloper,
  isOwnProjectRow
} from './services/rowAccess';

export const router = Router();

function serializeUser(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    enabled: Boolean(user.enabled),
    defaultDataSourceId: user.default_data_source_id || null,
    defaultDataSourceName: user.default_data_source_name || '',
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  platform: z.enum(['dingtalk', 'feishu'])
});

const userSchema = z.object({
  displayName: z.string().min(1),
  role: z.enum(['admin', 'editor', 'viewer']),
  enabled: z.boolean(),
  defaultDataSourceId: z.number().int().positive().nullable().optional()
});

const dataSourceSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  platform: z.enum(['dingtalk', 'feishu']),
  config: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  sortOrder: z.number().default(0)
});

const moduleSchema = z.object({
  id: z.number().optional(),
  key: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(['project', 'staff', 'todo']).default('project'),
  dataSourceId: z.number().optional().nullable(),
  sheetName: z.string().min(1),
  sheetId: z.string().optional().nullable(),
  headerRow: z.number().default(1),
  dataStartRow: z.number().default(2),
  editable: z.boolean().default(true),
  enabled: z.boolean().default(true),
  sortOrder: z.number().default(0)
});

const fieldsSchema = z.object({
  fields: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(['text', 'number', 'date', 'status', 'link', 'staff', 'formula', 'hidden']),
    required: z.boolean().optional(),
    hidden: z.boolean().optional(),
    formula: z.boolean().optional(),
    staffRole: z.enum(['product', 'tester', 'developer']).optional()
  }))
});

const permissionSchema = z.object({
  subjectType: z.enum(['role', 'user']),
  subjectId: z.string().min(1),
  permissions: z.array(z.object({
    moduleKey: z.string().min(1),
    canView: z.boolean(),
    canCreate: z.boolean(),
    canUpdate: z.boolean(),
    canDelete: z.boolean()
  }))
});

async function modulePermission(user: NonNullable<Express.Request['user']>, module: ModuleConfig) {
  return getModulePermission({
    userId: user.id,
    role: user.role,
    module: { key: module.key, enabled: module.enabled, editable: module.editable }
  });
}

async function decorateModule(user: NonNullable<Express.Request['user']>, module: ModuleConfig) {
  const permission = await modulePermission(user, module);
  return {
    ...module,
    canView: permission.canView,
    canCreate: permission.canCreate,
    canUpdate: permission.canUpdate,
    canDelete: permission.canDelete,
    canEdit: permission.canCreate || permission.canUpdate || permission.canDelete
  };
}

async function readableModules(user: NonNullable<Express.Request['user']>, modules: ModuleConfig[]) {
  const decorated = await Promise.all(modules.map((module) => decorateModule(user, module)));
  return decorated.filter((module) => module.canView);
}

router.get('/data-source/platforms', (_req, res) => {
  res.json({
    platforms: [
      { key: 'dingtalk', label: '钉钉' },
      { key: 'feishu', label: '飞书' }
    ]
  });
});

router.get('/data-source/instances', async (req, res, next) => {
  try {
    const includeDisabled = req.query.includeDisabled === 'true';
    const instances = await listDataSources(String(req.query.platform || '') || undefined, includeDisabled);
    res.json({ instances });
  } catch (error) {
    next(error);
  }
});

router.get('/auth/login-config', (_req, res) => {
  res.json({
    providers: [
      { key: 'dingtalk', label: '钉钉登录' },
      { key: 'feishu', label: '飞书登录' }
    ],
    localLoginEnabled: false
  });
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '用户名、密码和数据源实例不能为空' });
      return;
    }
    const dataSource = (await listDataSources(parsed.data.platform, false)).find((item) => item.enabled);
    if (!dataSource?.enabled) {
      res.status(403).json({ message: '当前数据源未授权管理员备用登录' });
      return;
    }
    const result = await login(parsed.data.username, parsed.data.password, dataSource.id);
    if (!result) {
      res.status(401).json({ message: '用户名或密码错误' });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/auth/oauth/:provider/start', async (req, res, next) => {
  try {
    const provider = req.params.provider as 'dingtalk' | 'feishu';
    if (!['dingtalk', 'feishu'].includes(provider)) {
      res.status(400).json({ message: '不支持的登录平台' });
      return;
    }
    const dataSourceId = Number(req.query.dataSourceId);
    if (false && !dataSourceId) {
      res.status(400).json({ message: '请先选择数据源实例' });
      return;
    }
    const dataSource = (await listDataSources(provider, false)).find((item) => (!dataSourceId || item.id === dataSourceId) && item.enabled);
    if (!dataSource) {
      res.status(400).json({ message: '数据源实例不可用' });
      return;
    }
    if (dataSource.config.loginEnabled === 'false') {
      res.status(400).json({ message: '该数据源未启用企业登录' });
      return;
    }
    const redirectUri = callbackUri(provider, dataSource);
    const state = signOAuthState({ provider, dataSourceId: dataSource.id, redirectUri });
    res.redirect(authUrl(provider, dataSource, redirectUri, state));
  } catch (error) {
    next(error);
  }
});

router.get('/auth/oauth/:provider/callback', async (req, res) => {
  try {
    const provider = req.params.provider as 'dingtalk' | 'feishu';
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) throw new Error('OAuth 回调缺少授权码或 state');
    const payload = verifyOAuthState(state);
    if (payload.provider !== provider) throw new Error('OAuth state 与登录平台不匹配');
    const dataSource = (await listDataSources(provider, true)).find((item) => item.id === payload.dataSourceId && item.enabled);
    if (!dataSource) throw new Error('数据源实例不可用');
    const identity = await fetchOAuthIdentity(provider, dataSource, code);
    const result = await loginWithOAuth(provider, dataSource.id, identity);
    res.redirect(frontendCallbackUrl(result.token));
  } catch (error: any) {
    res.redirect(frontendLoginErrorUrl(error.message || '企业登录失败'));
  }
});

router.use(requireAuth);

router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

router.get('/users', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以管理用户' });
      return;
    }
    const users = await listUsers();
    res.json({
      users: users.map(serializeUser)
    });
  } catch (error) {
    next(error);
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以管理用户' });
      return;
    }
    const parsed = userSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '用户配置不完整' });
      return;
    }
    const targetId = Number(req.params.id);
    const users = await listUsers();
    const target = users.find((item) => item.id === targetId);
    if (!target) {
      res.status(404).json({ message: '用户不存在' });
      return;
    }
    const enabledAdmins = users.filter((item) => item.role === 'admin' && item.enabled === 1);
    const isRemovingLastAdmin = target.role === 'admin'
      && target.enabled === 1
      && (parsed.data.role !== 'admin' || !parsed.data.enabled)
      && enabledAdmins.length <= 1;
    if (isRemovingLastAdmin) {
      res.status(400).json({ message: '至少需要保留一个启用的管理员账号，避免无法管理权限' });
      return;
    }
    const user = await updateUser({ id: targetId, ...parsed.data });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

router.get('/permissions', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以管理权限' });
      return;
    }
    const subjectType = String(req.query.subjectType || 'user') as PermissionSubjectType;
    const subjectId = String(req.query.subjectId || '');
    if (!['role', 'user'].includes(subjectType) || !subjectId) {
      res.status(400).json({ message: '请选择权限对象' });
      return;
    }

    const modules = await listModules({ enabledOnly: false, dataSourceId: req.user!.dataSourceId });
    const targetUser = subjectType === 'user' ? (await listUsers()).find((user) => String(user.id) === subjectId) : undefined;
    if (subjectType === 'user' && !targetUser) {
      res.status(404).json({ message: '用户不存在' });
      return;
    }
    const role = subjectType === 'role' ? subjectId as any : targetUser!.role;
    const userId = subjectType === 'role' ? -1 : Number(subjectId);
    const explicitRows = await listModulePermissions(subjectType, subjectId);
    const explicitKeys = new Set(explicitRows.map((row) => row.module_key));
    const permissions = await Promise.all(modules.map(async (module) => {
      const permission = await getModulePermission({
        userId,
        role,
        module: { key: module.key, enabled: module.enabled, editable: module.editable }
      });
      return {
        moduleKey: module.key,
        moduleTitle: module.title,
        category: module.category,
        explicit: explicitKeys.has(module.key),
        ...permission
      };
    }));
    res.json({ permissions });
  } catch (error) {
    next(error);
  }
});

router.put('/permissions', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以管理权限' });
      return;
    }
    const parsed = permissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '权限配置不完整' });
      return;
    }
    const permissions = await replaceModulePermissions(
      parsed.data.subjectType,
      parsed.data.subjectId,
      parsed.data.permissions
    );
    res.json({ permissions });
  } catch (error) {
    next(error);
  }
});

router.post('/enterprise-members/sync', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有超级管理员可以同步企业成员' });
      return;
    }
    const client = await getDataSourceClient(req.user!.dataSourceId) as any;
    if (typeof client.listEnterpriseMembers !== 'function') {
      res.status(400).json({ message: '当前数据源暂不支持企业成员同步' });
      return;
    }
    const members = await client.listEnterpriseMembers();
    const result = await upsertEnterpriseMembers(members.map((member: any) => ({
      provider: req.user!.platform,
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
    const users = await listUsers();
    res.json({ ...result, users: users.map(serializeUser) });
  } catch (error) {
    next(error);
  }
});

router.get('/modules', async (req, res, next) => {
  try {
    const modules = await listModules({ enabledOnly: true, dataSourceId: req.user!.dataSourceId });
    res.json({ modules: await readableModules(req.user!, modules) });
  } catch (error) {
    next(error);
  }
});

router.get('/project-modules', async (req, res, next) => {
  try {
    const modules = await listModules({ category: 'project', enabledOnly: true, dataSourceId: req.user!.dataSourceId });
    res.json({ modules: await readableModules(req.user!, modules) });
  } catch (error) {
    next(error);
  }
});

router.get('/staff-options', async (req, res, next) => {
  try {
    const staffModule = await findModule('staff');
    if (!staffModule || !(await modulePermission(req.user!, staffModule)).canView) {
      res.status(404).json({ message: '人员信息模块不存在或无权访问' });
      return;
    }
    const client = await getClientForModule(staffModule, req.user!.dataSourceId);
    const rows = await client.getRows(staffModule);
    const unique = (key: string) =>
      Array.from(new Set(rows.map((row: any) => String(row[key] || '').trim()).filter((value) => value && value !== '-')));
    res.json({ product: unique('productOwner'), tester: unique('tester'), developer: unique('developer') });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard/summary', async (req, res, next) => {
  try {
    res.json(await buildDashboardSummary(req.user!));
  } catch (error) {
    next(error);
  }
});

router.get('/notification/settings', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '没有消息推送查看权限' });
      return;
    }
    res.json({ settings: await getNotificationSettings() });
  } catch (error) {
    next(error);
  }
});

router.put('/notification/settings', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以配置消息推送' });
      return;
    }
    const parsed = z.object({
      enabled: z.boolean().default(false),
      webhookUrl: z.string().default(''),
      secret: z.string().default(''),
      keywords: z.array(z.string()).default([]),
      scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00')
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '消息推送配置不完整' });
      return;
    }
    res.json({ settings: await saveNotificationSettings(parsed.data) });
  } catch (error) {
    next(error);
  }
});

router.post('/notification/test', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以发送测试消息' });
      return;
    }
    res.json({ result: await sendTestNotification() });
  } catch (error) {
    next(error);
  }
});

router.post('/notification/push-dashboard', async (req, res, next) => {
  try {
    if (!['admin', 'editor'].includes(req.user!.role)) {
      res.status(403).json({ message: '没有消息推送权限' });
      return;
    }
    res.json(await pushDashboardNotification(req.user!, 'manual'));
  } catch (error) {
    next(error);
  }
});

router.get('/notification/logs', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以查看消息推送日志' });
      return;
    }
    res.json({ logs: await listNotificationLogs() });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const projectModules = await readableModules(
      req.user!,
      await listModules({ category: 'project', enabledOnly: true, dataSourceId: req.user!.dataSourceId })
    );
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
      developingItems: Array<Record<string, unknown>>;
      testingItems: Array<Record<string, unknown>>;
      error?: string;
      editable: boolean;
    }> = [];
    const developerNames = new Set<string>();
    const developerRows: Record<string, Record<string, { total: number; done: number; unfinished: number }>> = {};
    const isDone = (value: unknown) => ['是', '已完成', '完成', 'true'].includes(String(value || '').trim().toLowerCase());
    const versionName = (row: Record<string, unknown>) => String(row.name || row.content || row.branchName || '').trim();
    const scheduleItem = (module: ModuleConfig, row: Record<string, unknown>, status: 'developing' | 'testing') => ({
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
        const client = await getClientForModule(module, req.user!.dataSourceId);
        rows = await client.getRows(module);
      } catch (failure: any) {
        error = failure.response?.data?.message || failure.message || '读取失败';
      }
      const done = rows.filter((row) => isDone(row.isCompleted)).length;
      const unfinishedRows = rows.filter((row) => !isDone(row.isCompleted));
      const testingRows = unfinishedRows.filter((row) => isTesting(row));
      const developingRows = unfinishedRows.filter((row) => !isTesting(row));
      for (const row of rows) {
        String(row.developer || '')
          .split(/[、,，/]/)
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
    res.json({
      source: req.user!.platform,
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
    });
  } catch (error) {
    next(error);
  }
});

router.get('/project-modules/:module/rows', getModuleRows);
router.post('/project-modules/:module/rows', createModuleRow);
router.put('/project-modules/:module/rows/:rowId', updateModuleRow);
router.delete('/project-modules/:module/rows/:rowId', deleteModuleRow);
router.get('/sheets/:module/rows', getModuleRows);
router.post('/sheets/:module/rows', createModuleRow);
router.put('/sheets/:module/rows/:rowId', updateModuleRow);
router.delete('/sheets/:module/rows/:rowId', deleteModuleRow);

router.post('/data-source/instances', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const parsed = dataSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '数据源实例配置不完整' });
      return;
    }
    const instance = await saveDataSource(parsed.data);
    res.status(201).json({ instance });
  } catch (error) {
    next(error);
  }
});

router.put('/data-source/instances/:id', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const parsed = dataSourceSchema.safeParse({ ...req.body, id: Number(req.params.id) });
    if (!parsed.success) {
      res.status(400).json({ message: '数据源实例配置不完整' });
      return;
    }
    const instance = await saveDataSource(parsed.data);
    res.json({ instance });
  } catch (error) {
    next(error);
  }
});

router.delete('/data-source/instances/:id', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    run('UPDATE data_source_instances SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [Number(req.params.id)]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/config/modules', async (req, res, next) => {
  try {
    const modules = await listModules({ enabledOnly: false, dataSourceId: req.user!.dataSourceId });
    res.json({ modules });
  } catch (error) {
    next(error);
  }
});

router.post('/config/modules', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const parsed = moduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '模块配置不完整' });
      return;
    }
    const module = await saveModule(normalizeModuleInput(parsed.data));
    if (module && Array.isArray(req.body.fields)) await replaceModuleFields(module.key, req.body.fields as ModuleField[]);
    res.status(201).json({ module: module ? await findModule(module.key) : module });
  } catch (error) {
    next(error);
  }
});

router.put('/config/modules/:id', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const parsed = moduleSchema.safeParse({ ...req.body, id: Number(req.params.id) });
    if (!parsed.success) {
      res.status(400).json({ message: '模块配置不完整' });
      return;
    }
    const module = await saveModule(normalizeModuleInput(parsed.data));
    if (module && Array.isArray(req.body.fields)) await replaceModuleFields(module.key, req.body.fields as ModuleField[]);
    res.json({ module: module ? await findModule(module.key) : module });
  } catch (error) {
    next(error);
  }
});

router.delete('/config/modules/:id', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const moduleId = Number(req.params.id);
    const rows = await all<{ module_key: string }>('SELECT module_key FROM module_configs WHERE id = ?', [moduleId]);
    const moduleKey = rows[0]?.module_key;
    if (!moduleKey) {
      res.status(404).json({ message: '模块不存在' });
      return;
    }
    run('DELETE FROM module_fields WHERE module_key = ?', [moduleKey]);
    run('DELETE FROM module_permissions WHERE module_key = ?', [moduleKey]);
    run('DELETE FROM module_configs WHERE id = ?', [moduleId]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post('/config/modules/:id/sync', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const modules = await listModules({ enabledOnly: false, dataSourceId: req.user!.dataSourceId });
    const module = modules.find((item) => item.id === Number(req.params.id));
    if (!module) {
      res.status(404).json({ message: '模块不存在' });
      return;
    }
    const client = await getClientForModule(module, req.user!.dataSourceId) as any;
    if (typeof client.syncModule !== 'function') {
      res.json({ message: '当前平台暂不支持自动创建工作表，请手动创建后填写 sheetId。' });
      return;
    }
    const result = await client.syncModule(module);
    const sheetId = result?.sheetId || result?.id;
    const savedModule = sheetId && module.id ? await updateModuleSheetId(module.id, sheetId) : module;
    res.json({ result, module: savedModule, message: result?.created ? '已创建工作表并同步表头' : '已同步表头' });
  } catch (error) {
    next(error);
  }
});

router.get('/config/modules/:id/fields', async (req, res, next) => {
  try {
    const modules = await listModules({ enabledOnly: false, dataSourceId: req.user!.dataSourceId });
    const module = modules.find((item) => item.id === Number(req.params.id));
    if (!module) {
      res.status(404).json({ message: '模块不存在' });
      return;
    }
    res.json({ fields: module.fields });
  } catch (error) {
    next(error);
  }
});

router.put('/config/modules/:id/fields', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const modules = await listModules({ enabledOnly: false, dataSourceId: req.user!.dataSourceId });
    const module = modules.find((item) => item.id === Number(req.params.id));
    if (!module) {
      res.status(404).json({ message: '模块不存在' });
      return;
    }
    const parsed = fieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '字段配置不完整' });
      return;
    }
    const saved = await replaceModuleFields(module.key, parsed.data.fields);
    res.json({ module: saved });
  } catch (error) {
    next(error);
  }
});

router.get('/audit-logs', async (req, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ message: '只有管理员可以查看操作日志' });
    return;
  }
  const logs = await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
  res.json({ logs });
});

async function getModuleRows(req: any, res: any, next: any) {
  try {
    const module = await findModule(req.params.module);
    if (!module) {
      res.status(404).json({ message: '模块不存在或无权访问' });
      return;
    }
    const decorated = await decorateModule(req.user, module);
    if (!decorated.canView) {
      res.status(404).json({ message: '模块不存在或无权访问' });
      return;
    }
    const client = await getClientForModule(module, req.user.dataSourceId);
    const rows = module.category === 'project'
      ? filterProjectRowsForUser(req.user, await client.getRows(module))
      : await client.getRows(module);
    res.json({
      module: decorated,
      canEdit: decorated.canEdit,
      canCreate: decorated.canCreate,
      canUpdate: decorated.canUpdate,
      canDelete: decorated.canDelete,
      rows
    });
  } catch (error) {
    next(error);
  }
}

async function createModuleRow(req: any, res: any, next: any) {
  try {
    const module = await findModule(req.params.module);
    if (!module || !(await modulePermission(req.user, module)).canCreate) {
      res.status(403).json({ message: '没有新增权限' });
      return;
    }
    const client = await getClientForModule(module, req.user.dataSourceId);
    const payload = module.category === 'project' ? forceOwnDeveloper(req.user, req.body) : req.body;
    const row = await client.createRow(module, payload);
    await addAuditLog({ userId: req.user.id, username: req.user.username, moduleKey: module.key, action: 'create', rowId: row.id, payload });
    res.status(201).json({ row });
  } catch (error) {
    next(error);
  }
}

async function updateModuleRow(req: any, res: any, next: any) {
  try {
    const module = await findModule(req.params.module);
    if (!module || !(await modulePermission(req.user, module)).canUpdate) {
      res.status(403).json({ message: '没有编辑权限' });
      return;
    }
    const client = await getClientForModule(module, req.user.dataSourceId);
    const rows = await client.getRows(module);
    const current = rows.find((item: any) => item.id === req.params.rowId || String(item.rowNumber) === req.params.rowId);
    if (module.category === 'project' && !isOwnProjectRow(req.user, current)) {
      res.status(403).json({ message: '只能编辑研发人员为自己的项目数据' });
      return;
    }
    if (isCompletedRow(current)) {
      res.status(403).json({ message: '已完成的数据不能编辑' });
      return;
    }
    const payload = module.category === 'project' ? forceOwnDeveloper(req.user, req.body) : req.body;
    if (module.category === 'project') assertOwnDeveloperPayload(req.user, payload);
    const row = await client.updateRow(module, req.params.rowId, payload);
    await addAuditLog({ userId: req.user.id, username: req.user.username, moduleKey: module.key, action: 'update', rowId: req.params.rowId, payload });
    res.json({ row });
  } catch (error) {
    next(error);
  }
}

async function deleteModuleRow(req: any, res: any, next: any) {
  try {
    const module = await findModule(req.params.module);
    if (!module || !(await modulePermission(req.user, module)).canDelete) {
      res.status(403).json({ message: '没有删除权限' });
      return;
    }
    const client = await getClientForModule(module, req.user.dataSourceId);
    const rows = await client.getRows(module);
    const current = rows.find((item: any) => item.id === req.params.rowId || String(item.rowNumber) === req.params.rowId);
    if (module.category === 'project' && !isOwnProjectRow(req.user, current)) {
      res.status(403).json({ message: '只能删除研发人员为自己的项目数据' });
      return;
    }
    if (isCompletedRow(current)) {
      res.status(403).json({ message: '已完成的数据不能删除' });
      return;
    }
    await client.deleteRow(module, req.params.rowId);
    await addAuditLog({ userId: req.user.id, username: req.user.username, moduleKey: module.key, action: 'delete', rowId: req.params.rowId });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getClientForModule(module: ModuleConfig, selectedDataSourceId?: number) {
  return getDataSourceClient(moduleDataSourceId(module, selectedDataSourceId));
}

function normalizeModuleInput(input: z.infer<typeof moduleSchema>) {
  return {
    ...input,
    dataSourceId: input.dataSourceId ?? undefined,
    sheetId: input.sheetId || undefined
  };
}

function isCompletedRow(row: any) {
  return ['是', '已完成', '完成', 'true'].includes(String(row?.isCompleted ?? '').trim().toLowerCase());
}
