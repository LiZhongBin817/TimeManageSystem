/**
 * 飞书表格适配器：在模块行数据、飞书工作表 API 和应用标准行结构之间做转换。
 */
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { ModuleConfig } from '../config/configStore';
import { SheetRow } from '../data/mockRows';
import {
  deleteLocalModuleRow,
  invalidateSheetCache,
  listPendingLocalModuleRows,
  markLocalModuleRowSync,
  replaceLocalModuleRows
} from '../db';

interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  spreadsheetToken?: string;
  baseUrl?: string;
  dataSourceId?: number;
}

interface EnterpriseMember {
  providerUserId: string;
  unionId?: string;
  openId?: string;
  name: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  department?: string;
  raw?: unknown;
}

const feishuHttpAgent = new http.Agent({ family: 4 });
const feishuHttpsAgent = new https.Agent({ family: 4 });
const feishuAxiosOptions = { httpAgent: feishuHttpAgent, httpsAgent: feishuHttpsAgent };

// 把从 0 开始的字段索引转换为飞书范围字符串使用的表格列名。
function columnName(index: number) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function excelSerialToDate(value: number) {
  const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  return date.toISOString().slice(0, 10);
}

/**
 * 轻量飞书适配器：对齐路由和服务层所依赖的钉钉客户端接口。
 */
export class FeishuSheetClient {
  private config: FeishuConfig;
  private http: AxiosInstance;
  private token?: { value: string; expiresAt: number };

  constructor(config: FeishuConfig) {
    this.config = {
      baseUrl: 'https://open.feishu.cn',
      ...config
    };
    this.http = axios.create({ baseURL: this.config.baseUrl, timeout: 12000, ...feishuAxiosOptions });
  }

  get isConfigured() {
    return Boolean(this.config.appId && this.config.appSecret && this.config.spreadsheetToken);
  }

  /** 从飞书根部门读取通讯录用户，用于账号同步。 */
  async listEnterpriseMembers(): Promise<EnterpriseMember[]> {
    if (!this.config.appId || !this.config.appSecret) return [];
    const token = await this.getAccessToken();
    const members: EnterpriseMember[] = [];
    let pageToken = '';

    while (true) {
      const response = await this.http.get('/open-apis/contact/v3/users/find_by_department', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          department_id: '0',
          department_id_type: 'open_department_id',
          user_id_type: 'open_id',
          page_size: 50,
          page_token: pageToken || undefined
        }
      });
      const data = response.data?.data || {};
      const items = data.items || [];
      for (const user of items) {
        const providerUserId = user.union_id || user.open_id || user.user_id;
        if (!providerUserId) continue;
        members.push({
          providerUserId,
          unionId: user.union_id,
          openId: user.open_id,
          name: user.name || user.en_name || providerUserId,
          avatar: user.avatar?.avatar_origin || user.avatar_url,
          mobile: user.mobile,
          email: user.email,
          department: Array.isArray(user.department_ids) ? user.department_ids.join(',') : undefined,
          raw: user
        });
      }
      if (!data.has_more) break;
      pageToken = data.page_token;
      if (!pageToken) break;
    }

    return members;
  }

  async listWorksheets() {
    const token = await this.getAccessToken();
    const response = await this.http.get(`/open-apis/sheets/v3/spreadsheets/${this.config.spreadsheetToken}/sheets/query`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const sheets = response.data?.data?.sheets || [];
    return sheets.map((sheet: any) => ({
      sheetId: sheet.sheet_id,
      name: sheet.title
    }));
  }

  /** 把模块字段映射到工作表单元格，并过滤完全空白的行。 */
  async getRows(module: ModuleConfig): Promise<SheetRow[]> {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${sheetId}!A${module.dataStartRow}:${lastColumn}2000`;
    const response = await this.http.get(`/open-apis/sheets/v2/spreadsheets/${this.config.spreadsheetToken}/values/${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const values: unknown[][] = response.data?.data?.valueRange?.values || [];
    return values
      .map((cells, index) => this.cellsToRow(module, cells, module.dataStartRow + index))
      .filter((row) => module.fields.some((field) => {
        const value = String(row[field.key] ?? '').trim();
        return value !== '' && value !== '-';
      }));
  }

  async createRow(module: ModuleConfig, payload: Record<string, unknown>) {
    const rows = await this.getRows(module);
    const rowNumber = rows.length + module.dataStartRow;
    const row = this.normalizePayload(module, payload, String(rowNumber), rowNumber);
    await this.writeRow(module, rowNumber, row);
    return row;
  }

  async updateRow(module: ModuleConfig, rowId: string, payload: Record<string, unknown>) {
    const rows = await this.getRows(module);
    const current = rows.find((item) => item.id === rowId || String(item.rowNumber) === rowId);
    if (!current?.rowNumber) throw new Error('未找到要更新的数据行');
    const row = { ...current };
    for (const field of module.fields) {
      if (!Object.prototype.hasOwnProperty.call(payload, field.key)) continue;
      const value = payload[field.key];
      row[field.key] = value === undefined || value === null || value === ''
        ? (field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-')
        : String(value);
    }
    await this.writeRow(module, current.rowNumber, row);
    return row;
  }

  async deleteRow(module: ModuleConfig, rowId: string) {
    const rows = await this.getRows(module);
    const current = rows.find((item) => item.id === rowId || String(item.rowNumber) === rowId);
    if (!current?.rowNumber) throw new Error('未找到要删除的数据行');
    await this.writeRow(module, current.rowNumber, { id: current.id, rowNumber: current.rowNumber });
  }

  async syncModule(module: ModuleConfig) {
    const sheets = await this.listWorksheets();
    const exists = sheets.find((sheet: any) => sheet.sheetId === module.sheetId || sheet.name === module.sheetName);
    if (exists) return exists;
    const token = await this.getAccessToken();
    const response = await this.http.post(
      `/open-apis/sheets/v2/spreadsheets/${this.config.spreadsheetToken}/sheets_batch_update`,
      { requests: [{ addSheet: { properties: { title: module.sheetName } } }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data?.data;
  }

  async syncModuleFromRemote(module: ModuleConfig): Promise<{ rows: number }> {
    if (!this.isConfigured) return { rows: 0 };
    const rows = await this.getRows(module);
    const dataSourceId = this.dataSourceId();
    if (dataSourceId) {
      await replaceLocalModuleRows({
        platform: 'feishu',
        dataSourceId,
        moduleKey: module.key,
        rows
      });
      await invalidateSheetCache({ platform: 'feishu', dataSourceId, moduleKey: module.key });
    }
    return { rows: rows.length };
  }

  async syncPendingLocalChanges(module: ModuleConfig): Promise<{ total: number; success: number; failed: number }> {
    const dataSourceId = this.dataSourceId();
    if (!this.isConfigured || !dataSourceId) return { total: 0, success: 0, failed: 0 };
    const rows = await listPendingLocalModuleRows(dataSourceId, module.key);
    let success = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        if (row.syncAction === 'delete') {
          await this.writeRow(module, Number(row.rowNumber) || module.dataStartRow, row as SheetRow);
          deleteLocalModuleRow(dataSourceId, module.key, String(row.id || row.rowNumber));
        } else if (String(row.id || '').startsWith('local-')) {
          await this.createRow(module, row);
          this.markRowSynced(module, row as SheetRow);
        } else {
          await this.updateRow(module, String(row.id || row.rowNumber), row);
          this.markRowSynced(module, row as SheetRow);
        }
        success += 1;
      } catch (error) {
        failed += 1;
        this.markRowFailed(module, row as SheetRow, error);
      }
    }

    return { total: rows.length, success, failed };
  }

  /** 缓存 tenant access token 到临近过期前，减少认证请求次数。 */
  private async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    const response = await this.http.post('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.config.appId,
      app_secret: this.config.appSecret
    });
    const value = response.data?.tenant_access_token;
    if (!value) throw new Error(response.data?.msg || '飞书 tenant_access_token 获取失败');
    this.token = { value, expiresAt: Date.now() + Number(response.data?.expire || 7200) * 1000 };
    return value;
  }

  private async resolveSheetId(module: ModuleConfig) {
    if (module.sheetId) return module.sheetId;
    const sheets = await this.listWorksheets();
    const sheet = sheets.find((item: any) => item.name === module.sheetName);
    if (!sheet) throw new Error(`飞书表格中未找到工作表：${module.sheetName}`);
    return sheet.sheetId;
  }

  private cellsToRow(module: ModuleConfig, cells: unknown[], rowNumber: number): SheetRow {
    const row: SheetRow = { id: String(rowNumber), rowNumber };
    module.fields.forEach((field, index) => {
      const value = cells[index] as string | number | undefined;
      if (field.type === 'date') {
        const numericValue = typeof value === 'number' ? value : Number(value);
        row[field.key] = Number.isFinite(numericValue) && numericValue > 20000 ? excelSerialToDate(numericValue) : value;
      } else {
        row[field.key] = value;
      }
    });
    return row;
  }

  private normalizePayload(module: ModuleConfig, payload: Record<string, unknown>, id: string, rowNumber?: number): SheetRow {
    const row: SheetRow = { id, rowNumber };
    for (const field of module.fields) {
      const value = payload[field.key];
      row[field.key] = value === undefined || value === null || value === ''
        ? (field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-')
        : String(value);
    }
    return row;
  }

  /** 只写入一个已配置的行范围，让新增、更新、删除复用同一套单元格映射。 */
  private async writeRow(module: ModuleConfig, rowNumber: number, row: SheetRow) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${sheetId}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const values = [module.fields.map((field) => {
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      return field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-';
    })];
    await this.http.put(
      `/open-apis/sheets/v2/spreadsheets/${this.config.spreadsheetToken}/values`,
      { valueRange: { range, values } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }

  private dataSourceId() {
    const value = Number(this.config.dataSourceId || 0);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private markRowSynced(module: ModuleConfig, row: SheetRow) {
    const dataSourceId = this.dataSourceId();
    if (!dataSourceId) return;
    markLocalModuleRowSync({
      dataSourceId,
      moduleKey: module.key,
      rowId: String(row.id || row.rowNumber),
      status: 'synced'
    });
  }

  private markRowFailed(module: ModuleConfig, row: SheetRow, error: unknown) {
    const dataSourceId = this.dataSourceId();
    if (!dataSourceId) return;
    const detail = error as { message?: string };
    markLocalModuleRowSync({
      dataSourceId,
      moduleKey: module.key,
      rowId: String(row.id || row.rowNumber),
      status: 'failed',
      error: detail?.message || String(error || 'sync failed')
    });
  }
}
