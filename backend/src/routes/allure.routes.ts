import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getOrGenerateRealReport, getReportStatus, getLatestReport, getReportStats, REPORTS_ROOT, SAFE_RUN_ID_RE } from '../services/allure-report.service.js';
import { getReportFileFromBlob, contentTypeFor, mirrorReportToBlob } from '../services/report-storage.service.js';
import { PlaywrightRunError } from '../services/playwright-runner.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

// In-flight generation lock to prevent concurrent builds for the same key
const inFlight = new Map<string, Promise<any>>();

/**
 * POST /api/allure/generate  (auth required)
 * Trigger Allure report generation.
 * Body: { runId?: string }
 */
router.post('/generate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { runId } = req.body || {};
    if (!runId) {
      res.status(400).json({ error: 'runId is required to generate a real Allure report' });
      return;
    }
    const key = `${user.tenantId}:${runId}`;

    // If a report already exists for this run (e.g. built during the Chat
    // execution), serve it instead of re-running — the Chat flow is stateless
    // and stores no DB scripts to re-run. Pass { force: true } to rebuild.
    if (!req.body?.force) {
      const existing = await getReportStatus(user.tenantId, runId);
      if (existing.exists) {
        res.json({
          ok: true,
          generatedAt: existing.generatedAt,
          reportUrl: `/api/allure/report/${user.tenantId}/${runId}/allure/index.html`,
        });
        return;
      }
    }

    // Deduplicate concurrent requests
    if (inFlight.has(key)) {
      const result = await inFlight.get(key);
      res.json({
        ok: true,
        generatedAt: result.generatedAt,
        reportUrl: `/api/allure/report/${user.tenantId}/${runId}/allure/index.html`,
      });
      return;
    }

    const promise = getOrGenerateRealReport(user.tenantId, user.isPlatform, runId);
    inFlight.set(key, promise);

    try {
      const result = await promise;
      const scope = runId;
      // Persist the regenerated report to cloud storage (Azure Blob) so it
      // survives the ephemeral container FS. No-op unless a cloud
      // STORAGE_PROVIDER is configured; never blocks the response.
      void getReportStats(user.tenantId, scope)
        .then((stats) => mirrorReportToBlob(user.tenantId, scope, stats))
        .catch(() => {});
      res.json({
        ok: true,
        generatedAt: result.generatedAt,
        reportUrl: `/api/allure/report/${user.tenantId}/${scope}/allure/index.html`,
      });
    } finally {
      inFlight.delete(key);
    }
  } catch (err: any) {
    // Typed Playwright failures get the structured response — code, hint,
    // and (for admins/dev) the tail of the log. Generic errors get a plain 500.
    if (err instanceof PlaywrightRunError) {
      const isAdminOrDev =
        req.user?.role === 'admin' || process.env.NODE_ENV !== 'production';
      console.warn(`[allure] ${err.code}: ${err.message}`);
      res.status(err.httpStatus).json(err.toResponseJson(isAdminOrDev));
      return;
    }
    console.error('Allure generate error:', err.message);
    res.status(500).json({
      error: 'Failed to generate Allure report.',
      code: 'UNKNOWN',
      hint: 'An unexpected error occurred. Try again, or contact support if it persists.',
    });
  }
});

/**
 * GET /api/allure/status  (auth required)
 * Check if a report exists.
 * Query: ?runId=<uuid>
 */
router.get('/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = req.query.runId as string | undefined;
    const status = await getReportStatus(user.tenantId, runId);
    res.json(status);
  } catch (err: any) {
    console.error('Allure status error:', err.message);
    res.status(500).json({ error: 'Failed to check Allure report status' });
  }
});

/**
 * GET /api/allure/latest  (auth required)
 * Return the most recently generated report across all of the tenant's runs,
 * so the Reports page can show the latest report by default even when the
 * selected run has none.
 */
router.get('/latest', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const latest = await getLatestReport(user.tenantId);
    res.json(latest);
  } catch (err: any) {
    console.error('Allure latest error:', err.message);
    res.status(500).json({ error: 'Failed to look up the latest Allure report' });
  }
});

/**
 * GET /api/allure/report/:tenantId/:scope/*  (NO auth — static files for iframe)
 * Serve static Allure HTML report files.
 * Security: tenant ID in URL acts as an opaque token (UUIDs are unguessable).
 */
router.get('/report/:tenantId/:scope/{*filePath}', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '');
    const scope = String(req.params.scope || '');

    // Express decodes %2F only after route matching — an encoded slash inside
    // tenantId/scope would otherwise escape REPORTS_ROOT before the resolve
    // check below (which compares against the already-escaped baseDir).
    if (!SAFE_RUN_ID_RE.test(tenantId) || !SAFE_RUN_ID_RE.test(scope)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const rawFilePath = req.params.filePath;
    const filePath = Array.isArray(rawFilePath) ? rawFilePath.join('/') : (rawFilePath || '');

    const baseDir = path.join(REPORTS_ROOT, tenantId, scope);
    const requestedFile = path.resolve(baseDir, filePath);

    // Directory traversal protection (path.sep suffix so "…\scope-evil"
    // can't pass as a prefix of "…\scope")
    if (requestedFile !== baseDir && !requestedFile.startsWith(baseDir + path.sep)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const contentType = contentTypeFor(requestedFile);
    if (contentType) res.setHeader('Content-Type', contentType);

    // These are self-contained reports (Playwright HTML / Allure) that rely on
    // INLINE scripts + styles. In production, helmet's default CSP (script-src
    // 'self') blocks inline scripts, so the report iframe renders BLANK. They are
    // trusted, internally-generated, same-origin assets — drop the restrictive
    // security headers for this static-report route so the report actually runs.
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');

    // Prefer the local copy; fall back to cloud blob storage when the local
    // filesystem no longer has it (ephemeral container FS after a redeploy, or
    // a report built on another replica). Blob fallback is a no-op locally.
    let localExists = true;
    try {
      await fs.access(requestedFile);
    } catch {
      localExists = false;
    }
    if (localExists) {
      res.sendFile(requestedFile);
      return;
    }

    const blob = await getReportFileFromBlob(tenantId, scope, filePath);
    if (blob) {
      res.send(blob);
      return;
    }
    res.status(404).json({ error: 'File not found' });
  } catch (err: any) {
    console.error('Allure serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve report file' });
  }
});

export default router;
