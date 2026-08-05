/**
 * report-archive.service.ts
 * ─────────────────────────
 * Durable report storage + retention.
 *
 * Reports are generated onto local disk (REPORTS_ROOT/<tenant>/<run>), which is
 * ephemeral on Azure Container Apps. This service makes them durable and keeps
 * the set bounded:
 *
 *   • archiveReport      — zip a run's report dir and upload it to the TENANT's
 *                          Azure Blob Storage (System Configuration → Storage)
 *   • restoreReport      — download + unzip a report back to local disk when
 *                          the UI asks for a run that isn't cached locally
 *   • enforceReportRetention — keep only the LATEST N (default 10) reports:
 *                          when the 11th appears, the oldest is deleted from
 *                          local disk AND from Azure storage
 *   • validateStorageConfig — connectivity probe used by the connect/test route
 *
 * All functions are tenant-scoped; the Azure connection comes from the
 * tenant's saved 'azure-storage' integration (connectionString + containerName
 * + optional prefix), decrypted from client_configurations.
 */
import path from 'path';
import { promises as fs } from 'fs';
import JSZip from 'jszip';
import pool from '../db.js';
import { decryptConfigData } from '../utils/crypto.js';
import { REPORTS_ROOT, SAFE_RUN_ID_RE, listReports } from './allure-report.service.js';

export const REPORT_RETENTION = 10;

export interface TenantStorageConfig {
  /**
   * 'identity'          — Managed Identity (DefaultAzureCredential) against
   *                       accountUrl. Production mode: no secret exists anywhere.
   * 'connection-string' — classic shared-key connection string.
   */
  auth: 'identity' | 'connection-string';
  /** https://<account>.blob.core.windows.net — identity mode only. */
  accountUrl?: string;
  /** Shared-key connection string — connection-string mode only. */
  connectionString?: string;
  containerName: string;
  /** Optional folder inside the container; normalized to end with '/'. */
  prefix: string;
}

function normalizePrefix(raw: string): string {
  const p = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

/**
 * Resolve the Azure Storage connection for a tenant. This is a multi-tenant
 * IaaS product where EVERY CUSTOMER BRINGS THEIR OWN STORAGE ACCOUNT, so the
 * tenant's saved configuration is authoritative:
 *
 *   1. TENANT CONFIG — the 'azure-storage' integration saved from System
 *      Configuration → Storage. Two auth modes per tenant:
 *        • accountUrl only  → MANAGED IDENTITY: the customer grants IntelliQE's
 *          app identity "Storage Blob Data Contributor" on THEIR account —
 *          no secret is stored anywhere.
 *        • connectionString → shared-key auth, AES-encrypted at rest.
 *   2. PLATFORM ENV fallback — AZURE_STORAGE_ACCOUNT_URL (managed identity) or
 *      AZURE_STORAGE_CONNECTION_STRING, for tenants that have not configured
 *      their own storage yet (platform-owned pool account).
 *
 * Null when none is configured (archiving is skipped, local reports only).
 */
export async function getTenantStorageConfig(tenantId: string): Promise<TenantStorageConfig | null> {
  // 1. Tenant-owned storage account (primary).
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'azure-storage' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length > 0) {
    const raw = rows[0].config_data;
    const data = decryptConfigData(typeof raw === 'string' ? JSON.parse(raw) : (raw || {}));
    const connectionString = String(data.connectionString || '').trim();
    const accountUrl = String(data.accountUrl || '').trim().replace(/\/+$/, '');
    const containerName = String(data.containerName || '').trim() || 'intelliqe-reports';
    const prefix = normalizePrefix(data.prefix);
    if (connectionString) return { auth: 'connection-string', connectionString, containerName, prefix };
    if (accountUrl) return { auth: 'identity', accountUrl, containerName, prefix };
    // connected row without usable auth — fall through to platform default
  }

  // 2. Platform-wide default (env), for tenants without their own storage yet.
  const envAccountUrl = String(process.env.AZURE_STORAGE_ACCOUNT_URL || '').trim().replace(/\/+$/, '');
  if (envAccountUrl) {
    return {
      auth: 'identity',
      accountUrl: envAccountUrl,
      containerName: String(process.env.AZURE_STORAGE_CONTAINER || '').trim() || 'intelliqe-reports',
      prefix: normalizePrefix(process.env.AZURE_STORAGE_PREFIX || ''),
    };
  }
  const envConn = String(process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim();
  if (envConn) {
    return {
      auth: 'connection-string',
      connectionString: envConn,
      containerName: String(process.env.AZURE_STORAGE_CONTAINER || '').trim() || 'intelliqe-reports',
      prefix: normalizePrefix(process.env.AZURE_STORAGE_PREFIX || ''),
    };
  }
  return null;
}

async function containerFor(cfg: TenantStorageConfig) {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  let service: import('@azure/storage-blob').BlobServiceClient;
  if (cfg.auth === 'identity') {
    // Managed identity / workload identity / az-login chain — no secret involved.
    const { DefaultAzureCredential } = await import('@azure/identity');
    service = new BlobServiceClient(cfg.accountUrl!, new DefaultAzureCredential());
  } else {
    service = BlobServiceClient.fromConnectionString(cfg.connectionString!);
  }
  const container = service.getContainerClient(cfg.containerName);
  await container.createIfNotExists();
  return container;
}

/** Connectivity probe: reach the customer's storage account (via connection
 *  string OR the platform's managed identity against their account URL) and
 *  ensure the container exists (creating it if needed). Throws clearly. */
export async function validateStorageConfig(cfg: {
  connectionString?: string; accountUrl?: string; containerName?: string; prefix?: string;
}): Promise<{ ok: true; message: string }> {
  const connectionString = String(cfg.connectionString || '').trim();
  const accountUrl = String(cfg.accountUrl || '').trim().replace(/\/+$/, '');
  if (!connectionString && !accountUrl) {
    throw new Error('Provide either a Connection String or a Storage Account URL (Managed Identity access).');
  }
  if (!connectionString && accountUrl && !/^https:\/\/[a-z0-9]+\.blob\.core\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/i.test(accountUrl)) {
    throw new Error('The Storage Account URL must look like https://<account>.blob.core.windows.net (no path).');
  }
  const containerName = String(cfg.containerName || '').trim() || 'intelliqe-reports';
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(containerName)) {
    throw new Error(`"${containerName}" is not a valid container name (3-63 chars, lowercase letters, numbers, hyphens).`);
  }
  const mode: TenantStorageConfig = connectionString
    ? { auth: 'connection-string', connectionString, containerName, prefix: '' }
    : { auth: 'identity', accountUrl, containerName, prefix: '' };
  let container;
  try {
    container = await containerFor(mode);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/Invalid.*connection string|Unable to extract/i.test(msg)) {
      throw new Error('The Connection String is not a valid Azure Storage connection string. Copy it from Azure Portal → Storage Account → Access keys.');
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      throw new Error('The storage account could not be reached — check the account name/URL and network access.');
    }
    if (mode.auth === 'identity' && /AuthorizationPermissionMismatch|AuthorizationFailure|403/i.test(msg)) {
      throw new Error(
        'The IntelliQE app identity has no access to this storage account. ' +
        'Grant it the "Storage Blob Data Contributor" role on the account (Azure Portal → Storage Account → Access control (IAM)), then retry.',
      );
    }
    if (/AuthenticationFailed|Signature|CredentialUnavailable|403/i.test(msg)) {
      throw new Error('Azure rejected the credentials (authentication failed). Regenerate the access key and paste the fresh connection string.');
    }
    throw new Error(`Could not connect to Azure Storage: ${msg}`);
  }
  // Round-trip probe: list is the cheapest authenticated read.
  await container.listBlobsFlat().next();
  return {
    ok: true,
    message: mode.auth === 'identity'
      ? `Connected via Managed Identity — container "${containerName}" is reachable. No secret was stored.`
      : `Connected — container "${containerName}" is reachable and writable.`,
  };
}

/* ── zip helpers ── */

async function zipDirToBuffer(dir: string): Promise<Buffer> {
  const { default: archiver } = await import('archiver');
  return await new Promise<Buffer>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.directory(dir, false);
    void archive.finalize();
  });
}

async function extractZipToDir(buf: Buffer, dir: string): Promise<void> {
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    // Zip entries are attacker-shaped input in principle — never let a path
    // escape the target dir.
    const rel = entry.name.replace(/\\/g, '/');
    if (rel.includes('..')) continue;
    const dest = path.join(dir, rel);
    if (!dest.startsWith(dir)) continue;
    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, await entry.async('nodebuffer'));
    }
  }
}

/* ── blob keys ── */

const zipKey = (cfg: TenantStorageConfig, tenantId: string, runId: string) =>
  `${cfg.prefix}reports/${tenantId}/${runId}.zip`;
const metaKey = (cfg: TenantStorageConfig, tenantId: string, runId: string) =>
  `${cfg.prefix}reports/${tenantId}/${runId}.meta.json`;

/* ── public API ── */

/**
 * Zip the run's report directory and upload it to the tenant's Azure storage.
 * No-op (returns false) when the tenant has no storage connected or the run
 * has no rendered report.
 */
export async function archiveReport(tenantId: string, runId: string): Promise<boolean> {
  if (!SAFE_RUN_ID_RE.test(runId)) return false;
  const cfg = await getTenantStorageConfig(tenantId);
  if (!cfg) return false;

  const runDir = path.join(REPORTS_ROOT, tenantId, runId);
  try { await fs.access(path.join(runDir, 'index.html')); } catch { return false; }

  const container = await containerFor(cfg);
  const zip = await zipDirToBuffer(runDir);
  await container.getBlockBlobClient(zipKey(cfg, tenantId, runId)).uploadData(zip, {
    blobHTTPHeaders: { blobContentType: 'application/zip' },
  });
  await container.getBlockBlobClient(metaKey(cfg, tenantId, runId)).uploadData(
    Buffer.from(JSON.stringify({ runId, tenantId, archivedAt: new Date().toISOString(), sizeBytes: zip.length }), 'utf8'),
    { blobHTTPHeaders: { blobContentType: 'application/json' } },
  );
  console.log(`[report-archive] archived ${tenantId}/${runId} (${Math.round(zip.length / 1024)} KB) to ${cfg.containerName}`);
  return true;
}

/**
 * Make a run's report available on local disk, pulling it from Azure storage
 * when it isn't cached locally (ephemeral disk lost it, or another instance
 * generated it). Returns:
 *   'local'    — already on disk, nothing to do
 *   'restored' — downloaded from Azure and unpacked
 *   'missing'  — not on disk and not in Azure (regeneration required)
 */
export async function restoreReport(tenantId: string, runId: string): Promise<'local' | 'restored' | 'missing'> {
  if (!SAFE_RUN_ID_RE.test(runId)) return 'missing';
  const runDir = path.join(REPORTS_ROOT, tenantId, runId);
  try {
    await fs.access(path.join(runDir, 'index.html'));
    return 'local';
  } catch { /* not on disk — try Azure */ }

  const cfg = await getTenantStorageConfig(tenantId);
  if (!cfg) return 'missing';
  const container = await containerFor(cfg);
  const blob = container.getBlockBlobClient(zipKey(cfg, tenantId, runId));
  if (!(await blob.exists())) return 'missing';
  const buf = await blob.downloadToBuffer();
  await fs.mkdir(runDir, { recursive: true });
  await extractZipToDir(buf, runDir);
  console.log(`[report-archive] restored ${tenantId}/${runId} from ${cfg.containerName}`);
  return 'restored';
}

/**
 * Keep only the newest `keep` reports for the tenant. Older runs are removed
 * from local disk and (when storage is connected) from Azure. Local-only
 * pruning still runs when no storage is configured — the cap is a product
 * rule, not a storage optimisation.
 */
export async function enforceReportRetention(tenantId: string, keep = REPORT_RETENTION): Promise<string[]> {
  const items = await listReports(tenantId); // newest first
  const stale = items.slice(keep);
  if (stale.length === 0) return [];

  const cfg = await getTenantStorageConfig(tenantId);
  const container = cfg ? await containerFor(cfg) : null;
  const removed: string[] = [];
  for (const item of stale) {
    if (!SAFE_RUN_ID_RE.test(item.runId)) continue;
    try {
      await fs.rm(path.join(REPORTS_ROOT, tenantId, item.runId), { recursive: true, force: true });
      if (container && cfg) {
        await container.getBlockBlobClient(zipKey(cfg, tenantId, item.runId)).deleteIfExists();
        await container.getBlockBlobClient(metaKey(cfg, tenantId, item.runId)).deleteIfExists();
      }
      removed.push(item.runId);
    } catch (err: any) {
      console.warn(`[report-archive] could not prune ${tenantId}/${item.runId}: ${err?.message}`);
    }
  }
  if (removed.length > 0) {
    console.log(`[report-archive] retention (${keep}): pruned ${removed.length} old report(s) for ${tenantId}: ${removed.join(', ')}`);
  }
  return removed;
}

/**
 * Post-generation hook: archive the fresh report and prune beyond the cap.
 * Fire-and-forget safe — never throws.
 */
export async function archiveAndPrune(tenantId: string, runId: string): Promise<void> {
  try { await archiveReport(tenantId, runId); }
  catch (err: any) { console.warn(`[report-archive] archive failed for ${tenantId}/${runId}: ${err?.message}`); }
  try { await enforceReportRetention(tenantId); }
  catch (err: any) { console.warn(`[report-archive] retention failed for ${tenantId}: ${err?.message}`); }
}
