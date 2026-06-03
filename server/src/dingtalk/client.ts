import axios, { AxiosInstance } from 'axios';
import { ModuleConfig } from '../config/modules';
import { findModule } from '../config/modules';
import { SheetRow, mockRows } from '../data/mockRows';

interface DingTalkConfig {
  appKey?: string;
  appSecret?: string;
  workbookId?: string;
  operatorId?: string;
  baseUrl: string;
}

interface WorksheetMeta {
  sheetId: string;
  name: string;
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

export class DingTalkSheetClient {
  private config: DingTalkConfig;
  private http: AxiosInstance;
  private token?: { value: string; expiresAt: number };
  private memory = JSON.parse(JSON.stringify(mockRows)) as typeof mockRows;

  constructor() {
    this.config = {
      appKey: process.env.DINGTALK_APP_KEY,
      appSecret: process.env.DINGTALK_APP_SECRET,
      workbookId: process.env.DINGTALK_WORKBOOK_ID,
      operatorId: process.env.DINGTALK_OPERATOR_ID,
      baseUrl: process.env.DINGTALK_API_BASE_URL || 'https://api.dingtalk.com'
    };
    this.http = axios.create({ baseURL: this.config.baseUrl, timeout: 12000 });
  }

  get isConfigured() {
    return Boolean(this.config.appKey && this.config.appSecret && this.config.workbookId && this.config.operatorId);
  }

  async listWorksheets(): Promise<WorksheetMeta[]> {
    if (!this.isConfigured) {
      return Object.entries(mockRows).map(([key]) => ({ sheetId: key, name: key }));
    }

    const token = await this.getAccessToken();
    const response = await this.http.get(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets`, {
      headers: { 'x-acs-dingtalk-access-token': token },
      params: { operatorId: this.config.operatorId }
    });

    const sheets = response.data?.sheets || response.data?.value || response.data?.data || [];
    return sheets.map((sheet: any) => ({
      sheetId: sheet.sheetId || sheet.id,
      name: sheet.name || sheet.sheetName
    }));
  }

  async getRows(module: ModuleConfig): Promise<SheetRow[]> {
    if (!this.isConfigured) {
      return this.memory[module.key as keyof typeof this.memory] || [];
    }

    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${module.dataStartRow}:${lastColumn}2000`;
    const response = await this.withRetry(() =>
      this.http.get(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );

    const values: unknown[][] = response.data?.values || response.data?.valueRange?.values || response.data?.data?.values || [];
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
    const row = this.normalizePayload(module, payload, `local-${Date.now()}`, rowNumber);

    if (!this.isConfigured) {
      this.memory[module.key as keyof typeof this.memory].push(row);
      return row;
    }

    await this.writeRowWithPreviousFormulas(module, rowNumber, row);
    return row;
  }

  async updateRow(module: ModuleConfig, rowId: string, payload: Record<string, unknown>) {
    const rows = await this.getRows(module);
    const current = rows.find((item) => item.id === rowId || String(item.rowNumber) === rowId);
    if (!current) {
      throw new Error('未找到要更新的数据行');
    }

    const updated = { ...current, ...this.normalizePayload(module, payload, current.id, current.rowNumber) };
    if (!this.isConfigured) {
      const list = this.memory[module.key as keyof typeof this.memory];
      const index = list.findIndex((item) => item.id === rowId || String(item.rowNumber) === rowId);
      list[index] = updated;
      return updated;
    }

    await this.writeRowWithExistingFormulas(module, updated.rowNumber || module.dataStartRow, updated);
    return updated;
  }

  async deleteRow(module: ModuleConfig, rowId: string) {
    if (!this.isConfigured) {
      const list = this.memory[module.key as keyof typeof this.memory];
      const index = list.findIndex((item) => item.id === rowId || String(item.rowNumber) === rowId);
      if (index >= 0) list.splice(index, 1);
      return;
    }

    const rows = await this.getRows(module);
    const current = rows.find((item) => item.id === rowId || String(item.rowNumber) === rowId);
    if (!current?.rowNumber) {
      throw new Error('未找到要删除的数据行');
    }
    await this.writeRow(module, current.rowNumber, {
      id: current.id,
      rowNumber: current.rowNumber,
      ...Object.fromEntries(module.fields.map((field) => [field.key, '']))
    }, false);
  }

  async inspectRow(moduleKey: string, rowNumber: number) {
    const module = findModule(moduleKey);
    if (!module) throw new Error(`未找到模块：${moduleKey}`);
    if (!this.isConfigured) throw new Error('钉钉配置不完整');

    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const response = await this.withRetry(() =>
      this.http.get(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );
    return response.data;
  }

  private async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60000) {
      return this.token.value;
    }

    const response = await this.http.post('/v1.0/oauth2/accessToken', {
      appKey: this.config.appKey,
      appSecret: this.config.appSecret
    });
    const value = response.data?.accessToken;
    if (!value) throw new Error('钉钉 accessToken 获取失败');
    this.token = { value, expiresAt: Date.now() + Number(response.data?.expireIn || 7200) * 1000 };
    return value;
  }

  private async resolveSheetId(module: ModuleConfig) {
    if (module.sheetId) return module.sheetId;
    const sheets = await this.listWorksheets();
    const sheet = sheets.find((item) => item.name === module.sheetName);
    if (!sheet) throw new Error(`钉钉表格中未找到工作表：${module.sheetName}`);
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

  private async writeRow(module: ModuleConfig, rowNumber: number, row: SheetRow, emptyAsDash = true) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const values = [module.fields.map((field) => {
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      if (!emptyAsDash || field.type === 'date') return '';
      return '-';
    })];

    await this.withRetry(() =>
      this.http.put(
        `/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`,
        { values },
        {
          headers: { 'x-acs-dingtalk-access-token': token },
          params: { operatorId: this.config.operatorId }
        }
      )
    );
  }

  private async writeRowWithPreviousFormulas(module: ModuleConfig, rowNumber: number, row: SheetRow) {
    const previousRow = await this.findPreviousTemplateRow(module, rowNumber);
    const values = module.fields.map((field) => {
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      return field.type === 'date' ? '' : '-';
    });

    if (previousRow?.formulas?.[0]) {
      previousRow.formulas[0].forEach((formula: string, index: number) => {
        if (formula) values[index] = this.rewriteFormulaRow(formula, previousRow.rowNumber, rowNumber);
      });
    }

    await this.writeRawValues(module, rowNumber, values);
  }

  private async writeRowWithExistingFormulas(module: ModuleConfig, rowNumber: number, row: SheetRow) {
    const currentRow = await this.readRawRow(module, rowNumber);
    const values = module.fields.map((field, index) => {
      const existingFormula = currentRow.formulas?.[0]?.[index];
      if (existingFormula) return existingFormula;
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      return field.type === 'date' ? '' : '-';
    });

    await this.writeRawValues(module, rowNumber, values);
  }

  private async findPreviousTemplateRow(module: ModuleConfig, rowNumber: number) {
    for (let candidate = rowNumber - 1; candidate >= module.dataStartRow; candidate -= 1) {
      const data = await this.readRawRow(module, candidate);
      const values = data.values?.[0] || data.displayValues?.[0] || [];
      const hasContent = values.some((value: unknown) => {
        const text = String(value ?? '').trim();
        return text !== '' && text !== '-';
      });
      if (hasContent) return { rowNumber: candidate, ...data };
    }
    return null;
  }

  private rewriteFormulaRow(formula: string, fromRow: number, toRow: number) {
    return formula.replace(new RegExp(`(?<![A-Z])([A-Z]+)${fromRow}(?!\\d)`, 'g'), `$1${toRow}`);
  }

  private async readRawRow(module: ModuleConfig, rowNumber: number) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const response = await this.withRetry(() =>
      this.http.get(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );
    return response.data;
  }

  private async writeRawValues(module: ModuleConfig, rowNumber: number, values: string[]) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${rowNumber}:${lastColumn}${rowNumber}`;

    await this.withRetry(() =>
      this.http.put(
        `/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`,
        { values: [values] },
        {
          headers: { 'x-acs-dingtalk-access-token': token },
          params: { operatorId: this.config.operatorId }
        }
      )
    );
  }

  private async withRetry<T>(request: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      try {
        return await request();
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        if (![429, 500, 502, 503, 504].includes(status) || index === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (index + 1)));
      }
    }
    throw lastError;
  }
}

export const dingTalkClient = new DingTalkSheetClient();
