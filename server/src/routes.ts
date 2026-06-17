/**
 * REST API 层：校验请求、执行权限控制，并把数据操作委托给服务和数据源客户端。
 */
import { Router } from 'express';
import { z } from 'zod';
import { login, loginWithOAuth, requireAuth, resolveAuthUser, signOAuthState, verifyOAuthState } from './auth';
import {
  ModuleConfig,
  ModuleField,
  canConfigure,
  findModule,
  getDataSource,
  hardDeleteDataSource,
  listDataSources,
  listModules,
  replaceModuleFields,
  saveDataSource,
  saveModule,
  updateModuleSheetId
} from './config/modules';
import {
  PermissionSubjectType,
  StaffRole,
  addAuditLog,
  all,
  copyDataSourceStaffAssignments,
  countDataSourceStaffAssignments,
  createLocalUser,
  findUserByLoginNameOrUsername,
  getModulePermission,
  getApiUsageSummary,
  getDingTalkSyncSettings,
  getSyncOverview,
  invalidateSheetCache,
  importStaffOptionsToAssignments,
  isLoginNameAvailable,
  listDataSourceStaffMembers,
  listDataSourceStaffOptions,
  listModulePermissions,
  listUsers,
  logEnterpriseMemberSync,
  replaceDataSourceStaffAssignments,
  replaceModulePermissions,
  run,
  saveDingTalkSyncSettings,
  upsertEnterpriseMembers,
  updateUser
} from './db';
import { getDataSourceClient, moduleDataSourceId } from './dataSources';
import { authUrl, callbackUri, fetchOAuthIdentity, frontendCallbackUrl, frontendLoginErrorUrl } from './oauth/oauthClients';
import { buildDashboardSummary } from './services/dashboardSummary';
import { isDingTalkSyncRunning, syncDingTalkToLocal } from './services/dingtalkSync';
import { syncEnterpriseMembersForDingTalk } from './services/enterpriseMemberSync';
import {
  getNotificationSettings,
  getNotificationUserSettings,
  listNotificationLogs,
  pushDashboardNotification,
  saveNotificationSettings,
  saveNotificationUserSettings,
  sendTestNotification
} from './services/notification';
import {
  assertOwnDeveloperPayload,
  filterProjectRowsForUser,
  forceOwnDeveloper,
  isOwnProjectRow
} from './services/rowAccess';

export const router = Router();

// 移除敏感数据库字段，并补充前端易用的登录能力标记。
function serializeUser(user: any) {
  const hasLocalLogin = Boolean(user.password_hash);
  const hasEnterpriseLogin = Number(user.identity_count || 0) > 0;
  const loginMethod = hasLocalLogin && hasEnterpriseLogin
    ? 'both'
    : hasLocalLogin
      ? 'local'
      : hasEnterpriseLogin
        ? 'enterprise'
        : 'none';
  return {
    id: user.id,
    username: user.username,
    loginName: user.login_name || '',
    displayName: user.display_name,
    role: user.role,
    enabled: Boolean(user.enabled),
    defaultDataSourceId: user.default_data_source_id || null,
    defaultDataSourceName: user.default_data_source_name || '',
    hasLocalLogin,
    hasEnterpriseLogin,
    loginMethod,
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
  loginName: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  displayName: z.string().min(1),
  role: z.enum(['admin', 'editor', 'viewer']),
  enabled: z.boolean(),
  defaultDataSourceId: z.number().int().positive().nullable().optional(),
  newPassword: z.string().max(64).optional(),
  resetPassword: z.boolean().optional()
});

const usernameSchema = z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9_.-]+$/);

const createUserSchema = z.object({
  loginName: usernameSchema.optional(),
  username: usernameSchema.optional(),
  password: z.string().min(6).max(64),
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
  sortOrder: z.number().default(0),
  staffTemplateDataSourceId: z.number().int().positive().nullable().optional()
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
  sortOrder: z.number().default(0),
  referenceModuleKey: z.string().optional().nullable()
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

const staffAssignmentSchema = z.object({
  members: z.array(z.object({
    userId: z.number().int().positive().nullable().optional(),
    displayName: z.string().min(1),
    product: z.boolean().optional(),
    tester: z.boolean().optional(),
    developer: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().optional()
  }))
});

const staffInitializeSchema = z.object({
  sourceDataSourceId: z.number().int().positive(),
  targetDataSourceId: z.number().int().positive().optional()
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

// 把实际权限补到模块配置上，便于页面隐藏不可用操作。
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

async function legacyStaffOptionsForDataSource(user: NonNullable<Express.Request['user']>) {
  const empty: Record<StaffRole, string[]> = { product: [], tester: [], developer: [] };
  const staffModule = await findModule('staff');
  if (!staffModule) return empty;
  const staffDataSourceId = moduleDataSourceId(staffModule, user.dataSourceId);
  if (staffDataSourceId !== user.dataSourceId) return empty;
  const client = await getClientForModule(staffModule, user.dataSourceId, user);
  const rows = await client.getRows(staffModule);
  const unique = (key: string) =>
    Array.from(new Set(rows.map((row: any) => String(row[key] || '').trim()).filter((value) => value && value !== '-')));
  return {
    product: unique('productOwner'),
    tester: unique('tester'),
    developer: unique('developer')
  };
}

// 首次使用时按需把旧版人员表格选项迁移为本地分配记录。
async function ensureStaffAssignments(user: NonNullable<Express.Request['user']>) {
  if (await countDataSourceStaffAssignments(user.dataSourceId)) return;
  try {
    const options = await legacyStaffOptionsForDataSource(user);
    if (options.product.length || options.tester.length || options.developer.length) {
      await importStaffOptionsToAssignments(user.dataSourceId, options);
    }
  } catch {
    // 旧表格导入只做尽力尝试，本地人员分配仍然是可信来源。
  }
}

function visibleDataSourcesForUser(user: NonNullable<Express.Request['user']>, dataSources: any[]) {
  if (user.role === 'admin') return dataSources;
  return dataSources.filter((item) => item.ownerUserId === user.id || item.id === user.dataSourceId);
}

async function requireDataSourceAccess(req: any, res: any, dataSourceId: number) {
  const dataSource = await getDataSource(dataSourceId);
  if (!dataSource) {
    res.status(404).json({ message: '数据源实例不存在' });
    return undefined;
  }
  if (req.user.role !== 'admin' && dataSource.ownerUserId !== req.user.id && dataSource.id !== req.user.dataSourceId) {
    res.status(403).json({ message: '不能操作其他用户的数据源实例' });
    return undefined;
  }
  return dataSource;
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
    const user = await resolveAuthUser(req.headers.authorization);
    res.json({ instances: user ? visibleDataSourcesForUser(user, instances) : instances });
  } catch (error) {
    next(error);
  }
});

router.get('/auth/login-config', async (_req, res, next) => {
  try {
    const dataSources = await listDataSources(undefined, false);
    const seen = new Set<string>();
    const providers = dataSources
      .filter((item) => item.config.loginEnabled !== 'false')
      .filter((item) => {
        if (seen.has(item.platform)) return false;
        seen.add(item.platform);
        return true;
      })
      .map((item) => ({ key: item.platform, label: item.platform === 'feishu' ? 'Feishu Login' : 'DingTalk Login' }));
    const localLoginEnabled = dataSources.some((item) =>
      item.config.localLoginEnabled === 'true' || process.env.LOCAL_LOGIN_ENABLED === 'true'
    );
    res.json({ providers, localLoginEnabled });
  } catch (error) {
    next(error);
  }
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
    if (dataSource.config.localLoginEnabled !== 'true' && process.env.LOCAL_LOGIN_ENABLED !== 'true') {
      res.status(403).json({ message: 'Local fallback login is disabled' });
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
    const code = String(req.query.code || req.query.authCode || '');
    const state = String(req.query.state || '');
    console.log(`[oauth-callback] received provider=${provider} code=${code ? 'yes' : 'no'} state=${state ? 'yes' : 'no'}`);
    if (!code || !state) throw new Error('OAuth 回调缺少授权码或 state');
    const payload = verifyOAuthState(state);
    if (payload.provider !== provider) throw new Error('OAuth state 与登录平台不匹配');
    const dataSource = (await listDataSources(provider, true)).find((item) => item.id === payload.dataSourceId && item.enabled);
    if (!dataSource) throw new Error('数据源实例不可用');
    console.log(`[oauth-callback] fetching identity provider=${provider} dataSource=${dataSource.id}`);
    const identity = await fetchOAuthIdentity(provider, dataSource, code);
    console.log(`[oauth-callback] identity ready provider=${provider} providerUserId=${identity.providerUserId ? 'yes' : 'no'} unionId=${identity.unionId ? 'yes' : 'no'}`);
    console.log(`[oauth-callback] building session provider=${provider} dataSource=${dataSource.id}`);
    const result = await loginWithOAuth(provider, dataSource.id, identity);
    const redirectUrl = frontendCallbackUrl(result.token);
    console.log(`[oauth-callback] success provider=${provider} user=${result.user.displayName} dataSource=${dataSource.id}`);
    res.redirect(redirectUrl);
  } catch (error: any) {
    console.error('[oauth-callback] failed', error?.message || error);
    res.redirect(frontendLoginErrorUrl(error.message || '企业登录失败'));
  }
});

// 下面的路由都要求请求已通过登录认证。
router.use(requireAuth);

router.get('/admin/api-usage', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can view API usage' });
      return;
    }
    res.json({ usage: await getApiUsageSummary(String(req.query.platform || 'dingtalk')) });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/sync-overview', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can view sync status' });
      return;
    }
    res.json({ overview: await getSyncOverview(req.query.dataSourceId ? Number(req.query.dataSourceId) : undefined) });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/dingtalk-sync/settings', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can view sync settings' });
      return;
    }
    res.json({ settings: await getDingTalkSyncSettings() });
  } catch (error) {
    next(error);
  }
});

router.put('/admin/dingtalk-sync/settings', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can update sync settings' });
      return;
    }
    const parsed = z.object({
      enabled: z.boolean(),
      scheduledTime: z.string().regex(/^\d{2}:\d{2}$/),
      startupSyncEnabled: z.boolean(),
      startupDelayMs: z.number().int().min(0).max(3600000)
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid DingTalk sync settings' });
      return;
    }
    res.json({ settings: await saveDingTalkSyncSettings(parsed.data) });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/cache/refresh', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can refresh cache' });
      return;
    }
    const removed = await invalidateSheetCache({
      platform: String(req.body?.platform || 'dingtalk'),
      dataSourceId: req.body?.dataSourceId ? Number(req.body.dataSourceId) : undefined,
      moduleKey: req.body?.moduleKey ? String(req.body.moduleKey) : undefined
    });
    res.json({ removed });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/dingtalk-sync', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: 'Only admins can sync DingTalk data' });
      return;
    }
    const dataSourceId = req.body?.dataSourceId ? Number(req.body.dataSourceId) : undefined;
    if (isDingTalkSyncRunning()) {
      res.status(202).json({ accepted: true, running: true, message: '钉钉同步正在执行中，请稍后刷新同步记录' });
      return;
    }
    const options = {
      dataSourceId,
      moduleKey: req.body?.moduleKey ? String(req.body.moduleKey) : undefined
    };
    syncDingTalkToLocal(options)
      .then(async () => {
        await syncEnterpriseMembersForDingTalk({ dataSourceId });
      })
      .catch((error) => {
        console.error('[dingtalk-sync] manual background sync failed', error);
      });
    res.status(202).json({
      accepted: true,
      running: true,
      message: '钉钉同步已开始，请稍后刷新同步记录'
    });
  } catch (error) {
    next(error);
  }
});

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

router.post('/users', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以管理用户' });
      return;
    }
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '用户信息不完整，登录账号需为 3-50 位字母、数字、下划线、点或短横线，密码至少 6 位' });
      return;
    }
    const loginName = parsed.data.loginName || parsed.data.username || '';
    if (!loginName) {
      res.status(400).json({ message: '登录账号不能为空' });
      return;
    }
    const existing = await findUserByLoginNameOrUsername(loginName);
    if (existing) {
      res.status(409).json({ message: '登录账号已存在，请换一个' });
      return;
    }
    const created = await createLocalUser({ ...parsed.data, loginName });
    const users = await listUsers();
    const user = users.find((item) => item.id === created?.id) || created;
    res.status(201).json({ user: serializeUser(user) });
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
    if (parsed.data.loginName && !(await isLoginNameAvailable(parsed.data.loginName, targetId))) {
      res.status(409).json({ message: '登录账号已存在，请换一个' });
      return;
    }
    const nextPassword = parsed.data.newPassword?.trim() ? parsed.data.newPassword : undefined;
    if (nextPassword && nextPassword.length < 6) {
      res.status(400).json({ message: '新密码至少 6 位' });
      return;
    }
    const user = await updateUser({
      id: targetId,
      ...parsed.data,
      newPassword: nextPassword,
      resetPassword: !nextPassword && Boolean(parsed.data.resetPassword)
    });
    const usersAfterUpdate = await listUsers();
    const refreshed = usersAfterUpdate.find((item) => item.id === user?.id) || user;
    res.json({ user: serializeUser(refreshed) });
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
    logEnterpriseMemberSync({
      provider: req.user!.platform,
      dataSourceId: req.user!.dataSourceId,
      status: 'success',
      total: result.total,
      created: result.created,
      updated: result.updated,
      message: 'manual sync'
    });
    const users = await listUsers();
    res.json({ ...result, users: users.map(serializeUser) });
  } catch (error) {
    logEnterpriseMemberSync({
      provider: req.user!.platform,
      dataSourceId: req.user!.dataSourceId,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error)
    });
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
    await ensureStaffAssignments(req.user!);
    res.json(await listDataSourceStaffOptions(req.user!.dataSourceId));
  } catch (error) {
    next(error);
  }
});

router.get('/staff/members', async (req, res, next) => {
  try {
    await ensureStaffAssignments(req.user!);
    const [members, options] = await Promise.all([
      listDataSourceStaffMembers(req.user!.dataSourceId),
      listDataSourceStaffOptions(req.user!.dataSourceId)
    ]);
    res.json({ dataSourceId: req.user!.dataSourceId, members, options });
  } catch (error) {
    next(error);
  }
});

router.put('/staff/assignments', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以维护人员分组' });
      return;
    }
    const parsed = staffAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '人员分组配置不完整' });
      return;
    }
    const members = await replaceDataSourceStaffAssignments(req.user!.dataSourceId, parsed.data.members);
    res.json({ dataSourceId: req.user!.dataSourceId, members, options: await listDataSourceStaffOptions(req.user!.dataSourceId) });
  } catch (error) {
    next(error);
  }
});

router.post('/staff/initialize', async (req, res, next) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ message: '只有管理员可以初始化人员配置' });
      return;
    }
    const parsed = staffInitializeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '请选择人员模板数据源' });
      return;
    }
    const targetDataSourceId = parsed.data.targetDataSourceId || req.user!.dataSourceId;
    if (parsed.data.sourceDataSourceId === req.user!.dataSourceId) await ensureStaffAssignments(req.user!);
    const result = await copyDataSourceStaffAssignments(parsed.data.sourceDataSourceId, targetDataSourceId);
    res.json({
      ...result,
      dataSourceId: targetDataSourceId,
      members: await listDataSourceStaffMembers(targetDataSourceId),
      options: await listDataSourceStaffOptions(targetDataSourceId)
    });
  } catch (error) {
    next(error);
  }
});

// 基于当前可读项目模块和激活数据源直接生成看板数据。
router.get('/dashboard/summary', async (req, res, next) => {
  try {
    res.json(await buildDashboardSummary(req.user!));
  } catch (error) {
    next(error);
  }
});

router.get('/notification/settings', async (req, res, next) => {
  try {
    const settings = await getNotificationSettings();
    if (req.user!.role !== 'admin') {
      res.json({
        settings: {
          enabled: settings.enabled,
          webhookUrl: settings.webhookUrl ? 'configured' : '',
          secret: settings.secret ? 'configured' : '',
          keywords: settings.keywords,
          scheduledTime: settings.scheduledTime,
          lastScheduledDate: settings.lastScheduledDate
        }
      });
      return;
    }
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

router.get('/notification/my-settings', async (req, res, next) => {
  try {
    res.json({ settings: await getNotificationUserSettings(req.user!.id) });
  } catch (error) {
    next(error);
  }
});

router.put('/notification/my-settings', async (req, res, next) => {
  try {
    const parsed = z.object({
      enabled: z.boolean().default(false),
      scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00')
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: '个人定时推送配置不完整' });
      return;
    }
    res.json({ settings: await saveNotificationUserSettings(req.user!.id, parsed.data) });
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
    res.json({ result: await sendTestNotification(req.user!) });
  } catch (error) {
    next(error);
  }
});

router.post('/notification/push-dashboard', async (req, res, next) => {
  try {
    if (false && !['admin', 'editor'].includes(req.user!.role)) {
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
    res.json({ logs: await listNotificationLogs(req.user!) });
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
    const instance = await saveDataSource({ ...parsed.data, ownerUserId: req.user!.id });
    if (instance?.id && parsed.data.staffTemplateDataSourceId) {
      const sourceId = Number(parsed.data.staffTemplateDataSourceId);
      if (sourceId === req.user!.dataSourceId) await ensureStaffAssignments(req.user!);
      if (sourceId !== instance.id && await countDataSourceStaffAssignments(sourceId)) {
        await copyDataSourceStaffAssignments(sourceId, instance.id);
      }
    }
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
    const current = await requireDataSourceAccess(req, res, Number(req.params.id));
    if (!current) return;
    const instance = await saveDataSource({
      ...parsed.data,
      ownerUserId: current.ownerUserId ?? (req.user!.role === 'admin' ? null : req.user!.id)
    });
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
    const dataSource = await requireDataSourceAccess(req, res, Number(req.params.id));
    if (!dataSource) return;
    run('UPDATE data_source_instances SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [dataSource.id]);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.delete('/data-source/instances/:id/hard', async (req, res, next) => {
  try {
    if (!canConfigure(req.user!.role)) {
      res.status(403).json({ message: '没有配置权限' });
      return;
    }
    const dataSource = await requireDataSourceAccess(req, res, Number(req.params.id));
    if (!dataSource) return;
    const result = await hardDeleteDataSource(dataSource.id);
    res.json({ deleted: true, ...result });
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

router.get('/config/reference-modules', async (req, res, next) => {
  try {
    const modules = await listModules({ category: 'project', enabledOnly: false });
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
    const module = await saveModule(normalizeModuleInputForRequest(parsed.data, req.user!));
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
    const module = await saveModule(normalizeModuleInputForRequest(parsed.data, req.user!));
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
    const client = await getClientForModule(module, req.user!.dataSourceId, req.user!) as any;
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
    const modules = await listModules({ enabledOnly: false });
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
    const modules = await listModules({ enabledOnly: false });
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

/**
 * 旧版 /sheets 路由和新版 /project-modules 路由共用的行读取器。
 * 项目数据加载后再过滤，确保非管理员用户只能看到自己负责的研发行。
 */
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
    const client = await getClientForModule(module, req.user.dataSourceId, req.user);
    const rows = module.category === 'project'
      ? filterProjectRowsForUser(req.user, await client.getRows(module))
      : await client.getRows(module);
    res.json({
      module: decorated,
      canEdit: decorated.canEdit,
      canCreate: decorated.canCreate,
      canUpdate: decorated.canUpdate,
      canDelete: decorated.canDelete,
      cacheMeta: (rows as any).cacheMeta || null,
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
    const client = await getClientForModule(module, req.user.dataSourceId, req.user);
    const payload = module.category === 'project' ? forceOwnDeveloper(req.user, req.body) : req.body;
    const row = await client.createRow(module, payload);
    await addAuditLog({ userId: req.user.id, username: req.user.username, moduleKey: module.key, action: 'create', rowId: row.id, payload });
    res.status(201).json({ row });
  } catch (error) {
    next(error);
  }
}

// 更新前同时校验模块权限和行归属，再交给数据源适配器处理。
async function updateModuleRow(req: any, res: any, next: any) {
  try {
    const module = await findModule(req.params.module);
    if (!module || !(await modulePermission(req.user, module)).canUpdate) {
      res.status(403).json({ message: '没有编辑权限' });
      return;
    }
    const client = await getClientForModule(module, req.user.dataSourceId, req.user);
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
    const row = await client.updateRow(module, req.params.rowId, payload, current);
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
    const client = await getClientForModule(module, req.user.dataSourceId, req.user);
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
    await client.deleteRow(module, req.params.rowId, current);
    await addAuditLog({ userId: req.user.id, username: req.user.username, moduleKey: module.key, action: 'delete', rowId: req.params.rowId });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

async function getClientForModule(module: ModuleConfig, selectedDataSourceId?: number, user?: NonNullable<Express.Request['user']>) {
  return getDataSourceClient(moduleDataSourceId(module, selectedDataSourceId), user);
}

function normalizeModuleInput(input: z.infer<typeof moduleSchema>) {
  return {
    ...input,
    dataSourceId: input.dataSourceId ?? undefined,
    sheetId: input.sheetId || undefined,
    referenceModuleKey: input.referenceModuleKey || undefined
  };
}

// 新增模块默认使用用户当前选择的数据源，除非请求明确指定其它数据源。
function normalizeModuleInputForRequest(input: z.infer<typeof moduleSchema>, user: NonNullable<Express.Request['user']>) {
  const normalized = normalizeModuleInput(input);
  return {
    ...normalized,
    dataSourceId: normalized.dataSourceId ?? user.dataSourceId
  };
}

function isCompletedRow(row: any) {
  return ['是', '已完成', '完成', 'true'].includes(String(row?.isCompleted ?? '').trim().toLowerCase());
}
