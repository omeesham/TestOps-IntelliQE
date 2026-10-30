/**
 * api-integration-dashboard.service.ts — unified integration dashboard (Module 7).
 *
 * One read-only aggregate across the whole program: requirement counts (BRD /
 * FRD / manual), requirement coverage + orphans (from the integrated
 * traceability matrix), defect-automation stats (Jira + Azure defect links and
 * sync history), run success rates and imports-by-method. Composes the existing
 * getApiOverview and buildIntegratedMatrix rather than re-deriving them, so it
 * stays consistent with the rest of the module and adds no new tables.
 */
import pool from '../db.js';
import { getApiOverview } from './api-dashboard.service.js';
import { buildIntegratedMatrix, type IntegratedRow } from './api-traceability.service.js';

export interface IntegrationDashboard {
  runId: string | null;
  runTitle: string | null;
  kpis: {
    runs: number;
    avgPassRate: number | null;
    lastPassRate: number | null;
    requirements: number;
    coveragePct: number;
    trackerDefects: number;
    openDefects: number;
    orphanTests: number;
  };
  requirements: { brdDocs: number; brdReqs: number; frdDocs: number; frdReqs: number; manual: number; total: number };
  coverage: { covered: number; partial: number; failing: number; uncovered: number; linkable: number; coveragePct: number };
  defects: {
    links: number; open: number;
    byProvider: { jira: number; azure: number };
    syncRuns: number; created: number; updated: number; lastSyncAt: string | null;
  };
  imports: { total: number; byMethod: Record<string, number> };
  rows: IntegratedRow[];
  orphanTests: number;
  orphanDefects: number;
}

async function count(sql: string, params: any[]): Promise<number> {
  try { const { rows } = await pool.query(sql, params); return Number(rows[0]?.n || 0); }
  catch { return 0; }
}

export async function getIntegrationDashboard(tenantId: string, opts: { runId?: string } = {}): Promise<IntegrationDashboard> {
  // Compose the existing overview + integrated matrix (single source of truth).
  const [overview, matrix] = await Promise.all([
    getApiOverview(tenantId).catch(() => null),
    buildIntegratedMatrix(tenantId, { runId: opts.runId }),
  ]);

  // Requirement document / item counts.
  const [brdDocs, brdReqs, frdDocs, frdReqs, manual] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM brd_documents WHERE tenant_id = $1`, [tenantId]),
    count(`SELECT COUNT(*) AS n FROM business_requirements WHERE tenant_id = $1`, [tenantId]),
    count(`SELECT COUNT(*) AS n FROM frd_documents WHERE tenant_id = $1`, [tenantId]),
    count(`SELECT COUNT(*) AS n FROM functional_requirements WHERE tenant_id = $1`, [tenantId]),
    count(`SELECT COUNT(*) AS n FROM api_requirements WHERE tenant_id = $1`, [tenantId]),
  ]);

  // Defect links by provider + open; sync history totals.
  const linksByProvider = await pool.query(
    `SELECT provider, COUNT(*) AS n, SUM(CASE WHEN status <> 'closed' THEN 1 ELSE 0 END) AS open_n
     FROM jira_defect_links WHERE tenant_id = $1 GROUP BY provider`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  let jira = 0, azure = 0, open = 0, links = 0;
  for (const r of linksByProvider.rows) {
    const n = Number(r.n || 0); const openN = Number(r.open_n || 0);
    links += n; open += openN;
    if (r.provider === 'azure') azure += n; else jira += n;
  }
  // Count only REAL syncs — dry-run previews record would-create/update counts
  // but write nothing to the tracker, so they must not inflate created/updated.
  const syncAgg = await pool.query(
    `SELECT COUNT(*) AS runs, SUM(created_count) AS created, SUM(updated_count) AS updated, MAX(created_at) AS last_at
     FROM jira_sync_history WHERE tenant_id = $1 AND dry_run = 0`,
    [tenantId],
  ).catch(() => ({ rows: [{ runs: 0, created: 0, updated: 0, last_at: null }] }));
  const sa = syncAgg.rows[0] || {};

  const requirements = { brdDocs, brdReqs, frdDocs, frdReqs, manual, total: brdReqs + frdReqs + manual };
  const m = matrix.summary;

  return {
    runId: matrix.runId,
    runTitle: matrix.runTitle,
    kpis: {
      runs: overview?.kpis.runs ?? 0,
      avgPassRate: overview?.kpis.avgPassRate ?? null,
      lastPassRate: overview?.kpis.lastPassRate ?? null,
      requirements: requirements.total,
      coveragePct: m.coveragePct,
      trackerDefects: m.trackerDefects,
      openDefects: open,
      orphanTests: m.orphanTests,
    },
    requirements,
    coverage: { covered: m.covered, partial: m.partial, failing: m.failing, uncovered: m.uncovered, linkable: m.linkable, coveragePct: m.coveragePct },
    defects: {
      links, open, byProvider: { jira, azure },
      syncRuns: Number(sa.runs || 0), created: Number(sa.created || 0), updated: Number(sa.updated || 0),
      lastSyncAt: sa.last_at ? String(sa.last_at) : null,
    },
    imports: { total: overview?.imports.total ?? 0, byMethod: overview?.imports.byMethod ?? {} },
    rows: matrix.rows.slice(0, 500),
    orphanTests: m.orphanTests,
    orphanDefects: m.orphanDefects,
  };
}
