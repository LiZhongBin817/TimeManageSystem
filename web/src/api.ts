import axios from 'axios';
import type { ModuleConfig, SheetRow, User } from './types';

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

export async function login(username: string, password: string) {
  const { data } = await api.post<{ token: string; user: User }>('/auth/login', { username, password });
  setToken(data.token);
  return data;
}

export async function getMe() {
  const { data } = await api.get<{ user: User }>('/me');
  return data.user;
}

export async function getModules() {
  const { data } = await api.get<{ modules: ModuleConfig[] }>('/modules');
  return data.modules;
}

export async function getSummary() {
  const { data } = await api.get('/dashboard/summary');
  return data;
}

export async function getRows(moduleKey: string) {
  const { data } = await api.get<{ module: ModuleConfig; canEdit: boolean; rows: SheetRow[] }>(`/sheets/${moduleKey}/rows`);
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

export async function updateRow(moduleKey: string, rowId: string, payload: Record<string, unknown>) {
  const { data } = await api.put<{ row: SheetRow }>(`/sheets/${moduleKey}/rows/${rowId}`, payload);
  return data.row;
}

export async function deleteRow(moduleKey: string, rowId: string) {
  await api.delete(`/sheets/${moduleKey}/rows/${rowId}`);
}

export async function getAuditLogs() {
  const { data } = await api.get('/audit-logs');
  return data.logs;
}
