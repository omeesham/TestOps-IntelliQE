/**
 * api-attachment-count.service.ts
 * ───────────────────────────────
 * A cheap, DETERMINISTIC "how many test cases / endpoints does this file hold?"
 * count for a tracker attachment, used to label each file in the import picker
 * before anything is imported.
 *
 * It never calls the LLM: it counts the obvious structural unit for the format —
 * data rows for a spreadsheet or CSV (the test-case sheets IntelliQE exports and
 * the swagger test sheets users attach), requests for a Postman collection or
 * HAR, operations for an OpenAPI document. Anything it cannot count cheaply
 * returns `count: null` so the UI simply shows no badge rather than a wrong one.
 */
export interface FileItemCount {
  /** How many items the file holds, or null when it can't be counted cheaply. */
  count: number | null;
  /** Short unit label for the badge: "cases", "requests", "operations", "". */
  kind: string;
}

const EMPTY: FileItemCount = { count: null, kind: '' };

function extOf(fileName: string): string {
  return (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
}

/** Non-empty data rows in a CSV/TSV, excluding a single header row. */
function countDelimitedRows(text: string): number {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 1 ? lines.length - 1 : lines.length; // drop the header when there is more than one row
}

/** Leaf requests in a Postman collection's (possibly nested) item tree. */
function countPostmanItems(items: any[]): number {
  let n = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (it && typeof it === 'object') {
      if (Array.isArray(it.item)) n += countPostmanItems(it.item);
      else if (it.request) n += 1;
    }
  }
  return n;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** path × method operations in an OpenAPI/Swagger document. */
function countOpenApiOps(doc: any): number {
  const paths = doc && typeof doc.paths === 'object' ? doc.paths : {};
  let n = 0;
  for (const item of Object.values<any>(paths)) {
    if (item && typeof item === 'object') {
      for (const m of Object.keys(item)) if (HTTP_METHODS.has(m.toLowerCase())) n += 1;
    }
  }
  return n;
}

/**
 * Count the items a tracker attachment holds, by format. Pure/deterministic and
 * cheap — safe to run over every attachment on an issue. Never throws.
 */
export async function countFileItems(buffer: Buffer, fileName: string): Promise<FileItemCount> {
  const ext = extOf(fileName);
  try {
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      return { count: countDelimitedRows(buffer.toString('utf8')), kind: 'cases' };
    }
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      let rows = 0;
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        if (!sheet) continue;
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[][];
        if (grid.length > 1) rows += grid.length - 1; // minus the header row
      }
      return { count: rows, kind: 'cases' };
    }
    if (ext === 'json') {
      const doc = JSON.parse(buffer.toString('utf8'));
      if (doc && typeof doc === 'object') {
        if (doc.info && Array.isArray(doc.item)) return { count: countPostmanItems(doc.item), kind: 'requests' };
        if (doc.openapi || doc.swagger) return { count: countOpenApiOps(doc), kind: 'operations' };
        if (doc.log && Array.isArray(doc.log.entries)) return { count: doc.log.entries.length, kind: 'requests' };
        if (Array.isArray(doc)) return { count: doc.length, kind: 'items' };
      }
      return EMPTY;
    }
  } catch { /* unreadable / wrong shape — fall through to "no count" */ }
  return EMPTY;
}
