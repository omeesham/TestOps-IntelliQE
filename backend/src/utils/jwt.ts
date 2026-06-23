/**
 * JWT signing and verification.
 *
 * - HS256 (HMAC-SHA256) with a shared secret from `JWT_SECRET` env var.
 * - Token lifetime configurable via `JWT_EXPIRES_IN` (default 24h).
 * - Tokens carry the minimum needed for auth: username + role + tenant.
 *
 * For multi-instance deployments behind a load balancer, every replica must
 * see the same JWT_SECRET (set via env var or your cloud secret manager).
 */
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;        // username
  uid: string;        // user UUID
  role: string;       // 'admin' | 'qa_engineer' | 'data_analyst'
  tid: string;        // tenant ID
  tn: string;         // tenant name
  pf: boolean;        // is_platform
}

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production');
    }
    // Dev fallback — deterministic, with a warning emitted once at boot.
    return 'intelliqe-dev-jwt-secret-change-me';
  }
  if (s.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return s;
}

export function signToken(payload: JwtPayload): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || '24h';
  const opts: SignOptions = { algorithm: 'HS256', expiresIn: expiresIn as any };
  return jwt.sign(payload, getSecret(), opts);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as JwtPayload;
}
