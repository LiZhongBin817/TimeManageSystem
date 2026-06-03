import axios, { AxiosInstance } from 'axios';
import { ModuleConfig } from '../config/configStore';
import { SheetRow } from '../data/mockRows';

interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  spreadsheetToken?: string;
  baseUrl?: string;
}

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

export class FeishuSheetClient {
  private config: FeishuConfig;
  private http: AxiosInstance;
  private token?: { value: string; expiresAt: number };

  constructor(config: FeishuConfig) {
    this.config = {
      baseUrl: 'https://open.feishu.cn',
      ...config
    };
    this.http = axios.create({ baseURL: this.config.baseUrl, timeout: 12000 });
  }

  get isConfigured() {
    return Boolean(this.config.appId && this.config.appSecret && this.config.spreadsheetToken);
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
      row[field.key] = value === undefined || value === null || value === '' ? (field.type === 'date' ? '' : '-') : String(value);
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
      row[field.key] = value === undefined || value === null || value === '' ? (field.type === 'date' ? '' : '-') : String(value);
    }
    return row;
  }

  private async writeRow(module: ModuleConfig, rowNumber: number, row: SheetRow) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${sheetId}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const values = [module.fields.map((field) => {
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      return field.type === 'date' ? '' : '-';
    })];
    await this.http.put(
      `/open-apis/sheets/v2/spreadsheets/${this.config.spreadsheetToken}/values`,
      { valueRange: { range, values } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }
}
