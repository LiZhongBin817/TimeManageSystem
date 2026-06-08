import { all, get, run, withPersistenceBatch } from '../db';

export type Role = 'admin' | 'editor' | 'viewer';
export type ModuleCategory = 'project' | 'staff' | 'todo';

export interface DataSourceInstance {
  id: number;
  name: string;
  platform: 'dingtalk' | 'feishu';
  config: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
}

export interface ModuleField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'status' | 'link' | 'staff' | 'formula' | 'hidden';
  required?: boolean;
  hidden?: boolean;
  formula?: boolean;
  staffRole?: 'product' | 'tester' | 'developer';
}

export interface ModuleConfig {
  id?: number;
  key: string;
  title: string;
  category: ModuleCategory;
  dataSourceId?: number;
  sheetName: string;
  sheetId?: string;
  headerRow: number;
  dataStartRow: number;
  editable: boolean;
  enabled: boolean;
  sortOrder: number;
  fields: ModuleField[];
}

interface ModuleRow {
  id: number;
  module_key: string;
  title: string;
  category: ModuleCategory;
  data_source_id?: number;
  sheet_name: string;
  sheet_id?: string;
  header_row: number;
  data_start_row: number;
  editable: number;
  enabled: number;
  sort_order: number;
}

interface FieldRow {
  field_key: string;
  label: string;
  type: ModuleField['type'];
  required: number;
  hidden: number;
  formula: number;
  staff_role?: ModuleField['staffRole'];
  sort_order: number;
}

function parseDataSource(row: any): DataSourceInstance {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    config: JSON.parse(row.config_json || '{}'),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order
  };
}

function normalizeField(row: FieldRow): ModuleField {
  return {
    key: row.field_key,
    label: row.label,
    type: row.type,
    required: Boolean(row.required),
    hidden: Boolean(row.hidden),
    formula: Boolean(row.formula),
    staffRole: row.staff_role || undefined
  };
}

export const rolePermissions: Record<Role, { canConfigure: boolean; canEditData: boolean }> = {
  admin: { canConfigure: true, canEditData: true },
  editor: { canConfigure: true, canEditData: true },
  viewer: { canConfigure: false, canEditData: false }
};

export function canConfigure(role: Role) {
  return rolePermissions[role].canConfigure;
}

export function canEdit(role: Role, module: ModuleConfig) {
  return module.editable && rolePermissions[role].canEditData;
}

export function canRead(_role: Role, module: ModuleConfig) {
  return module.enabled;
}

export async function listDataSources(platform?: string, includeDisabled = false) {
  const where = [
    platform ? 'platform = ?' : '',
    includeDisabled ? '' : 'enabled = 1'
  ].filter(Boolean);
  const rows = await all<any>(
    `SELECT * FROM data_source_instances${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_order, id`,
    platform ? [platform] : []
  );
  return rows.map(parseDataSource);
}

export async function getDataSource(id?: number) {
  const row = id
    ? await get<any>('SELECT * FROM data_source_instances WHERE id = ?', [id])
    : await get<any>('SELECT * FROM data_source_instances WHERE enabled = 1 ORDER BY sort_order, id LIMIT 1');
  return row ? parseDataSource(row) : undefined;
}

const sharedConfigKeys: Record<DataSourceInstance['platform'], string[]> = {
  dingtalk: ['appKey', 'appSecret', 'corpId', 'realmCorpId', 'baseUrl', 'loginEnabled', 'localLoginEnabled', 'redirectUri', 'operatorId'],
  feishu: ['appId', 'appSecret', 'baseUrl', 'loginEnabled', 'localLoginEnabled', 'redirectUri']
};

function envSharedConfig(platform: DataSourceInstance['platform']): Record<string, string> {
  if (platform === 'dingtalk') {
    return {
      appKey: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      corpId: process.env.DINGTALK_CORP_ID || '',
      baseUrl: process.env.DINGTALK_API_BASE_URL || 'https://api.dingtalk.com',
      loginEnabled: 'true',
      localLoginEnabled: process.env.LOCAL_LOGIN_ENABLED || 'false',
      operatorId: process.env.DINGTALK_OPERATOR_ID || ''
    };
  }
  return {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    baseUrl: process.env.FEISHU_BASE_URL || 'https://open.feishu.cn',
    loginEnabled: 'true',
    localLoginEnabled: process.env.LOCAL_LOGIN_ENABLED || 'false'
  };
}

async function inheritSharedConfig(input: Partial<DataSourceInstance> & { platform: DataSourceInstance['platform']; config: Record<string, string> }) {
  const inherited = envSharedConfig(input.platform);
  const rows = await all<any>(
    `SELECT * FROM data_source_instances
     WHERE platform = ? ${input.id ? 'AND id <> ?' : ''}
     ORDER BY sort_order, id
     LIMIT 1`,
    input.id ? [input.platform, input.id] : [input.platform]
  );
  const existing = rows[0] ? parseDataSource(rows[0]).config : {};
  const config = { ...input.config };

  for (const key of sharedConfigKeys[input.platform]) {
    const current = String(config[key] || '').trim();
    if (current) continue;
    config[key] = String(existing[key] || inherited[key] || '');
  }

  return config;
}

export async function saveDataSource(input: Partial<DataSourceInstance> & { name: string; platform: 'dingtalk' | 'feishu'; config: Record<string, string> }) {
  const config = await inheritSharedConfig(input);
  if (input.id) {
    run('UPDATE data_source_instances SET name = ?, platform = ?, config_json = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      input.name,
      input.platform,
      JSON.stringify(config),
      input.enabled === false ? 0 : 1,
      input.sortOrder ?? 0,
      input.id
    ]);
    return getDataSource(input.id);
  }
  run('INSERT INTO data_source_instances (name, platform, config_json, enabled, sort_order) VALUES (?, ?, ?, ?, ?)', [
    input.name,
    input.platform,
    JSON.stringify(config),
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 0
  ]);
  return getDataSource((await get<{ id: number }>('SELECT last_insert_rowid() as id'))?.id);
}

export async function listModules(options: { category?: ModuleCategory; enabledOnly?: boolean; dataSourceId?: number } = {}) {
  const clauses = [
    options.category ? 'category = ?' : '',
    options.enabledOnly === false ? '' : 'enabled = 1',
    options.dataSourceId ? '(data_source_id = ? OR data_source_id IS NULL)' : ''
  ].filter(Boolean);
  const params = [
    ...(options.category ? [options.category] : []),
    ...(options.dataSourceId ? [options.dataSourceId] : [])
  ];
  const rows = await all<ModuleRow>(
    `SELECT * FROM module_configs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY sort_order, id`,
    params
  );
  return Promise.all(rows.map(hydrateModule));
}

export async function findModule(key: string) {
  const row = await get<ModuleRow>('SELECT * FROM module_configs WHERE module_key = ?', [key]);
  return row ? hydrateModule(row) : undefined;
}

export async function saveModule(input: Partial<ModuleConfig> & { key: string; title: string; sheetName: string }) {
  const duplicate = await get<ModuleRow>(
    input.id
      ? 'SELECT * FROM module_configs WHERE module_key = ? AND id <> ?'
      : 'SELECT * FROM module_configs WHERE module_key = ?',
    input.id ? [input.key, input.id] : [input.key]
  );
  if (duplicate) {
    throw new Error(`模块 key 已存在：${input.key}`);
  }

  if (input.id) {
    run(
      'UPDATE module_configs SET module_key = ?, title = ?, category = ?, data_source_id = ?, sheet_name = ?, sheet_id = ?, header_row = ?, data_start_row = ?, editable = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        input.key,
        input.title,
        input.category || 'project',
        input.dataSourceId ?? null,
        input.sheetName,
        input.sheetId || null,
        input.headerRow ?? 1,
        input.dataStartRow ?? 2,
        input.editable === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        input.sortOrder ?? 0,
        input.id
      ]
    );
  } else {
    run(
      'INSERT INTO module_configs (module_key, title, category, data_source_id, sheet_name, sheet_id, header_row, data_start_row, editable, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.key,
        input.title,
        input.category || 'project',
        input.dataSourceId ?? null,
        input.sheetName,
        input.sheetId || null,
        input.headerRow ?? 1,
        input.dataStartRow ?? 2,
        input.editable === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        input.sortOrder ?? 0
      ]
    );
  }
  return findModule(input.key);
}

export async function updateModuleSheetId(moduleId: number, sheetId: string) {
  run('UPDATE module_configs SET sheet_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sheetId, moduleId]);
  const row = await get<ModuleRow>('SELECT * FROM module_configs WHERE id = ?', [moduleId]);
  return row ? hydrateModule(row) : undefined;
}

export async function replaceModuleFields(moduleKey: string, fields: ModuleField[]) {
  await withPersistenceBatch(() => {
    run('DELETE FROM module_fields WHERE module_key = ?', [moduleKey]);
    fields.forEach((field, index) => {
      run(
        'INSERT INTO module_fields (module_key, field_key, label, type, required, hidden, formula, staff_role, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          moduleKey,
          field.key,
          field.label,
          field.type,
          field.required ? 1 : 0,
          field.hidden ? 1 : 0,
          field.formula || field.type === 'formula' ? 1 : 0,
          field.staffRole || null,
          index * 10
        ]
      );
    });
  });
  return findModule(moduleKey);
}

async function hydrateModule(row: ModuleRow): Promise<ModuleConfig> {
  const fields = await all<FieldRow>('SELECT * FROM module_fields WHERE module_key = ? ORDER BY sort_order, id', [row.module_key]);
  return {
    id: row.id,
    key: row.module_key,
    title: row.title,
    category: row.category,
    dataSourceId: row.data_source_id,
    sheetName: row.sheet_name,
    sheetId: row.sheet_id,
    headerRow: row.header_row,
    dataStartRow: row.data_start_row,
    editable: Boolean(row.editable),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    fields: fields.map(normalizeField)
  };
}
