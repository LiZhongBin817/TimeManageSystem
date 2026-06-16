/**
 * 钉钉表格适配器：处理令牌、工作簿元数据、工作表增删改查、本地缓存和 API 用量记录。
 */
import axios from 'axios';
import http from 'http';
import https from 'https';
import { ModuleConfig, findModule, getDataSource } from '../config/modules';
import { SheetRow, mockRows } from '../data/mockRows';
import {
  deleteLocalModuleRow,
  getLocalModuleRow,
  getSheetCache,
  invalidateSheetCache,
  listLocalModuleRows,
  listPendingLocalModuleRows,
  logApiCall,
  markLocalModuleRowSync,
  replaceLocalModuleRows,
  setSheetCache,
  upsertLocalModuleRow
} from '../db';

interface DingTalkConfig {
  appKey?: string;
  appSecret?: string;
  workbookId?: string;
  operatorId?: string;
  dataSourceId?: string | number;
  baseUrl: string;
}

interface WorksheetMeta {
  sheetId: string;
  name: string;
}

interface FormulaSource {
  rowNumber: number;
  formulas: string[];
}

const accessTokenCache = new Map<string, { value: string; expiresAt: number }>();
const legacyAccessTokenCache = new Map<string, { value: string; expiresAt: number }>();
const worksheetCache = new Map<string, { value: WorksheetMeta[]; expiresAt: number }>();
const WORKSHEET_CACHE_TTL = 5 * 60 * 1000;
const ROW_READ_CHUNK_SIZE = Number(process.env.DINGTALK_ROW_READ_CHUNK_SIZE || 150);
const ROW_READ_MAX_ROW = Number(process.env.DINGTALK_ROW_READ_MAX_ROW || 2000);
const ROW_READ_TAIL_WINDOW = Number(process.env.DINGTALK_ROW_READ_TAIL_WINDOW || 20);
const DINGTALK_REQUEST_TIMEOUT = Number(process.env.DINGTALK_REQUEST_TIMEOUT || 60000);
const DINGTALK_REQUEST_RETRIES = Number(process.env.DINGTALK_REQUEST_RETRIES || 3);
const CACHE_TTL_SECONDS = Number(process.env.DINGTALK_CACHE_TTL_SECONDS || 180);
const CACHE_STALE_SECONDS = Number(process.env.DINGTALK_CACHE_STALE_SECONDS || 86400);
const LOCAL_FIRST = process.env.DINGTALK_LOCAL_FIRST !== 'false';
const dingTalkHttpAgent = new http.Agent({ family: 4 });
const dingTalkHttpsAgent = new https.Agent({ family: 4 });
const dingTalkAxiosOptions = { httpAgent: dingTalkHttpAgent, httpsAgent: dingTalkHttpsAgent };
const rowRefreshes = new Map<string, Promise<SheetRow[]>>();

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

interface RowsCachePayload {
  rows: SheetRow[];
}

// 附加缓存元数据，同时不改变普通消费者拿到的 JSON 行数据。
function annotateRows(rows: SheetRow[], meta: Record<string, unknown>) {
  Object.defineProperty(rows, 'cacheMeta', {
    value: meta,
    enumerable: false,
    configurable: true
  });
  return rows;
}

function cacheAgeSeconds(updatedAt: string) {
  const normalized = updatedAt.includes('T') ? updatedAt : `${updatedAt.replace(' ', 'T')}Z`;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : Number.MAX_SAFE_INTEGER;
}

function errorCode(error: any) {
  return String(error?.response?.data?.code || error?.response?.status || error?.code || error?.message || 'unknown').slice(0, 120);
}

// 只重试后续尝试可能恢复的平台或网络故障。
function isTransientDingTalkError(error: any) {
  const status = error?.response?.status;
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return [429, 500, 502, 503, 504].includes(status)
    || ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ERR_NETWORK'].includes(code)
    || message.includes('timeout')
    || message.includes('network')
    || message.includes('fetch failed');
}

// 把从 0 开始的字段索引转换为钉钉范围使用的 Excel 风格列名。
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

async function fetchJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: unknown; timeout?: number } = {}) {
  return fetchJsonWithAxios(url, options);
}

async function fetchJsonWithAxios(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; timeout?: number } = {},
  fallbackReason?: string
) {
  try {
    const response = await axios.request({
      url,
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      data: options.body,
      timeout: options.timeout || DINGTALK_REQUEST_TIMEOUT,
      ...dingTalkAxiosOptions
    });
    return { data: response.data };
  } catch (failure: any) {
    if (fallbackReason) {
      failure.message = `${fallbackReason}; ${failure.message || 'axios fallback failed'}`;
    }
    throw failure;
  }
}

/**
 * 单个钉钉工作簿的有状态适配器。公开方法提供应用层行操作；
 * 私有辅助方法封装令牌、工作表、公式、缓存、重试和本地优先等细节。
 */
export class DingTalkSheetClient {
  private config: DingTalkConfig;
  private memory = JSON.parse(JSON.stringify(mockRows)) as typeof mockRows;

  constructor(config?: Partial<DingTalkConfig>) {
    this.config = {
      appKey: config?.appKey ?? process.env.DINGTALK_APP_KEY,
      appSecret: config?.appSecret ?? process.env.DINGTALK_APP_SECRET,
      workbookId: config?.workbookId ?? process.env.DINGTALK_WORKBOOK_ID,
      operatorId: config?.operatorId ?? process.env.DINGTALK_OPERATOR_ID,
      dataSourceId: config?.dataSourceId,
      baseUrl: config?.baseUrl ?? process.env.DINGTALK_API_BASE_URL ?? 'https://api.dingtalk.com'
    };
  }

  get isConfigured() {
    return Boolean(this.config.appKey && this.config.appSecret && this.config.workbookId && this.config.operatorId);
  }

  /** 读取企业通讯录，并对跨部门重复用户去重。 */
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
        const response = await this.trackedAxios('contact.user.list', () =>
          axios.post(
            'https://oapi.dingtalk.com/topapi/v2/user/list',
            { dept_id: Number(deptId), cursor, size: 100, contain_access_limit: false, language: 'zh_CN' },
            { params: { access_token: token }, timeout: 12000, ...dingTalkAxiosOptions }
          )
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

  /** 列出工作簿工作表；由于元数据较少变化，使用短时内存缓存。 */
  async listWorksheets(): Promise<WorksheetMeta[]> {
    if (!this.isConfigured) {
      return Object.entries(mockRows).map(([key]) => ({ sheetId: key, name: key }));
    }

    const cacheKey = this.worksheetCacheKey();
    const cached = worksheetCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const token = await this.getAccessToken();
    const response = await this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets`, {
      headers: { 'x-acs-dingtalk-access-token': token },
      params: { operatorId: this.config.operatorId }
    });

    const sheets = response.data?.sheets || response.data?.value || response.data?.data || [];
    const normalized = sheets.map((sheet: any) => ({
      sheetId: sheet.sheetId || sheet.id,
      name: sheet.name || sheet.sheetName
    }));
    worksheetCache.set(cacheKey, { value: normalized, expiresAt: Date.now() + WORKSHEET_CACHE_TTL });
    return normalized;
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
      worksheetCache.delete(this.worksheetCacheKey());
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const syncedModule = { ...module, sheetId: sheet.sheetId };
    await this.writeHeaderRow(syncedModule);
    if (module.referenceModuleKey && !(await this.getRows(syncedModule)).length) {
      await this.writeReferenceFormulaTemplate(syncedModule);
    }
    return { ...sheet, created, headerSynced: true };
  }

  async getRows(module: ModuleConfig): Promise<SheetRow[]> {
    if (!this.isConfigured) {
      return annotateRows(this.memory[module.key as keyof typeof this.memory] || [], { source: 'mock' });
    }

    if (LOCAL_FIRST && this.dataSourceId()) {
      const localRows = await listLocalModuleRows(this.dataSourceId(), module.key);
      if (localRows.length) {
        this.logCacheHit('local_db.rows', `${this.dataSourceId()}|${module.key}`);
        return annotateRows(localRows as SheetRow[], {
          source: 'local_db',
          hit: true,
          stale: false,
          updatedAt: localRows.reduce((latest, row) => String(row.updatedAt || latest) > latest ? String(row.updatedAt) : latest, '')
        });
      }
    }

    const sheetId = await this.resolveSheetId(module);
    const cacheKey = this.rowsCacheKey(module, sheetId);
    const cached = await getSheetCache<RowsCachePayload>(cacheKey);
    if (cached) {
      const age = cacheAgeSeconds(cached.updatedAt);
      if (age <= Math.max(1, CACHE_TTL_SECONDS)) {
        this.logCacheHit('sheet.rows', cacheKey);
        return annotateRows(cached.payload.rows, { hit: true, stale: false, updatedAt: cached.updatedAt, ageSeconds: age });
      }
      if (age <= Math.max(CACHE_TTL_SECONDS, CACHE_STALE_SECONDS)) {
        this.logCacheHit('sheet.rows.stale', cacheKey);
        this.refreshRowsCache(module, sheetId, cacheKey).catch((error) => {
          console.error(`[dingtalk-cache] background refresh failed for ${module.key}`, error?.message || error);
        });
        return annotateRows(cached.payload.rows, { hit: true, stale: true, updatedAt: cached.updatedAt, ageSeconds: age });
      }
    }

    try {
      const rows = await this.refreshRowsCache(module, sheetId, cacheKey);
      await this.replaceLocalRows(module, rows);
      return rows;
    } catch (error) {
      if (cached) {
        const age = cacheAgeSeconds(cached.updatedAt);
        this.logCacheHit('sheet.rows.fallback', cacheKey);
        return annotateRows(cached.payload.rows, { hit: true, stale: true, fallback: true, updatedAt: cached.updatedAt, ageSeconds: age });
      }
      throw error;
    }
  }

  /** 刷新单个模块缓存；并发调用会复用同一个进行中的 Promise。 */
  private async refreshRowsCache(module: ModuleConfig, sheetId: string, cacheKey: string) {
    const running = rowRefreshes.get(cacheKey);
    if (running) return running;
    const promise = this.fetchRowsFromDingTalk(module, sheetId)
      .then((rows) => {
        setSheetCache({
          cacheKey,
          platform: 'dingtalk',
          dataSourceId: this.dataSourceId(),
          moduleKey: module.key,
          payload: { rows }
        });
        return annotateRows(rows, { hit: false, stale: false, updatedAt: new Date().toISOString(), ageSeconds: 0 });
      })
      .finally(() => {
        rowRefreshes.delete(cacheKey);
      });
    rowRefreshes.set(cacheKey, promise);
    return promise;
  }

  /** 分块读取行，并在尾部连续空白后停止，避免扫描大量空行。 */
  private async fetchRowsFromDingTalk(module: ModuleConfig, sheetId: string): Promise<SheetRow[]> {
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const rows: SheetRow[] = [];
    const chunkSize = Math.max(50, ROW_READ_CHUNK_SIZE);
    const maxRow = Math.max(module.dataStartRow, ROW_READ_MAX_ROW);
    const tailWindow = Math.max(5, ROW_READ_TAIL_WINDOW);

    for (let startRow = module.dataStartRow; startRow <= maxRow; startRow += chunkSize) {
      const endRow = Math.min(startRow + chunkSize - 1, maxRow);
      const values = await this.readRangeValues(module, sheetId, token, lastColumn, startRow, endRow);
      if (!values.length) break;

      const chunkRows = values.map((cells, index) => this.cellsToRow(module, cells, startRow + index));
      rows.push(...chunkRows.filter((row) => this.hasRowContent(module, row)));

      const lastContentIndex = chunkRows.reduce((last, row, index) => this.hasRowContent(module, row) ? index : last, -1);
      const requestedRows = endRow - startRow + 1;
      if (values.length < requestedRows || lastContentIndex < values.length - tailWindow) break;
    }

    return rows;
  }

  async syncModuleFromRemote(module: ModuleConfig): Promise<{ rows: number }> {
    if (!this.isConfigured) return { rows: 0 };
    const sheetId = await this.resolveSheetId(module);
    const rows = await this.fetchRowsFromDingTalk(module, sheetId);
    await this.replaceLocalRows(module, rows);
    await invalidateSheetCache({ platform: 'dingtalk', dataSourceId: this.dataSourceId(), moduleKey: module.key });
    return { rows: rows.length };
  }

  async syncPendingLocalChanges(module: ModuleConfig): Promise<{ total: number; success: number; failed: number }> {
    const dataSourceId = this.dataSourceId();
    if (!this.isConfigured || !LOCAL_FIRST || !dataSourceId) return { total: 0, success: 0, failed: 0 };
    const rows = await listPendingLocalModuleRows(dataSourceId, module.key);
    let success = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        if (row.syncAction === 'delete') {
          await this.syncDeletedRowToRemote(module, row as SheetRow);
          deleteLocalModuleRow(dataSourceId, module.key, String(row.id || row.rowNumber));
        } else if (String(row.id || '').startsWith('local-')) {
          const previousRowNumber = Number(row.rowNumber || 0) > module.dataStartRow ? Number(row.rowNumber) - 1 : undefined;
          await this.syncCreatedRowToRemote(module, row as SheetRow, previousRowNumber);
        } else {
          await this.syncUpdatedRowToRemote(module, row as SheetRow);
        }
        success += 1;
      } catch (error) {
        failed += 1;
        this.markRowFailed(module, row as SheetRow, error);
      }
    }

    return { total: rows.length, success, failed };
  }

  async createRow(module: ModuleConfig, payload: Record<string, unknown>, existingRows?: SheetRow[]) {
    const rows = existingRows || await this.getRows(module);
    const lastRowNumber = rows.reduce((max, row) => Math.max(max, Number(row.rowNumber) || 0), module.dataStartRow - 1);
    const rowNumber = lastRowNumber + 1;
    const row = this.normalizePayload(module, payload, `local-${Date.now()}`, rowNumber);

    if (!this.isConfigured) {
      this.memory[module.key as keyof typeof this.memory].push(row);
      return row;
    }

    if (LOCAL_FIRST && this.dataSourceId()) {
      this.upsertLocalRow(module, row, 'pending');
      return row;
    }

    await this.writeRowWithPreviousFormulas(module, rowNumber, row, lastRowNumber >= module.dataStartRow ? lastRowNumber : undefined);
    await this.afterRemoteWrite(module);
    return row;
  }

  async updateRow(module: ModuleConfig, rowId: string, payload: Record<string, unknown>, currentRow?: SheetRow) {
    const current = currentRow || await this.findCurrentRow(module, rowId);
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

    if (LOCAL_FIRST && this.dataSourceId()) {
      this.upsertLocalRow(module, updated, 'pending');
      return updated;
    }

    await this.writeRowWithExistingFormulas(module, updated.rowNumber || module.dataStartRow, updated);
    await this.afterRemoteWrite(module);
    return updated;
  }

  async deleteRow(module: ModuleConfig, rowId: string, currentRow?: SheetRow) {
    if (!this.isConfigured) {
      const list = this.memory[module.key as keyof typeof this.memory];
      const index = list.findIndex((item) => item.id === rowId || String(item.rowNumber) === rowId);
      if (index >= 0) list.splice(index, 1);
      return;
    }

    const current = currentRow || await this.findCurrentRow(module, rowId);
    if (!current?.rowNumber) {
      throw new Error('未找到要删除的数据行');
    }
    const clearedRow = {
      id: current.id,
      rowNumber: current.rowNumber,
      ...Object.fromEntries(module.fields.map((field) => [field.key, '']))
    };

    if (LOCAL_FIRST && this.dataSourceId()) {
      this.upsertLocalRow(module, clearedRow, 'pending', undefined, 'delete');
      return;
    }

    await this.writeRow(module, current.rowNumber, clearedRow, false);
    await this.afterRemoteWrite(module);
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
      this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );
    return response.data;
  }

  private async getAccessToken() {
    const cacheKey = this.tokenCacheKey();
    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.value;

    const response = await this.fetchApi('/v1.0/oauth2/accessToken', {
      method: 'POST',
      body: {
        appKey: this.config.appKey,
        appSecret: this.config.appSecret
      }
    });
    const value = response.data?.accessToken;
    if (!value) throw new Error('钉钉 accessToken 获取失败');
    accessTokenCache.set(cacheKey, { value, expiresAt: Date.now() + Number(response.data?.expireIn || 7200) * 1000 });
    return value;
  }

  private async getLegacyAccessToken() {
    const cacheKey = this.tokenCacheKey();
    const cached = legacyAccessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.value;

    const response = await this.trackedAxios('contact.access_token', () =>
      axios.get('https://oapi.dingtalk.com/gettoken', {
        params: { appkey: this.config.appKey, appsecret: this.config.appSecret },
        timeout: 12000,
        ...dingTalkAxiosOptions
      })
    );
    const token = response.data?.access_token;
    if (!token || response.data?.errcode) {
      throw new Error(response.data?.errmsg || '钉钉通讯录 access_token 获取失败');
    }
    legacyAccessTokenCache.set(cacheKey, { value: token, expiresAt: Date.now() + Number(response.data?.expires_in || 7200) * 1000 });
    return token;
  }

  private async listDepartments(token: string, rootDeptId: number): Promise<any[]> {
    const response = await this.trackedAxios('contact.department.list', () =>
      axios.post(
        'https://oapi.dingtalk.com/topapi/v2/department/listsub',
        { dept_id: rootDeptId },
        { params: { access_token: token }, timeout: 12000, ...dingTalkAxiosOptions }
      )
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
        const response = await this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets`, {
          method: 'POST',
          headers: { 'x-acs-dingtalk-access-token': token },
          params: { operatorId: this.config.operatorId },
          body
        });
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

  private async readRangeValues(module: ModuleConfig, sheetId: string, token: string, lastColumn: string, startRow: number, endRow: number): Promise<unknown[][]> {
    const range = `${module.sheetName}!A${startRow}:${lastColumn}${endRow}`;
    const response = await this.withRetry(() =>
      this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );
    return response.data?.values || response.data?.valueRange?.values || response.data?.data?.values || [];
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

  private hasRowContent(module: ModuleConfig, row: SheetRow) {
    return module.fields.some((field) => {
      if (field.type === 'formula' || field.formula) return false;
      const value = String(row[field.key] ?? '').trim();
      return value !== '' && value !== '-';
    });
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
      this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        method: 'PUT',
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId },
        body: { values }
      })
    );
  }

  /** 写入前从邻近源行复制公式单元格，以保留表格公式。 */
  private async writeRowWithPreviousFormulas(module: ModuleConfig, rowNumber: number, row: SheetRow, previousRowNumber?: number) {
    const formulaSource = previousRowNumber
      ? await this.getFormulaSourceFromRow(module, previousRowNumber)
      : await this.getReferenceFormulaSource(module);
    const values = module.fields.map((field) => {
      const value = String(row[field.key] ?? '').trim();
      if (value) return value;
      return field.type === 'date' || field.type === 'formula' || field.formula ? '' : '-';
    });

    this.applyFormulaSource(values, formulaSource, rowNumber);

    await this.writeRawValues(module, rowNumber, values);
  }

  private async writeRowWithExistingFormulas(module: ModuleConfig, rowNumber: number, row: SheetRow) {
    const editableRanges = this.buildNonFormulaRanges(module, row);
    for (const range of editableRanges) {
      await this.writeRawValues(module, rowNumber, range.values, range.startIndex);
    }
  }

  // 更新已有行时跳过公式列，避免读取远端公式超时导致普通字段无法同步。
  private buildNonFormulaRanges(module: ModuleConfig, row: SheetRow) {
    const ranges: Array<{ startIndex: number; values: string[] }> = [];
    let currentRange: { startIndex: number; values: string[] } | undefined;

    module.fields.forEach((field, index) => {
      if (field.type === 'formula' || field.formula) {
        currentRange = undefined;
        return;
      }

      const value = String(row[field.key] ?? '').trim();
      const normalized = value || (field.type === 'date' ? '' : '-');
      if (!currentRange) {
        currentRange = { startIndex: index, values: [] };
        ranges.push(currentRange);
      }
      currentRange.values.push(normalized);
    });

    return ranges;
  }

  private rewriteFormulaRow(formula: string, fromRow: number, toRow: number) {
    return formula.replace(new RegExp(`(?<![A-Z])([A-Z]+)${fromRow}(?!\\d)`, 'g'), `$1${toRow}`);
  }

  private async writeReferenceFormulaTemplate(module: ModuleConfig) {
    const formulaSource = await this.getReferenceFormulaSource(module);
    if (!formulaSource) return;
    const values = module.fields.map(() => '');
    this.applyFormulaSource(values, formulaSource, module.dataStartRow);
    if (values.some(Boolean)) {
      await this.writeRawValues(module, module.dataStartRow, values);
    }
  }

  private async getFormulaSourceFromRow(module: ModuleConfig, rowNumber: number): Promise<FormulaSource | null> {
    const rawRow = await this.readRawRow(module, rowNumber);
    const formulas = rawRow.formulas?.[0] || [];
    return formulas.some(Boolean) ? { rowNumber, formulas } : null;
  }

  private async getReferenceFormulaSource(module: ModuleConfig): Promise<FormulaSource | null> {
    if (!module.referenceModuleKey || module.referenceModuleKey === module.key) return null;
    const referenceModule = await findModule(module.referenceModuleKey);
    if (!referenceModule) return null;
    const sourceClient = await this.getReferenceFormulaClient(module, referenceModule);
    if (!sourceClient.isConfigured) return null;

    const maxScanRows = 50;
    for (let offset = 0; offset < maxScanRows; offset += 1) {
      const rowNumber = referenceModule.dataStartRow + offset;
      const source = await sourceClient.getFormulaSourceFromRow(referenceModule, rowNumber);
      if (source) return source;
    }
    return null;
  }

  private async getReferenceFormulaClient(module: ModuleConfig, referenceModule: ModuleConfig) {
    if (!referenceModule.dataSourceId || referenceModule.dataSourceId === module.dataSourceId) return this;
    const referenceDataSource = await getDataSource(referenceModule.dataSourceId);
    if (!referenceDataSource) throw new Error('参考模块的数据源不存在，无法复制公式');
    if (referenceDataSource.platform !== 'dingtalk') throw new Error('当前仅支持从钉钉参考模块复制公式');
    return new DingTalkSheetClient({ ...referenceDataSource.config, dataSourceId: referenceDataSource.id });
  }

  private applyFormulaSource(values: string[], formulaSource: FormulaSource | null, targetRowNumber: number) {
    if (!formulaSource) return;
    formulaSource.formulas.forEach((formula, index) => {
      if (formula) values[index] = this.rewriteFormulaRow(formula, formulaSource.rowNumber, targetRowNumber);
    });
  }

  private async readRawRow(module: ModuleConfig, rowNumber: number) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const lastColumn = columnName(module.fields.length - 1);
    const range = `${module.sheetName}!A${rowNumber}:${lastColumn}${rowNumber}`;
    const response = await this.withRetry(() =>
      this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId }
      })
    );
    return response.data;
  }

  private async writeRawValues(module: ModuleConfig, rowNumber: number, values: string[], startIndex = 0) {
    const sheetId = await this.resolveSheetId(module);
    const token = await this.getAccessToken();
    const firstColumn = columnName(startIndex);
    const lastColumn = columnName(startIndex + values.length - 1);
    const range = `${module.sheetName}!${firstColumn}${rowNumber}:${lastColumn}${rowNumber}`;

    await this.withRetry(() =>
      this.fetchApi(`/v1.0/doc/workbooks/${this.config.workbookId}/sheets/${sheetId}/ranges/${encodeURIComponent(range)}`, {
        method: 'PUT',
        headers: { 'x-acs-dingtalk-access-token': token },
        params: { operatorId: this.config.operatorId },
        body: { values: [values] }
      })
    );
  }

  /** 把远端行镜像到本地表，便于故障或限流时读取兜底。 */
  private async replaceLocalRows(module: ModuleConfig, rows: SheetRow[]) {
    const dataSourceId = this.dataSourceId();
    if (!LOCAL_FIRST || !dataSourceId) return;
    await replaceLocalModuleRows({
      platform: 'dingtalk',
      dataSourceId,
      moduleKey: module.key,
      rows
    });
  }

  private upsertLocalRow(
    module: ModuleConfig,
    row: SheetRow,
    syncStatus: 'pending' | 'synced' | 'failed',
    syncError?: string,
    syncAction: 'upsert' | 'delete' = 'upsert'
  ) {
    const dataSourceId = this.dataSourceId();
    if (!dataSourceId) return;
    upsertLocalModuleRow({
      platform: 'dingtalk',
      dataSourceId,
      moduleKey: module.key,
      row,
      syncStatus,
      syncAction,
      syncError,
      syncedAt: syncStatus === 'synced' ? new Date().toISOString() : undefined
    });
  }

  private async findCurrentRow(module: ModuleConfig, rowId: string) {
    const dataSourceId = this.dataSourceId();
    if (LOCAL_FIRST && dataSourceId) {
      const local = await getLocalModuleRow(dataSourceId, module.key, rowId);
      if (local) return local as SheetRow;
    }
    return (await this.getRows(module)).find((item) => item.id === rowId || String(item.rowNumber) === rowId);
  }

  private async syncCreatedRowToRemote(module: ModuleConfig, row: SheetRow, lastRowNumber?: number) {
    const previousRowNumber = typeof lastRowNumber === 'number' && lastRowNumber >= module.dataStartRow ? lastRowNumber : undefined;
    await this.writeRowWithPreviousFormulas(module, row.rowNumber || module.dataStartRow, row, previousRowNumber);
    await this.afterRemoteWrite(module);
    this.markRowSynced(module, row);
  }

  private async syncUpdatedRowToRemote(module: ModuleConfig, row: SheetRow) {
    await this.writeRowWithExistingFormulas(module, row.rowNumber || module.dataStartRow, row);
    await this.afterRemoteWrite(module);
    this.markRowSynced(module, row);
  }

  private async syncDeletedRowToRemote(module: ModuleConfig, row: SheetRow) {
    await this.writeRow(module, row.rowNumber || module.dataStartRow, row, false);
    await this.afterRemoteWrite(module);
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

  private markRowFailed(module: ModuleConfig, row: SheetRow, error: any) {
    const dataSourceId = this.dataSourceId();
    if (!dataSourceId) return;
    markLocalModuleRowSync({
      dataSourceId,
      moduleKey: module.key,
      rowId: String(row.id || row.rowNumber),
      status: 'failed',
      error: error?.message || String(error || 'sync failed')
    });
  }

  private async afterRemoteWrite(module: ModuleConfig) {
    await this.invalidateModuleRows(module);
  }

  private async invalidateModuleRows(module: ModuleConfig) {
    await invalidateSheetCache({
      platform: 'dingtalk',
      dataSourceId: this.dataSourceId(),
      moduleKey: module.key
    });
  }

  /** 钉钉调用的统一重试封装，包含递增退避和过期缓存兜底。 */
  private async withRetry<T>(request: () => Promise<T>, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      try {
        return await request();
      } catch (error: any) {
        lastError = error;
        const status = error.response?.status;
        if ((!isTransientDingTalkError(error) && ![429, 500, 502, 503, 504].includes(status)) || index === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (index + 1)));
      }
    }
    throw lastError;
  }

  private tokenCacheKey() {
    return `${this.config.baseUrl}|${this.config.appKey || ''}`;
  }

  private worksheetCacheKey() {
    return `${this.tokenCacheKey()}|${this.config.workbookId || ''}|${this.config.operatorId || ''}`;
  }
  
  private rowsCacheKey(module: ModuleConfig, sheetId: string) {
    return [
      'dingtalk',
      this.dataSourceId() || 'env',
      this.config.workbookId || '',
      sheetId,
      module.key,
      module.dataStartRow,
      ROW_READ_MAX_ROW,
      module.fields.map((field) => field.key).join(',')
    ].join('|');
  }

  private dataSourceId() {
    const value = Number(this.config.dataSourceId || 0);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private logCacheHit(capability: string, path: string) {
    logApiCall({
      platform: 'dingtalk',
      capability,
      path,
      cacheHit: true,
      success: true
    });
  }

  /** 记录每次钉钉 API 调用，用于管理员用量看板和告警阈值。 */
  private async trackedAxios<T>(capability: string, request: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const response: any = await this.withRetry(request, DINGTALK_REQUEST_RETRIES);
      logApiCall({
        platform: 'dingtalk',
        capability,
        path: capability,
        statusCode: response?.status,
        durationMs: Date.now() - startedAt,
        success: true
      });
      return response;
    } catch (error: any) {
      logApiCall({
        platform: 'dingtalk',
        capability,
        path: capability,
        statusCode: error?.response?.status,
        durationMs: Date.now() - startedAt,
        success: false,
        errorCode: errorCode(error)
      });
      throw error;
    }
  }

  private fetchApi(path: string, options: { method?: string; headers?: Record<string, string>; params?: Record<string, unknown>; body?: unknown } = {}) {
    const url = new URL(path, this.config.baseUrl);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    const startedAt = Date.now();
    const capability = path.includes('/ranges/') ? (options.method === 'PUT' ? 'sheet.range.write' : 'sheet.range.read')
      : path.includes('/sheets') ? (options.method === 'POST' ? 'sheet.create' : 'sheet.list')
        : path.includes('/oauth2/') ? 'oauth.app_token'
          : 'dingtalk.api';
    return this.withRetry(() => fetchJson(url.toString(), {
      method: options.method,
      headers: options.headers,
      body: options.body,
      timeout: DINGTALK_REQUEST_TIMEOUT
    }), DINGTALK_REQUEST_RETRIES).then((response) => {
      logApiCall({
        platform: 'dingtalk',
        capability,
        path,
        durationMs: Date.now() - startedAt,
        success: true
      });
      return response;
    }).catch((error) => {
      logApiCall({
        platform: 'dingtalk',
        capability,
        path,
        statusCode: error?.response?.status,
        durationMs: Date.now() - startedAt,
        success: false,
        errorCode: errorCode(error)
      });
      throw error;
    });
  }
}

export const dingTalkClient = new DingTalkSheetClient();
