import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getConfigsForTenant,
  getConfigsForTenantByCategory,
  upsertConfig,
  disconnectConfig,
} from '../services/configurations.service.js';
import {
  maskConfigData,
  decryptConfigData,
  encryptConfigData,
} from '../utils/crypto.js';

const router = Router();

/**
 * GET /api/configurations
 * List all integration configurations for the authenticated user's tenant.
 * ⛔ NEVER returns raw credentials — all sensitive fields are masked.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    let tenantId = user.tenantId;

    // Platform admin can view any tenant's configs
    if (user.isPlatform && req.query.tenantId) {
      tenantId = req.query.tenantId as string;
    }

    const category = req.query.category as string | undefined;
    const configs = category
      ? await getConfigsForTenantByCategory(tenantId, category)
      : await getConfigsForTenant(tenantId);
    // Mask all sensitive fields before sending to client
    const maskedConfigs = configs.map((c: any) => ({
      ...c,
      configData: maskConfigData(c.configData || {}),
    }));
    res.json({ configs: maskedConfigs });
  } catch (err: any) {
    console.error('Get configurations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch configurations' });
  }
});

/**
 * PUT /api/configurations/:integrationId
 * Connect or update an integration for the tenant.
 * Body: { ...configData } (may contain __ENC__ encrypted fields from frontend)
 * Decrypts transit encryption → re-encrypts for at-rest DB storage → returns masked.
 */
router.put('/:integrationId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;
    const rawConfigData = req.body || {};

    // Step 1: Decrypt any __ENC__ values from frontend transit encryption
    const decryptedData = decryptConfigData(rawConfigData);
    // Step 2: Re-encrypt sensitive fields for secure at-rest storage in DB
    const encryptedData = encryptConfigData(decryptedData);

    const config = await upsertConfig(
      user.tenantId,
      integrationId as string,
      'connected',
      encryptedData,
      user.username
    );

    console.log(`Configuration connected: tenant=${user.tenantId}, integration=${integrationId}, by=${user.username}`);
    // Return masked config — never expose real credentials in response
    res.json({ ok: true, config: { ...config, configData: maskConfigData(decryptedData) } });
  } catch (err: any) {
    console.error('Connect configuration error:', err.message);
    res.status(500).json({ error: 'Failed to connect integration' });
  }
});

/**
 * DELETE /api/configurations/:integrationId
 * Disconnect an integration for the tenant.
 */
router.delete('/:integrationId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;

    const deleted = await disconnectConfig(user.tenantId, integrationId as string);
    if (!deleted) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    console.log(`Configuration disconnected: tenant=${user.tenantId}, integration=${integrationId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Disconnect configuration error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

/**
 * POST /api/configurations/:integrationId/test
 * Verify a notification integration's configuration by sending a test message.
 * Currently supports email only.
 */
router.post('/:integrationId/test', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;

    if (integrationId === 'notif-email') {
      const { sendTestEmail, clearSmtpCache } = await import('../services/email.service.js');
      clearSmtpCache(user.tenantId);
      const result = await sendTestEmail(user.tenantId, user.username);
      res.json({ ok: result.sent, ...result });
      return;
    }

    res.json({ ok: false, error: `Test not available for ${integrationId}` });
  } catch (err: any) {
    console.error('Test notification error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
