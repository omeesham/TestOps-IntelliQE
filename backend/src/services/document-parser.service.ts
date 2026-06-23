/**
 * document-parser.service.ts
 * ──────────────────────────
 * Extracts plain-text requirements from uploaded BRD / functional-spec
 * documents. Supports PDF, DOCX, and plain text. The extracted string is
 * what the requirementAgent will analyse, so quality of extraction here
 * directly affects test-case quality downstream.
 *
 * Lazy-imports the parser libraries so the backend boot doesn't pay for
 * them on every cold start.
 */

const MAX_OUTPUT_LENGTH = 200_000;   // ~50 pages — guard against runaway PDFs

export interface DocumentParseResult {
  text: string;            // The extracted, cleaned plain-text content
  pageCount?: number;      // For PDFs only
  warning?: string;        // Non-fatal note (e.g., "truncated to first 200k chars")
}

/**
 * Parse a document buffer based on its mimetype (preferred) or filename
 * extension. Returns the extracted text or throws an Error describing
 * exactly which step failed.
 */
export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<DocumentParseResult> {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty file — nothing to parse');
  }

  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();

  // PDF
  if (mt === 'application/pdf' || ext === 'pdf') {
    return parsePdf(buffer);
  }

  // DOCX (modern Word) — use mammoth which strips formatting to plain text
  if (
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return parseDocx(buffer);
  }

  // Plain text — also catches markdown
  if (
    mt.startsWith('text/') ||
    ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'csv'
  ) {
    return parsePlainText(buffer);
  }

  // Legacy DOC (.doc, not .docx) — we don't support binary Word.
  if (mt === 'application/msword' || ext === 'doc') {
    throw new Error('Legacy .doc files are not supported. Please save as .docx (Word 2007+) and re-upload.');
  }

  throw new Error(`Unsupported file type: ${mimeType || ext || 'unknown'}. Supported formats: PDF, DOCX, TXT, MD.`);
}

/**
 * PDF via pdf-parse v2 (class API). The parser is instantiated per call
 * with the buffer; we destroy it immediately after to release the
 * underlying pdfjs document and free memory.
 */
async function parsePdf(buffer: Buffer): Promise<DocumentParseResult> {
  // Lazy import — the v2 parser pulls in pdfjs-dist which is heavy.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    // getText concatenates per-page text into the `text` field.
    const result = await parser.getText();
    const pageCount = Array.isArray(result.pages) ? result.pages.length : undefined;
    const rawText = result.text || '';
    return {
      text: clean(rawText),
      pageCount,
      warning: rawText.length > MAX_OUTPUT_LENGTH
        ? `Document was very large (${pageCount || 'many'} pages); truncated to first ${MAX_OUTPUT_LENGTH} characters.`
        : undefined,
    };
  } finally {
    // Always release the pdfjs document, even on parse errors.
    await parser.destroy().catch(() => { /* already destroyed */ });
  }
}

/** DOCX via mammoth — yields plain text, not HTML. */
async function parseDocx(buffer: Buffer): Promise<DocumentParseResult> {
  const mammoth = await import('mammoth');
  // extractRawText returns { value: string, messages: any[] }
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: clean(result.value),
    warning: result.messages?.length
      ? `Mammoth emitted ${result.messages.length} warning(s) during conversion.`
      : undefined,
  };
}

/** Plain text — assume UTF-8. */
function parsePlainText(buffer: Buffer): DocumentParseResult {
  return { text: clean(buffer.toString('utf-8')) };
}

/**
 * Normalise extracted text: collapse runs of whitespace, drop control
 * characters, trim, and truncate. Helps the downstream LLM prompt stay
 * within token limits and avoid noise from PDF-extracted hidden chars.
 */
function clean(raw: string): string {
  if (!raw) return '';
  let t = raw
    // Strip null bytes and most control chars except newline + tab
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing whitespace per line
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (t.length > MAX_OUTPUT_LENGTH) {
    t = t.slice(0, MAX_OUTPUT_LENGTH);
  }
  return t;
}
