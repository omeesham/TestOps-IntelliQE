/**
 * Tenant-level settings — the Anthropic API key.
 *
 * The key is the customer's own Claude credential and lives in their Azure
 * Key Vault (see services/llm-credentials.service.ts); it is no longer stored
 * in tenants.anthropic_api_key.
 *
 * Endpoints:
 *   GET    /api/tenant-settings/anthropic-key    -> { configured, source, reference, vault }
 *   PUT    /api/tenant-settings/anthropic-key    -> 410: keys are set in Key Vault
 *   DELETE /api/tenant-settings/anthropic-key    -> clears any legacy key left in the DB
 *
 * All require admin role within the tenant.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { logAudit } from '../utils/audit.js';
import { resolveLlmCredential } from '../services/llm-credentials.service.js';

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
    const cred = await resolveLlmCredential('anthropic', req.user!.tenantId);
    res.json({ configured: !!cred.value, source: cred.source, reference: cred.reference, vault: cred.vault });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/anthropic-key', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.status(410).json({ error: 'The Anthropic API key is managed in Azure Key Vault and cannot be set through the API.' });
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
