import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getOrGenerateRealReport, getReportStatus, getLatestReport, REPORTS_ROOT } from '../services/allure-report.service.js';
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
          reportUrl: `/api/allure/report/${user.tenantId}/${runId}/index.html`,
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
        reportUrl: `/api/allure/report/${user.tenantId}/${runId}/index.html`,
      });
      return;
    }

    const promise = getOrGenerateRealReport(user.tenantId, user.isPlatform, runId);
    inFlight.set(key, promise);

    try {
      const result = await promise;
      const scope = runId;
      res.json({
        ok: true,
        generatedAt: result.generatedAt,
        reportUrl: `/api/allure/report/${user.tenantId}/${scope}/index.html`,
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

    const rawFilePath = req.params.filePath;
    const filePath = Array.isArray(rawFilePath) ? rawFilePath.join('/') : (rawFilePath || '');

    const baseDir = path.join(REPORTS_ROOT, tenantId, scope);
    const requestedFile = path.resolve(baseDir, filePath);

    // Directory traversal protection
    if (!requestedFile.startsWith(baseDir)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    // Check file exists
    try {
      await fs.access(requestedFile);
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Set content type based on extension
    const ext = path.extname(requestedFile).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };

    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    }

    // These are self-contained reports (Playwright HTML / Allure) that rely on
    // INLINE scripts + styles. In production, helmet's default CSP (script-src
    // 'self') blocks inline scripts, so the report iframe renders BLANK. They are
    // trusted, internally-generated, same-origin assets — drop the restrictive
    // security headers for this static-report route so the report actually runs.
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');

    res.sendFile(requestedFile);
  } catch (err: any) {
    console.error('Allure serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve report file' });
  }
});

export default router;
