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
  identity_count?: number;
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

export type StaffRole = 'product' | 'tester' | 'developer';

export interface StaffMemberInput {
  userId?: number | null;
  displayName: string;
  product?: boolean;
  tester?: boolean;
  developer?: boolean;
  enabled?: boolean;
  sortOrder?: number;
}

export interface StaffMemberRecord {
  key: string;
  userId?: number | null;
  username?: string;
  displayName: string;
  source: 'enterprise' | 'manual';
  product: boolean;
  tester: boolean;
  developer: boolean;
  enabled: boolean;
  sortOrder: number;
}

export interface LocalModuleRow {
  id: string;
  rowNumber?: number;
  syncStatus?: string;
  syncAction?: 'upsert' | 'delete';
  syncError?: string;
  updatedAt?: string;
  syncedAt?: string;
  [key: string]: string | number | undefined;
}

export interface ApiUsageSummary {
  todayCalls: number;
  monthCalls: number;
  todayFailures: number;
  monthFailures: number;
  todayTimeouts: number;
  monthTimeouts: number;
  todayCacheHits: number;
  monthCacheHits: number;
  cacheHitRate: number;
  monthlyWarnLimit: number;
  warnLevel: 'ok' | 'warning' | 'danger';
}

export interface DingTalkSyncSettings {
  enabled: boolean;
  scheduledTime: string;
  startupSyncEnabled: boolean;
  startupDelayMs: number;
}

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, '..', 'server-data.db');
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
      reference_module_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('module_configs', 'reference_module_key', 'TEXT');

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
    CREATE TABLE IF NOT EXISTS data_source_staff_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_source_id INTEGER NOT NULL,
      user_id INTEGER,
      display_name TEXT NOT NULL,
      staff_role TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(data_source_id, staff_role, display_name)
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
      user_id INTEGER,
      user_display_name TEXT,
      message TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn('notification_logs', 'user_id', 'INTEGER');
  await ensureColumn('notification_logs', 'user_display_name', 'TEXT');

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

  run(`
    CREATE TABLE IF NOT EXISTS sheet_cache (
      cache_key TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      data_source_id INTEGER,
      module_key TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS api_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      capability TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS module_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      data_source_id INTEGER NOT NULL,
      module_key TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_number INTEGER,
      payload_json TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      sync_action TEXT NOT NULL DEFAULT 'upsert',
      sync_error TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(data_source_id, module_key, row_id)
    )
  `);
  await ensureColumn('module_rows', 'sync_status', "TEXT NOT NULL DEFAULT 'synced'");
  await ensureColumn('module_rows', 'sync_action', "TEXT NOT NULL DEFAULT 'upsert'");
  await ensureColumn('module_rows', 'sync_error', 'TEXT');
  await ensureColumn('module_rows', 'synced_at', 'TEXT');

  run(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      data_source_id INTEGER,
      module_key TEXT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      total_rows INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS enterprise_member_sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      data_source_id INTEGER,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
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

  const enabledAdmin = await get<{ total: number }>("SELECT COUNT(*) as total FROM users WHERE role = 'admin' AND enabled = 1");
  if (!enabledAdmin?.total) {
    const fallbackPassword = bcrypt.hashSync('admin123', 10);
    const existingAdmin = await get<UserRecord>('SELECT * FROM users WHERE username = ?', ['admin']);
    if (existingAdmin) {
      run(
        `UPDATE users
         SET password_hash = ?, role = 'admin', display_name = COALESCE(NULLIF(display_name, ''), '管理员'), enabled = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [fallbackPassword, existingAdmin.id]
      );
    } else {
      run('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)', [
        'admin',
        fallbackPassword,
        'admin',
        '管理员',
        1
      ]);
    }
    console.warn('[auth] 没有启用的管理员账号，已恢复默认管理员 admin/admin123。请登录后立即修改密码。');
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
      d.name as default_data_source_name,
      (
        SELECT COUNT(*)
        FROM user_identities i
        WHERE i.user_id = u.id
      ) as identity_count
    FROM users u
    LEFT JOIN user_data_source_preferences p ON p.user_id = u.id
    LEFT JOIN data_source_instances d ON d.id = p.data_source_id
    ORDER BY u.id DESC
  `);
}

function saveUserDataSourcePreference(userId: number, defaultDataSourceId?: number | null) {
  if (defaultDataSourceId) {
    run(
      `INSERT INTO user_data_source_preferences (user_id, data_source_id, platform, updated_at)
       SELECT ?, id, platform, CURRENT_TIMESTAMP FROM data_source_instances WHERE id = ?
       ON CONFLICT(user_id) DO UPDATE SET
         data_source_id = excluded.data_source_id,
         platform = excluded.platform,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, defaultDataSourceId]
    );
  } else {
    run('DELETE FROM user_data_source_preferences WHERE user_id = ?', [userId]);
  }
}

export async function createLocalUser(input: {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  defaultDataSourceId?: number | null;
}) {
  run('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)', [
    input.username,
    bcrypt.hashSync(input.password, 10),
    input.role,
    input.displayName,
    input.enabled ? 1 : 0
  ]);
  const user = await findUserByUsername(input.username);
  if (!user) throw new Error('用户创建后未找到');
  saveUserDataSourcePreference(user.id, input.defaultDataSourceId);
  return findUserById(user.id);
}

export async function updateUser(input: {
  id: number;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  defaultDataSourceId?: number | null;
  newPassword?: string;
}) {
  if (input.newPassword) {
    run('UPDATE users SET display_name = ?, role = ?, enabled = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      input.displayName,
      input.role,
      input.enabled ? 1 : 0,
      bcrypt.hashSync(input.newPassword, 10),
      input.id
    ]);
  } else {
    run('UPDATE users SET display_name = ?, role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      input.displayName,
      input.role,
      input.enabled ? 1 : 0,
      input.id
    ]);
  }
  saveUserDataSourcePreference(input.id, input.defaultDataSourceId);
  return findUserById(input.id);
}

export async function getUserDataSourcePreference(userId: number) {
  return get<{ data_source_id: number; platform?: string }>(
    'SELECT data_source_id, platform FROM user_data_source_preferences WHERE user_id = ?',
    [userId]
  );
}

const staffRoles: StaffRole[] = ['product', 'tester', 'developer'];

function emptyStaffMember(input: Partial<StaffMemberRecord> & { key: string; displayName: string }): StaffMemberRecord {
  return {
    key: input.key,
    userId: input.userId ?? null,
    username: input.username,
    displayName: input.displayName,
    source: input.source || 'manual',
    product: Boolean(input.product),
    tester: Boolean(input.tester),
    developer: Boolean(input.developer),
    enabled: input.enabled !== false,
    sortOrder: input.sortOrder ?? 0
  };
}

export async function countDataSourceStaffAssignments(dataSourceId: number) {
  const row = await get<{ total: number }>(
    'SELECT COUNT(*) as total FROM data_source_staff_assignments WHERE data_source_id = ?',
    [dataSourceId]
  );
  return Number(row?.total || 0);
}

export async function listDataSourceStaffMembers(dataSourceId: number): Promise<StaffMemberRecord[]> {
  const users = await all<UserRecord>('SELECT * FROM users WHERE enabled = 1 ORDER BY display_name, id');
  const assignments = await all<any>(
    `SELECT a.*, u.username, u.display_name as user_display_name
     FROM data_source_staff_assignments a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.data_source_id = ?
     ORDER BY a.sort_order, a.display_name, a.staff_role`,
    [dataSourceId]
  );
  const members = new Map<string, StaffMemberRecord>();

  for (const user of users) {
    members.set(`user:${user.id}`, emptyStaffMember({
      key: `user:${user.id}`,
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      source: 'enterprise'
    }));
  }

  for (const assignment of assignments) {
    const displayName = String(assignment.user_display_name || assignment.display_name || '').trim();
    if (!displayName) continue;
    const key = assignment.user_id ? `user:${assignment.user_id}` : `manual:${displayName}`;
    const member = members.get(key) || emptyStaffMember({
      key,
      userId: assignment.user_id || null,
      username: assignment.username || undefined,
      displayName,
      source: assignment.user_id ? 'enterprise' : 'manual',
      enabled: Boolean(assignment.enabled),
      sortOrder: assignment.sort_order || 0
    });
    if (staffRoles.includes(assignment.staff_role)) {
      member[assignment.staff_role as StaffRole] = Boolean(assignment.enabled);
    }
    member.sortOrder = Math.min(member.sortOrder || Number.MAX_SAFE_INTEGER, assignment.sort_order || 0);
    members.set(key, member);
  }

  return Array.from(members.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'));
}

export async function listDataSourceStaffOptions(dataSourceId: number) {
  const rows = await all<{ staff_role: StaffRole; display_name: string }>(
    `SELECT a.staff_role, COALESCE(NULLIF(u.display_name, ''), a.display_name) as display_name
     FROM data_source_staff_assignments a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.data_source_id = ? AND a.enabled = 1
     ORDER BY a.sort_order, display_name`,
    [dataSourceId]
  );
  const options: Record<StaffRole, string[]> = { product: [], tester: [], developer: [] };
  const seen: Record<StaffRole, Set<string>> = {
    product: new Set(),
    tester: new Set(),
    developer: new Set()
  };
  for (const row of rows) {
    if (!staffRoles.includes(row.staff_role)) continue;
    const name = String(row.display_name || '').trim();
    if (!name || seen[row.staff_role].has(name)) continue;
    seen[row.staff_role].add(name);
    options[row.staff_role].push(name);
  }
  return options;
}

export async function replaceDataSourceStaffAssignments(dataSourceId: number, members: StaffMemberInput[]) {
  await withPersistenceBatch(() => {
    run('DELETE FROM data_source_staff_assignments WHERE data_source_id = ?', [dataSourceId]);
    members.forEach((member, memberIndex) => {
      const displayName = String(member.displayName || '').trim();
      if (!displayName) return;
      staffRoles.forEach((role, roleIndex) => {
        if (!member[role]) return;
        run(
          `INSERT OR REPLACE INTO data_source_staff_assignments
           (data_source_id, user_id, display_name, staff_role, enabled, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            dataSourceId,
            member.userId || null,
            displayName,
            role,
            member.enabled === false ? 0 : 1,
            member.sortOrder ?? memberIndex * 10 + roleIndex
          ]
        );
      });
    });
  });
  return listDataSourceStaffMembers(dataSourceId);
}

export async function copyDataSourceStaffAssignments(sourceDataSourceId: number, targetDataSourceId: number) {
  const rows = await all<any>(
    'SELECT user_id, display_name, staff_role, enabled, sort_order FROM data_source_staff_assignments WHERE data_source_id = ? ORDER BY sort_order, id',
    [sourceDataSourceId]
  );
  await withPersistenceBatch(() => {
    run('DELETE FROM data_source_staff_assignments WHERE data_source_id = ?', [targetDataSourceId]);
    rows.forEach((row) => {
      run(
        `INSERT OR REPLACE INTO data_source_staff_assignments
         (data_source_id, user_id, display_name, staff_role, enabled, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          targetDataSourceId,
          row.user_id || null,
          row.display_name,
          row.staff_role,
          row.enabled === 0 ? 0 : 1,
          row.sort_order || 0
        ]
      );
    });
  });
  return { copied: rows.length };
}

export async function importStaffOptionsToAssignments(dataSourceId: number, options: Record<StaffRole, string[]>) {
  const byName = new Map<string, StaffMemberInput>();
  staffRoles.forEach((role) => {
    for (const name of options[role] || []) {
      const displayName = String(name || '').trim();
      if (!displayName || displayName === '-') continue;
      const item = byName.get(displayName) || { displayName };
      item[role] = true;
      byName.set(displayName, item);
    }
  });
  if (!byName.size) return { imported: 0 };
  await replaceDataSourceStaffAssignments(dataSourceId, Array.from(byName.values()));
  return { imported: byName.size };
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

export async function getSheetCache<T>(cacheKey: string) {
  const row = await get<{ payload_json: string; updated_at: string }>('SELECT payload_json, updated_at FROM sheet_cache WHERE cache_key = ?', [cacheKey]);
  if (!row) return undefined;
  try {
    return {
      payload: JSON.parse(row.payload_json) as T,
      updatedAt: row.updated_at
    };
  } catch {
    run('DELETE FROM sheet_cache WHERE cache_key = ?', [cacheKey]);
    return undefined;
  }
}

export function setSheetCache(input: { cacheKey: string; platform: string; dataSourceId?: number; moduleKey?: string; payload: unknown }) {
  run(
    `INSERT INTO sheet_cache (cache_key, platform, data_source_id, module_key, payload_json, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(cache_key) DO UPDATE SET
       platform = excluded.platform,
       data_source_id = excluded.data_source_id,
       module_key = excluded.module_key,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      input.cacheKey,
      input.platform,
      input.dataSourceId ?? null,
      input.moduleKey || null,
      JSON.stringify(input.payload)
    ]
  );
}

export async function invalidateSheetCache(input: { platform?: string; dataSourceId?: number; moduleKey?: string } = {}) {
  const clauses = [
    input.platform ? 'platform = ?' : '',
    input.dataSourceId ? 'data_source_id = ?' : '',
    input.moduleKey ? 'module_key = ?' : ''
  ].filter(Boolean);
  const params = [
    ...(input.platform ? [input.platform] : []),
    ...(input.dataSourceId ? [input.dataSourceId] : []),
    ...(input.moduleKey ? [input.moduleKey] : [])
  ];
  const count = await get<{ total: number }>(`SELECT COUNT(*) as total FROM sheet_cache${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`, params);
  run(`DELETE FROM sheet_cache${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`, params);
  return count?.total || 0;
}

export function logApiCall(input: {
  platform: string;
  capability: string;
  path: string;
  statusCode?: number;
  durationMs?: number;
  cacheHit?: boolean;
  success?: boolean;
  errorCode?: string;
}) {
  run(
    `INSERT INTO api_call_logs (platform, capability, path, status_code, duration_ms, cache_hit, success, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.platform,
      input.capability,
      input.path,
      input.statusCode ?? null,
      Math.max(0, Math.round(input.durationMs || 0)),
      input.cacheHit ? 1 : 0,
      input.success === false ? 0 : 1,
      input.errorCode || null
    ]
  );
}

async function scalarCount(sql: string, params: unknown[] = []) {
  return (await get<{ total: number }>(sql, params))?.total || 0;
}

export async function getApiUsageSummary(platform = 'dingtalk'): Promise<ApiUsageSummary> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const monthlyWarnLimit = Number(process.env.DINGTALK_API_MONTHLY_WARN_LIMIT || 7000);
  const [todayCalls, monthCalls, todayFailures, monthFailures, todayTimeouts, monthTimeouts, todayCacheHits, monthCacheHits] = await Promise.all([
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND cache_hit = 0 AND date(created_at) = date(?)", [platform, today]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND cache_hit = 0 AND substr(created_at, 1, 7) = ?", [platform, month]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND success = 0 AND date(created_at) = date(?)", [platform, today]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND success = 0 AND substr(created_at, 1, 7) = ?", [platform, month]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND success = 0 AND error_code LIKE '%timeout%' AND date(created_at) = date(?)", [platform, today]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND success = 0 AND error_code LIKE '%timeout%' AND substr(created_at, 1, 7) = ?", [platform, month]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND cache_hit = 1 AND date(created_at) = date(?)", [platform, today]),
    scalarCount("SELECT COUNT(*) as total FROM api_call_logs WHERE platform = ? AND cache_hit = 1 AND substr(created_at, 1, 7) = ?", [platform, month])
  ]);
  const totalReads = monthCalls + monthCacheHits;
  const cacheHitRate = totalReads ? Math.round((monthCacheHits / totalReads) * 100) : 0;
  const warnLevel = monthCalls >= monthlyWarnLimit * 0.9 ? 'danger' : monthCalls >= monthlyWarnLimit * 0.7 ? 'warning' : 'ok';
  return {
    todayCalls,
    monthCalls,
    todayFailures,
    monthFailures,
    todayTimeouts,
    monthTimeouts,
    todayCacheHits,
    monthCacheHits,
    cacheHitRate,
    monthlyWarnLimit,
    warnLevel
  };
}

function normalizeLocalRow(row: any): LocalModuleRow | undefined {
  if (!row) return undefined;
  try {
    const payload = JSON.parse(row.payload_json || '{}');
    return {
      ...payload,
      id: String(row.row_id),
      rowNumber: row.row_number ? Number(row.row_number) : payload.rowNumber,
      syncStatus: row.sync_status,
      syncAction: row.sync_action || 'upsert',
      syncError: row.sync_error || undefined,
      syncedAt: row.synced_at || undefined,
      updatedAt: row.updated_at || undefined
    };
  } catch {
    return undefined;
  }
}

export async function listLocalModuleRows(dataSourceId: number | undefined, moduleKey: string): Promise<LocalModuleRow[]> {
  if (!dataSourceId) return [];
  const rows = await all<any>(
    `SELECT * FROM module_rows
     WHERE data_source_id = ? AND module_key = ?
       AND COALESCE(sync_action, 'upsert') <> 'delete'
     ORDER BY COALESCE(row_number, id), id`,
    [dataSourceId, moduleKey]
  );
  return rows.map(normalizeLocalRow).filter(Boolean) as LocalModuleRow[];
}

export async function getLocalModuleRow(dataSourceId: number | undefined, moduleKey: string, rowId: string) {
  if (!dataSourceId) return undefined;
  const row = await get<any>(
    `SELECT * FROM module_rows
     WHERE data_source_id = ? AND module_key = ? AND (row_id = ? OR row_number = ?)
     ORDER BY id LIMIT 1`,
    [dataSourceId, moduleKey, rowId, Number(rowId) || -1]
  );
  return normalizeLocalRow(row);
}

export function upsertLocalModuleRow(input: {
  platform: string;
  dataSourceId: number;
  moduleKey: string;
  row: Record<string, unknown>;
  syncStatus?: string;
  syncAction?: 'upsert' | 'delete';
  syncError?: string;
  syncedAt?: string;
}) {
  const rowId = String(input.row.id || input.row.rowNumber || `local-${Date.now()}`);
  const rowNumber = Number(input.row.rowNumber || rowId);
  run(
    `INSERT INTO module_rows (platform, data_source_id, module_key, row_id, row_number, payload_json, sync_status, sync_action, sync_error, synced_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(data_source_id, module_key, row_id) DO UPDATE SET
       row_number = excluded.row_number,
       payload_json = excluded.payload_json,
       sync_status = excluded.sync_status,
       sync_action = excluded.sync_action,
       sync_error = excluded.sync_error,
       synced_at = excluded.synced_at,
       updated_at = CURRENT_TIMESTAMP`,
    [
      input.platform,
      input.dataSourceId,
      input.moduleKey,
      rowId,
      Number.isFinite(rowNumber) ? rowNumber : null,
      JSON.stringify({ ...input.row, id: rowId }),
      input.syncStatus || 'pending',
      input.syncAction || 'upsert',
      input.syncError || null,
      input.syncedAt || null
    ]
  );
}

export async function listPendingLocalModuleRows(dataSourceId: number | undefined, moduleKey: string): Promise<LocalModuleRow[]> {
  if (!dataSourceId) return [];
  const rows = await all<any>(
    `SELECT * FROM module_rows
     WHERE data_source_id = ? AND module_key = ?
       AND sync_status IN ('pending', 'failed')
     ORDER BY updated_at, COALESCE(row_number, id), id`,
    [dataSourceId, moduleKey]
  );
  return rows.map(normalizeLocalRow).filter(Boolean) as LocalModuleRow[];
}

export async function replaceLocalModuleRows(input: {
  platform: string;
  dataSourceId: number;
  moduleKey: string;
  rows: Record<string, unknown>[];
}) {
  await withPersistenceBatch(() => {
    run('DELETE FROM module_rows WHERE data_source_id = ? AND module_key = ?', [input.dataSourceId, input.moduleKey]);
    input.rows.forEach((row) => {
      upsertLocalModuleRow({
        platform: input.platform,
        dataSourceId: input.dataSourceId,
        moduleKey: input.moduleKey,
        row,
        syncStatus: 'synced',
        syncedAt: new Date().toISOString()
      });
    });
  });
}

export function deleteLocalModuleRow(dataSourceId: number | undefined, moduleKey: string, rowId: string) {
  if (!dataSourceId) return;
  run('DELETE FROM module_rows WHERE data_source_id = ? AND module_key = ? AND (row_id = ? OR row_number = ?)', [
    dataSourceId,
    moduleKey,
    rowId,
    Number(rowId) || -1
  ]);
}

export function markLocalModuleRowSync(input: {
  dataSourceId: number;
  moduleKey: string;
  rowId: string;
  status: 'synced' | 'pending' | 'failed';
  error?: string;
}) {
  run(
    `UPDATE module_rows
     SET sync_status = ?, sync_error = ?, synced_at = CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE synced_at END, updated_at = CURRENT_TIMESTAMP
     WHERE data_source_id = ? AND module_key = ? AND (row_id = ? OR row_number = ?)`,
    [
      input.status,
      input.error || null,
      input.status,
      input.dataSourceId,
      input.moduleKey,
      input.rowId,
      Number(input.rowId) || -1
    ]
  );
}

export async function createSyncJob(input: { platform: string; dataSourceId?: number; moduleKey?: string; direction: string }) {
  const dataSourceId = input.dataSourceId ?? null;
  const moduleKey = input.moduleKey || null;
  run(
    'INSERT INTO sync_jobs (platform, data_source_id, module_key, direction, status) VALUES (?, ?, ?, ?, ?)',
    [input.platform, dataSourceId, moduleKey, input.direction, 'running']
  );
  const row = await get<{ id: number }>(
    `SELECT id FROM sync_jobs
     WHERE platform = ?
       AND COALESCE(data_source_id, -1) = COALESCE(?, -1)
       AND COALESCE(module_key, '') = COALESCE(?, '')
       AND direction = ?
     ORDER BY id DESC
     LIMIT 1`,
    [input.platform, dataSourceId, moduleKey, input.direction]
  );
  return row?.id || 0;
}

export function finishSyncJob(input: { id: number; status: 'success' | 'failed'; totalRows?: number; message?: string }) {
  run(
    'UPDATE sync_jobs SET status = ?, total_rows = ?, message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
    [input.status, input.totalRows || 0, input.message || '', input.id]
  );
}

export function failStaleRunningSyncJobs(minutes = 30) {
  run(
    `UPDATE sync_jobs
     SET status = 'failed',
         message = CASE WHEN message = '' THEN '任务中断或服务重启，已自动标记失败' ELSE message END,
         finished_at = CURRENT_TIMESTAMP
     WHERE status = 'running'
       AND datetime(started_at) <= datetime('now', ?)`,
    [`-${minutes} minutes`]
  );
}

export function logEnterpriseMemberSync(input: {
  provider: string;
  dataSourceId?: number;
  status: 'success' | 'failed';
  total?: number;
  created?: number;
  updated?: number;
  message?: string;
}) {
  run(
    `INSERT INTO enterprise_member_sync_logs (provider, data_source_id, status, total, created, updated, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.provider,
      input.dataSourceId ?? null,
      input.status,
      input.total || 0,
      input.created || 0,
      input.updated || 0,
      input.message || ''
    ]
  );
}

export async function getSyncOverview(dataSourceId?: number) {
  const params = dataSourceId ? [dataSourceId] : [];
  const dataSourceClause = dataSourceId ? 'WHERE data_source_id = ?' : '';
  const rowStats = await get<{ total: number; pending: number; failed: number; synced: number }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) as failed,
       SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END) as synced
     FROM module_rows ${dataSourceClause}`,
    params
  );
  const jobs = await all<any>(
    `SELECT * FROM sync_jobs
     ${dataSourceClause}
     ORDER BY id DESC
     LIMIT 20`,
    params
  );
  const memberLogs = await all<any>(
    `SELECT * FROM enterprise_member_sync_logs
     ${dataSourceClause}
     ORDER BY id DESC
     LIMIT 20`,
    params
  );
  return {
    rows: {
      total: rowStats?.total || 0,
      pending: rowStats?.pending || 0,
      failed: rowStats?.failed || 0,
      synced: rowStats?.synced || 0
    },
    jobs,
    memberLogs
  };
}

function boolSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function normalizeTimeSetting(value: string | undefined, fallback = '02:00') {
  const text = String(value || fallback).trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
}

export async function getDingTalkSyncSettings(): Promise<DingTalkSyncSettings> {
  const rows = await all<{ key: string; value: string }>("SELECT key, value FROM system_settings WHERE key LIKE 'dingtalk.sync.%'");
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    enabled: boolSetting(values.get('dingtalk.sync.enabled'), process.env.DINGTALK_SYNC_ENABLED !== 'false'),
    scheduledTime: normalizeTimeSetting(values.get('dingtalk.sync.scheduledTime'), process.env.DINGTALK_SYNC_TIME || '02:00'),
    startupSyncEnabled: boolSetting(values.get('dingtalk.sync.startupSyncEnabled'), process.env.DINGTALK_SYNC_STARTUP_ENABLED !== 'false'),
    startupDelayMs: Number(values.get('dingtalk.sync.startupDelayMs') || process.env.DINGTALK_SYNC_STARTUP_DELAY_MS || 15000)
  };
}

export async function saveDingTalkSyncSettings(input: Partial<DingTalkSyncSettings>) {
  const current = await getDingTalkSyncSettings();
  const next: DingTalkSyncSettings = {
    enabled: input.enabled ?? current.enabled,
    scheduledTime: normalizeTimeSetting(input.scheduledTime, current.scheduledTime),
    startupSyncEnabled: input.startupSyncEnabled ?? current.startupSyncEnabled,
    startupDelayMs: Math.max(0, Number(input.startupDelayMs ?? current.startupDelayMs) || 0)
  };
  await withPersistenceBatch(() => {
    Object.entries({
      'dingtalk.sync.enabled': String(next.enabled),
      'dingtalk.sync.scheduledTime': next.scheduledTime,
      'dingtalk.sync.startupSyncEnabled': String(next.startupSyncEnabled),
      'dingtalk.sync.startupDelayMs': String(next.startupDelayMs)
    }).forEach(([key, value]) => {
      run(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
      );
    });
  });
  return next;
}
