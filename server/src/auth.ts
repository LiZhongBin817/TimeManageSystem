import bcrypt from 'bcryptjs';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from './config/modules';
import { findUserByUsername } from './db';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  displayName: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function login(username: string, password: string) {
  const user = await findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return null;
  }

  const payload: AuthUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name
  };

  return {
    user: payload,
    token: jwt.sign(payload, jwtSecret, { expiresIn: '8h' })
  };
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
