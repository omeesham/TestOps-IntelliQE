/**
 * Tenant-level settings — currently just the Anthropic API key.
 *
 * The Anthropic API key is the tenant's own Claude credential (per the HIPAA
 * architecture: "customer-owned Claude API keys"). Stored AES-encrypted in
 * tenants.anthropic_api_key and decrypted only when the worker fetches a task.
 *
 * Endpoints:
 *   GET    /api/tenant-settings/anthropic-key    -> { configured: boolean, masked?: string }
 *   PUT    /api/tenant-settings/anthropic-key    -> set / rotate the key
 *   DELETE /api/tenant-settings/anthropic-key    -> remove the key
 *
 * All require admin role within the tenant.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { decryptField, encryptAtRest, decryptStored, maskSecret } from '../utils/crypto.js';
import { logAudit } from '../utils/audit.js';

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return false;
  }
  return true;
}

router.get('/anthropic-key', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT anthropic_api_key FROM "JBSTestOpsAI".tenants WHERE id = $1`,
      [req.user!.tenantId],
    );
    const stored = rows[0]?.anthropic_api_key as string | null;
    if (!stored) {
      res.json({ configured: false });
      return;
    }
    let plain: string;
    try {
      plain = decryptStored(stored);
    } catch {
      res.json({ configured: true, masked: '••••••' });
      return;
    }
    res.json({ configured: true, masked: maskSecret(plain) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/anthropic-key', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = (req.body?.apiKey || '') as string;
    if (!raw) {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }
    // Body may carry the value transit-encrypted (`__ENC__...`) from the frontend.
    const plain = decryptField(raw).trim();
    if (!plain.startsWith('sk-') || plain.length < 20) {
      res.status(400).json({ error: 'Invalid Anthropic API key format' });
      return;
    }
    const encrypted = encryptAtRest(plain);
    await pool.query(
      `UPDATE "JBSTestOpsAI".tenants SET anthropic_api_key = $1, updated_at = NOW() WHERE id = $2`,
      [encrypted, req.user!.tenantId],
    );
    void logAudit(req, 'rotate_key', 'tenant.anthropic_api_key', req.user!.tenantId);
    res.json({ ok: true, masked: maskSecret(plain) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/anthropic-key', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    await pool.query(
      `UPDATE "JBSTestOpsAI".tenants SET anthropic_api_key = NULL, updated_at = NOW() WHERE id = $1`,
      [req.user!.tenantId],
    );
    void logAudit(req, 'delete', 'tenant.anthropic_api_key', req.user!.tenantId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
