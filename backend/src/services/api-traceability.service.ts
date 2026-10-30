/**
 * api-traceability.service.ts
 * ───────────────────────────
 * Requirements traceability matrix for the API module: requirement → case →
 * defect. Requirements become first-class records (their own table); each links
 * to catalogue endpoints and/or scenario titles, plus any external defect refs
 * (e.g. a Jira key). The matrix joins those links to the outcomes of a chosen
 * run (or the latest run) so each requirement shows its coverage, pass/fail,
 * and the failing cases that are its defects.
 *
 * Fully additive and read-mostly — it reads the existing run reports via the
 * dashboard service and never touches the pipeline.
 */
import pool from '../db.js';
import { getApiRunDetail, listApiRuns } from './api-dashboard.service.js';

export interface LinkedEndpoint { method: string; url: string }
export interface DefectRef { key: string; url?: string; status?: string }
export interface Requirement {
  id: string; reqKey: string; title: string; description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  linkedEndpoints: LinkedEndpoint[];
  linkedScenarios: string[];
  defects: DefectRef[];
  createdBy: string; createdAt: string; updatedAt: string;
}

const PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

// linked_endpoints/linked_scenarios/defects aren't on the db.ts JSON_COLUMNS
// allowlist, so they arrive as raw JSON strings — coerce here.
function jArr(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch { /* leave empty */ } }
  return [];
}

function toReq(r: any): Requirement {
  return {
    id: String(r.id), reqKey: r.req_key || '', title: r.title || '', description: r.description || '',
    priority: (PRIORITIES.has(r.priority) ? r.priority : 'medium') as Requirement['priority'],
    source: r.source || '',
    linkedEndpoints: jArr(r.linked_endpoints),
    linkedScenarios: jArr(r.linked_scenarios).map(String),
    defects: jArr(r.defects),
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listRequirements(tenantId: string): Promise<Requirement[]> {
  const { rows } = await pool.query(`SELECT * FROM api_requirements WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toReq);
}

export async function saveRequirement(tenantId: string, username: string, input: any): Promise<Requirement> {
  const title = String(input?.title || '').trim().slice(0, 300);
  if (!title) throw new Error('A requirement needs a title.');
  const reqKey = String(input?.reqKey || '').trim().slice(0, 60);
  const description = String(input?.description || '').slice(0, 8000);
  const priority = PRIORITIES.has(input?.priority) ? input.priority : 'medium';
  const source = String(input?.source || '').slice(0, 100);
  const linkedEndpoints: LinkedEndpoint[] = Array.isArray(input?.linkedEndpoints)
    ? input.linkedEndpoints.slice(0, 200).map((e: any) => ({ method: String(e?.method || 'GET').toUpperCase().slice(0, 10), url: String(e?.url || '').slice(0, 2000) })).filter((e: LinkedEndpoint) => e.url)
    : [];
  const linkedScenarios: string[] = Array.isArray(input?.linkedScenarios)
    ? input.linkedScenarios.map((s: unknown) => String(s).slice(0, 300)).filter(Boolean).slice(0, 200)
    : [];
  const defects: DefectRef[] = Array.isArray(input?.defects)
    ? input.defects.slice(0, 100).map((d: any) => ({ key: String(d?.key || '').slice(0, 120), url: d?.url ? String(d.url).slice(0, 2000) : undefined, status: d?.status ? String(d.status).slice(0, 40) : undefined })).filter((d: DefectRef) => d.key)
    : [];

  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_requirements SET req_key = $3, title = $4, description = $5, priority = $6, source = $7,
              linked_endpoints = $8, linked_scenarios = $9, defects = $10, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, reqKey, title, description, priority, source, linkedEndpoints, linkedScenarios, defects],
    );
    if (!rows.length) throw new Error('Requirement not found.');
    return toReq(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_requirements (tenant_id, req_key, title, description, priority, source, linked_endpoints, linked_scenarios, defects, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, reqKey, title, description, priority, source, linkedEndpoints, linkedScenarios, defects, username],
  );
  return toReq(rows[0]);
}

export async function deleteRequirement(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_requirements WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── the matrix ──────────────────────────────────────────────────────────────

export type TraceStatus = 'covered' | 'partial' | 'failing' | 'uncovered';
export interface MatrixCase { id: string; title: string; status: string }
export interface MatrixRow {
  requirement: { id: string; reqKey: string; title: string; priority: string };
  cases: MatrixCase[];
  passed: number; failed: number; notRun: number;
  status: TraceStatus;
  defects: DefectRef[];
}
export interface TraceMatrix {
  runId: string | null; runTitle: string | null;
  rows: MatrixRow[];
  summary: { total: number; covered: number; partial: number; failing: number; uncovered: number; coveragePct: number };
}

function pathOf(u: string): string {
  const s = String(u || '');
  try { return new URL(s).pathname; } catch { return s.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] || s; }
}
function norm(s: string): string { return String(s || '').trim().toLowerCase(); }

export async function buildMatrix(tenantId: string, opts: { runId?: string } = {}): Promise<TraceMatrix> {
  const requirements = await listRequirements(tenantId);

  // reference run: given one, else the latest
  let runId = opts.runId || null;
  if (!runId) {
    const recent = await listApiRuns(tenantId, 1, 1);
    runId = recent.items[0]?.runId || null;
  }
  const detail = runId ? await getApiRunDetail(tenantId, runId) : null;
  const runCases = detail?.cases || [];

  // index run cases by endpoint signature and by title
  const byEndpoint = new Map<string, typeof runCases>();
  const byTitle = new Map<string, typeof runCases[number]>();
  for (const c of runCases) {
    const ep = c.api && typeof c.api === 'object' ? c.api : null;
    if (ep?.endpoint) {
      const sig = `${norm(ep.method || 'GET')} ${norm(pathOf(ep.endpoint))}`;
      const arr = byEndpoint.get(sig) || [];
      arr.push(c); byEndpoint.set(sig, arr);
    }
    byTitle.set(norm(c.title), c);
  }

  const rows: MatrixRow[] = requirements.map((req) => {
    const matched = new Map<string, MatrixCase>();
    for (const le of req.linkedEndpoints) {
      const sig = `${norm(le.method || 'GET')} ${norm(pathOf(le.url))}`;
      for (const c of byEndpoint.get(sig) || []) matched.set(c.id, { id: c.id, title: c.title, status: c.status });
    }
    for (const sc of req.linkedScenarios) {
      const c = byTitle.get(norm(sc));
      if (c) matched.set(c.id, { id: c.id, title: c.title, status: c.status });
    }
    const cases = [...matched.values()];
    const passed = cases.filter((c) => c.status === 'passed').length;
    const failed = cases.filter((c) => c.status === 'failed' || c.status === 'broken').length;
    const notRun = cases.filter((c) => c.status !== 'passed' && c.status !== 'failed' && c.status !== 'broken').length;

    let status: TraceStatus;
    if (!req.linkedEndpoints.length && !req.linkedScenarios.length) status = 'uncovered';
    else if (!cases.length) status = 'uncovered';
    else if (failed > 0) status = 'failing';
    else if (passed === cases.length) status = 'covered';
    else status = 'partial';

    // defects = failing matched cases + any manual defect refs
    const defects: DefectRef[] = [
      ...req.defects,
      ...cases.filter((c) => c.status === 'failed' || c.status === 'broken').map((c) => ({ key: c.id, status: c.status })),
    ];

    return {
      requirement: { id: req.id, reqKey: req.reqKey, title: req.title, priority: req.priority },
      cases, passed, failed, notRun, status, defects,
    };
  });

  const covered = rows.filter((r) => r.status === 'covered').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const failing = rows.filter((r) => r.status === 'failing').length;
  const uncovered = rows.filter((r) => r.status === 'uncovered').length;
  const total = rows.length;
  return {
    runId, runTitle: detail?.title || null, rows,
    summary: { total, covered, partial, failing, uncovered, coveragePct: total ? Math.round(((covered + partial + failing) / total) * 100) : 0 },
  };
}

// ─── integrated matrix (Module 6) ─────────────────────────────────────────────
// The full chain: a requirement from ANY source (manual api_requirements, FRD
// functional requirements with their endpoints, BRD business requirements) →
// its endpoints → a run's cases (execution) → defects (real tracker defects from
// the Module 4/5 defect links, matched by endpoint signature, plus failing
// cases). Adds orphan detection: tested endpoints with no requirement, and
// tracker defects with no requirement. Read-only; reuses the existing builders.

export type TraceSource = 'manual' | 'frd' | 'brd';

export interface IntegratedRow {
  source: TraceSource;
  reqKey: string;
  title: string;
  endpoints: LinkedEndpoint[];
  cases: MatrixCase[];
  passed: number; failed: number; notRun: number;
  status: TraceStatus;
  trackerDefects: DefectRef[];
  caseDefects: { key: string; status: string }[];
}

export interface OrphanTest { id: string; title: string; status: string; endpoint?: string }

export interface IntegratedMatrix {
  runId: string | null; runTitle: string | null;
  rows: IntegratedRow[];
  orphanTests: OrphanTest[];
  orphanDefects: DefectRef[];
  summary: {
    total: number; linkable: number;
    covered: number; partial: number; failing: number; uncovered: number;
    coveragePct: number;
    bySource: { manual: number; frd: number; brd: number };
    trackerDefects: number; orphanTests: number; orphanDefects: number;
  };
}

interface ReqNode { source: TraceSource; reqKey: string; title: string; endpoints: LinkedEndpoint[]; scenarios: string[] }

function sigOf(method: string, url: string): string { return `${norm(method || 'GET')} ${norm(pathOf(url))}`; }

/** Gather requirement nodes from every source (manual + FRD + BRD). */
async function gatherReqNodes(tenantId: string): Promise<ReqNode[]> {
  const nodes: ReqNode[] = [];

  const manual = await listRequirements(tenantId);
  for (const r of manual) {
    nodes.push({ source: 'manual', reqKey: r.reqKey, title: r.title, endpoints: r.linkedEndpoints, scenarios: r.linkedScenarios });
  }

  // FRD functional requirements carry the endpoints they imply.
  const frd = await pool.query(
    `SELECT fr_id, title, endpoints FROM functional_requirements WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  for (const r of frd.rows) {
    const eps = jArr(r.endpoints)
      .map((e: any) => ({ method: String(e?.method || 'GET').toUpperCase(), url: String(e?.path || e?.url || '') }))
      .filter((e: LinkedEndpoint) => e.url);
    nodes.push({ source: 'frd', reqKey: r.fr_id || '', title: r.title || '', endpoints: eps, scenarios: [] });
  }

  // BRD business requirements sit at the top of the chain (no endpoints of their own).
  const brd = await pool.query(
    `SELECT br_id, title FROM business_requirements WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  for (const r of brd.rows) {
    nodes.push({ source: 'brd', reqKey: r.br_id || '', title: r.title || '', endpoints: [], scenarios: [] });
  }

  return nodes;
}

export async function buildIntegratedMatrix(tenantId: string, opts: { runId?: string } = {}): Promise<IntegratedMatrix> {
  const nodes = await gatherReqNodes(tenantId);

  // reference run
  let runId = opts.runId || null;
  if (!runId) {
    const recent = await listApiRuns(tenantId, 1, 1);
    runId = recent.items[0]?.runId || null;
  }
  const detail = runId ? await getApiRunDetail(tenantId, runId) : null;
  const runCases = detail?.cases || [];

  // index run cases by endpoint signature and title
  const byEndpoint = new Map<string, typeof runCases>();
  const byTitle = new Map<string, typeof runCases[number]>();
  const caseSig = new Map<string, string>(); // caseId → endpoint sig (for orphan endpoint label)
  for (const c of runCases) {
    const ep = c.api && typeof c.api === 'object' ? c.api : null;
    if (ep?.endpoint) {
      const sig = sigOf(ep.method || 'GET', ep.endpoint);
      const arr = byEndpoint.get(sig) || []; arr.push(c); byEndpoint.set(sig, arr);
      caseSig.set(c.id, `${String(ep.method || 'GET').toUpperCase()} ${pathOf(ep.endpoint)}`);
    }
    byTitle.set(norm(c.title), c);
  }

  // tracker defects (Jira + Azure) indexed by endpoint signature
  const defectLinks = await pool.query(
    `SELECT provider, signature, issue_key, issue_url, title, method, url, status FROM jira_defect_links WHERE tenant_id = $1`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  const defectsBySig = new Map<string, DefectRef[]>();
  for (const d of defectLinks.rows) {
    if (!d.url && !d.method) continue;
    const sig = sigOf(d.method || 'GET', d.url || '');
    const ref: DefectRef = { key: d.issue_key || d.signature, url: d.issue_url || undefined, status: d.status || undefined };
    const arr = defectsBySig.get(sig) || []; arr.push(ref); defectsBySig.set(sig, arr);
  }

  const matchedCaseIds = new Set<string>();
  const matchedDefectSigs = new Set<string>();

  const rows: IntegratedRow[] = nodes.map((node) => {
    const sigs = node.endpoints.map((e) => sigOf(e.method, e.url));
    const matched = new Map<string, MatrixCase>();
    for (const sig of sigs) {
      for (const c of byEndpoint.get(sig) || []) { matched.set(c.id, { id: c.id, title: c.title, status: c.status }); matchedCaseIds.add(c.id); }
    }
    for (const sc of node.scenarios) {
      const c = byTitle.get(norm(sc));
      if (c) { matched.set(c.id, { id: c.id, title: c.title, status: c.status }); matchedCaseIds.add(c.id); }
    }
    const cases = [...matched.values()];
    const passed = cases.filter((c) => c.status === 'passed').length;
    const failed = cases.filter((c) => c.status === 'failed' || c.status === 'broken').length;
    const notRun = cases.length - passed - failed;

    const trackerDefects: DefectRef[] = [];
    for (const sig of sigs) {
      for (const d of defectsBySig.get(sig) || []) trackerDefects.push(d);
      if (defectsBySig.has(sig)) matchedDefectSigs.add(sig);
    }
    const caseDefects = cases.filter((c) => c.status === 'failed' || c.status === 'broken').map((c) => ({ key: c.id, status: c.status }));

    const linkable = node.endpoints.length > 0 || node.scenarios.length > 0;
    let status: TraceStatus;
    if (!linkable || !cases.length) status = 'uncovered';
    else if (failed > 0) status = 'failing';
    else if (passed === cases.length) status = 'covered';
    else status = 'partial';

    return { source: node.source, reqKey: node.reqKey, title: node.title, endpoints: node.endpoints, cases, passed, failed, notRun, status, trackerDefects, caseDefects };
  });

  // orphans: tested cases tied to no requirement; tracker defects tied to no requirement
  const orphanTests: OrphanTest[] = runCases
    .filter((c) => !matchedCaseIds.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, status: c.status, endpoint: caseSig.get(c.id) }));
  const orphanDefects: DefectRef[] = [];
  for (const [sig, refs] of defectsBySig) {
    if (!matchedDefectSigs.has(sig)) orphanDefects.push(...refs);
  }

  const linkableRows = rows.filter((r) => r.endpoints.length > 0 || r.source === 'manual');
  const covered = rows.filter((r) => r.status === 'covered').length;
  const partial = rows.filter((r) => r.status === 'partial').length;
  const failing = rows.filter((r) => r.status === 'failing').length;
  const uncovered = rows.filter((r) => r.status === 'uncovered').length;
  const linkableCount = linkableRows.length;
  const linkableCoveredish = linkableRows.filter((r) => r.status !== 'uncovered').length;

  return {
    runId, runTitle: detail?.title || null, rows, orphanTests, orphanDefects,
    summary: {
      total: rows.length, linkable: linkableCount,
      covered, partial, failing, uncovered,
      coveragePct: linkableCount ? Math.round((linkableCoveredish / linkableCount) * 100) : 0,
      bySource: {
        manual: rows.filter((r) => r.source === 'manual').length,
        frd: rows.filter((r) => r.source === 'frd').length,
        brd: rows.filter((r) => r.source === 'brd').length,
      },
      trackerDefects: rows.reduce((n, r) => n + r.trackerDefects.length, 0),
      orphanTests: orphanTests.length, orphanDefects: orphanDefects.length,
    },
  };
}
