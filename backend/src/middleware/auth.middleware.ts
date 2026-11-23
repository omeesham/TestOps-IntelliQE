/**
 * Auth middleware.
 *
 * Reads `Authorization: Bearer <jwt>` and verifies the JWT signature.
 * Attaches a small `AuthUser` to `req.user` for downstream routes.
 *
 * Legacy token format (`intelliqe-demo-token-{ts}:{username}`) is still
 * accepted for one release cycle so existing sessions don't break — the
 * server then does a DB lookup. Disable by setting `LEGACY_TOKEN_AUTH=false`.
 */
import type { Request, Response, NextFunction } from 'express';
import pool from '../db.js';
import { verifyToken } from '../utils/jwt.js';

export interface AuthUser {
  username: string;
  userId: string;
  role: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  isPlatform: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const LEGACY_PREFIX = 'intelliqe-demo-token-';

// ── Session revocation ──────────────────────────────────────────────────────
// A JWT is stateless, so a deactivated/deleted user would otherwise keep a valid
// token until it expires. We re-check `is_active` on the JWT path, cached briefly
// so it is not a DB hit on every request. Deactivating/deleting a user busts the
// cache in-process (immediate here); other replicas pick it up within the TTL.
const ACTIVE_TTL_MS = Number(process.env.AUTH_ACTIVE_TTL_MS) || 30_000;
const activeCache = new Map<string, { active: boolean; expiresAt: number }>();

async function isUserActive(userId: string): Promise<boolean> {
  if (!userId) return false;
  const now = Date.now();
  const hit = activeCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.active;
  let active: boolean;
  try {
    const { rows } = await pool.query(`SELECT 1 AS ok FROM users WHERE id = $1 AND is_active = 1`, [userId]);
    active = rows.length > 0;
  } catch {
    // Fail OPEN on a transient DB error: the token is already cryptographically
    // valid, and a DB blip must not log every user out. Do not cache this.
    return true;
  }
  activeCache.set(userId, { active, expiresAt: now + ACTIVE_TTL_MS });
  return active;
}

/** Drop a user's cached active-status so a deactivate/delete takes effect at once
 *  (in this process). Call it from the user-management mutation handlers. */
export function revokeUserFromCache(userId: string): void {
  if (userId) activeCache.delete(userId);
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }
    const token = authHeader.slice(7);

    // ── Path A: JWT (current) ──────────────────────────────
    if (!token.startsWith(LEGACY_PREFIX)) {
      let claims;
      try {
        claims = verifyToken(token);
      } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      // Reject a token whose user has since been deactivated or deleted.
      if (!(await isUserActive(claims.uid))) {
        res.status(401).json({ error: 'Session revoked — please log in again' });
        return;
      }
      req.user = {
        username: claims.sub,
        userId: claims.uid,
        role: claims.role,
        displayName: claims.sub,
        tenantId: claims.tid,
        tenantName: claims.tn,
        isPlatform: claims.pf,
      };
      next();
      return;
    }

    // ── Path B: Legacy demo token — DB-backed lookup ──────
    if (process.env.LEGACY_TOKEN_AUTH === 'false') {
      res.status(401).json({ error: 'Token format no longer supported — please log in again' });
      return;
    }
    const colonIdx = token.lastIndexOf(':');
    if (colonIdx === -1) {
      res.status(401).json({ error: 'Invalid token format' });
      return;
    }
    const username = token.slice(colonIdx + 1);
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role,
              t.id AS tenant_id, t.name AS tenant_name, t.is_platform
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1 AND u.is_active = 1`,
      [username],
    );
    if (rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    const row = rows[0];
    req.user = {
      username: row.username,
      userId: row.id,
      role: row.role,
      displayName: row.full_name,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      isPlatform: row.is_platform,
    };
    next();
  } catch (err) {
    console.error('Auth middleware error:', (err as Error).message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
