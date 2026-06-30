import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db.js';
import { decryptField } from '../utils/crypto.js';

const S = '"JBSTestOpsAI"';
const router = Router();

const VALID_ROLES = ['admin', 'qa_engineer', 'data_analyst'];

function isAdmin(req: Request): boolean {
  return req.user?.role === 'admin';
}

/* ───────────────────────────────────────────
   GET /api/users/menu-config
   Return allowed sidebar paths for the current tenant
   (any authenticated role can call this — used by Sidebar)
   ─────────────────────────────────────────── */
router.get('/menu-config', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { rows } = await pool.query(
      `SELECT config_data FROM ${S}.client_configurations WHERE tenant_id = $1 AND integration_id = 'menu-config'`,
      [tenantId]
    );
    if (rows.length === 0) {
      res.json({ allowedPaths: null }); // null = all menus allowed
    } else {
      const config = rows[0].config_data;
      res.json({ allowedPaths: config?.allowed_paths || null });
    }
  } catch (err: any) {
    console.error('Menu config error:', err.message);
    res.status(500).json({ error: 'Failed to fetch menu config' });
  }
});

/* ───────────────────────────────────────────
   GET /api/users/tenants
   List all tenants (platform admin only, for create user dropdown)
   ─────────────────────────────────────────── */
router.get('/tenants', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }
    if (!req.user!.isPlatform) { res.status(403).json({ error: 'Platform admin access required' }); return; }

    const { rows } = await pool.query(
      `SELECT id, name, slug, is_platform FROM ${S}.tenants ORDER BY is_platform DESC, name`
    );
    res.json({ tenants: rows });
  } catch (err: any) {
    console.error('List tenants error:', err.message);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

/* ───────────────────────────────────────────
   GET /api/users
   List users — platform admin sees all tenants, client admin sees own tenant
   ─────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const user = req.user!;
    let query: string;
    let params: any[];

    if (user.isPlatform) {
      query = `SELECT u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.created_at, u.updated_at,
                      t.name AS tenant_name, t.slug AS tenant_slug
               FROM ${S}.users u
               JOIN ${S}.tenants t ON t.id = u.tenant_id
               ORDER BY t.name, u.created_at DESC`;
      params = [];
    } else {
      query = `SELECT u.id, u.username, u.email, u.full_name, u.role, u.is_active, u.created_at, u.updated_at,
                      t.name AS tenant_name, t.slug AS tenant_slug
               FROM ${S}.users u
               JOIN ${S}.tenants t ON t.id = u.tenant_id
               WHERE u.tenant_id = $1
               ORDER BY u.created_at DESC`;
      params = [user.tenantId];
    }

    const { rows } = await pool.query(query, params);
    res.json({ users: rows });
  } catch (err: any) {
    console.error('List users error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/* ───────────────────────────────────────────
   POST /api/users
   Create user — platform admin can specify tenantId, client admin uses own tenant
   ─────────────────────────────────────────── */
router.post('/', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const user = req.user!;
    const { username, password, email, fullName, role, tenantId } = req.body;

    if (!username || !password || !role) {
      res.status(400).json({ error: 'Username, password, and role are required' });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    // Determine target tenant
    const targetTenantId = user.isPlatform && tenantId ? tenantId : user.tenantId;

    // Decrypt password (frontend encrypts before sending), then bcrypt hash for storage
    const plain = decryptField(password);
    const passwordHash = await bcrypt.hash(plain, 10);

    // Check for existing username
    const existing = await pool.query(`SELECT id FROM ${S}.users WHERE username = $1`, [username]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO ${S}.users (tenant_id, username, password_hash, email, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, full_name, role, is_active, created_at`,
      [targetTenantId, username, passwordHash, email || null, fullName || null, role]
    );

    res.json({ success: true, user: rows[0] });
  } catch (err: any) {
    console.error('Create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/* ───────────────────────────────────────────
   PUT /api/users/:userId
   Update user details — enforce tenant scope
   ─────────────────────────────────────────── */
router.put('/:userId', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const user = req.user!;
    const { userId } = req.params;
    const { fullName, email, role, password, isActive } = req.body;

    // Verify target user exists and belongs to allowed tenant
    const tenantCheck = user.isPlatform
      ? `SELECT id, username FROM ${S}.users WHERE id = $1`
      : `SELECT id, username FROM ${S}.users WHERE id = $1 AND tenant_id = $2`;
    const checkParams = user.isPlatform ? [userId] : [userId, user.tenantId];
    const existing = await pool.query(tenantCheck, checkParams);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }

    if (role && !VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    // Prevent self-deactivation via this endpoint as well
    if (isActive === false && existing.rows[0].username === user.username) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    const updates: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (fullName !== undefined) { updates.push(`full_name = $${idx++}`); vals.push(fullName); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); vals.push(email); }
    if (role !== undefined) { updates.push(`role = $${idx++}`); vals.push(role); }
    if (typeof isActive === 'boolean') { updates.push(`is_active = $${idx++}`); vals.push(isActive); }
    if (password) {
      const plain = decryptField(password);
      if (plain && plain.length > 0) {
        const hash = await bcrypt.hash(plain, 10);
        updates.push(`password_hash = $${idx++}`);
        vals.push(hash);
      }
    }
    updates.push(`updated_at = NOW()`);

    if (vals.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    vals.push(userId);
    const { rows } = await pool.query(
      `UPDATE ${S}.users SET ${updates.join(', ')} WHERE id = $${idx++} RETURNING id, username, email, full_name, role, is_active, updated_at`,
      vals
    );

    res.json({ success: true, user: rows[0] });
  } catch (err: any) {
    console.error('Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/* ───────────────────────────────────────────
   PUT /api/users/:userId/status
   Activate/deactivate user — prevent self-deactivation
   ─────────────────────────────────────────── */
router.put('/:userId/status', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const user = req.user!;
    const { userId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive must be a boolean' });
      return;
    }

    // Verify target user exists and belongs to allowed tenant
    const tenantCheck = user.isPlatform
      ? `SELECT username FROM ${S}.users WHERE id = $1`
      : `SELECT username FROM ${S}.users WHERE id = $1 AND tenant_id = $2`;
    const checkParams = user.isPlatform ? [userId] : [userId, user.tenantId];
    const existing = await pool.query(tenantCheck, checkParams);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }

    // Prevent self-deactivation
    if (!isActive && existing.rows[0].username === user.username) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    const { rows } = await pool.query(
      `UPDATE ${S}.users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, is_active`,
      [isActive, userId]
    );

    res.json({ success: true, user: rows[0] });
  } catch (err: any) {
    console.error('Update user status error:', err.message);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

/* ───────────────────────────────────────────
   DELETE /api/users/:userId
   Delete user — prevent self-deletion
   ─────────────────────────────────────────── */
router.delete('/:userId', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const user = req.user!;
    const { userId } = req.params;

    // Verify target user exists and belongs to allowed tenant
    const tenantCheck = user.isPlatform
      ? `SELECT username FROM ${S}.users WHERE id = $1`
      : `SELECT username FROM ${S}.users WHERE id = $1 AND tenant_id = $2`;
    const checkParams = user.isPlatform ? [userId] : [userId, user.tenantId];
    const existing = await pool.query(tenantCheck, checkParams);
    if (existing.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return; }

    // Prevent self-deletion
    if (existing.rows[0].username === user.username) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await pool.query(`DELETE FROM ${S}.users WHERE id = $1`, [userId]);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
