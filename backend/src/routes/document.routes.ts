/**
 * document.routes.ts
 * ──────────────────
 * POST /api/document/extract
 *   Accepts multipart/form-data with a single `file` field.
 *   Returns { text, fileName, mimeType, sizeBytes, pageCount?, warning?, notice? }
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
import { parseApiEndpointsFromText } from '../services/api-spec-parser.service.js';
import { getTenantLlm } from '../services/llm.service.js';

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
      notice: parsed.notice,
      characterCount: parsed.text.length,
    });
  } catch (err) {
    const message = (err as Error).message || 'Document parsing failed';
    console.error(`[document/extract] Failed to parse ${originalname} (${mimetype}, ${size} bytes):`, message);
    res.status(400).json({ error: message, fileName: originalname });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   API-spec upload — the "Upload API Spec" button on the chat API form.
   Accepts an API description in ANY format (OpenAPI/Swagger JSON or YAML,
   Postman collection, WSDL/XML, PDF or Word API doc, cURL, plain text),
   extracts its text, and asks the tenant's LLM to normalise it into the
   same structured endpoint the API form produces.
   ───────────────────────────────────────────────────────────────────── */

// Broader whitelist than /extract — API specs commonly arrive as .json / .yaml
// / .xml, plus the PDF/DOCX/text formats the requirement path already accepts.
const API_SPEC_EXTS = ['pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'wsdl', 'bru'];
const API_SPEC_MIMES = new Set<string>([
  'application/json', 'application/xml', 'text/xml',
  'application/x-yaml', 'application/yaml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',  // .xlsx
  'application/vnd.ms-excel',                                            // .xls
]);

const apiSpecUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },   // 15 MB
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    if (ALLOWED_MIMES.has(file.mimetype) || API_SPEC_EXTS.includes(ext) || API_SPEC_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype} (.${ext}). Allowed: PDF, DOCX, XLSX, JSON, YAML, XML, TXT, MD.`));
    }
  },
});

/**
 * POST /api/document/parse-api-spec
 * Form fields: file (single), format (optional hint: openapi|postman|json|yaml|xml|pdf|docx|auto)
 * Returns { spec, fileName, mimeType, sizeBytes, warning?, notice?, notes? }
 */
router.post('/parse-api-spec', apiSpecUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Send a multipart/form-data POST with a "file" field.' });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const { buffer, mimetype, originalname, size } = req.file;
  const formatHint = typeof req.body?.format === 'string' ? req.body.format : undefined;

  try {
    const parsed = await parseDocument(buffer, mimetype, originalname);
    if (!parsed.text || parsed.text.trim().length === 0) {
      res.status(422).json({
        error: 'File parsed successfully but contained no extractable text. It may be image-only (scanned) or password-protected.',
        fileName: originalname,
      });
      return;
    }

    const llm = await getTenantLlm(req.user.tenantId);
    if (!llm) {
      res.status(400).json({
        error: 'No LLM is configured. Add an Anthropic API key in System Configuration → LLM Configuration before uploading an API spec.',
      });
      return;
    }

    const endpoints = await parseApiEndpointsFromText(parsed.text, originalname, llm, formatHint);

    res.json({
      endpoints,
      count: endpoints.length,
      fileName: originalname,
      mimeType: mimetype,
      sizeBytes: size,
      warning: parsed.warning,
      notice: parsed.notice,
    });
  } catch (err) {
    const message = (err as Error).message || 'API spec parsing failed';
    console.error(`[document/parse-api-spec] Failed for ${originalname} (${mimetype}, ${size} bytes):`, message);
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
