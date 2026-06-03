import axios from 'axios';
import type { DataSourceInstance, DataSourcePlatform, ManagedUser, ModuleConfig, ModuleField, PlatformKey, SheetRow, User } from './types';

const TOKEN_KEY = 'tms-token';

export const api = axios.create({
  baseURL: '/api'
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      if (location.pathname !== '/login') location.href = '/login';
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

export async function login(username: string, password: string, dataSourceId: number) {
  const { data } = await api.post<{ token: string; user: User }>('/auth/login', { username, password, dataSourceId });
  setToken(data.token);
  return data;
}

export function oauthStartUrl(provider: PlatformKey, dataSourceId: number) {
  return `/api/auth/oauth/${provider}/start?dataSourceId=${encodeURIComponent(dataSourceId)}`;
}

export async function getLoginConfig() {
  const { data } = await api.get<{ providers: Array<{ key: PlatformKey; label: string }>; localLoginEnabled: boolean }>('/auth/login-config');
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
  const { data } = await api.get<{ module: ModuleConfig; canEdit: boolean; rows: SheetRow[] }>(`/sheets/${moduleKey}/rows`);
  return data;
}

export async function getProjectRows(moduleKey: string) {
  const { data } = await api.get<{ module: ModuleConfig; canEdit: boolean; rows: SheetRow[] }>(`/project-modules/${moduleKey}/rows`);
  return data;
}

export async function getStaffOptions() {
  const { data } = await api.get<{ product: string[]; tester: string[]; developer: string[] }>('/staff-options');
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

export async function updateManagedUser(user: Pick<ManagedUser, 'id' | 'displayName' | 'role' | 'enabled' | 'defaultDataSourceId'>) {
  const { data } = await api.put<{ user: ManagedUser }>(`/users/${user.id}`, user);
  return data.user;
}
