import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database } from 'sql.js';

export type UserRole = 'admin' | 'editor' | 'viewer';
export type IdentityProvider = 'dingtalk' | 'feishu';

export interface UserRecord {
  id: number;
  username: string;
  password_hash?: string | null;
  role: UserRole;
  display_name: string;
  enabled: number;
  created_at: string;
  updated_at?: string;
  default_data_source_id?: number | null;
  default_data_source_name?: string | null;
}

export interface UserIdentityRecord {
  id: number;
  user_id: number;
  provider: IdentityProvider;
  provider_user_id: string;
  union_id?: string;
  open_id?: string;
  name?: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  raw_json?: string;
  created_at: string;
  updated_at?: string;
}

export type PermissionSubjectType = 'role' | 'user';

export interface ModulePermissionRecord {
  subject_type: PermissionSubjectType;
  subject_id: string;
  module_key: string;
  can_view: number;
  can_create: number;
  can_update: number;
  can_delete: number;
}

export interface ModulePermissionInput {
  moduleKey: string;
  canView: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface EnterpriseMemberInput {
  provider: IdentityProvider;
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

const dbPath = path.resolve(process.cwd(), 'server-data.db');
let db: Database;
let batchDepth = 0;
let batchDirty = false;

function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function run(sql: string, params: unknown[] = []) {
  db.run(sql, params as any[]);
  if (batchDepth > 0) {
    batchDirty = true;
  } else {
    persist();
  }
}

export async function withPersistenceBatch<T>(fn: () => T | Promise<T>) {
  batchDepth += 1;
  try {
    return await fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false;
      persist();
    }
  }
}

export async function get<T>(sql: string, params: unknown[] = []) {
  const statement = db.prepare(sql);
  statement.bind(params as any[]);
  const row = statement.step() ? (statement.getAsObject() as T) : undefined;
  statement.free();
  return row;
}

export async function all<T>(sql: string, params: unknown[] = []) {
  const statement = db.prepare(sql);
  statement.bind(params as any[]);
  const rows: T[] = [];
  while (statement.step()) rows.push(statement.getAsObject() as T);
  statement.free();
  return rows;
}

async function hasColumn(table: string, column: string) {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

async function ensureColumn(table: string, column: string, definition: string) {
  if (!(await hasColumn(table, column))) {
    run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function initDatabase() {
  const SQL = await initSqlJs();
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();

  run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('users', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('users', 'updated_at', 'TEXT');
  run("UPDATE users SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)");

  run(`
    CREATE TABLE IF NOT EXISTS user_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      union_id TEXT,
      open_id TEXT,
      name TEXT,
      avatar TEXT,
      mobile TEXT,
      email TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_user_id)
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS data_source_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS module_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'project',
      data_source_id INTEGER,
      sheet_name TEXT NOT NULL,
      sheet_id TEXT,
      header_row INTEGER NOT NULL DEFAULT 1,
      data_start_row INTEGER NOT NULL DEFAULT 2,
      editable INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS module_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_key TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      formula INTEGER NOT NULL DEFAULT 0,
      staff_role TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(module_key, field_key)
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS user_data_source_preferences (
      user_id INTEGER PRIMARY KEY,
      platform TEXT,
      data_source_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS module_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      module_key TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(subject_type, subject_id, module_key)
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      module_key TEXT NOT NULL,
      action TEXT NOT NULL,
      row_id TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel TEXT NOT NULL DEFAULT 'dingtalk_robot',
      enabled INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT,
      secret TEXT,
      keyword_json TEXT,
      scheduled_time TEXT,
      last_scheduled_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('notification_settings', 'keyword_json', 'TEXT');

  run(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS notification_user_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      scheduled_time TEXT NOT NULL DEFAULT '09:00',
      last_scheduled_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const notificationCount = await get<{ total: number }>('SELECT COUNT(*) as total FROM notification_settings');
  if (!notificationCount?.total) {
    run('INSERT INTO notification_settings (id, channel, enabled, webhook_url, secret, keyword_json, scheduled_time) VALUES (1, ?, ?, ?, ?, ?, ?)', [
      'dingtalk_robot',
      0,
      '',
      '',
      JSON.stringify(['项目提醒']),
      '09:00'
    ]);
  }

  const count = await get<{ total: number }>('SELECT COUNT(*) as total FROM users');
  if (!count?.total) {
    const users = [
      ['admin', 'admin123', 'admin', '管理员'],
      ['editor', 'editor123', 'editor', '编辑者'],
      ['viewer', 'viewer123', 'viewer', '只读用户']
    ];

    for (const [username, password, role, displayName] of users) {
      run('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)', [
        username,
        bcrypt.hashSync(password, 10),
        role,
        displayName,
        1
      ]);
    }
  }

  await seedConfigTables();
}

async function seedConfigTables() {
  const dsCount = await get<{ total: number }>('SELECT COUNT(*) as total FROM data_source_instances');
  if (!dsCount?.total) {
    const dingtalkConfig = {
      appKey: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      workbookId: process.env.DINGTALK_WORKBOOK_ID || '',
      operatorId: process.env.DINGTALK_OPERATOR_ID || '',
      baseUrl: process.env.DINGTALK_API_BASE_URL || 'https://api.dingtalk.com',
      loginEnabled: 'true',
      localLoginEnabled: process.env.LOCAL_LOGIN_ENABLED || 'false'
    };
    run('INSERT INTO data_source_instances (name, platform, config_json, enabled, sort_order) VALUES (?, ?, ?, ?, ?)', [
      '钉钉-项目管理表',
      'dingtalk',
      JSON.stringify(dingtalkConfig),
      1,
      1
    ]);
  }

  const moduleCount = await get<{ total: number }>('SELECT COUNT(*) as total FROM module_configs');
  if (moduleCount?.total) return;

  const ds = await get<{ id: number }>("SELECT id FROM data_source_instances WHERE platform = 'dingtalk' ORDER BY id LIMIT 1");
  const dataSourceId = ds?.id ?? null;
  const modules = [
    ['power-standard', '发电标准版', 'project', '发电标准版', 's2', 10],
    ['sales-standard', '售电标准版', 'project', '售电标准版', 's3', 20],
    ['crawler', '爬虫', 'project', '爬虫', 's4', 30],
    ['province-system', '分省系统', 'project', '分省系统', 's5', 40],
    ['staff', '人员信息', 'staff', '人员信息', 's6', 50],
    ['todos', '待办事项', 'todo', '待办事项', 's8', 60]
  ];

  for (const [key, title, category, sheetName, sheetId, sortOrder] of modules) {
    run(
      'INSERT INTO module_configs (module_key, title, category, data_source_id, sheet_name, sheet_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [key, title, category, dataSourceId, sheetName, sheetId, sortOrder]
    );
  }

  const standardFields = [
    ['sequence', '序号', 'number', 1, 1, 0, '', 10],
    ['branchName', '分支名称', 'text', 0, 0, 0, '', 20],
    ['content', '内容', 'text', 0, 0, 0, '', 30],
    ['zentaoLink', '禅道链接', 'link', 0, 0, 0, '', 40],
    ['isCompleted', '是否完成', 'formula', 0, 1, 1, '', 50],
    ['plannedTestAt', '计划提测时间', 'date', 0, 0, 0, '', 60],
    ['actualTestAt', '实际提测时间', 'date', 0, 0, 0, '', 70],
    ['launchAt', '上线时间', 'date', 0, 0, 0, '', 80],
    ['developer', '研发人员', 'staff', 0, 0, 0, 'developer', 90],
    ['productOwner', '产品人员', 'staff', 0, 0, 0, 'product', 100],
    ['tester', '测试人员', 'staff', 0, 0, 0, 'tester', 110],
    ['name', '名称', 'formula', 0, 1, 1, '', 120],
    ['remark', '备注', 'text', 0, 0, 0, '', 130]
  ];
  const staffFields = [
    ['productOwner', '产品人员', 'text', 0, 0, 0, '', 10],
    ['tester', '测试人员', 'text', 0, 0, 0, '', 20],
    ['developer', '开发人员', 'text', 0, 0, 0, '', 30]
  ];

  for (const [key, , category] of modules) {
    const fields = category === 'staff' ? staffFields : standardFields;
    for (const field of fields) {
      run(
        'INSERT INTO module_fields (module_key, field_key, label, type, required, hidden, formula, staff_role, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [key, ...field]
      );
    }
  }
}

export async function findUserByUsername(username: string) {
  return get<UserRecord>('SELECT * FROM users WHERE username = ?', [username]);
}

export async function findUserById(id: number) {
  return get<UserRecord>('SELECT * FROM users WHERE id = ?', [id]);
}

export async function listUsers() {
  return all<UserRecord>(`
    SELECT
      u.*,
      p.data_source_id as default_data_source_id,
      d.name as default_data_source_name
    FROM users u
    LEFT JOIN user_data_source_preferences p ON p.user_id = u.id
    LEFT JOIN data_source_instances d ON d.id = p.data_source_id
    ORDER BY u.id DESC
  `);
}

export async function updateUser(input: { id: number; displayName: string; role: UserRole; enabled: boolean; defaultDataSourceId?: number | null }) {
  run('UPDATE users SET display_name = ?, role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    input.displayName,
    input.role,
    input.enabled ? 1 : 0,
    input.id
  ]);
  if (input.defaultDataSourceId) {
    run(
      `INSERT INTO user_data_source_preferences (user_id, data_source_id, platform, updated_at)
       SELECT ?, id, platform, CURRENT_TIMESTAMP FROM data_source_instances WHERE id = ?
       ON CONFLICT(user_id) DO UPDATE SET
         data_source_id = excluded.data_source_id,
         platform = excluded.platform,
         updated_at = CURRENT_TIMESTAMP`,
      [input.id, input.defaultDataSourceId]
    );
  } else {
    run('DELETE FROM user_data_source_preferences WHERE user_id = ?', [input.id]);
  }
  return findUserById(input.id);
}

export async function getUserDataSourcePreference(userId: number) {
  return get<{ data_source_id: number; platform?: string }>(
    'SELECT data_source_id, platform FROM user_data_source_preferences WHERE user_id = ?',
    [userId]
  );
}

export async function getUserIdentityForProvider(userId: number, provider: IdentityProvider) {
  return get<UserIdentityRecord>(
    'SELECT * FROM user_identities WHERE user_id = ? AND provider = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
    [userId, provider]
  );
}

function defaultModulePermission(role: UserRole, module: { enabled: boolean; editable: boolean }) {
  const canEdit = module.enabled && module.editable && (role === 'admin' || role === 'editor');
  return {
    canView: module.enabled,
    canCreate: canEdit,
    canUpdate: canEdit,
    canDelete: canEdit
  };
}

function normalizePermission(row: ModulePermissionRecord | undefined, fallback: ReturnType<typeof defaultModulePermission>) {
  if (!row) return fallback;
  return {
    canView: Boolean(row.can_view),
    canCreate: Boolean(row.can_create),
    canUpdate: Boolean(row.can_update),
    canDelete: Boolean(row.can_delete)
  };
}

export async function getModulePermission(input: {
  userId: number;
  role: UserRole;
  module: { key: string; enabled: boolean; editable: boolean };
}) {
  const fallback = defaultModulePermission(input.role, input.module);
  const userPermission = await get<ModulePermissionRecord>(
    'SELECT * FROM module_permissions WHERE subject_type = ? AND subject_id = ? AND module_key = ?',
    ['user', String(input.userId), input.module.key]
  );
  if (userPermission) return normalizePermission(userPermission, fallback);

  const rolePermission = await get<ModulePermissionRecord>(
    'SELECT * FROM module_permissions WHERE subject_type = ? AND subject_id = ? AND module_key = ?',
    ['role', input.role, input.module.key]
  );
  return normalizePermission(rolePermission, fallback);
}

export async function listModulePermissions(subjectType: PermissionSubjectType, subjectId: string) {
  return all<ModulePermissionRecord>(
    'SELECT * FROM module_permissions WHERE subject_type = ? AND subject_id = ? ORDER BY module_key',
    [subjectType, subjectId]
  );
}

export async function replaceModulePermissions(subjectType: PermissionSubjectType, subjectId: string, permissions: ModulePermissionInput[]) {
  await withPersistenceBatch(() => {
    run('DELETE FROM module_permissions WHERE subject_type = ? AND subject_id = ?', [subjectType, subjectId]);
    for (const permission of permissions) {
      run(
        `INSERT INTO module_permissions
         (subject_type, subject_id, module_key, can_view, can_create, can_update, can_delete)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          subjectType,
          subjectId,
          permission.moduleKey,
          permission.canView ? 1 : 0,
          permission.canCreate ? 1 : 0,
          permission.canUpdate ? 1 : 0,
          permission.canDelete ? 1 : 0
        ]
      );
    }
  });
  return listModulePermissions(subjectType, subjectId);
}

export async function findIdentity(provider: IdentityProvider, providerUserId: string) {
  return get<UserIdentityRecord>('SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?', [provider, providerUserId]);
}

async function findReusableIdentity(member: EnterpriseMemberInput) {
  const exact = await findIdentity(member.provider, member.providerUserId);
  if (exact) return exact;

  const candidates: Array<[string, string | undefined]> = [
    ['union_id', member.unionId],
    ['open_id', member.openId],
    ['mobile', member.mobile],
    ['email', member.email]
  ];
  for (const [column, value] of candidates) {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) continue;
    const identity = await get<UserIdentityRecord>(
      `SELECT * FROM user_identities WHERE provider = ? AND ${column} = ? ORDER BY id LIMIT 1`,
      [member.provider, cleanValue]
    );
    if (identity) return identity;
  }
  return undefined;
}

export async function upsertOAuthUser(input: {
  provider: IdentityProvider;
  providerUserId: string;
  unionId?: string;
  openId?: string;
  name?: string;
  avatar?: string;
  mobile?: string;
  email?: string;
  raw?: unknown;
}) {
  const identity = await findIdentity(input.provider, input.providerUserId);
  if (identity) {
    let linkedUser = await findUserById(identity.user_id);
    if (!linkedUser) {
      const repairedUsername = `${input.provider}_${input.providerUserId}`.replace(/[^\w.-]/g, '_').slice(0, 80);
      linkedUser = await findUserByUsername(repairedUsername);
      if (linkedUser) {
        run('UPDATE user_identities SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [linkedUser.id, identity.id]);
      }
    }
    run(
      'UPDATE user_identities SET union_id = ?, open_id = ?, name = ?, avatar = ?, mobile = ?, email = ?, raw_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        input.unionId || null,
        input.openId || null,
        input.name || null,
        input.avatar || null,
        input.mobile || null,
        input.email || null,
        input.raw ? JSON.stringify(input.raw) : null,
        identity.id
      ]
    );
    return linkedUser || findUserById(identity.user_id);
  }

  const baseUsername = `${input.provider}_${input.providerUserId}`.replace(/[^\w.-]/g, '_').slice(0, 80);
  let username = baseUsername;
  let suffix = 1;
  while (await findUserByUsername(username)) {
    username = `${baseUsername}_${suffix}`;
    suffix += 1;
  }

  try {
    run('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)', [
      username,
      null,
      'viewer',
      input.name || username,
      1
    ]);
    const createdUser = await findUserByUsername(username);
    if (!createdUser) throw new Error('新用户写入后未找到');
    run(
      'INSERT INTO user_identities (user_id, provider, provider_user_id, union_id, open_id, name, avatar, mobile, email, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        createdUser.id,
        input.provider,
        input.providerUserId,
        input.unionId || null,
        input.openId || null,
        input.name || null,
        input.avatar || null,
        input.mobile || null,
        input.email || null,
        input.raw ? JSON.stringify(input.raw) : null
      ]
    );
    return createdUser;
  } catch (error: any) {
    throw new Error(`创建用户失败：${error.message || error}`);
  }
}

export async function upsertEnterpriseMembers(members: EnterpriseMemberInput[]) {
  let created = 0;
  let updated = 0;

  await withPersistenceBatch(async () => {
    for (const member of members) {
      const existing = await findReusableIdentity(member);
      if (existing) {
        run(
          'UPDATE user_identities SET provider_user_id = ?, union_id = ?, open_id = ?, name = ?, avatar = ?, mobile = ?, email = ?, raw_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [
            member.providerUserId,
            member.unionId || null,
            member.openId || null,
            member.name || null,
            member.avatar || null,
            member.mobile || null,
            member.email || null,
            member.raw ? JSON.stringify(member.raw) : null,
            existing.id
          ]
        );
        run('UPDATE users SET display_name = COALESCE(NULLIF(?, \'\'), display_name), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
          member.name,
          existing.user_id
        ]);
        updated += 1;
        continue;
      }

      const baseUsername = `${member.provider}_${member.providerUserId}`.replace(/[^\w.-]/g, '_').slice(0, 80);
      let username = baseUsername;
      let suffix = 1;
      const existingUserByName = await findUserByUsername(username);
      if (existingUserByName) {
        run(
          'INSERT INTO user_identities (user_id, provider, provider_user_id, union_id, open_id, name, avatar, mobile, email, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            existingUserByName.id,
            member.provider,
            member.providerUserId,
            member.unionId || null,
            member.openId || null,
            member.name || null,
            member.avatar || null,
            member.mobile || null,
            member.email || null,
            member.raw ? JSON.stringify(member.raw) : null
          ]
        );
        run('UPDATE users SET display_name = COALESCE(NULLIF(?, \'\'), display_name), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
          member.name,
          existingUserByName.id
        ]);
        updated += 1;
        continue;
      }
      while (await findUserByUsername(username)) {
        username = `${baseUsername}_${suffix}`;
        suffix += 1;
      }

      run('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)', [
        username,
        null,
        'viewer',
        member.name || username,
        1
      ]);
      const user = await findUserByUsername(username);
      if (!user) continue;
      run(
        'INSERT INTO user_identities (user_id, provider, provider_user_id, union_id, open_id, name, avatar, mobile, email, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          user.id,
          member.provider,
          member.providerUserId,
          member.unionId || null,
          member.openId || null,
          member.name || null,
          member.avatar || null,
          member.mobile || null,
          member.email || null,
          member.raw ? JSON.stringify(member.raw) : null
        ]
      );
      created += 1;
    }
  });

  return { total: members.length, created, updated };
}

export async function addAuditLog(input: {
  userId?: number;
  username: string;
  moduleKey: string;
  action: string;
  rowId?: string;
  payload?: unknown;
}) {
  run('INSERT INTO audit_logs (user_id, username, module_key, action, row_id, payload) VALUES (?, ?, ?, ?, ?, ?)', [
    input.userId ?? null,
    input.username,
    input.moduleKey,
    input.action,
    input.rowId ?? null,
    input.payload ? JSON.stringify(input.payload) : null
  ]);
}
