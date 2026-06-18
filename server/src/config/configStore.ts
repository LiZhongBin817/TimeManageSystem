/**
 * 配置仓储：管理数据源实例、模块元数据、字段以及角色级能力。
 */
import { all, get, run, withPersistenceBatch } from '../db';

export type Role = 'admin' | 'editor' | 'viewer';
export type ModuleCategory = 'project' | 'staff' | 'todo';

export interface DataSourceInstance {
  id: number;
  name: string;
  platform: 'dingtalk' | 'feishu';
  config: Record<string, string>;
  ownerUserId?: number | null;
  enabled: boolean;
  sortOrder: number;
}

export type PlatformKey = DataSourceInstance['platform'];

export interface PlatformConfig {
  platform: PlatformKey;
  config: Record<string, string>;
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
  referenceModuleKey?: string;
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
  reference_module_key?: string;
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

// 数据库以 JSON 存储配置，在仓储边界统一解析和规范化。
function parseDataSource(row: any): DataSourceInstance {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    config: JSON.parse(row.config_json || '{}'),
    ownerUserId: row.owner_user_id ?? null,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order
  };
}

async function hydrateDataSource(row: any): Promise<DataSourceInstance> {
  const dataSource = parseDataSource(row);
  const platformConfig = await getPlatformConfig(dataSource.platform);
  return {
    ...dataSource,
    config: {
      ...dataSource.config,
      ...platformConfig.config
    }
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
  return Promise.all(rows.map(hydrateDataSource));
}

export async function getDataSource(id?: number) {
  const row = id
    ? await get<any>('SELECT * FROM data_source_instances WHERE id = ?', [id])
    : await get<any>('SELECT * FROM data_source_instances WHERE enabled = 1 ORDER BY sort_order, id LIMIT 1');
  return row ? hydrateDataSource(row) : undefined;
}

const sharedConfigKeys: Record<PlatformKey, string[]> = {
  dingtalk: ['appKey', 'appSecret', 'corpId', 'realmCorpId', 'baseUrl', 'operatorId'],
  feishu: ['appId', 'appSecret', 'baseUrl']
};

function envSharedConfig(platform: PlatformKey): Record<string, string> {
  if (platform === 'dingtalk') {
    return {
      appKey: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      corpId: process.env.DINGTALK_CORP_ID || '',
      baseUrl: process.env.DINGTALK_API_BASE_URL || 'https://api.dingtalk.com',
      operatorId: process.env.DINGTALK_OPERATOR_ID || ''
    };
  }
  return {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    baseUrl: process.env.FEISHU_BASE_URL || 'https://open.feishu.cn'
  };
}

/**
 * 新增同平台实例时继承共享凭据，减少重复配置。
 * 每个实例的表格设置仍可单独编辑，密钥可放在环境变量或首个实例中。
 */
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

function pickSharedConfig(platform: PlatformKey, config: Record<string, string>) {
  return sharedConfigKeys[platform].reduce<Record<string, string>>((picked, key) => {
    picked[key] = String(config[key] || '').trim();
    return picked;
  }, {});
}

function stripSharedConfig(platform: PlatformKey, config: Record<string, string>) {
  const next = { ...config };
  sharedConfigKeys[platform].forEach((key) => {
    delete next[key];
  });
  return next;
}

async function storedPlatformConfig(platform: PlatformKey) {
  const rows = await all<{ key: string; value: string }>('SELECT key, value FROM system_settings WHERE key LIKE ?', [`platform.${platform}.%`]);
  const prefix = `platform.${platform}.`;
  return rows.reduce<Record<string, string>>((values, row) => {
    values[row.key.replace(prefix, '')] = row.value;
    return values;
  }, {});
}

async function legacyPlatformConfig(platform: PlatformKey) {
  const row = await get<any>('SELECT * FROM data_source_instances WHERE platform = ? ORDER BY sort_order, id LIMIT 1', [platform]);
  return row ? pickSharedConfig(platform, parseDataSource(row).config) : {};
}

export async function getPlatformConfig(platform: PlatformKey): Promise<PlatformConfig> {
  const stored = await storedPlatformConfig(platform);
  const env = envSharedConfig(platform);
  const legacy = await legacyPlatformConfig(platform);
  const config = sharedConfigKeys[platform].reduce<Record<string, string>>((next, key) => {
    next[key] = String(stored[key] || env[key] || legacy[key] || '');
    return next;
  }, {});
  return { platform, config };
}

export async function getPlatformConfigs() {
  const [dingtalk, feishu] = await Promise.all([
    getPlatformConfig('dingtalk'),
    getPlatformConfig('feishu')
  ]);
  return { dingtalk: dingtalk.config, feishu: feishu.config };
}

export async function savePlatformConfig(platform: PlatformKey, config: Record<string, string>) {
  await withPersistenceBatch(() => {
    sharedConfigKeys[platform].forEach((key) => {
      run(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [`platform.${platform}.${key}`, String(config[key] || '').trim()]
      );
    });
  });
  return getPlatformConfig(platform);
}

async function promoteSharedConfig(platform: PlatformKey, config: Record<string, string>) {
  const shared = pickSharedConfig(platform, config);
  await withPersistenceBatch(() => {
    Object.entries(shared)
      .filter(([, value]) => value)
      .forEach(([key, value]) => {
        run(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
          [`platform.${platform}.${key}`, value]
        );
      });
  });
}

export async function saveDataSource(input: Partial<DataSourceInstance> & { name: string; platform: 'dingtalk' | 'feishu'; config: Record<string, string> }) {
  await promoteSharedConfig(input.platform, input.config);
  const config = stripSharedConfig(input.platform, await inheritSharedConfig(input));
  if (input.id) {
    run('UPDATE data_source_instances SET name = ?, platform = ?, config_json = ?, owner_user_id = ?, enabled = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      input.name,
      input.platform,
      JSON.stringify(config),
      input.ownerUserId ?? null,
      input.enabled === false ? 0 : 1,
      input.sortOrder ?? 0,
      input.id
    ]);
    return getDataSource(input.id);
  }
  run('INSERT INTO data_source_instances (name, platform, config_json, owner_user_id, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?)', [
    input.name,
    input.platform,
    JSON.stringify(config),
    input.ownerUserId ?? null,
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 0
  ]);
  return getDataSource((await get<{ id: number }>('SELECT last_insert_rowid() as id'))?.id);
}

export async function hardDeleteDataSource(dataSourceId: number) {
  const modules = await all<ModuleRow>('SELECT * FROM module_configs WHERE data_source_id = ?', [dataSourceId]);
  await withPersistenceBatch(() => {
    for (const module of modules) {
      run('DELETE FROM module_fields WHERE module_key = ?', [module.module_key]);
      run('DELETE FROM module_permissions WHERE module_key = ?', [module.module_key]);
    }
    run('DELETE FROM module_configs WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM module_rows WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM sheet_cache WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM sync_jobs WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM enterprise_member_sync_logs WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM data_source_staff_assignments WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM user_data_source_preferences WHERE data_source_id = ?', [dataSourceId]);
    run('DELETE FROM data_source_instances WHERE id = ?', [dataSourceId]);
  });
  return { modules: modules.length };
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

/**
 * 新增或更新模块元数据，并阻止重复模块 key 或同数据源下的同名模块。
 */
export async function saveModule(input: Partial<ModuleConfig> & { key: string; title: string; sheetName: string }) {
  const title = input.title.trim();
  const category = input.category || 'project';
  const dataSourceId = input.dataSourceId ?? null;
  const duplicate = await get<ModuleRow>(
    input.id
      ? 'SELECT * FROM module_configs WHERE module_key = ? AND id <> ?'
      : 'SELECT * FROM module_configs WHERE module_key = ?',
    input.id ? [input.key, input.id] : [input.key]
  );
  if (duplicate) {
    throw new Error(`模块 key 已存在：${input.key}`);
  }

  const duplicateTitles = await all<ModuleRow>(
    input.id
      ? 'SELECT * FROM module_configs WHERE title = ? AND category = ? AND id <> ?'
      : 'SELECT * FROM module_configs WHERE title = ? AND category = ?',
    input.id ? [title, category, input.id] : [title, category]
  );
  const duplicateTitle = duplicateTitles.find((row) => (row.data_source_id ?? null) === dataSourceId);
  if (duplicateTitle) {
    throw new Error(`同一数据源下模块名称已存在：${title}`);
  }
  if (input.id) {
    run(
      'UPDATE module_configs SET module_key = ?, title = ?, category = ?, data_source_id = ?, sheet_name = ?, sheet_id = ?, header_row = ?, data_start_row = ?, editable = ?, enabled = ?, sort_order = ?, reference_module_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        input.key,
        title,
        category,
        dataSourceId,
        input.sheetName,
        input.sheetId || null,
        input.headerRow ?? 1,
        input.dataStartRow ?? 2,
        input.editable === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        input.sortOrder ?? 0,
        input.referenceModuleKey || null,
        input.id
      ]
    );
  } else {
    run(
      'INSERT INTO module_configs (module_key, title, category, data_source_id, sheet_name, sheet_id, header_row, data_start_row, editable, enabled, sort_order, reference_module_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.key,
        title,
        category,
        dataSourceId,
        input.sheetName,
        input.sheetId || null,
        input.headerRow ?? 1,
        input.dataStartRow ?? 2,
        input.editable === false ? 0 : 1,
        input.enabled === false ? 0 : 1,
        input.sortOrder ?? 0,
        input.referenceModuleKey || null
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

// 返回配置前，把模块记录和有序字段定义组合起来。
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
    referenceModuleKey: row.reference_module_key || undefined,
    fields: fields.map(normalizeField)
  };
}
