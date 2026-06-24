/**
 * 前端 API 客户端：集中处理 HTTP 调用、token 存储和响应解包。
 */
import axios from 'axios';
import type {
  CreateManagedUserPayload,
  DataSourceInstance,
  DataSourcePlatform,
  ManagedUser,
  ModuleConfig,
  ModuleField,
  ModulePermission,
  NotificationLog,
  NotificationSendResult,
  NotificationSettings,
  NotificationUserSettings,
  PermissionSubjectType,
  PlatformKey,
  PlatformConfigs,
  ApiUsageSummary,
  DingTalkSyncSettings,
  RuntimeSettings,
  SheetRow,
  SyncOverview,
  StaffMember,
  StaffMembersResponse,
  UpdateManagedUserPayload,
  User
} from './types';

const TOKEN_KEY = 'tms-token';

export const api = axios.create({
  baseURL: '/api'
});
// 登录后为每个 API 请求附加 bearer token。
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
// 数据源变更或禁用会使当前会话失效，并引导用户回到登录页。
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 409 && error.response?.data?.code === 'DATA_SOURCE_CHANGED') {
      localStorage.removeItem(TOKEN_KEY);
      const message = error.response.data.message || '数据源已变更，请重新登录';
      if (location.pathname !== '/login') {
        location.href = `/login?oauthError=${encodeURIComponent(message)}`;
      }
    }
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      if (location.pathname !== '/login') {
        const message = error.response.data?.code === 'SESSION_REPLACED'
          ? error.response.data.message || '账号已在其他设备登录，请重新登录'
          : '';
        location.href = message ? `/login?oauthError=${encodeURIComponent(message)}` : '/login';
      }
    }
    return Promise.reject(error);
  }
);

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(username: string, password: string, platform: PlatformKey) {
  const { data } = await api.post<{ token: string; user: User }>('/auth/login', { username, password, platform });
  setToken(data.token);
  return data;
}

export function oauthStartUrl(provider: PlatformKey, dataSourceId?: number) {
  const query = dataSourceId ? `?dataSourceId=${encodeURIComponent(dataSourceId)}` : '';
  return `/api/auth/oauth/${provider}/start${query}`;
}

export async function getLoginConfig() {
  const { data } = await api.get<{ providers: Array<{ key: PlatformKey; label: string }>; localLoginEnabled: boolean }>('/auth/login-config');
  return data;
}

export async function getApiUsage(platform: PlatformKey = 'dingtalk') {
  const { data } = await api.get<{ usage: ApiUsageSummary }>('/admin/api-usage', { params: { platform } });
  return data.usage;
}

export async function getSyncOverview(dataSourceId?: number) {
  const { data } = await api.get<{ overview: SyncOverview }>('/admin/sync-overview', { params: { dataSourceId } });
  return data.overview;
}

export async function getDingTalkSyncSettings() {
  const { data } = await api.get<{ settings: DingTalkSyncSettings }>('/admin/dingtalk-sync/settings');
  return data.settings;
}

export async function saveDingTalkSyncSettings(settings: DingTalkSyncSettings) {
  const { data } = await api.put<{ settings: DingTalkSyncSettings }>('/admin/dingtalk-sync/settings', settings);
  return data.settings;
}

export async function getRuntimeSettings() {
  const { data } = await api.get<{ settings: RuntimeSettings }>('/admin/runtime/settings');
  return data.settings;
}

export async function saveRuntimeSettings(settings: Partial<RuntimeSettings>) {
  const { data } = await api.put<{ settings: RuntimeSettings }>('/admin/runtime/settings', settings);
  return data.settings;
}

export async function getPlatformConfigs() {
  const { data } = await api.get<{ configs: PlatformConfigs }>('/admin/platform-configs');
  return data.configs;
}

export async function savePlatformConfigs(configs: PlatformConfigs) {
  const { data } = await api.put<{ configs: PlatformConfigs }>('/admin/platform-configs', configs);
  return data.configs;
}

export async function refreshApiCache(payload: { platform?: PlatformKey; dataSourceId?: number; moduleKey?: string } = {}) {
  const { data } = await api.post<{ removed: number }>('/admin/cache/refresh', payload);
  return data;
}

export async function syncDingTalkNow(payload: { dataSourceId?: number; moduleKey?: string } = {}) {
  const { data } = await api.post('/admin/dingtalk-sync', payload);
  return data;
}

export async function getMe() {
  const { data } = await api.get<{ user: User }>('/me');
  return data.user;
}

export async function getDataSourcePlatforms() {
  const { data } = await api.get<{ platforms: DataSourcePlatform[] }>('/data-source/platforms');
  return data.platforms;
}

export async function getDataSourceInstances(platform?: PlatformKey, includeDisabled = false) {
  const { data } = await api.get<{ instances: DataSourceInstance[] }>('/data-source/instances', {
    params: { platform, includeDisabled }
  });
  return data.instances;
}

export async function saveDataSourceInstance(instance: DataSourceInstance) {
  const { data } = instance.id
    ? await api.put<{ instance: DataSourceInstance }>(`/data-source/instances/${instance.id}`, instance)
    : await api.post<{ instance: DataSourceInstance }>('/data-source/instances', instance);
  return data.instance;
}

export async function deleteDataSourceInstance(id: number) {
  await api.delete(`/data-source/instances/${id}`);
}

export async function hardDeleteDataSourceInstance(id: number) {
  const { data } = await api.delete<{ deleted: boolean; modules: number }>(`/data-source/instances/${id}/hard`);
  return data;
}

export async function getModules() {
  const { data } = await api.get<{ modules: ModuleConfig[] }>('/modules');
  return data.modules;
}

export async function getProjectModules() {
  const { data } = await api.get<{ modules: ModuleConfig[] }>('/project-modules');
  return data.modules;
}

export async function getConfigModules() {
  const { data } = await api.get<{ modules: ModuleConfig[] }>('/config/modules');
  return data.modules;
}

export async function getReferenceModules() {
  const { data } = await api.get<{ modules: ModuleConfig[] }>('/config/reference-modules');
  return data.modules;
}

export async function saveConfigModule(module: ModuleConfig) {
  const { data } = module.id
    ? await api.put<{ module: ModuleConfig }>(`/config/modules/${module.id}`, module)
    : await api.post<{ module: ModuleConfig }>('/config/modules', module);
  return data.module;
}

export async function deleteConfigModule(id: number) {
  await api.delete(`/config/modules/${id}`);
}

export async function syncConfigModule(id: number) {
  const { data } = await api.post(`/config/modules/${id}/sync`);
  return data;
}

export async function saveModuleFields(moduleId: number, fields: ModuleField[]) {
  const { data } = await api.put<{ module: ModuleConfig }>(`/config/modules/${moduleId}/fields`, { fields });
  return data.module;
}

export async function getSummary() {
  const { data } = await api.get('/dashboard/summary');
  return data;
}

export async function getRows(moduleKey: string) {
  const { data } = await api.get<{ module: ModuleConfig; canEdit: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean; cacheMeta?: any; rows: SheetRow[] }>(`/sheets/${moduleKey}/rows`);
  return data;
}

export async function getProjectRows(moduleKey: string) {
  const { data } = await api.get<{ module: ModuleConfig; canEdit: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean; cacheMeta?: any; rows: SheetRow[] }>(`/project-modules/${moduleKey}/rows`);
  return data;
}

export async function getStaffOptions() {
  const { data } = await api.get<{ product: string[]; tester: string[]; developer: string[] }>('/staff-options');
  return data;
}

export async function getStaffMembers() {
  const { data } = await api.get<StaffMembersResponse>('/staff/members');
  return data;
}

export async function saveStaffAssignments(members: StaffMember[]) {
  const { data } = await api.put<StaffMembersResponse>('/staff/assignments', { members });
  return data;
}

export async function initializeStaffAssignments(sourceDataSourceId: number, targetDataSourceId?: number) {
  const { data } = await api.post<StaffMembersResponse>('/staff/initialize', { sourceDataSourceId, targetDataSourceId });
  return data;
}

export async function createRow(moduleKey: string, payload: Record<string, unknown>) {
  const { data } = await api.post<{ row: SheetRow }>(`/sheets/${moduleKey}/rows`, payload);
  return data.row;
}

export async function createProjectRow(moduleKey: string, payload: Record<string, unknown>) {
  const { data } = await api.post<{ row: SheetRow }>(`/project-modules/${moduleKey}/rows`, payload);
  return data.row;
}

export async function updateRow(moduleKey: string, rowId: string, payload: Record<string, unknown>) {
  const { data } = await api.put<{ row: SheetRow }>(`/sheets/${moduleKey}/rows/${rowId}`, payload);
  return data.row;
}

export async function updateProjectRow(moduleKey: string, rowId: string, payload: Record<string, unknown>) {
  const { data } = await api.put<{ row: SheetRow }>(`/project-modules/${moduleKey}/rows/${rowId}`, payload);
  return data.row;
}

export async function deleteRow(moduleKey: string, rowId: string) {
  await api.delete(`/sheets/${moduleKey}/rows/${rowId}`);
}

export async function deleteProjectRow(moduleKey: string, rowId: string) {
  await api.delete(`/project-modules/${moduleKey}/rows/${rowId}`);
}

export async function getAuditLogs() {
  const { data } = await api.get('/audit-logs');
  return data.logs;
}

export async function getUsers() {
  const { data } = await api.get<{ users: ManagedUser[] }>('/users');
  return data.users;
}

export async function createManagedUser(user: CreateManagedUserPayload) {
  const { data } = await api.post<{ user: ManagedUser }>('/users', user);
  return data.user;
}

export async function updateManagedUser(user: UpdateManagedUserPayload) {
  const { data } = await api.put<{ user: ManagedUser }>(`/users/${user.id}`, user);
  return data.user;
}

export async function getPermissions(subjectType: PermissionSubjectType, subjectId: string) {
  const { data } = await api.get<{ permissions: ModulePermission[] }>('/permissions', {
    params: { subjectType, subjectId }
  });
  return data.permissions;
}

export async function savePermissions(subjectType: PermissionSubjectType, subjectId: string, permissions: ModulePermission[]) {
  const { data } = await api.put<{ permissions: ModulePermission[] }>('/permissions', {
    subjectType,
    subjectId,
    permissions: permissions.map((item) => ({
      moduleKey: item.moduleKey,
      canView: item.canView,
      canCreate: item.canCreate,
      canUpdate: item.canUpdate,
      canDelete: item.canDelete
    }))
  });
  return data.permissions;
}

export async function syncEnterpriseMembers() {
  const { data } = await api.post<{ total: number; created: number; updated: number; users: ManagedUser[] }>('/enterprise-members/sync');
  return data;
}

export async function getNotificationSettings() {
  const { data } = await api.get<{ settings: NotificationSettings }>('/notification/settings');
  return data.settings;
}

export async function saveNotificationSettings(settings: NotificationSettings) {
  const { data } = await api.put<{ settings: NotificationSettings }>('/notification/settings', settings);
  return data.settings;
}

export async function getNotificationUserSettings() {
  const { data } = await api.get<{ settings: NotificationUserSettings }>('/notification/my-settings');
  return data.settings;
}

export async function saveNotificationUserSettings(settings: NotificationUserSettings) {
  const { data } = await api.put<{ settings: NotificationUserSettings }>('/notification/my-settings', settings);
  return data.settings;
}

export async function sendNotificationTest(channel?: 'dingtalk_robot' | 'feishu_robot') {
  const { data } = await api.post<{ result: { results: NotificationSendResult[] } }>('/notification/test', { channel });
  return data;
}

export async function pushDashboardNotification(channel?: 'dingtalk_robot' | 'feishu_robot') {
  const { data } = await api.post<{
    results: NotificationSendResult[];
    summary: { developing: number; testing: number };
  }>('/notification/push-dashboard', { channel });
  return data;
}

export async function getNotificationLogs() {
  const { data } = await api.get<{ logs: NotificationLog[] }>('/notification/logs');
  return data.logs;
}
