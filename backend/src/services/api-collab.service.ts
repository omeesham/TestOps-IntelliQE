/**
 * api-collab.service.ts
 * ─────────────────────
 * Test-level collaboration + versioning. Threaded comments on a specific test
 * (keyed by a stable "METHOD url" test key) and point-in-time version snapshots
 * with a simple field-level diff. Postman-2026 shared-workspace parity for the
 * API studio.
 *
 * Standalone and opt-in: comments + versions live in their own tables, scoped by
 * tenant, and are never read by the generate → execute → heal pipeline.
 */
import pool from '../db.js';

export interface TestComment { id: string; testKey: string; author: string; body: string; createdAt: string }
export interface TestVersion { id: string; testKey: string; versionNo: number; label: string; snapshot: any; author: string; createdAt: string }

/** Stable key for a test/endpoint — method + url, upper-cased method. */
export function testKeyOf(method: string, url: string): string {
  return `${String(method || 'GET').toUpperCase()} ${String(url || '').trim()}`.slice(0, 500);
}

function mapComment(r: any): TestComment {
  return { id: String(r.id), testKey: r.test_key, author: r.author || '', body: r.body || '', createdAt: r.created_at };
}
function mapVersion(r: any): TestVersion {
  let snapshot: any = {};
  try { snapshot = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : (r.snapshot || {}); } catch { /* ignore */ }
  return { id: String(r.id), testKey: r.test_key, versionNo: Number(r.version_no) || 0, label: r.label || '', snapshot, author: r.author || '', createdAt: r.created_at };
}

/* ── Comments ── */

export async function listComments(tenantId: string, testKey: string): Promise<TestComment[]> {
  const { rows } = await pool.query(
    `SELECT * FROM api_test_comments WHERE tenant_id = $1 AND test_key = $2 ORDER BY created_at ASC`,
    [tenantId, testKey],
  );
  return rows.map(mapComment);
}

export async function addComment(tenantId: string, author: string, testKey: unknown, body: unknown): Promise<TestComment> {
  const key = String(testKey || '').trim().slice(0, 500);
  const text = String(body || '').trim().slice(0, 4000);
  if (!key) throw new Error('A comment needs a test key.');
  if (!text) throw new Error('A comment cannot be empty.');
  const { rows } = await pool.query(
    `INSERT INTO api_test_comments (tenant_id, test_key, author, body) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`,
    [tenantId, key, author || '', text],
  );
  return mapComment(rows[0]);
}

export async function deleteComment(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_comments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Comment counts across many test keys at once (for badges). */
export async function commentCounts(tenantId: string, testKeys: string[]): Promise<Record<string, number>> {
  const keys = [...new Set(testKeys.map((k) => String(k).slice(0, 500)))].slice(0, 500);
  if (!keys.length) return {};
  const { rows } = await pool.query(
    `SELECT test_key, COUNT(*) AS n FROM api_test_comments WHERE tenant_id = $1 GROUP BY test_key`,
    [tenantId],
  );
  const wanted = new Set(keys);
  const out: Record<string, number> = {};
  for (const r of rows) if (wanted.has(r.test_key)) out[r.test_key] = Number(r.n) || 0;
  return out;
}

/* ── Versions ── */

export async function listVersions(tenantId: string, testKey: string): Promise<TestVersion[]> {
  const { rows } = await pool.query(
    `SELECT * FROM api_test_versions WHERE tenant_id = $1 AND test_key = $2 ORDER BY version_no DESC`,
    [tenantId, testKey],
  );
  return rows.map(mapVersion);
}

export async function saveVersion(tenantId: string, author: string, input: { testKey: unknown; label?: unknown; snapshot: unknown }): Promise<TestVersion> {
  const key = String(input.testKey || '').trim().slice(0, 500);
  if (!key) throw new Error('A version needs a test key.');
  const label = String(input.label || '').trim().slice(0, 200);
  const snapshot = JSON.stringify(input.snapshot ?? {});
  const { rows: maxRows } = await pool.query(
    `SELECT MAX(version_no) AS mx FROM api_test_versions WHERE tenant_id = $1 AND test_key = $2`,
    [tenantId, key],
  );
  const next = (Number(maxRows[0]?.mx) || 0) + 1;
  const { rows } = await pool.query(
    `INSERT INTO api_test_versions (tenant_id, test_key, version_no, label, snapshot, author)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, key, next, label || `v${next}`, snapshot, author || ''],
  );
  return mapVersion(rows[0]);
}

export async function deleteVersion(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface FieldDiff { field: string; change: 'added' | 'removed' | 'changed'; before?: string; after?: string }

/** Shallow field-level diff between two version snapshots (objects). */
export function diffSnapshots(before: any, after: any): FieldDiff[] {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const out: FieldDiff[] = [];
  for (const k of keys) {
    const inA = k in a; const inB = k in b;
    if (inA && !inB) out.push({ field: k, change: 'removed', before: str(a[k]).slice(0, 400) });
    else if (!inA && inB) out.push({ field: k, change: 'added', after: str(b[k]).slice(0, 400) });
    else if (str(a[k]) !== str(b[k])) out.push({ field: k, change: 'changed', before: str(a[k]).slice(0, 400), after: str(b[k]).slice(0, 400) });
  }
  return out;
}

export async function getVersionDiff(tenantId: string, fromId: string, toId: string): Promise<{ from: TestVersion; to: TestVersion; diff: FieldDiff[] }> {
  const { rows } = await pool.query(
    `SELECT * FROM api_test_versions WHERE tenant_id = $1 AND id IN ($2, $3)`,
    [tenantId, fromId, toId],
  );
  const from = rows.find((r: any) => String(r.id) === fromId);
  const to = rows.find((r: any) => String(r.id) === toId);
  if (!from || !to) throw new Error('One or both versions were not found.');
  const f = mapVersion(from); const t = mapVersion(to);
  return { from: f, to: t, diff: diffSnapshots(f.snapshot, t.snapshot) };
}
