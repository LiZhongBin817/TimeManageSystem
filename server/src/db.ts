import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database } from 'sql.js';

export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'editor' | 'viewer';
  display_name: string;
}

const dbPath = path.resolve(process.cwd(), 'server-data.db');
let db: Database;

function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function run(sql: string, params: unknown[] = []) {
  db.run(sql, params as any[]);
  persist();
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

export async function initDatabase() {
  const SQL = await initSqlJs();
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();

  run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  const count = await get<{ total: number }>('SELECT COUNT(*) as total FROM users');
  if (!count?.total) {
    const users = [
      ['admin', 'admin123', 'admin', '管理员'],
      ['editor', 'editor123', 'editor', '编辑者'],
      ['viewer', 'viewer123', 'viewer', '只读用户']
    ];

    for (const [username, password, role, displayName] of users) {
      run('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)', [
        username,
        bcrypt.hashSync(password, 10),
        role,
        displayName
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
      baseUrl: process.env.DINGTALK_API_BASE_URL || 'https://api.dingtalk.com'
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
