/**
 * Client-log ingest — receives the frontend logger's warn/error entries and
 * re-emits them through the backend structured logger so browser-side failures
 * are visible in the same log stream (and searchable by the same requestId) as
 * the server-side ones.
 *
 * Deliberately:
 *   - No auth: errors on the login/landing pages (pre-token) must still report.
 *   - No DB write: this is observability, not an audit trail — it pipes to
 *     stdout/stderr where the cloud log ingester picks it up. (The HIPAA
 *     audit_log is a separate, authenticated path.)
 *   - Best-effort + bounded: caps batch size and silently accepts malformed
 *     payloads so a buggy client can never take the endpoint down.
 *
 * The frontend posts here via fetch+keepalive / sendBeacon (see utils/logger.ts),
 * NOT through the axios client, to avoid recursive logging.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';

const router = Router();

const MAX_ENTRIES = 50; // one beacon batch; extra entries are dropped

interface ClientLogEntry {
  level?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  requestId?: string;
  durationMs?: number;
  ts?: string;
}

router.post('/', (req: Request, res: Response) => {
  // Acknowledge immediately — the client treats this as fire-and-forget.
  res.status(204).end();

  try {
    const body = req.body || {};
    const entries: ClientLogEntry[] = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;

    for (const e of entries) {
      const level = e.level === 'error' ? 'error' : 'warn'; // only warn/error are shipped
      logger[level](`client.${e.category || 'app'}`, {
        source: 'client',
        sessionId,
        clientTs: e.ts,
        requestId: e.requestId,
        durationMs: e.durationMs,
        msg: typeof e.message === 'string' ? e.message.slice(0, 500) : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
        userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : undefined,
        data: e.data,
      });
    }
  } catch {
    // Never throw from the ingest path — the response is already sent.
  }
});

export default router;
