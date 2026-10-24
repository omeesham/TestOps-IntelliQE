/**
 * test-data.routes
 * ────────────────
 * Test files per application under test (Application Setup).
 *
 *   GET    /api/test-data/:appId          → { files: [{ name, size, updatedAt }], negativeFiles }
 *   POST   /api/test-data/:appId          → multipart, field "files" (one or more) → { saved, rejected }
 *   DELETE /api/test-data/:appId/:name    → { ok: true }
 *
 * The app must be an Application Setup entry (app-*) of the caller's tenant.
 * Uploading and deleting need the admin or qa_engineer role.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs/promises';
import { getConfigsForTenant } from '../services/configurations.service.js';
import { listTestData, saveTestData, deleteTestData, NEGATIVE_FILES } from '../services/test-data.service.js';

const router = Router();

const MAX_FILE_MB = 25;
const MAX_FILES_PER_UPLOAD = 20;
// Uploads stream to a temporary folder (not memory), then move into the store.
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
});

const EDIT_ROLES = new Set(['admin', 'qa_engineer']);

/** Resolve :appId to an Application Setup entry of the caller's tenant, or answer 400/404. */
async function requireApp(req: Request, res: Response): Promise<string | null> {
  const appId = String(req.params.appId || '');
  if (!/^app-[A-Za-z0-9-]{1,100}$/.test(appId)) {
    res.status(400).json({ error: 'Invalid application id' });
    return null;
  }
  const configs = await getConfigsForTenant(req.user!.tenantId);
  if (!configs.some((c) => c.integrationId === appId)) {
    res.status(404).json({ error: 'Application not found. Save it in Application Setup first.' });
    return null;
  }
  return appId;
}

function requireEditRole(req: Request, res: Response, next: NextFunction): void {
  if (!EDIT_ROLES.has(req.user!.role)) {
    res.status(403).json({ error: 'Only administrators and QA engineers can change test files.' });
    return;
  }
  next();
}

router.get('/:appId', async (req: Request, res: Response) => {
  try {
    const appId = await requireApp(req, res);
    if (!appId) return;
    res.json({ files: await listTestData(req.user!.tenantId, appId), negativeFiles: NEGATIVE_FILES });
  } catch (err) {
    console.error('List test files error:', (err as Error).message);
    res.status(500).json({ error: 'Failed to list test files' });
  }
});

router.post('/:appId', requireEditRole, (req: Request, res: Response, next: NextFunction) => {
  upload.array('files')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `A file exceeds the ${MAX_FILE_MB} MB limit`
        : err.code === 'LIMIT_FILE_COUNT' ? `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time` : err.message;
      res.status(400).json({ error: msg });
      return;
    }
    if (err) { next(err); return; }
    next();
  });
}, async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  try {
    const appId = await requireApp(req, res);
    if (!appId) return;
    if (files.length === 0) {
      res.status(400).json({ error: 'No files received (form field "files")' });
      return;
    }
    const saved: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for (const f of files) {
      try {
        saved.push(await saveTestData(req.user!.tenantId, appId, f.originalname, f.path));
      } catch (e) {
        rejected.push({ name: f.originalname, reason: (e as Error).message });
      }
    }
    res.status(saved.length ? 200 : 400).json({ saved, rejected });
  } catch (err) {
    console.error('Upload test files error:', (err as Error).message);
    res.status(500).json({ error: 'Failed to save test files' });
  } finally {
    await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
  }
});

router.delete('/:appId/:name', requireEditRole, async (req: Request, res: Response) => {
  try {
    const appId = await requireApp(req, res);
    if (!appId) return;
    if (!(await deleteTestData(req.user!.tenantId, appId, String(req.params.name || '')))) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete test file error:', (err as Error).message);
    res.status(500).json({ error: 'Failed to delete test file' });
  }
});

export default router;
