/**
 * html-report.routes.ts
 * ─────────────────────
 * Generate / serve / download the custom branded HTML execution report.
 * Symmetric with allure.routes.ts so the Reports UI can treat both formats the
 * same way. The tenant UUID in serve URLs acts as an opaque token (same model
 * the Allure route uses), so static serving needs no auth — generate/status do.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { getOrGenerateHtmlReport, getHtmlReportStatus } from '../services/html-report.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const router = Router();

// In-flight generation lock to dedupe concurrent builds for the same key.
const inFlight = new Map<string, Promise<any>>();

/** Reject a URL segment that could escape its directory (see allure.routes). */
function unsafeSegment(s: string): boolean {
  return !s || s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0');
}

/** True when `target` is NOT strictly contained within `baseDir`. */
function escapesDir(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * POST /api/html-report/generate  (auth required)
 * Body: { runId: string }
 */
router.post('/generate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { runId } = req.body || {};
    if (!runId) {
      res.status(400).json({ error: 'runId is required to generate an HTML report', code: 'NO_RUN' });
      return;
    }
    const key = `${user.tenantId}:${runId}`;

    if (inFlight.has(key)) {
      const result = await inFlight.get(key);
      res.json({ ok: true, generatedAt: result.generatedAt, reportUrl: `/api/html-report/report/${user.tenantId}/${runId}/index.html` });
      return;
    }

    const promise = getOrGenerateHtmlReport(user.tenantId, user.isPlatform, runId);
    inFlight.set(key, promise);
    try {
      const result = await promise;
      res.json({ ok: true, generatedAt: result.generatedAt, reportUrl: `/api/html-report/report/${user.tenantId}/${runId}/index.html` });
    } finally {
      inFlight.delete(key);
    }
  } catch (err: any) {
    console.error('HTML report generate error:', err.message);
    res.status(500).json({
      error: 'Failed to generate HTML report.',
      code: 'UNKNOWN',
      hint: 'An unexpected error occurred. Try again, or contact support if it persists.',
    });
  }
});

/**
 * GET /api/html-report/status?runId=<uuid>  (auth required)
 */
router.get('/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = req.query.runId as string | undefined;
    const status = await getHtmlReportStatus(user.tenantId, runId);
    res.json(status);
  } catch (err: any) {
    console.error('HTML report status error:', err.message);
    res.status(500).json({ error: 'Failed to check HTML report status' });
  }
});

/**
 * GET /api/html-report/report/:tenantId/:scope/download  (NO auth — opaque token)
 * Download the self-contained report as an attachment. Registered BEFORE the
 * wildcard serve route so "download" isn't treated as a filename.
 */
router.get('/report/:tenantId/:scope/download', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '');
    const scope = String(req.params.scope || '');
    if (unsafeSegment(tenantId) || unsafeSegment(scope)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const baseDir = path.join(BACKEND_ROOT, 'html-reports', tenantId, scope);
    const indexFile = path.resolve(baseDir, 'index.html');
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
    res.download(indexFile, `intelliqe-report-${scope.slice(0, 8)}.html`);
  } catch (err: any) {
    console.error('HTML report download error:', err.message);
    res.status(500).json({ error: 'Failed to download report file' });
  }
});

/**
 * GET /api/html-report/report/:tenantId/:scope/*  (NO auth — static for iframe)
 */
router.get('/report/:tenantId/:scope/{*filePath}', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId || '');
    const scope = String(req.params.scope || '');
    if (unsafeSegment(tenantId) || unsafeSegment(scope)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    const rawFilePath = req.params.filePath;
    const filePath = Array.isArray(rawFilePath) ? rawFilePath.join('/') : (rawFilePath || 'index.html');

    const baseDir = path.join(BACKEND_ROOT, 'html-reports', tenantId, scope);
    const requestedFile = path.resolve(baseDir, filePath);
    if (escapesDir(baseDir, requestedFile)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    try {
      await fs.access(requestedFile);
    } catch {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const ext = path.extname(requestedFile).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    };
    if (mimeTypes[ext]) res.setHeader('Content-Type', mimeTypes[ext]);
    res.removeHeader('X-Frame-Options'); // allow our own report to embed in an iframe
    res.sendFile(requestedFile);
  } catch (err: any) {
    console.error('HTML report serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve report file' });
  }
});

export default router;
