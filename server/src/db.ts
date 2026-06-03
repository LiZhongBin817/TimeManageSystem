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

function run(sql: string, params: unknown[] = []) {
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

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
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
