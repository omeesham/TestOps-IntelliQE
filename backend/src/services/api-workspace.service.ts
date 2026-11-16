/**
 * api-workspace.service.ts
 * ────────────────────────
 * Server-side persistence for the API Studio working set — the catalogue a
 * reviewer imports, which endpoints are selected, the derived profile, the
 * strategy, the import log and the generated scenarios. Previously this lived
 * only in the browser's sessionStorage and was thrown away on logout
 * (IQE-037.1 #6 / IQE-043.2 #2). Stored one row per (tenant, owner) in
 * api_catalog_workspace so the work survives logout and device changes.
 *
 * Writes are partial: useCatalog saves the catalogue fields, useApiRun saves
 * scenarios — each PUT merges into the existing row (read-modify-write), so one
 * caller never clobbers another caller's column.
 */
import { pool } from '../db.js';

export interface WorkspaceState {
  endpoints: unknown[];
  selected: string[];
  profile: unknown | null;
  strategy: unknown | null;
  imports: unknown[];
  scenarios: unknown[];
  updatedAt?: string;
}

export type WorkspacePatch = Partial<Omit<WorkspaceState, 'updatedAt'>>;

/** Hard ceiling on a serialized column so a runaway catalogue can't bloat the row. */
const MAX_COL = 8 * 1024 * 1024; // 8 MB of JSON per column

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

function clampJson(value: unknown, fallback: string): string {
  try {
    const s = JSON.stringify(value ?? JSON.parse(fallback));
    return s.length > MAX_COL ? fallback : s;
  } catch { return fallback; }
}

/** Load a user's workspace, or null when they have none saved yet. */
export async function getWorkspace(tenantId: string, owner: string): Promise<WorkspaceState | null> {
  const { rows } = await pool.query(
    `SELECT endpoints, selected, profile, strategy, imports, scenarios, updated_at
       FROM api_catalog_workspace WHERE tenant_id = $1 AND owner = $2`,
    [tenantId, owner],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    endpoints: parseJson<unknown[]>(r.endpoints, []),
    selected: parseJson<string[]>(r.selected, []),
    profile: parseJson<unknown | null>(r.profile, null),
    strategy: parseJson<unknown | null>(r.strategy, null),
    imports: parseJson<unknown[]>(r.imports, []),
    scenarios: parseJson<unknown[]>(r.scenarios, []),
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

/** Merge a partial update into the user's workspace row (creating it if needed). */
export async function saveWorkspace(tenantId: string, owner: string, patch: WorkspacePatch): Promise<WorkspaceState> {
  const current = (await getWorkspace(tenantId, owner)) || {
    endpoints: [], selected: [], profile: null, strategy: null, imports: [], scenarios: [],
  };
  const next: WorkspaceState = {
    endpoints: patch.endpoints ?? current.endpoints,
    selected: patch.selected ?? current.selected,
    profile: patch.profile !== undefined ? patch.profile : current.profile,
    strategy: patch.strategy !== undefined ? patch.strategy : current.strategy,
    imports: patch.imports ?? current.imports,
    scenarios: patch.scenarios ?? current.scenarios,
  };
  await pool.query(
    `MERGE INTO api_catalog_workspace WITH (HOLDLOCK) AS t
       USING (SELECT $1 AS tenant_id, $2 AS owner) AS s
         ON t.tenant_id = s.tenant_id AND t.owner = s.owner
       WHEN MATCHED THEN UPDATE SET
         endpoints = $3, selected = $4, profile = $5, strategy = $6,
         imports = $7, scenarios = $8, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (tenant_id, owner, endpoints, selected, profile, strategy, imports, scenarios)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
    [
      tenantId, owner,
      clampJson(next.endpoints, '[]'),
      clampJson(next.selected, '[]'),
      next.profile == null ? null : clampJson(next.profile, 'null'),
      next.strategy == null ? null : clampJson(next.strategy, 'null'),
      clampJson(next.imports, '[]'),
      clampJson(next.scenarios, '[]'),
    ],
  );
  return (await getWorkspace(tenantId, owner))!;
}

/** Clear a user's workspace row (used when they reset the whole workspace). */
export async function clearWorkspace(tenantId: string, owner: string): Promise<void> {
  await pool.query(
    `DELETE FROM api_catalog_workspace WHERE tenant_id = $1 AND owner = $2`,
    [tenantId, owner],
  );
}
