/**
 * Cloud persistence for generated test reports (Playwright HTML + Allure).
 *
 * Reports are built onto the local filesystem under REPORTS_ROOT. On Azure
 * Container Apps that filesystem is EPHEMERAL and per-replica, so a report
 * vanishes on redeploy and is invisible to other replicas. When a cloud blob
 * provider is configured (STORAGE_PROVIDER=azure-blob | s3 | gcs) this module
 * mirrors each freshly-built report to that store so it durably survives, and
 * lets the Reports page list + serve reports straight from the store when the
 * local copy is gone.
 *
 * When STORAGE_PROVIDER is unset or 'local' every function here is a no-op /
 * empty result, so the existing filesystem-only behaviour is unchanged.
 *
 * Blob key convention: reports/<tenantId>/<runId>/<relative-path>
 * A tiny sidecar `report-index.json` is written alongside each report so the
 * history listing can read stats + timestamp without downloading the report.
 */
import fs from 'fs/promises';
import path from 'path';
import { getBlobStorage } from './storage/index.js';
import { REPORTS_ROOT, SAFE_RUN_ID_RE } from './allure-report.service.js';
import type { ReportStats, ReportListItem } from './allure-report.service.js';
import { logger } from '../utils/logger.js';

/** True when reports should be mirrored to / served from a cloud blob store. */
export function blobStorageEnabled(): boolean {
  const provider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  return provider !== 'local';
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};
export function contentTypeFor(name: string): string | undefined {
  return MIME[path.extname(name).toLowerCase()];
}

function reportPrefix(tenantId: string, runId: string): string {
  return `reports/${tenantId}/${runId}/`;
}

/** Recursively list absolute file paths under `dir` (empty when dir is absent). */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * Upload a freshly-built report directory (REPORTS_ROOT/<tenant>/<runId>) to the
 * configured cloud blob store. Best-effort: any failure is logged and swallowed
 * so it never breaks the run — the report still exists locally.
 */
export async function mirrorReportToBlob(
  tenantId: string,
  runId: string,
  stats?: Partial<ReportStats> | null,
): Promise<void> {
  if (!blobStorageEnabled()) return;
  if (!SAFE_RUN_ID_RE.test(String(runId))) return;
  try {
    const storage = await getBlobStorage();
    const runDir = path.join(REPORTS_ROOT, tenantId, runId);
    const files = await walkFiles(runDir);
    if (files.length === 0) {
      logger.warn('report_storage.no_files', { tenantId, runId, runDir });
      return;
    }
    let hasAllure = false;
    for (const abs of files) {
      const rel = path.relative(runDir, abs).split(path.sep).join('/');
      if (rel === 'allure/index.html') hasAllure = true;
      const body = await fs.readFile(abs);
      await storage.put(reportPrefix(tenantId, runId) + rel, body, { contentType: contentTypeFor(rel) });
    }
    // Normalize the caller's counts into a full ReportStats so the history
    // listing (which renders pass rate) is complete for blob-only reports.
    let fullStats: ReportStats | null = null;
    if (stats && typeof stats.total === 'number') {
      const passed = stats.passed ?? 0;
      const total = stats.total ?? 0;
      fullStats = {
        passed,
        failed: stats.failed ?? 0,
        broken: stats.broken ?? 0,
        skipped: stats.skipped ?? 0,
        total,
        passRate: stats.passRate ?? (total > 0 ? Math.round((passed / total) * 100) : 0),
        durationMs: stats.durationMs ?? 0,
      };
    }

    // Sidecar summary so the history listing is cheap (one small GET per run).
    const index = {
      runId,
      tenantId,
      generatedAt: new Date().toISOString(),
      hasAllure,
      stats: fullStats,
    };
    await storage.put(
      reportPrefix(tenantId, runId) + 'report-index.json',
      JSON.stringify(index),
      { contentType: 'application/json' },
    );
    logger.info('report_storage.mirrored', { tenantId, runId, files: files.length, hasAllure });
  } catch (err) {
    logger.warn('report_storage.mirror_failed', { tenantId, runId, err: (err as Error).message });
  }
}

/**
 * Fetch a single report file from the blob store. Returns null when blob storage
 * is disabled or the object is missing — the caller falls back to a 404.
 */
export async function getReportFileFromBlob(
  tenantId: string,
  runId: string,
  relPath: string,
): Promise<Buffer | null> {
  if (!blobStorageEnabled()) return null;
  if (!SAFE_RUN_ID_RE.test(String(runId))) return null;
  // Guard the relative path — no traversal outside the run's prefix.
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  try {
    const storage = await getBlobStorage();
    return await storage.get(reportPrefix(tenantId, runId) + normalized);
  } catch {
    return null;
  }
}

/**
 * List every report the tenant has in the blob store, newest first, using the
 * per-run `report-index.json` sidecars. Returns [] when blob storage is
 * disabled. The reports.routes /history endpoint unions this with the local
 * filesystem listing so redeployed / cross-replica reports still appear.
 */
export async function listBlobReports(tenantId: string): Promise<ReportListItem[]> {
  if (!blobStorageEnabled()) return [];
  try {
    const storage = await getBlobStorage();
    const prefix = `reports/${tenantId}/`;
    const blobs = await storage.list(prefix, { maxResults: 5000 });
    const indexKeys = blobs
      .map((b) => b.name)
      .filter((n) => n.endsWith('/report-index.json'));
    const items: ReportListItem[] = [];
    for (const key of indexKeys) {
      try {
        const buf = await storage.get(key);
        const idx = JSON.parse(buf.toString('utf-8'));
        const runId = String(idx.runId || key.slice(prefix.length).split('/')[0]);
        if (!runId) continue;
        items.push({
          runId,
          generatedAt: idx.generatedAt || new Date(0).toISOString(),
          hasBasic: true,
          hasAllure: !!idx.hasAllure,
          stats: idx.stats || null,
        });
      } catch {
        /* skip a corrupt sidecar */
      }
    }
    items.sort((a, b) => (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0));
    return items;
  } catch (err) {
    logger.warn('report_storage.list_failed', { tenantId, err: (err as Error).message });
    return [];
  }
}
