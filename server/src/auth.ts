/**
 * 认证辅助模块：生成 JWT 会话、校验账号状态，并把当前用户挂载到 Express 请求上。
 */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role, getDataSource } from './config/modules';
import { IdentityProvider, UserRecord, findUserById, findUserByLoginNameOrUsername, getUserDataSourcePreference, updateUserSessionId, upsertOAuthUser, withPersistenceBatch } from './db';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '8h';

export interface AuthUser {
  id: number;
  username: string;
  loginName?: string;
  role: Role;
  displayName: string;
  dataSourceId: number;
  platform: 'dingtalk' | 'feishu';
  dataSourceName: string;
  provider?: IdentityProvider | 'local';
  sessionId?: string;
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

/**
 * 解析用户实际使用的数据源后，构建带签名的会话载荷。
 * 用户偏好可能覆盖登录时选择的数据源，因此所有登录入口都复用这段检查。
 */
async function buildSession(user: UserRecord, dataSourceId: number, provider: AuthUser['provider']) {
  assertEnabled(user);
  const preference = await getUserDataSourcePreference(user.id);
  const preferredDataSource = preference?.data_source_id ? await getDataSource(preference.data_source_id) : undefined;
  const dataSource = preferredDataSource?.enabled ? preferredDataSource : await getDataSource(dataSourceId);
  if (!dataSource || !dataSource.enabled) {
    throw new Error('请选择可用的数据源实例');
  }

  const sessionId = randomUUID();
  updateUserSessionId(user.id, sessionId);

  const payload: AuthUser = {
    id: user.id,
    username: user.username,
    loginName: user.login_name || undefined,
    role: user.role,
    displayName: user.display_name,
    dataSourceId: dataSource.id,
    platform: dataSource.platform,
    dataSourceName: dataSource.name,
    provider,
    sessionId
  };

  return {
    user: payload,
    token: jwt.sign(payload, jwtSecret, { expiresIn: jwtExpiresIn } as jwt.SignOptions)
  };
}

export async function login(username: string, password: string, dataSourceId: number) {
  const user = await findUserByLoginNameOrUsername(username);
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
  return withPersistenceBatch(async () => {
    const user = await upsertOAuthUser({ provider, ...identity });
    if (!user) throw new Error('创建用户失败');
    return buildSession(user, dataSourceId, provider);
  });
}

export function signOAuthState(input: { provider: IdentityProvider; dataSourceId: number; redirectUri: string }) {
  return jwt.sign(input, jwtSecret, { expiresIn: '10m' });
}

export function verifyOAuthState(state: string) {
  return jwt.verify(state, jwtSecret) as { provider: IdentityProvider; dataSourceId: number; redirectUri: string };
}

export async function resolveAuthUser(authHeader?: string): Promise<AuthUser | undefined> {
  try {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    if (!token) return undefined;

    const tokenUser = jwt.verify(token, jwtSecret) as AuthUser;
    const user = await findUserById(tokenUser.id);
    if (!user || user.enabled === 0) return undefined;
    if (!tokenUser.sessionId || user.current_session_id !== tokenUser.sessionId) return undefined;

    const tokenDataSource = await getDataSource(tokenUser.dataSourceId);
    if (!tokenDataSource?.enabled) return undefined;

    const preference = await getUserDataSourcePreference(user.id);
    if (preference?.data_source_id && preference.data_source_id !== tokenUser.dataSourceId) return undefined;

    return tokenUser;
  } catch {
    return undefined;
  }
}

function dataSourceChanged(res: Response, message = '账号数据源已变更，请重新登录') {
  res.status(409).json({ code: 'DATA_SOURCE_CHANGED', message });
}

/**
 * 受保护 API 路由的 Express 守卫：校验 JWT，并重新读取可能变化的账号状态。
 * 当所选数据源被切换或禁用时拒绝过期会话。
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ message: '请先登录' });
    return;
  }

  try {
    const tokenUser = jwt.verify(token, jwtSecret) as AuthUser;
    const user = await findUserById(tokenUser.id);
    if (!user) {
      res.status(401).json({ message: '账号不存在，请重新登录' });
      return;
    }
    if (user.enabled === 0) {
      res.status(401).json({ message: '账号已停用，请联系管理员' });
      return;
    }
    if (!tokenUser.sessionId || user.current_session_id !== tokenUser.sessionId) {
      res.status(401).json({ code: 'SESSION_REPLACED', message: '账号已在其他设备登录，请重新登录' });
      return;
    }

    const tokenDataSource = await getDataSource(tokenUser.dataSourceId);
    if (!tokenDataSource?.enabled) {
      dataSourceChanged(res, '当前数据源不可用，请重新登录选择新的数据源');
      return;
    }
    if (tokenDataSource.platform !== tokenUser.platform) {
      dataSourceChanged(res);
      return;
    }

    const preference = await getUserDataSourcePreference(user.id);
    if (preference?.data_source_id && preference.data_source_id !== tokenUser.dataSourceId) {
      dataSourceChanged(res);
      return;
    }

    req.user = {
      ...tokenUser,
      username: user.username,
      loginName: user.login_name || undefined,
      role: user.role,
      displayName: user.display_name,
      platform: tokenDataSource.platform,
      dataSourceName: tokenDataSource.name
    };
    next();
  } catch (error) {
    if (!(error instanceof jwt.JsonWebTokenError) && !(error instanceof jwt.TokenExpiredError)) {
      next(error);
      return;
    }
    res.status(401).json({ message: '登录已过期，请重新登录' });
  }
}
