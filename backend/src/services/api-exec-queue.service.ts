/**
 * api-exec-queue.service.ts
 * ─────────────────────────
 * Parallel execution queue — a slot/queue model over the headless pipeline.
 * Runs are enqueued and drained by a per-tenant pump that keeps at most
 * `slots` runs executing at once (the rest wait as 'queued'); each slot drives
 * a real `runHeadlessApiRun` job and is freed when that job settles, which then
 * pulls the next queued run. Items + their stats persist so the queue survives
 * a page reload.
 *
 * Additive and opt-in: its own tables; enqueuing is the only entry point and
 * the pipeline itself is unchanged.
 */
import pool from '../db.js';
import { startJob, getJob } from './async-jobs.service.js';
import { runHeadlessApiRun } from './api-run.service.js';
import { normalizeEndpoints } from '../utils/endpoint-normalize.js';

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export interface QueueItem {
  id: string;
  title: string;
  status: QueueStatus;
  endpointCount: number;
  jobId?: string;
  stats?: { total: number; passed: number; failed: number; passRate: number } | null;
  error?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface QueueView { slots: number; running: number; queued: number; items: QueueItem[] }

function mapItem(r: any): QueueItem {
  const s = r.stats && typeof r.stats === 'object' ? r.stats : null;
  return {
    id: String(r.id), title: r.title, status: r.status as QueueStatus,
    endpointCount: Number(r.endpoint_count) || 0,
    jobId: r.job_id || undefined,
    stats: s ? { total: s.total, passed: s.passed, failed: s.failed, passRate: s.passRate } : null,
    error: r.error || undefined,
    enqueuedAt: r.enqueued_at, startedAt: r.started_at || undefined, finishedAt: r.finished_at || undefined,
  };
}

async function getSlots(tenantId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT slots FROM api_exec_queue_config WHERE tenant_id = $1`, [tenantId]);
  return rows.length ? Math.max(1, Math.min(8, Number(rows[0].slots) || 2)) : 2;
}
export async function saveQueueConfig(tenantId: string, slots: unknown): Promise<{ slots: number }> {
  const s = Math.max(1, Math.min(8, Math.round(Number(slots)) || 2));
  const upd = await pool.query(`UPDATE api_exec_queue_config SET slots = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1`, [tenantId, s]);
  if (!upd.rowCount) await pool.query(`INSERT INTO api_exec_queue_config (tenant_id, slots) VALUES ($1, $2)`, [tenantId, s]);
  void pump(tenantId);
  return { slots: s };
}

export async function listQueue(tenantId: string): Promise<QueueView> {
  const slots = await getSlots(tenantId);
  const { rows } = await pool.query(`SELECT TOP 100 * FROM api_exec_queue_items WHERE tenant_id = $1 ORDER BY enqueued_at DESC`, [tenantId]);
  const items = rows.map(mapItem);
  return { slots, running: items.filter((i) => i.status === 'running').length, queued: items.filter((i) => i.status === 'queued').length, items };
}

export async function enqueueRun(tenantId: string, username: string, input: any): Promise<QueueItem> {
  const endpoints = normalizeEndpoints(input?.endpoints);
  if (!endpoints.length) throw new Error('No endpoints to enqueue (absolute http(s) URLs required).');
  const title = String(input?.title || 'Queued run').slice(0, 160);
  const coverage = ['essential', 'standard', 'exhaustive'].includes(String(input?.coverage)) ? input.coverage : undefined;
  const payload = { endpoints, coverage, execute: input?.execute !== false, heal: input?.heal === true };
  const { rows } = await pool.query(
    `INSERT INTO api_exec_queue_items (tenant_id, title, status, endpoint_count, payload, created_by) OUTPUT INSERTED.* VALUES ($1, $2, 'queued', $3, $4, $5)`,
    [tenantId, title, endpoints.length, payload, username],
  );
  const item = mapItem(rows[0]);
  void pump(tenantId);
  return item;
}

export async function cancelQueued(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE api_exec_queue_items SET status = 'canceled', finished_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
    [tenantId, id],
  );
  return rowCount > 0;
}

// ── drain loop (in-process; one pump per tenant at a time) ──
const pumping = new Set<string>();

async function pump(tenantId: string): Promise<void> {
  if (pumping.has(tenantId)) return;
  pumping.add(tenantId);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const slots = await getSlots(tenantId);
      const { rows: runningRows } = await pool.query(`SELECT COUNT(*) AS c FROM api_exec_queue_items WHERE tenant_id = $1 AND status = 'running'`, [tenantId]);
      const running = Number(runningRows[0]?.c) || 0;
      if (running >= slots) break;
      const { rows: nextRows } = await pool.query(`SELECT TOP 1 * FROM api_exec_queue_items WHERE tenant_id = $1 AND status = 'queued' ORDER BY enqueued_at ASC`, [tenantId]);
      if (!nextRows.length) break;
      const item = nextRows[0];
      const payload: any = item.payload && typeof item.payload === 'object' ? item.payload : {};
      const input = { endpoints: payload.endpoints || [], title: item.title, coverage: payload.coverage, execute: payload.execute !== false, heal: payload.heal === true };
      const jobId = startJob(tenantId, (id) => runHeadlessApiRun(tenantId, item.created_by || 'queue', input, id));
      await pool.query(`UPDATE api_exec_queue_items SET status = 'running', job_id = $3, started_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`, [tenantId, item.id, jobId]);
      watchJob(tenantId, String(item.id), jobId);
    }
  } catch { /* swallow — the next enqueue/config change re-pumps */ } finally {
    pumping.delete(tenantId);
  }
}

function watchJob(tenantId: string, itemId: string, jobId: string): void {
  const poll = async (): Promise<void> => {
    try {
      const job = getJob(tenantId, jobId);
      if (!job) {
        await pool.query(`UPDATE api_exec_queue_items SET status = 'failed', error = 'job lost', finished_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`, [tenantId, itemId]);
        void pump(tenantId);
        return;
      }
      if (job.status === 'running') { setTimeout(() => void poll(), 3000); return; }
      const res: any = job.result || {};
      const stats = res.stats || null;
      await pool.query(
        `UPDATE api_exec_queue_items SET status = $3, stats = $4, error = $5, finished_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, itemId, job.status === 'completed' ? 'done' : 'failed', stats, job.error || null],
      );
      void pump(tenantId);
    } catch { /* leave item; a later pump reconciles */ }
  };
  setTimeout(() => void poll(), 2000);
}
