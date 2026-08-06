import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getConfigsForTenant,
  getConfigsForTenantByCategory,
  upsertConfig,
  disconnectConfig,
  reconnectConfig,
  deleteConfig,
} from '../services/configurations.service.js';
import {
  maskConfigData,
  decryptConfigData,
  encryptConfigData,
  decryptField,
  isMaskedSecret,
  SENSITIVE_CONFIG_KEYS,
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

    // Step 1b: The UI shows saved secrets MASKED (e.g. "git•••xy"). If the user
    // saves without retyping a secret field, the mask itself comes back here —
    // persisting it would DESTROY the stored secret. A masked value means
    // "keep the existing one", so substitute it from the stored config.
    const cameBackMasked = Object.keys(decryptedData).some(
      (k) => SENSITIVE_CONFIG_KEYS.has(k) && isMaskedSecret(decryptedData[k]),
    );
    if (cameBackMasked) {
      const existing = (await getConfigsForTenant(user.tenantId))
        .find((c: any) => c.integrationId === integrationId);
      const stored = existing ? decryptConfigData(existing.configData || {}) : {};
      for (const key of Object.keys(decryptedData)) {
        if (SENSITIVE_CONFIG_KEYS.has(key) && isMaskedSecret(decryptedData[key])) {
          if (typeof stored[key] === 'string' && stored[key]) {
            decryptedData[key] = stored[key];
          } else {
            delete decryptedData[key]; // nothing stored — drop the mask entirely
          }
        }
      }
    }

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
 * POST /api/configurations/:integrationId/disconnect
 * Soft-disconnect — keeps the stored config so it can be reconnected later.
 */
router.post('/:integrationId/disconnect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;
    const ok = await disconnectConfig(user.tenantId, integrationId as string);
    if (!ok) { res.status(404).json({ error: 'Configuration not found' }); return; }
    console.log(`Configuration disconnected (kept): tenant=${user.tenantId}, integration=${integrationId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Disconnect configuration error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

/**
 * POST /api/configurations/:integrationId/reconnect
 * Reactivate a previously-disconnected integration using its stored config.
 */
router.post('/:integrationId/reconnect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;
    const ok = await reconnectConfig(user.tenantId, integrationId as string);
    if (!ok) { res.status(404).json({ error: 'Configuration not found' }); return; }
    console.log(`Configuration reconnected: tenant=${user.tenantId}, integration=${integrationId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Reconnect configuration error:', err.message);
    res.status(500).json({ error: 'Failed to reconnect integration' });
  }
});

/**
 * DELETE /api/configurations/:integrationId
 * Permanently remove an integration configuration for the tenant.
 */
router.delete('/:integrationId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { integrationId } = req.params;

    const deleted = await deleteConfig(user.tenantId, integrationId as string);
    if (!deleted) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    console.log(`Configuration deleted: tenant=${user.tenantId}, integration=${integrationId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete configuration error:', err.message);
    res.status(500).json({ error: 'Failed to delete integration' });
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

    if (integrationId === 'notif-slack' || integrationId === 'notif-teams') {
      const provider = integrationId === 'notif-slack' ? 'slack' : 'teams';
      const { sendWebhookTest, sendWebhookTestUrl } = await import('../services/webhook-notification.service.js');
      // Ad-hoc test: if the request carries a webhook_url (transit-encrypted),
      // verify THAT url (before it's saved). Otherwise test the saved config.
      const rawUrl = (req.body?.webhook_url || '') as string;
      const result = rawUrl
        ? await sendWebhookTestUrl(provider, decryptField(rawUrl))
        : await sendWebhookTest(user.tenantId, provider);
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
