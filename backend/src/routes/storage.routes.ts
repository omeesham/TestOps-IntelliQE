/**
 * storage.routes.ts
 * ─────────────────
 * Azure Blob Storage connection for durable report archiving
 * (System Configuration → Storage). Mirrors the ADO/JIRA pattern:
 * the connection is VALIDATED against Azure before it is saved.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { upsertConfig } from '../services/configurations.service.js';
import { validateStorageConfig } from '../services/report-archive.service.js';
import { decryptField, encryptConfigData } from '../utils/crypto.js';

const router = Router();

// POST /api/storage/connect — validate + save the tenant's Azure Storage config.
// Each customer brings their OWN storage account, in one of two auth modes:
//   • accountUrl only  → Managed Identity (customer granted IntelliQE's app
//     identity "Storage Blob Data Contributor" on their account; no secret saved)
//   • connectionString → shared-key auth (AES-encrypted at rest)
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectionString: rawConnStr, accountUrl, containerName, prefix } = req.body || {};
    const connectionString = decryptField(String(rawConnStr || ''));
    const cleanAccountUrl = String(accountUrl || '').trim().replace(/\/+$/, '');
    if (!connectionString && !cleanAccountUrl) {
      res.status(400).json({ error: 'Provide either a Connection String or a Storage Account URL (Managed Identity access).' });
      return;
    }

    const container = String(containerName || '').trim() || 'intelliqe-reports';
    const result = await validateStorageConfig({ connectionString, accountUrl: cleanAccountUrl, containerName: container });

    await upsertConfig(
      user.tenantId,
      'azure-storage',
      'connected',
      encryptConfigData({
        // Connection string wins when both are supplied (matches resolution order).
        connectionString: connectionString || '',
        accountUrl: cleanAccountUrl,
        containerName: container,
        prefix: String(prefix || '').trim(),
      }),
      user.username,
    );

    console.log(`Azure Storage connected: tenant=${user.tenantId}, user=${user.username}, container=${container}, mode=${connectionString ? 'connection-string' : 'managed-identity'}`);
    res.json({ ok: true, message: result.message, containerName: container });
  } catch (err: any) {
    console.error('Azure Storage connect error:', err?.message);
    res.status(400).json({ ok: false, error: err?.message || 'Could not connect to Azure Storage' });
  }
});

// POST /api/storage/test — connectivity check for entered values (before saving)
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { connectionString: rawConnStr, accountUrl, containerName } = req.body || {};
    const connectionString = decryptField(String(rawConnStr || ''));
    const result = await validateStorageConfig({
      connectionString,
      accountUrl: String(accountUrl || '').trim() || undefined,
      containerName: String(containerName || '').trim() || undefined,
    });
    res.json(result);
  } catch (err: any) {
    // A failed test is an expected outcome — 200 + ok:false renders inline.
    res.json({ ok: false, error: err?.message || 'Connection test failed' });
  }
});

export default router;
