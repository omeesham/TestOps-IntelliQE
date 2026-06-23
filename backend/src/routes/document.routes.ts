/**
 * document.routes.ts
 * ──────────────────
 * POST /api/document/extract
 *   Accepts multipart/form-data with a single `file` field.
 *   Returns { text, fileName, mimeType, sizeBytes, pageCount?, warning? }
 *
 * The wizard's "Upload Document" path uses this endpoint to convert a
 * user-uploaded BRD / functional spec into plain-text requirements that
 * are then fed to the test-generation pipeline.
 *
 * Constraints:
 *   - 15 MB max upload (multer limits.fileSize)
 *   - Only PDF, DOCX, TXT, MD are accepted (enforced in fileFilter AND parser)
 *   - File is parsed entirely in memory — never written to disk
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { parseDocument } from '../services/document-parser.service.js';

const router = Router();

// Whitelist of accepted MIME types. We also check by extension at parse
// time as a defence against browsers that send a generic mimetype.
const ALLOWED_MIMES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/octet-stream',  // some clients send this for any binary
]);

// Multer config — memory storage so we don't touch disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },   // 15 MB
  fileFilter: (_req, file, cb) => {
    // Either an allow-listed mimetype OR a known extension is OK; the
    // parser does the final, stricter check.
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const okExt = ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv'].includes(ext);
    if (ALLOWED_MIMES.has(file.mimetype) || okExt) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype} (.${ext}). Allowed: PDF, DOCX, TXT, MD.`));
    }
  },
});

/**
 * POST /api/document/extract
 * Form field: file (single file upload)
 */
router.post('/extract', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Send a multipart/form-data POST with a "file" field.' });
    return;
  }

  const { buffer, mimetype, originalname, size } = req.file;

  try {
    const parsed = await parseDocument(buffer, mimetype, originalname);

    if (!parsed.text || parsed.text.trim().length === 0) {
      res.status(422).json({
        error: 'Document parsed successfully but contained no extractable text. The file may be image-only (scanned) or password-protected.',
        fileName: originalname,
        mimeType: mimetype,
        sizeBytes: size,
      });
      return;
    }

    res.json({
      text: parsed.text,
      fileName: originalname,
      mimeType: mimetype,
      sizeBytes: size,
      pageCount: parsed.pageCount,
      warning: parsed.warning,
      characterCount: parsed.text.length,
    });
  } catch (err) {
    const message = (err as Error).message || 'Document parsing failed';
    console.error(`[document/extract] Failed to parse ${originalname} (${mimetype}, ${size} bytes):`, message);
    res.status(400).json({ error: message, fileName: originalname });
  }
});

// Custom multer error handler — converts multer's MulterError into a clean
// JSON response instead of falling through to Express's default HTML page.
router.use((err: any, _req: Request, res: Response, _next: any) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File too large. Maximum upload size is 15 MB.' });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message || 'Upload failed' });
    return;
  }
  res.status(500).json({ error: 'Unknown upload error' });
});

export default router;
