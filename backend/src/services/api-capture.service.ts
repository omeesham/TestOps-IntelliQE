/**
 * api-capture.service.ts
 * ──────────────────────
 * Live traffic capture → tests. A standalone, opt-in feature that lives
 * ALONGSIDE the generation → execute → heal pipeline and never modifies it.
 *
 * The idea (this is what Loadmill calls "tests from real traffic"): record the
 * API calls your app, a proxy, or a browser actually makes into a persistent
 * *capture session*, then turn the accumulated requests into catalogue
 * endpoints — deduped, noise-filtered, auth-extracted — which feed the SAME
 * generator every other import method feeds.
 *
 * Three ways to record into a session, all additive:
 *   1. Drop/paste a HAR recording (browser DevTools → Save all as HAR).
 *   2. Point the generated recorder proxy snippet at a session — it forwards
 *      traffic to your API and streams each request/response here.
 *   3. POST entries directly (any tool that can emit request/response JSON).
 *
 * Nothing here is read by the pipeline. Converting a session produces ordinary
 * ImportedEndpoints handed back to the client, exactly like a file import.
 */
import pool from '../db.js';
import {
  parseHar, dedupeEndpoints, type ImportedEndpoint,
} from './api-import.service.js';

/* ── Limits (bounded storage; a session is a sample, not an archive) ── */
const MAX_ENTRIES_PER_SESSION = 5000;
const MAX_INGEST_BATCH = 2000;
const BODY_STORE_LIMIT = 200_000;
const MAX_HEADERS = 40;

/** Static assets we never want as "endpoints" — filtered at ingest to save room. */
const STATIC_EXT = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|mp4|webm|mp3|wav|pdf|zip|gz)(?:$|\?)/i;
const STATIC_MIME = /^(?:image|font|video|audio)\/|text\/css|application\/javascript|text\/javascript|text\/html/i;

export interface CaptureSession {
  id: string;
  name: string;
  status: 'recording' | 'closed';
  entryCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureEntrySample {
  method: string;
  url: string;
  status?: number;
  mime?: string;
  at: string;
}

/** A normalised capture row, ready to store. */
interface NormalEntry {
  method: string;
  url: string;
  status?: number;
  mime?: string;
  reqHeaders: { key: string; value: string }[];
  reqBody?: string;
  resBody?: string;
}

function mapSession(r: any): CaptureSession {
  return {
    id: String(r.id),
    name: r.name || 'Capture',
    status: r.status === 'closed' ? 'closed' : 'recording',
    entryCount: Number(r.entry_count) || 0,
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ────────────────────────────────────────────────────────────────
   Session CRUD
   ──────────────────────────────────────────────────────────────── */

export async function listCaptureSessions(tenantId: string): Promise<CaptureSession[]> {
  const { rows } = await pool.query(
    `SELECT * FROM api_capture_sessions WHERE tenant_id = $1 ORDER BY updated_at DESC`,
    [tenantId],
  );
  return rows.map(mapSession);
}

export async function createCaptureSession(tenantId: string, username: string, name: unknown): Promise<CaptureSession> {
  const clean = String(name || '').trim().slice(0, 200) || `Capture ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const { rows } = await pool.query(
    `INSERT INTO api_capture_sessions (tenant_id, name, status, created_by)
     VALUES ($1, $2, 'recording', $3) RETURNING *`,
    [tenantId, clean, username || ''],
  );
  return mapSession(rows[0]);
}

export async function getCaptureSession(tenantId: string, id: string): Promise<(CaptureSession & { sample: CaptureEntrySample[] }) | null> {
  const { rows } = await pool.query(`SELECT * FROM api_capture_sessions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) return null;
  const { rows: ent } = await pool.query(
    `SELECT TOP 20 method, url, status, mime, created_at FROM api_capture_entries
     WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at DESC`,
    [tenantId, id],
  );
  return {
    ...mapSession(rows[0]),
    sample: ent.map((e: any) => ({ method: e.method, url: e.url, status: e.status ?? undefined, mime: e.mime ?? undefined, at: e.created_at })),
  };
}

export async function closeCaptureSession(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE api_capture_sessions SET status = 'closed', updated_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rowCount > 0;
}

export async function deleteCaptureSession(tenantId: string, id: string): Promise<boolean> {
  await pool.query(`DELETE FROM api_capture_entries WHERE tenant_id = $1 AND session_id = $2`, [tenantId, id]);
  const { rowCount } = await pool.query(`DELETE FROM api_capture_sessions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ────────────────────────────────────────────────────────────────
   Ingest
   Accepts HAR docs/entries OR flat {method,url,status,…} objects, from any
   recorder. Normalises, drops static-asset noise, caps the session.
   ──────────────────────────────────────────────────────────────── */

function headerArray(raw: unknown): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (!h || typeof h !== 'object') continue;
      const key = String((h as any).key ?? (h as any).name ?? '').trim();
      if (!key) continue;
      out.push({ key: key.slice(0, 200), value: String((h as any).value ?? '').slice(0, 2000) });
      if (out.length >= MAX_HEADERS) break;
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!k.trim()) continue;
      out.push({ key: k.trim().slice(0, 200), value: String(v ?? '').slice(0, 2000) });
      if (out.length >= MAX_HEADERS) break;
    }
  }
  return out;
}

function isNoise(url: string, mime?: string): boolean {
  if (/\/api\/|\/graphql\b|\/v\d+\//i.test(url)) return false; // obvious API path — keep
  if (mime && STATIC_MIME.test(mime)) return true;
  if (STATIC_EXT.test(url)) return true;
  return false;
}

/** One raw entry → a normal row, or null if it is not a usable request. */
function normalizeEntry(raw: any): NormalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  // HAR entry shape
  if (raw.request && typeof raw.request === 'object') {
    const req = raw.request; const res = raw.response || {};
    const url = String(req.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const mime = String(res?.content?.mimeType || '').split(';')[0] || undefined;
    if (isNoise(url, mime)) return null;
    return {
      method: String(req.method || 'GET').toUpperCase().slice(0, 10),
      url: url.slice(0, 4000),
      status: Number(res.status) || undefined,
      mime,
      reqHeaders: headerArray(req.headers),
      reqBody: req.postData?.text ? String(req.postData.text).slice(0, BODY_STORE_LIMIT) : undefined,
      resBody: res?.content?.text ? String(res.content.text).slice(0, BODY_STORE_LIMIT) : undefined,
    };
  }
  // Flat shape
  const url = String(raw.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const mime = raw.mime ? String(raw.mime).split(';')[0] : (raw.responseMime ? String(raw.responseMime).split(';')[0] : undefined);
  if (isNoise(url, mime)) return null;
  const body = raw.requestBody ?? raw.reqBody ?? raw.body;
  const resBody = raw.responseBody ?? raw.resBody;
  return {
    method: String(raw.method || 'GET').toUpperCase().slice(0, 10),
    url: url.slice(0, 4000),
    status: Number(raw.status ?? raw.responseStatus) || undefined,
    mime,
    reqHeaders: headerArray(raw.requestHeaders ?? raw.headers),
    reqBody: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, BODY_STORE_LIMIT) : undefined,
    resBody: resBody != null ? (typeof resBody === 'string' ? resBody : JSON.stringify(resBody)).slice(0, BODY_STORE_LIMIT) : undefined,
  };
}

/** Pull entries out of whatever the caller sent (HAR doc, HAR entries, flat list). */
function extractRaw(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.entries)) return payload.entries;
    if (payload.log && Array.isArray(payload.log.entries)) return payload.log.entries; // HAR
  }
  return [];
}

export interface IngestResult { accepted: number; skipped: number; entryCount: number; capped: boolean }

export async function ingestCapture(tenantId: string, sessionId: string, payload: unknown): Promise<IngestResult> {
  const { rows } = await pool.query(`SELECT entry_count, status FROM api_capture_sessions WHERE tenant_id = $1 AND id = $2`, [tenantId, sessionId]);
  if (!rows.length) throw new Error('Capture session not found.');
  if (rows[0].status === 'closed') throw new Error('This capture session is closed. Open a new one to keep recording.');

  let count = Number(rows[0].entry_count) || 0;
  const raw = extractRaw(payload).slice(0, MAX_INGEST_BATCH);
  if (!raw.length) throw new Error('No capturable requests found. Send a HAR recording or a list of request/response objects.');

  let accepted = 0; let skipped = 0; let capped = false;
  for (const r of raw) {
    if (count >= MAX_ENTRIES_PER_SESSION) { capped = true; break; }
    const n = normalizeEntry(r);
    if (!n) { skipped++; continue; }
    await pool.query(
      `INSERT INTO api_capture_entries (tenant_id, session_id, method, url, status, mime, req_headers, req_body, res_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, sessionId, n.method, n.url, n.status ?? null, n.mime ?? null, JSON.stringify(n.reqHeaders), n.reqBody ?? null, n.resBody ?? null],
    );
    accepted++; count++;
  }
  await pool.query(
    `UPDATE api_capture_sessions SET entry_count = $3, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, sessionId, count],
  );
  return { accepted, skipped, entryCount: count, capped };
}

/* ────────────────────────────────────────────────────────────────
   Convert: session → catalogue endpoints
   Reassembles the stored rows into a HAR document and runs the existing
   HAR parser, so clustering, noise-filtering and auth extraction are
   identical to a HAR file import. Deduped the same way, too.
   ──────────────────────────────────────────────────────────────── */

export async function captureToEndpoints(tenantId: string, sessionId: string): Promise<{ endpoints: ImportedEndpoint[]; name: string; fromEntries: number }> {
  const { rows: sess } = await pool.query(`SELECT name FROM api_capture_sessions WHERE tenant_id = $1 AND id = $2`, [tenantId, sessionId]);
  if (!sess.length) throw new Error('Capture session not found.');
  const { rows: ent } = await pool.query(
    `SELECT method, url, status, mime, req_headers, req_body, res_body FROM api_capture_entries
     WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at ASC`,
    [tenantId, sessionId],
  );
  const har = {
    log: {
      version: '1.2',
      entries: ent.map((e: any) => {
        let headers: { name: string; value: string }[] = [];
        try { headers = (JSON.parse(e.req_headers || '[]') as { key: string; value: string }[]).map((h) => ({ name: h.key, value: h.value })); } catch { /* ignore */ }
        return {
          request: {
            method: e.method,
            url: e.url,
            headers,
            postData: e.req_body ? { text: e.req_body } : undefined,
          },
          response: {
            status: e.status ?? 0,
            content: { mimeType: e.mime || 'application/json', text: e.res_body || undefined },
          },
        };
      }),
    },
  };
  const result = parseHar(har, sess[0].name || 'Capture session');
  return { endpoints: dedupeEndpoints(result.endpoints), name: sess[0].name || 'Capture session', fromEntries: ent.length };
}
