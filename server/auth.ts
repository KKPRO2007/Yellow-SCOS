import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Db } from './db.js';

export type Role = 'buyer' | 'seller' | 'admin';
export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const SESSION_DAYS = 7;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`, [
    token,
    userId,
    String(SESSION_DAYS),
  ]);
  return token;
}

/** Attaches req.user when a valid bearer token is present. Never rejects. */
export function loadUser(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) {
      const rows = await db.query<User>(
        `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = $1 AND s.expires_at > now()`,
        [token],
      );
      if (rows[0]) req.user = rows[0];
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Sign in first.' });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'FORBIDDEN', message: `This needs a ${roles.join(' or ')} account.` });
    next();
  };
}
