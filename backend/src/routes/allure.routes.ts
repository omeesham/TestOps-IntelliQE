import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getOrGenerateRealReport, getReportStatus } from '../services/allure-report.service.js';
import { PlaywrightRunError } from '../services/playwright-runner.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const router = Router();

// In-flight generation lock to prevent concurrent builds for the same key
const inFlight = new Map<string, Promise<any>>();

/**
 * Reject a tenantId/scope URL segment that could escape its directory. Express
 * URL-decodes %2F/%2E inside a single param, so a raw `includes` check on the
 * decoded value is what stops `..%2Fother-tenant` style cross-tenant traversal.
 */
function unsafeSegment(s: string): boolean {
  return !s || s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0');
}

/** True when `target` is NOT strictly contained within `baseDir`. */
function escapesDir(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
}

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
    // Validate the path segments BEFORE building baseDir — otherwise a crafted
    // tenantId/scope (e.g. "..%2Fother-tenant") escapes into another tenant's dir.
    if (unsafeSegment(tenantId) || unsafeSegment(scope)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const baseDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, scope);
    const indexFile = path.resolve(baseDir, 'index.html');

    // Directory traversal protection
    if (escapesDir(baseDir, indexFile)) {
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
    // Validate the tenant/scope segments before they become trusted path roots.
    if (unsafeSegment(tenantId) || unsafeSegment(scope)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const rawFilePath = req.params.filePath;
    const filePath = Array.isArray(rawFilePath) ? rawFilePath.join('/') : (rawFilePath || '');

    const baseDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, scope);
    const requestedFile = path.resolve(baseDir, filePath);

    // Directory traversal protection — boundary-checked, not a bare prefix match.
    if (escapesDir(baseDir, requestedFile)) {
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
