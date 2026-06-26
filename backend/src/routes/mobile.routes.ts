/**
 * mobile.routes.ts
 * ────────────────
 * POST /api/mobile/extract
 *   Accepts multipart/form-data with a single `file` field (an Android .apk or
 *   iOS .ipa build) and returns its parsed metadata (package/bundle id, app
 *   name, version, permissions). Used by the chat wizard's Mobile Automation
 *   path to seed mobile-aware test generation.
 *
 * Mirrors document.routes.ts (multer memory storage, custom error handler) but
 * accepts binary mobile builds and parses structure instead of text.
 *
 * Constraints:
 *   - 300 MB max upload (mobile builds are large)
 *   - Only .apk / .ipa accepted
 *   - Parsed entirely in memory + a transient temp file — no permanent storage
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { parseMobileApp } from '../services/mobile-app-parser.service.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    if (ext === 'apk' || ext === 'ipa') {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type (.${ext}). Upload an Android .apk or iOS .ipa build.`));
    }
  },
});

router.post('/extract', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Send a multipart/form-data POST with a "file" field.' });
    return;
  }

  const { buffer, originalname } = req.file;
  try {
    const meta = await parseMobileApp(buffer, originalname);
    res.json(meta);
  } catch (err) {
    const message = (err as Error).message || 'Failed to read the mobile app build';
    console.error(`[mobile/extract] Failed to parse ${originalname} (${req.file.size} bytes):`, message);
    res.status(400).json({ error: message, fileName: originalname });
  }
});

// Custom multer error handler — clean JSON instead of Express's default HTML page.
router.use((err: any, _req: Request, res: Response, _next: any) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File too large. Maximum upload size is 300 MB.' });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message || 'Upload failed' });
    return;
  }
  res.status(500).json({ error: 'Unknown upload error' });
});

export default router;
