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

  constructor(config?: Partial<DingTalkConfig>) {
    this.config = {
      appKey: config?.appKey ?? process.env.DINGTALK_APP_KEY,
      appSecret: config?.appSecret ?? process.env.DINGTALK_APP_SECRET,
      workbookId: config?.workbookId ?? process.env.DINGTALK_WORKBOOK_ID,
      operatorId: config?.operatorId ?? process.env.DINGTALK_OPERATOR_ID,
      baseUrl: config?.baseUrl ?? process.env.DINGTALK_API_BASE_URL ?? 'https://api.dingtalk.com'
    };
    this.http = axios.create({ baseURL: this.config.baseUrl, timeout: 12000 });
  }

  get isConfigured() {
    return Boolean(this.config.appKey && this.config.appSecret && this.config.workbookId && this.config.operatorId);
  }

  async listEnterpriseMembers(): Promise<EnterpriseMember[]> {
    if (!this.config.appKey || !this.config.appSecret) return [];
    const token = await this.getLegacyAccessToken();
    const departments = await this.listDepartments(token, 1);
    const deptIds = [1, ...departments.map((dept) => dept.dept_id || dept.deptId).filter(Boolean)];
    const deptNameById = new Map<number, string>();
    departments.forEach((dept) => deptNameById.set(Number(dept.dept_id || dept.deptId), String(dept.name || '')));
    const members = new Map<string, EnterpriseMember>();

    for (const deptId of deptIds) {
      let cursor = 0;
      while (true) {
        const response = await axios.post(
          'https://oapi.dingtalk.com/topapi/v2/user/list',
          { dept_id: Number(deptId), cursor, size: 100, contain_access_limit: false, language: 'zh_CN' },
          { params: { access_token: token }, timeout: 12000 }
        );
        const result = response.data?.result || {};
        const list = result.list || [];
        for (const user of list) {
          const providerUserId = user.unionid || user.userid;
          if (!providerUserId) continue;
          members.set(String(providerUserId), {
            providerUserId: String(providerUserId),
            unionId: user.unionid,
            openId: user.open_id,
            name: user.name || user.nickname || String(providerUserId),
            avatar: user.avatar,
            mobile: user.mobile,
            email: user.email,
            department: deptNameById.get(Number(deptId)),
            raw: user
          });
        }
        if (!result.has_more) break;
        cursor = Number(result.next_cursor || 0);
        if (!cursor) break;
      }
    }

    return Array.from(members.values());
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

  async syncModule(module: ModuleConfig) {
    if (!this.isConfigured) {
      if (!this.memory[module.key as keyof typeof this.memory]) {
        this.memory[module.key as keyof typeof this.memory] = [] as any;
      }
      return { sheetId: module.sheetId || module.key, name: module.sheetName, created: false, headerSynced: true };
    }

    const existingSheets = await this.listWorksheets();
    let sheet = existingSheets.find((item) => item.sheetId === module.sheetId || item.name === module.sheetName);
    let created = false;

    if (!sheet) {
      sheet = await this.createWorksheet(module.sheetName);
      created = true;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const syncedModule = { ...module, sheetId: sheet.sheetId };
    await this.writeHeaderRow(syncedModule);
    return { ...sheet, created, headerSynced: true };
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
    const rowNumber = this.isConfigured ? await this.findWritableRow(module, rows.length + module.dataStartRow) : rows.length + module.dataStartRow;
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

    const updated = this.mergePayload(module, current, payload);
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
    const module = await findModule(moduleKey);
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

  private async getLegacyAccessToken() {
    const response = await axios.get('https://oapi.dingtalk.com/gettoken', {
      params: { appkey: this.config.appKey, appsecret: this.config.appSecret },
      timeout: 12000
    });
    const token = response.data?.access_token;
    if (!token || response.data?.errcode) {
      throw new Error(response.data?.errmsg || '钉钉通讯录 access_token 获取失败');
    }
    return token;
  }

  private async listDepartments(token: string, rootDeptId: number): Promise<any[]> {
    const response = await axios.post(
      'https://oapi.dingtalk.com/topapi/v2/department/listsub',
      { dept_id: rootDeptId },
      { params: { access_token: token }, timeout: 12000 }
    );
    const list = response.data?.result || [];
    const children: any[] = [];
    for (const dept of list) {
      children.push(dept);
      children.push(...await this.listDepartments(token, Number(dept.dept_id || dept.deptId)));
    }
    return children;
  }

  private async resolveSheetId(module: ModuleConfig) {
    if (module.sheetId) return module.sheetId;
    const sheets = await this.listWorksheets();
    const sheet = sheets.find((item) => item.name === module.sheetName);
    if (!sheet) throw new Error(`钉钉表格中未找到工作表：${module.sheetName}`);
    return sheet.sheetId;
  }

  private async createWorksheet(name: string): Promise<WorksheetMeta> {
    const token = await this.getAccessToken();
    const candidates = [
      { name },
      { sheetName: name },
      { title: name }
    ];
    let lastError: any;

    for (const body of candidates) {
      try {
        const response = await this.http.post(
          `/v1.0/doc/workbooks/${this.config.workbookId}/sheets`,
          body,
          {
            headers: { 'x-acs-dingtalk-access-token': token },
            params: { operatorId: this.config.operatorId }
          }
        );
        const data = response.data?.sheet || response.data?.data || response.data?.value || response.data;
        const sheetId = data?.sheetId || data?.id;
        const sheetName = data?.name || data?.sheetName || name;
        if (!sheetId) throw new Error('钉钉创建工作表成功但未返回 sheetId');
        return { sheetId, name: sheetName };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  private async writeHeaderRow(module: ModuleConfig) {
    const values = module.fields.map((field) => field.label);
    await this.writeRawValues(module, module.headerRow, values);
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

  private mergePayload(module: ModuleConfig, current: SheetRow, payload: Record<string, unknown>) {
    const row: SheetRow = { ...current };
    for (const field of module.fields) {
      if (!Object.prototype.hasOwnProperty.call(payload, field.key)) continue;
      const value = payload[field.key];
      row[field.key] = value === undefined || value === null || value === ''
        ? (field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-')
        : String(value);
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
      if (!emptyAsDash || field.type === 'date' || field.type === 'formula' || field.formula) return '';
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
      return field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-';
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
      return field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-';
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

  private async findWritableRow(module: ModuleConfig, fallbackRowNumber: number) {
    for (let candidate = fallbackRowNumber; candidate <= fallbackRowNumber + 30; candidate += 1) {
      const data = await this.readRawRow(module, candidate);
      const values = data.values?.[0] || data.displayValues?.[0] || [];
      const formulas = data.formulas?.[0] || [];
      const hasUserContent = values.some((value: unknown, index: number) => {
        if (formulas[index]) return false;
        const text = String(value ?? '').trim();
        return text !== '' && text !== '-';
      });
      if (!hasUserContent) return candidate;
    }
    return fallbackRowNumber;
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

  private async withRetry<T>(request: () => Promise<T>, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      try {
        return await request();
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        if (![429, 500, 502, 503, 504].includes(status) || index === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 800 * (index + 1)));
      }
    }
    throw lastError;
  }
}

export const dingTalkClient = new DingTalkSheetClient();
