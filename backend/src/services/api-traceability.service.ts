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
import * as XLSX from 'xlsx';
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
  /** Gap A: for an FRD row, the BRD requirement it realises; for a BRD row, the
   *  FRD requirements mapped under it. Populated from brd_frd_links. */
  brdRef?: string;
  frdRefs?: string[];
  /** Gap C: automation script file names for this row's matched cases (from
   *  automation_scripts, joined by tc_number within the reference run). */
  scriptPaths?: string[];
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

interface ReqNode { source: TraceSource; reqKey: string; title: string; endpoints: LinkedEndpoint[]; scenarios: string[]; dbId?: string }

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
    `SELECT id, fr_id, title, endpoints FROM functional_requirements WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  for (const r of frd.rows) {
    const eps = jArr(r.endpoints)
      .map((e: any) => ({ method: String(e?.method || 'GET').toUpperCase(), url: String(e?.path || e?.url || '') }))
      .filter((e: LinkedEndpoint) => e.url);
    nodes.push({ source: 'frd', reqKey: r.fr_id || '', title: r.title || '', endpoints: eps, scenarios: [], dbId: String(r.id) });
  }

  // BRD business requirements sit at the top of the chain (no endpoints of their own).
  const brd = await pool.query(
    `SELECT id, br_id, title FROM business_requirements WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  for (const r of brd.rows) {
    nodes.push({ source: 'brd', reqKey: r.br_id || '', title: r.title || '', endpoints: [], scenarios: [], dbId: String(r.id) });
  }

  return nodes;
}

// ─── Gap A: BRD ↔ FRD requirement mapping ─────────────────────────────────────
// Each functional requirement is mapped to the business requirement it realises,
// so the RTM chains BRD → FRD → API → case → defect. Deterministic matcher (no
// LLM dependency, so it is verifiable and never flaky): (1) an explicit BR-###
// mention anywhere in the FR's text wins; else (2) the BR with the highest
// token-overlap score above a floor. Rebuilt wholesale per tenant on each call.

export interface BrdFrdLink { brKey: string; frKey: string; brDbId?: string; frDbId?: string; confidence: number; rationale: string }

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'is', 'are', 'be', 'by', 'as', 'at', 'it', 'this', 'that', 'shall', 'should', 'must', 'will', 'can', 'api', 'user', 'system', 'data']);
function tokens(s: string): Set<string> {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hits = 0; for (const t of a) if (b.has(t)) hits++;
  return hits / Math.sqrt(a.size * b.size); // cosine-ish, 0..1
}

/** Rebuild the tenant's BRD↔FRD links and return them. Pure DB + heuristics. */
export async function mapBrdFrd(tenantId: string, username: string): Promise<{ links: BrdFrdLink[]; summary: { frTotal: number; mapped: number; unmapped: number; brTotal: number } }> {
  const brs = await pool.query(
    `SELECT id, br_id, title, description, objective, rules FROM business_requirements WHERE tenant_id = $1`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  const frs = await pool.query(
    `SELECT id, fr_id, title, description, dependencies FROM functional_requirements WHERE tenant_id = $1 ORDER BY sort_order`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));

  const brRows = brs.rows
    .filter((b: any) => b.br_id)
    .map((b: any) => {
      const blob = [b.title, b.description, b.objective, b.rules].filter(Boolean).join(' ');
      return { id: String(b.id), br_key: String(b.br_id), tok: tokens(blob), keyUpper: String(b.br_id).toUpperCase() };
    });
  const frRows = frs.rows
    .filter((f: any) => f.fr_id)
    .map((f: any) => {
      const blob = [f.title, f.description, Array.isArray(f.dependencies) ? f.dependencies.join(' ') : f.dependencies].filter(Boolean).join(' ');
      return { id: String(f.id), fr_key: String(f.fr_id), tok: tokens(blob), text: blob.toUpperCase() };
    });

  const links: BrdFrdLink[] = [];
  const MIN_SCORE = 0.12;
  for (const fr of frRows) {
    // (1) explicit mention of a BR key in the FR text
    const explicit = brRows.find((br) => fr.text.includes(br.keyUpper));
    if (explicit) { links.push({ brKey: explicit.br_key, frKey: fr.fr_key, brDbId: explicit.id, frDbId: fr.id, confidence: 1, rationale: `FR text references ${explicit.br_key}` }); continue; }
    // (2) best token overlap
    let best: { br: typeof brRows[number]; score: number } | null = null;
    for (const br of brRows) {
      const score = overlap(fr.tok, br.tok);
      if (!best || score > best.score) best = { br, score };
    }
    if (best && best.score >= MIN_SCORE) {
      links.push({ brKey: best.br.br_key, frKey: fr.fr_key, brDbId: best.br.id, frDbId: fr.id, confidence: Math.round(best.score * 100) / 100, rationale: `Best keyword overlap (${Math.round(best.score * 100)}%)` });
    }
  }

  // rebuild wholesale for this tenant
  await pool.query(`DELETE FROM brd_frd_links WHERE tenant_id = $1`, [tenantId]);
  for (const l of links) {
    await pool.query(
      `INSERT INTO brd_frd_links (tenant_id, br_key, fr_key, br_db_id, fr_db_id, confidence, rationale, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, l.brKey, l.frKey, l.brDbId || null, l.frDbId || null, l.confidence, l.rationale.slice(0, 600), username],
    );
  }

  const mapped = new Set(links.map((l) => l.frKey)).size;
  return { links, summary: { frTotal: frRows.length, mapped, unmapped: frRows.length - mapped, brTotal: brRows.length } };
}

// ─── Gap C: RTM export (true .xlsx, via SheetJS already in deps) ───────────────
// One row per requirement with the full chain: BRD → FRD → API (endpoint+method)
// → test case → automation script path → status → defect. Plus a summary sheet.
export async function exportRtmXlsx(tenantId: string, runId?: string): Promise<Buffer> {
  const m = await buildIntegratedMatrix(tenantId, { runId });
  const rows = m.rows.map((r) => ({
    'BRD ID': r.source === 'brd' ? r.reqKey : (r.brdRef || ''),
    'FRD ID': r.source === 'frd' ? r.reqKey : (r.frdRefs ? r.frdRefs.join(', ') : ''),
    'Source': r.source.toUpperCase(),
    'Requirement': r.title,
    'API endpoint(s)': r.endpoints.map((e) => `${e.method} ${e.url}`).join('\n'),
    'Test case IDs': r.cases.map((c) => c.id).join(', '),
    'Automation script path': (r.scriptPaths || []).join('\n'),
    'Execution status': r.status,
    'Passed/Failed/NotRun': `${r.passed}/${r.failed}/${r.notRun}`,
    'Defect IDs': [...r.trackerDefects.map((d) => d.key), ...r.caseDefects.map((d) => d.key)].join(', '),
  }));
  const s = m.summary;
  const summary = [
    { Metric: 'Coverage %', Value: s.coveragePct },
    { Metric: 'Requirements (total)', Value: s.total },
    { Metric: 'BRD / FRD / manual', Value: `${s.bySource.brd} / ${s.bySource.frd} / ${s.bySource.manual}` },
    { Metric: 'Covered / Partial / Failing / Uncovered', Value: `${s.covered} / ${s.partial} / ${s.failing} / ${s.uncovered}` },
    { Metric: 'Tracker defects', Value: s.trackerDefects },
    { Metric: 'Orphan tests / Orphan defects', Value: `${s.orphanTests} / ${s.orphanDefects}` },
    { Metric: 'Run', Value: m.runTitle || m.runId || '(none)' },
    { Metric: 'Generated', Value: new Date().toISOString() },
  ];
  const wb = XLSX.utils.book_new();
  const wsRtm = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'BRD ID': '', 'FRD ID': '', Source: '', Requirement: '(no requirements)', 'API endpoint(s)': '', 'Test case IDs': '', 'Automation script path': '', 'Execution status': '', 'Passed/Failed/NotRun': '', 'Defect IDs': '' }]);
  wsRtm['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 40 }, { wch: 32 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsRtm, 'RTM');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function listBrdFrdLinks(tenantId: string): Promise<BrdFrdLink[]> {
  const { rows } = await pool.query(
    `SELECT br_key, fr_key, br_db_id, fr_db_id, confidence, rationale FROM brd_frd_links WHERE tenant_id = $1 ORDER BY br_key, fr_key`,
    [tenantId],
  ).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ brKey: r.br_key, frKey: r.fr_key, brDbId: r.br_db_id ? String(r.br_db_id) : undefined, frDbId: r.fr_db_id ? String(r.fr_db_id) : undefined, confidence: Number(r.confidence || 0), rationale: r.rationale || '' }));
}

export async function buildIntegratedMatrix(tenantId: string, opts: { runId?: string } = {}): Promise<IntegratedMatrix> {
  const nodes = await gatherReqNodes(tenantId);

  // Gap A: BRD↔FRD edges, keyed by requirement DB id (FR-###/BR-### keys are only
  // unique within one document, so a bare key would over-link across documents).
  const links = await listBrdFrdLinks(tenantId);
  const brOfFr = new Map<string, string>();      // fr_db_id → br_key (display)
  const frsOfBr = new Map<string, string[]>();    // br_db_id → [fr_key] (display)
  for (const l of links) {
    if (l.frDbId) brOfFr.set(l.frDbId, l.brKey);
    if (l.brDbId) { const arr = frsOfBr.get(l.brDbId) || []; arr.push(l.frKey); frsOfBr.set(l.brDbId, arr); }
  }

  // reference run
  let runId = opts.runId || null;
  if (!runId) {
    const recent = await listApiRuns(tenantId, 1, 1);
    runId = recent.items[0]?.runId || null;
  }
  const detail = runId ? await getApiRunDetail(tenantId, runId) : null;
  const runCases = detail?.cases || [];

  // Gap C: automation script file names for this run, keyed by tc_number (= case id).
  const scriptByTc = new Map<string, string>();
  if (runId) {
    const scripts = await pool.query(
      `SELECT tc_number, file_name FROM automation_scripts WHERE tenant_id = $1 AND test_run_id = $2`,
      [tenantId, runId],
    ).catch(() => ({ rows: [] as any[] }));
    for (const s of scripts.rows) { if (s.tc_number && s.file_name) scriptByTc.set(String(s.tc_number).toUpperCase(), String(s.file_name)); }
  }

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

    const brdRef = node.source === 'frd' && node.dbId ? brOfFr.get(node.dbId) : undefined;
    const frdRefs = node.source === 'brd' && node.dbId ? frsOfBr.get(node.dbId) : undefined;
    const scriptPaths = [...new Set(cases.map((c) => scriptByTc.get(c.id.toUpperCase())).filter((v): v is string => !!v))];
    return { source: node.source, reqKey: node.reqKey, title: node.title, endpoints: node.endpoints, cases, passed, failed, notRun, status, trackerDefects, caseDefects, brdRef, frdRefs, scriptPaths };
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
