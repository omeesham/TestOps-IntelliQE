import { Router } from 'express';
import type { Request, Response } from 'express';
import { getConfigsForTenant, upsertConfig } from '../services/configurations.service.js';

/**
 * Feature Toggles — per-tenant, per-role UI feature permissions.
 *
 * Stored as a normal row in the generic `client_configurations` table
 * (integration_id = 'feature-toggles'), exactly like the `menu-config` row.
 * No dedicated table / migration is needed.
 *
 * Shape of config_data:
 *   { features: { [featureKey]: { admin?: boolean; qa_engineer?: boolean; data_analyst?: boolean } } }
 *
 * A missing feature key — or a missing role within a key — is treated as
 * ENABLED by the frontend, so behaviour is unchanged until an admin turns
 * something off. This is a frontend-enforced (UI-hiding) permission layer.
 */
const router = Router();
const INTEGRATION_ID = 'feature-toggles';

function isAdmin(req: Request): boolean {
  return req.user?.role === 'admin';
}

/* ───────────────────────────────────────────
   GET /api/feature-toggles
   Return the tenant's feature-toggle map.
   Any authenticated role can read it — the frontend needs it to gate the UI
   for the current user.
   ─────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const configs = await getConfigsForTenant(tenantId);
    const row = configs.find((c) => c.integrationId === INTEGRATION_ID);
    const features = (row?.configData?.features && typeof row.configData.features === 'object')
      ? row.configData.features
      : {};
    res.json({ features });
  } catch (err: any) {
    console.error('Get feature toggles error:', err.message);
    res.status(500).json({ error: 'Failed to fetch feature toggles' });
  }
});

/* ───────────────────────────────────────────
   PUT /api/feature-toggles
   Replace the tenant's feature-toggle map. Admin only.
   Body: { features: { [key]: { admin, qa_engineer, data_analyst } } }
   ─────────────────────────────────────────── */
router.put('/', async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return; }

    const tenantId = req.user!.tenantId;
    const { features } = req.body;

    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      res.status(400).json({ error: 'A "features" object is required' });
      return;
    }

    // Light sanitisation: keep only boolean role flags per feature key.
    const clean: Record<string, Record<string, boolean>> = {};
    for (const [key, roles] of Object.entries(features as Record<string, any>)) {
      if (!roles || typeof roles !== 'object') continue;
      const entry: Record<string, boolean> = {};
      for (const [roleKey, val] of Object.entries(roles)) {
        if (typeof val === 'boolean') entry[roleKey] = val;
      }
      clean[key] = entry;
    }

    const saved = await upsertConfig(tenantId, INTEGRATION_ID, 'connected', { features: clean }, req.user!.username);
    res.json({ success: true, features: saved.configData?.features || clean });
  } catch (err: any) {
    console.error('Update feature toggles error:', err.message);
    res.status(500).json({ error: 'Failed to update feature toggles' });
  }
});

export default router;
