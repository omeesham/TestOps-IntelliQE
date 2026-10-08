/**
 * api-callback.service.ts
 * ───────────────────────
 * Webhook / async-callback verification — a standalone, opt-in tool. Many APIs
 * do their real work asynchronously: you POST something, and later the service
 * calls YOU back (a webhook) or emits an event. This gives you a disposable
 * public capture URL (/hook/:token) to use as that callback target, records
 * every request it receives, and lets a test assert the callback arrived with
 * the expected payload within a timeout.
 *
 * Capture is public (the calling service can't send an IntelliQE login — the
 * unguessable token is the capability); management is tenant-authenticated.
 * Nothing here touches the generate → execute → heal pipeline.
 */
import { randomBytes } from 'node:crypto';
import pool from '../db.js';

const MAX_EVENTS_PER_LISTENER = 200;
const BODY_LIMIT = 100_000;

export interface CallbackListener { id: string; token: string; name: string; eventCount: number; createdBy: string; createdAt: string }
export interface CallbackEvent { id: string; method: string; path: string; query: string; headers: Record<string, string>; body: string; receivedAt: string }

function mapListener(r: any): CallbackListener {
  return { id: String(r.id), token: r.token, name: r.name || 'Callback', eventCount: Number(r.event_count) || 0, createdBy: r.created_by || '', createdAt: r.created_at };
}

export async function listListeners(tenantId: string): Promise<CallbackListener[]> {
  const { rows } = await pool.query(
    `SELECT l.*, (SELECT COUNT(*) FROM api_callback_events e WHERE e.token = l.token) AS event_count
       FROM api_callback_listeners l WHERE l.tenant_id = $1 ORDER BY l.created_at DESC`,
    [tenantId],
  );
  return rows.map(mapListener);
}

export async function createListener(tenantId: string, username: string, name: unknown): Promise<CallbackListener> {
  const clean = String(name || '').trim().slice(0, 200) || 'Callback listener';
  const token = randomBytes(12).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO api_callback_listeners (tenant_id, token, name, created_by) VALUES ($1, $2, $3, $4)
     RETURNING *, 0 AS event_count`,
    [tenantId, token, clean, username || ''],
  );
  return mapListener(rows[0]);
}

export async function deleteListener(tenantId: string, id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT token FROM api_callback_listeners WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) return false;
  await pool.query(`DELETE FROM api_callback_events WHERE token = $1`, [rows[0].token]);
  const { rowCount } = await pool.query(`DELETE FROM api_callback_listeners WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export async function getEvents(tenantId: string, token: string): Promise<CallbackEvent[] | null> {
  const { rows: own } = await pool.query(`SELECT id FROM api_callback_listeners WHERE tenant_id = $1 AND token = $2`, [tenantId, token]);
  if (!own.length) return null; // not this tenant's listener
  const { rows } = await pool.query(
    `SELECT TOP 100 id, method, path, query, headers, body, received_at FROM api_callback_events
       WHERE token = $1 ORDER BY received_at DESC`,
    [token],
  );
  return rows.map((r: any) => {
    let headers: Record<string, string> = {};
    try { headers = JSON.parse(r.headers || '{}'); } catch { /* ignore */ }
    return { id: String(r.id), method: r.method, path: r.path || '', query: r.query || '', headers, body: r.body || '', receivedAt: r.received_at };
  });
}

/* ── PUBLIC: record an inbound callback (matched by the unguessable token only) ── */
export async function recordCallback(token: string, input: { method: string; path: string; query?: string; headers?: Record<string, unknown>; body?: string }): Promise<boolean> {
  if (!/^[0-9a-f]{8,64}$/i.test(token)) return false;
  const { rows } = await pool.query(`SELECT id FROM api_callback_listeners WHERE token = $1`, [token]);
  if (!rows.length) return false;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers || {})) {
    if (/^(host|content-length|connection)$/i.test(k)) continue;
    headers[k.slice(0, 120)] = String(Array.isArray(v) ? v.join(', ') : v ?? '').slice(0, 1000);
  }
  await pool.query(
    `INSERT INTO api_callback_events (token, method, path, query, headers, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [token, String(input.method || 'POST').toUpperCase().slice(0, 10), String(input.path || '').slice(0, 2000), String(input.query || '').slice(0, 2000), JSON.stringify(headers), String(input.body || '').slice(0, BODY_LIMIT)],
  );
  // Trim to the newest N so a chatty producer can't grow the table unbounded.
  await pool.query(
    `DELETE FROM api_callback_events WHERE token = $1 AND id NOT IN (
       SELECT TOP (${MAX_EVENTS_PER_LISTENER}) id FROM api_callback_events WHERE token = $1 ORDER BY received_at DESC
     )`,
    [token],
  ).catch(() => {});
  return true;
}
