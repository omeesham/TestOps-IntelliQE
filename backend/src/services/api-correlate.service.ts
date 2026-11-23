/**
 * api-correlate.service.ts
 * ────────────────────────
 * Capture → RUNNABLE flow (auto-dependency correlation) — the DB-facing wrapper.
 *
 * `api-capture.service` turns a capture session into FLAT catalogue endpoints.
 * This does the higher-value thing a traffic-based tool is really judged on: it
 * reads the ordered request/response entries and *correlates dependencies* — a
 * value produced in one response (id, token, uuid, email) that a later request
 * reuses is extracted to a {{var}} and injected downstream, yielding a flow that
 * runs end-to-end instead of N disconnected calls with stale ids.
 *
 * All the logic is the pure, DB-free `utils/correlate-engine` (directly unit-
 * tested); this file only loads the session's entries and delegates. Standalone
 * and opt-in — it never touches the generate→heal pipeline.
 */
import pool from '../db.js';
import { buildCorrelatedFlow, type CaptureEntry, type CorrelatedFlow } from '../utils/correlate-engine.js';

export type { CorrelatedFlow, CorrelationLink } from '../utils/correlate-engine.js';

const MAX_SCAN_ENTRIES = 400;    // entries examined before trimming to a journey

export async function correlateSessionToFlow(tenantId: string, sessionId: string): Promise<CorrelatedFlow> {
  const { rows: sess } = await pool.query(`SELECT name FROM api_capture_sessions WHERE tenant_id = $1 AND id = $2`, [tenantId, sessionId]);
  if (!sess.length) throw new Error('Capture session not found.');

  const { rows } = await pool.query(
    `SELECT method, url, status, req_headers, req_body, res_body FROM api_capture_entries
     WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at ASC`,
    [tenantId, sessionId],
  );
  const fromEntries = rows.length;
  const entries: CaptureEntry[] = rows.slice(0, MAX_SCAN_ENTRIES).map((e: any) => {
    let reqHeaders: { key: string; value: string }[] = [];
    try { reqHeaders = JSON.parse(e.req_headers || '[]'); } catch { /* ignore */ }
    return {
      method: String(e.method || 'GET').toUpperCase(),
      url: String(e.url || ''),
      status: e.status ?? undefined,
      reqHeaders: Array.isArray(reqHeaders) ? reqHeaders : [],
      reqBody: e.req_body ?? undefined,
      resBody: e.res_body ?? undefined,
    };
  });

  return buildCorrelatedFlow(entries, sess[0].name || 'Capture', fromEntries);
}
