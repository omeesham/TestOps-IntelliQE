import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getOrGenerateRealReport, getReportStatus, getOrGenerateReportFromExecution, type ExecOutcome } from '../services/allure-report.service.js';
import { PlaywrightRunError } from '../services/playwright-runner.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

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
    const { runId, results } = req.body || {};
    if (!runId) {
      res.status(400).json({ error: 'runId is required to generate a real Allure report' });
      return;
    }

    // Preferred path: build the report from the wizard's ACTUAL in-app results so
    // the downloadable report matches the Test Execution Report exactly — one
    // source of truth, immune to stale snapshots and flaky re-runs.
    if (Array.isArray(results) && results.length > 0) {
      const execMap = new Map<string, ExecOutcome>();
      for (const r of results) {
        if (r && r.testCaseId) {
          execMap.set(String(r.testCaseId), {
            status: String(r.status || 'unknown'),
            durationMs: Number.isFinite(Number(r.durationMs)) ? Number(r.durationMs) : undefined,
            error: r.error ? String(r.error) : undefined,
          });
        }
      }
      const result = await getOrGenerateReportFromExecution(user.tenantId, user.isPlatform, runId, execMap);
      res.json({
        ok: true,
        generatedAt: result.generatedAt,
        reportUrl: `/api/allure/report/${user.tenantId}/${runId}/index.html`,
      });
      return;
    }

    const key = `${user.tenantId}:${runId}`;

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
 * GET /api/allure/report/:tenantId/:scope/download  (NO auth — tenant UUID is an opaque token)
 * Download the single self-contained report HTML as a file attachment.
 * Registered BEFORE the wildcard serve route so "download" isn't treated as a filename.
 */
router.get('/report/:tenantId/:scope/download', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '');
    const scope = String(req.params.scope || '');
    const baseDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, scope);
    const indexFile = path.resolve(baseDir, 'index.html');

    // Directory traversal protection
    if (!indexFile.startsWith(baseDir)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    try {
      await fs.access(indexFile);
    } catch {
      res.status(404).json({ error: 'Report not found. Generate the report first, then download.' });
      return;
    }
    res.download(indexFile, `allure-report-${scope.slice(0, 8)}.html`);
  } catch (err: any) {
    console.error('Allure download error:', err.message);
    res.status(500).json({ error: 'Failed to download report file' });
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

    const baseDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, scope);
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

    // Don't block iframe embedding for our own reports
    res.removeHeader('X-Frame-Options');

    res.sendFile(requestedFile);
  } catch (err: any) {
    console.error('Allure serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve report file' });
  }
});

export default router;
