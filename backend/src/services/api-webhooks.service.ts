/**
 * api-webhooks.service.ts
 * ───────────────────────
 * Outbound run notifications — an opt-in, fire-and-forget helper. When a run
 * finishes (from the scheduler, or any caller that chooses to notify), each
 * enabled webhook for the tenant is POSTed a summary. Slack and Teams get a
 * chat-formatted message; a "generic" webhook gets the raw JSON payload, HMAC
 * -signed when a secret is set.
 *
 * Nothing here is on the run's critical path: dispatch is invoked AFTER a run
 * has completed and every failure is swallowed, so a broken webhook can never
 * affect generation, execution, or healing.
 */
import pool from '../db.js';
import { createHmac } from 'crypto';
import { encryptAtRest, decryptStored, isMaskedSecret } from '../utils/crypto.js';

export type WebhookKind = 'slack' | 'teams' | 'generic';

export interface ApiWebhook {
  id: string;
  name: string;
  url: string;
  kind: WebhookKind;
  hasSecret: boolean;
  onFailureOnly: boolean;
  enabled: boolean;
  createdBy?: string;
  lastStatus?: string;
  lastSentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunNotification {
  event: 'run.completed';
  title: string;
  runId?: string | null;
  reportUrl?: string;
  status: 'passed' | 'failed';
  stats?: { total: number; passed: number; failed: number; notRun: number; passRate: number } | null;
  failures?: { title: string; error?: string }[];
  source: 'scheduler' | 'manual' | 'api';
  at: string;
}

const KINDS: WebhookKind[] = ['slack', 'teams', 'generic'];
const DISPATCH_TIMEOUT_MS = 8000;

function rowToWebhook(row: any): ApiWebhook {
  return {
    id: String(row.id),
    name: row.name,
    url: row.url,
    kind: (KINDS.includes(row.kind) ? row.kind : 'generic') as WebhookKind,
    hasSecret: !!row.secret,
    onFailureOnly: !!row.on_failure_only,
    enabled: !!row.enabled,
    createdBy: row.created_by || undefined,
    lastStatus: row.last_status || undefined,
    lastSentAt: row.last_sent_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWebhooks(tenantId: string): Promise<ApiWebhook[]> {
  const { rows } = await pool.query(`SELECT * FROM api_webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(rowToWebhook);
}

function normalizeKind(v: unknown): WebhookKind {
  return KINDS.includes(String(v) as WebhookKind) ? (String(v) as WebhookKind) : 'generic';
}

export async function createWebhook(tenantId: string, createdBy: string, input: any): Promise<ApiWebhook> {
  const name = String(input?.name || '').trim().slice(0, 200);
  const url = String(input?.url || '').trim().slice(0, 2000);
  if (!name) throw new Error('A webhook needs a name.');
  if (!/^https?:\/\//i.test(url)) throw new Error('The webhook URL must be an absolute http(s) URL.');
  const secret = input?.secret && !isMaskedSecret(input.secret) ? encryptAtRest(String(input.secret).slice(0, 500)) : null;
  const { rows } = await pool.query(
    `INSERT INTO api_webhooks (tenant_id, name, url, kind, secret, on_failure_only, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tenantId, name, url, normalizeKind(input?.kind), secret, input?.onFailureOnly ? 1 : 0, input?.enabled === false ? 0 : 1, createdBy],
  );
  return rowToWebhook(rows[0]);
}

export async function updateWebhook(tenantId: string, id: string, input: any): Promise<ApiWebhook | null> {
  const { rows: existing } = await pool.query(`SELECT * FROM api_webhooks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!existing.length) return null;
  const cur = existing[0];
  const name = input?.name !== undefined ? String(input.name).trim().slice(0, 200) : cur.name;
  const url = input?.url !== undefined ? String(input.url).trim().slice(0, 2000) : cur.url;
  if (!name) throw new Error('A webhook needs a name.');
  if (!/^https?:\/\//i.test(url)) throw new Error('The webhook URL must be an absolute http(s) URL.');
  // A masked secret means "keep what is stored"; a real value re-encrypts; empty clears.
  let secret = cur.secret;
  if (input?.secret !== undefined) {
    secret = input.secret && !isMaskedSecret(input.secret) ? encryptAtRest(String(input.secret).slice(0, 500)) : (input.secret ? cur.secret : null);
  }
  const { rows } = await pool.query(
    `UPDATE api_webhooks SET name = $1, url = $2, kind = $3, secret = $4, on_failure_only = $5, enabled = $6, updated_at = SYSUTCDATETIME()
     WHERE tenant_id = $7 AND id = $8 RETURNING *`,
    [name, url, normalizeKind(input?.kind ?? cur.kind), secret,
     input?.onFailureOnly !== undefined ? (input.onFailureOnly ? 1 : 0) : cur.on_failure_only,
     input?.enabled !== undefined ? (input.enabled ? 1 : 0) : cur.enabled, tenantId, id],
  );
  return rowToWebhook(rows[0]);
}

export async function deleteWebhook(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_webhooks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

function summaryLine(n: RunNotification): string {
  const emoji = n.status === 'passed' ? '✅' : '❌';
  const s = n.stats;
  const rate = s ? ` — ${s.passRate}% pass (${s.passed}/${s.total})` : '';
  return `${emoji} API run ${n.status.toUpperCase()}: ${n.title}${rate}`;
}

/** Shape the payload for the target platform. */
function bodyFor(kind: WebhookKind, n: RunNotification): unknown {
  const line = summaryLine(n);
  const failures = (n.failures || []).slice(0, 5).map((f) => `• ${f.title}${f.error ? ` — ${f.error.slice(0, 120)}` : ''}`).join('\n');
  const detail = [line, n.reportUrl ? `Report: ${n.reportUrl}` : '', failures].filter(Boolean).join('\n');
  if (kind === 'slack') return { text: detail };
  if (kind === 'teams') return { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: line, themeColor: n.status === 'passed' ? '2EB67D' : 'E01E5A', title: line, text: [n.reportUrl ? `[Report](${n.reportUrl})` : '', failures].filter(Boolean).join('\n\n') };
  return n; // generic — the raw notification
}

async function postOne(webhook: { id: string; url: string; kind: WebhookKind; secret?: string | null }, n: RunNotification): Promise<'ok' | 'failed'> {
  const body = JSON.stringify(bodyFor(webhook.kind, n));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (webhook.secret) {
    try {
      const plain = decryptStored(webhook.secret);
      if (plain) headers['X-IntelliQE-Signature'] = `sha256=${createHmac('sha256', plain).update(body).digest('hex')}`;
    } catch { /* no signature if the secret cannot be read */ }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(webhook.url, { method: 'POST', headers, body, signal: ctrl.signal });
    return res.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify every enabled webhook for the tenant. Fire-and-forget: this is called
 * after a run has finished and any error is contained here, so notification can
 * never disturb the run itself. Returns how many were sent, for a manual test.
 */
export async function dispatchWebhooks(tenantId: string, n: RunNotification): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  try {
    const { rows } = await pool.query(`SELECT id, url, kind, secret, on_failure_only FROM api_webhooks WHERE tenant_id = $1 AND enabled = 1`, [tenantId]);
    for (const row of rows as any[]) {
      if (row.on_failure_only && n.status === 'passed') continue;
      const result = await postOne({ id: String(row.id), url: row.url, kind: normalizeKind(row.kind), secret: row.secret }, n);
      if (result === 'ok') sent++; else failed++;
      try { await pool.query(`UPDATE api_webhooks SET last_status = $1, last_sent_at = SYSUTCDATETIME() WHERE id = $2`, [result, String(row.id)]); } catch { /* best effort */ }
    }
  } catch { /* dispatch is best-effort by contract */ }
  return { sent, failed };
}

/** Send a single test notification to one webhook, for the "Test" button. */
export async function testWebhook(tenantId: string, id: string): Promise<{ ok: boolean }> {
  const { rows } = await pool.query(`SELECT id, url, kind, secret FROM api_webhooks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) throw new Error('Webhook not found.');
  const row = rows[0];
  const n: RunNotification = {
    event: 'run.completed', title: 'Test notification from IntelliQE', status: 'passed',
    stats: { total: 3, passed: 3, failed: 0, notRun: 0, passRate: 100 }, failures: [], source: 'manual', at: new Date().toISOString(),
  };
  const result = await postOne({ id: String(row.id), url: row.url, kind: normalizeKind(row.kind), secret: row.secret }, n);
  try { await pool.query(`UPDATE api_webhooks SET last_status = $1, last_sent_at = SYSUTCDATETIME() WHERE id = $2`, [result, String(row.id)]); } catch { /* best effort */ }
  if (result !== 'ok') throw new Error('The webhook did not accept the test request (non-2xx or unreachable).');
  return { ok: true };
}
