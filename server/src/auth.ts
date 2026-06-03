import bcrypt from 'bcryptjs';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role, getDataSource } from './config/modules';
import { IdentityProvider, UserRecord, findUserByUsername, getUserDataSourcePreference, upsertOAuthUser } from './db';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  dataSourceId: number;
  platform: 'dingtalk' | 'feishu';
  dataSourceName: string;
  provider?: IdentityProvider | 'local';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function assertEnabled(user: UserRecord) {
  if (user.enabled === 0) {
    throw new Error('账号已停用，请联系管理员');
  }
}

async function buildSession(user: UserRecord, dataSourceId: number, provider: AuthUser['provider']) {
  assertEnabled(user);
  const preference = await getUserDataSourcePreference(user.id);
  const preferredDataSource = preference?.data_source_id ? await getDataSource(preference.data_source_id) : undefined;
  const dataSource = preferredDataSource?.enabled ? preferredDataSource : await getDataSource(dataSourceId);
  if (!dataSource || !dataSource.enabled) {
    throw new Error('请选择可用的数据源实例');
  }

  const payload: AuthUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    dataSourceId: dataSource.id,
    platform: dataSource.platform,
    dataSourceName: dataSource.name,
    provider
  };

  return {
    user: payload,
    token: jwt.sign(payload, jwtSecret, { expiresIn: '8h' })
  };
}

export async function login(username: string, password: string, dataSourceId: number) {
  const user = await findUserByUsername(username);
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return null;
  }
  return buildSession(user, dataSourceId, 'local');
}

export async function loginWithOAuth(
  provider: IdentityProvider,
  dataSourceId: number,
  identity: {
    providerUserId: string;
    unionId?: string;
    openId?: string;
    name?: string;
    avatar?: string;
    mobile?: string;
    email?: string;
    raw?: unknown;
  }
) {
  const user = await upsertOAuthUser({ provider, ...identity });
  if (!user) throw new Error('创建用户失败');
  return buildSession(user, dataSourceId, provider);
}

export function signOAuthState(input: { provider: IdentityProvider; dataSourceId: number; redirectUri: string }) {
  return jwt.sign(input, jwtSecret, { expiresIn: '10m' });
}

export function verifyOAuthState(state: string) {
  return jwt.verify(state, jwtSecret) as { provider: IdentityProvider; dataSourceId: number; redirectUri: string };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ message: '请先登录' });
    return;
  }

  try {
    req.user = jwt.verify(token, jwtSecret) as AuthUser;
    next();
  } catch {
    res.status(401).json({ message: '登录已过期，请重新登录' });
  }
}
