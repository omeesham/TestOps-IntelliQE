/**
 * api-defect-sync.service.ts — provider-agnostic defect automation core (Modules 4 & 5).
 *
 * Turns API-test failures into tracker defects. A stable per-failure *signature*
 * links a failure to the issue it raised, so a recurring failure UPDATES the
 * existing issue (a comment) instead of filing a duplicate. Every sync is
 * recorded in jira_sync_history; each link in jira_defect_links. Both tables
 * carry a `provider` column, so Jira and Azure DevOps share them — one engine,
 * two thin adapters (see api-jira-sync / api-azure-sync).
 *
 * A `dryRun` computes signatures and dedupe decisions WITHOUT any tracker write,
 * so the logic is verifiable without an external side effect and a user can
 * preview before committing.
 */
import { createHash } from 'crypto';
import pool from '../db.js';

export interface RunFailure {
  title: string;
  error?: string;
  method?: string;
  url?: string;
  testId?: string;
}

export interface SyncDefectInput {
  failures: RunFailure[];
  runId?: string;
  runTitle?: string;
  dryRun?: boolean;
}

export type SyncAction = 'created' | 'updated' | 'would-create' | 'would-update' | 'skipped';

export interface SyncDefectResult {
  signature: string;
  title: string;
  action: SyncAction;
  issueKey?: string;
  issueUrl?: string;
  occurrence?: number;
  error?: string;
}

export interface SyncDefectResponse {
  provider: string;
  dryRun: boolean;
  connected: boolean;
  summary: { total: number; created: number; updated: number; skipped: number };
  results: SyncDefectResult[];
}

/** A provider-neutral defect to file. The adapter maps it to its own bug input. */
export interface DefectDraft {
  title: string;
  description: string;
  actualResult?: string;
  environment?: string;
  tags: string[];
}

/** Everything the core needs from a specific tracker (Jira / Azure). */
export interface DefectAdapter<C> {
  provider: string;
  getCreds(tenantId: string): Promise<C | null>;
  createDefect(creds: C, draft: DefectDraft): Promise<{ key: string; url: string }>;
  addComment(creds: C, issueKey: string, text: string): Promise<void>;
}

/** Normalise a URL so the same endpoint hashes the same across runs: drop the
 *  query string and collapse volatile path segments (ids, uuids) to {id}. */
function normalizeUrl(url?: string): string {
  if (!url) return '';
  let s = url.split('?')[0]!.trim().toLowerCase();
  s = s.replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/g, '/{id}'); // uuids
  s = s.replace(/\/\d+(?=\/|$)/g, '/{id}');                 // numeric ids
  return s;
}

/** Normalise a title: lowercase and strip volatile numbers so wording stays stable. */
function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim();
}

/** A short, stable signature for a failure — the dedupe key. */
export function failureSignature(f: RunFailure): string {
  const base = `${(f.method || '').toUpperCase()} ${normalizeUrl(f.url)} :: ${normalizeTitle(f.title)}`;
  return 'iqe-' + createHash('sha1').update(base).digest('hex').slice(0, 16);
}

interface LinkRow { id: string; issue_key: string | null; issue_url: string | null; occurrence_count: number; status: string }

async function findOpenLink(tenantId: string, provider: string, signature: string): Promise<LinkRow | null> {
  const { rows } = await pool.query(
    `SELECT TOP 1 id, issue_key, issue_url, occurrence_count, status
     FROM jira_defect_links
     WHERE tenant_id = $1 AND provider = $2 AND signature = $3 AND status <> 'closed'
     ORDER BY last_seen_at DESC`,
    [tenantId, provider, signature],
  );
  return rows.length ? (rows[0] as LinkRow) : null;
}

function bugTitle(f: RunFailure): string {
  const ep = [f.method, f.url].filter(Boolean).join(' ').trim();
  const base = f.title || (ep ? `${ep} failed` : 'API test failure');
  return base.slice(0, 200);
}

function bugDescription(f: RunFailure, runTitle?: string): string {
  const lines: string[] = [];
  if (f.method || f.url) lines.push(`Endpoint: ${[f.method, f.url].filter(Boolean).join(' ')}`);
  if (runTitle) lines.push(`Run: ${runTitle}`);
  lines.push('', f.error || 'An API test failed.');
  return lines.join('\n');
}

/**
 * Sync a run's failures to tracker defects via `adapter`. Dedupe is by signature
 * against this tenant+provider's existing links: a known signature updates
 * (comment) the linked issue; a new one creates a defect. Within one batch,
 * repeated signatures collapse. `dryRun` performs no tracker writes.
 */
export async function syncDefects<C>(
  tenantId: string, username: string, input: SyncDefectInput, adapter: DefectAdapter<C>,
): Promise<SyncDefectResponse> {
  const provider = adapter.provider;
  const failures = Array.isArray(input.failures) ? input.failures.slice(0, 200) : [];
  const dryRun = input.dryRun === true; // real sync unless explicitly a dry run
  const results: SyncDefectResult[] = [];

  let creds: C | null = null;
  try { creds = await adapter.getCreds(tenantId); } catch { creds = null; }
  const connected = !!creds;
  if (!dryRun && !connected) {
    throw new Error(`${provider === 'azure' ? 'Azure DevOps' : 'Jira'} is not connected. Connect it in System Configuration, or use a dry run to preview.`);
  }

  const seenInBatch = new Map<string, SyncDefectResult>();
  let created = 0, updated = 0, skipped = 0;

  for (const f of failures) {
    if (!f || !String(f.title || '').trim()) { skipped++; results.push({ signature: '', title: String(f?.title || ''), action: 'skipped', error: 'Empty failure.' }); continue; }
    const signature = failureSignature(f);

    const dup = seenInBatch.get(signature);
    if (dup) { skipped++; results.push({ signature, title: bugTitle(f), action: 'skipped', issueKey: dup.issueKey, error: 'Duplicate of another failure in this batch.' }); continue; }

    const existing = await findOpenLink(tenantId, provider, signature);

    try {
      if (existing && existing.issue_key) {
        const occurrence = (existing.occurrence_count || 1) + 1;
        if (dryRun) {
          const r: SyncDefectResult = { signature, title: bugTitle(f), action: 'would-update', issueKey: existing.issue_key, issueUrl: existing.issue_url || undefined, occurrence };
          seenInBatch.set(signature, r); results.push(r); updated++; continue;
        }
        if (creds) await adapter.addComment(creds, existing.issue_key, `Recurred${input.runTitle ? ` in run "${input.runTitle}"` : ''}: ${f.error || f.title}`);
        await pool.query(
          `UPDATE jira_defect_links SET occurrence_count = $1, last_seen_at = SYSUTCDATETIME(), run_id = $2 WHERE id = $3`,
          [occurrence, input.runId || null, existing.id],
        );
        const r: SyncDefectResult = { signature, title: bugTitle(f), action: 'updated', issueKey: existing.issue_key, issueUrl: existing.issue_url || undefined, occurrence };
        seenInBatch.set(signature, r); results.push(r); updated++;
      } else {
        if (dryRun) {
          const r: SyncDefectResult = { signature, title: bugTitle(f), action: 'would-create', occurrence: 1 };
          seenInBatch.set(signature, r); results.push(r); created++; continue;
        }
        const draft: DefectDraft = {
          title: bugTitle(f), description: bugDescription(f, input.runTitle),
          actualResult: f.error, environment: f.url, tags: [signature],
        };
        const issue = await adapter.createDefect(creds!, draft);
        await pool.query(
          `INSERT INTO jira_defect_links
             (tenant_id, provider, signature, issue_key, issue_url, title, method, url, run_id, status, occurrence_count, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', 1, $10)`,
          [tenantId, provider, signature, issue.key, issue.url, bugTitle(f), f.method || null, f.url || null, input.runId || null, username],
        );
        const r: SyncDefectResult = { signature, title: bugTitle(f), action: 'created', issueKey: issue.key, issueUrl: issue.url, occurrence: 1 };
        seenInBatch.set(signature, r); results.push(r); created++;
      }
    } catch (err: any) {
      skipped++;
      results.push({ signature, title: bugTitle(f), action: 'skipped', error: err?.response?.data?.errorMessages?.join('; ') || err?.message || 'Sync failed for this failure.' });
    }
  }

  try {
    await pool.query(
      `INSERT INTO jira_sync_history (tenant_id, provider, run_id, run_title, created_count, updated_count, skipped_count, dry_run, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, provider, input.runId || null, input.runTitle || null, created, updated, skipped, dryRun ? 1 : 0, username],
    );
  } catch { /* history is best-effort */ }

  return { provider, dryRun, connected, summary: { total: failures.length, created, updated, skipped }, results };
}

export interface SyncHistoryRow {
  id: string; runId?: string; runTitle?: string;
  createdCount: number; updatedCount: number; skippedCount: number;
  dryRun: boolean; createdBy?: string; createdAt: string;
}

export async function listSyncHistory(tenantId: string, provider: string, limit = 50): Promise<SyncHistoryRow[]> {
  const { rows } = await pool.query(
    `SELECT TOP (${Math.min(200, Math.max(1, limit))}) id, run_id, run_title, created_count, updated_count, skipped_count, dry_run, created_by, created_at
     FROM jira_sync_history WHERE tenant_id = $1 AND provider = $2 ORDER BY created_at DESC`,
    [tenantId, provider],
  );
  return rows.map((r: any) => ({
    id: r.id, runId: r.run_id || undefined, runTitle: r.run_title || undefined,
    createdCount: Number(r.created_count || 0), updatedCount: Number(r.updated_count || 0), skippedCount: Number(r.skipped_count || 0),
    dryRun: r.dry_run === true || r.dry_run === 1, createdBy: r.created_by || undefined, createdAt: String(r.created_at),
  }));
}

export interface DefectLinkRow {
  id: string; signature: string; issueKey?: string; issueUrl?: string; title?: string;
  method?: string; url?: string; runId?: string; status: string; occurrenceCount: number; createdAt: string; lastSeenAt: string;
}

export async function listDefectLinks(tenantId: string, provider: string, runId?: string, limit = 100): Promise<DefectLinkRow[]> {
  const params: any[] = [tenantId, provider];
  let where = `tenant_id = $1 AND provider = $2`;
  if (runId) { params.push(runId); where += ` AND run_id = $3`; }
  const { rows } = await pool.query(
    `SELECT TOP (${Math.min(200, Math.max(1, limit))}) id, signature, issue_key, issue_url, title, method, url, run_id, status, occurrence_count, created_at, last_seen_at
     FROM jira_defect_links WHERE ${where} ORDER BY last_seen_at DESC`,
    params,
  );
  return rows.map((r: any) => ({
    id: r.id, signature: r.signature, issueKey: r.issue_key || undefined, issueUrl: r.issue_url || undefined, title: r.title || undefined,
    method: r.method || undefined, url: r.url || undefined, runId: r.run_id || undefined, status: r.status,
    occurrenceCount: Number(r.occurrence_count || 1), createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at),
  }));
}
