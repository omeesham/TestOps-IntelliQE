/**
 * api-automation-public.routes.ts
 * ───────────────────────────────
 * The public, RESTful face of API Automation — /api/v1/public/api-automation.
 *
 * Organised the way a CI job or a terminal user thinks about test information:
 *
 *   Projects   GET  /projects                 what has been automated, grouped by API
 *   Plans      GET  /plans · GET /plans/:id   saved scenario suites (test plans) + their cases
 *   Builds     GET  /builds · GET /builds/:id executions with stats; a build's sessions
 *   Sessions   GET  /builds/:id/sessions/:tc  one scenario's result inside a build
 *   Runs       POST /runs · GET /runs/:jobId  start the headless pipeline; poll it
 *   Imports    POST /imports · GET /imports   turn any source into endpoints; history
 *   Analysis   POST /analyze                  pattern intelligence for a set of endpoints
 *   Envs       GET  /environments
 *
 * Standard HTTP verbs, JSON in and out, a uniform `{ data, meta }` envelope on
 * collections and `{ error }` on failure. Authenticated with the same Bearer
 * token the UI uses (`POST /api/auth/login` mints one), which is what the CLI
 * in /cli sends. Every mutation is audited by the middleware mounted with it.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import pool from '../../db.js';
import { listApiRuns, getApiRunDetail, listImports, recordImport } from '../../services/api-dashboard.service.js';
import { listEnvironments } from '../../services/api-environments.service.js';
import { analyzeApiSurface } from '../../services/api-intelligence.service.js';
import { importFromText, importFromUrl, parseCurlCommands, introspectGraphql, discoverMcpTools, parseConnectorManifest, dedupeEndpoints, type ImportedEndpoint } from '../../services/api-import.service.js';
import { getTenantLlm } from '../../services/llm.service.js';
import { runHeadlessApiRun } from '../../services/api-run.service.js';
import { startJob, getJob } from '../../services/async-jobs.service.js';

const router = Router();

const EndpointSchema = z.object({
  title: z.string().max(160).optional(),
  method: z.string().max(10).optional(),
  url: z.string().url(),
  headers: z.array(z.object({ key: z.string(), value: z.string().optional() })).optional(),
  auth: z.object({ type: z.enum(['none', 'bearer', 'basic', 'apikey']).optional(), value: z.string().optional(), headerName: z.string().optional() }).optional(),
  body: z.string().max(20000).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  expectedResponse: z.string().max(20000).optional(),
  resource: z.string().max(80).optional(),
  pathTemplate: z.string().max(500).optional(),
  style: z.string().max(20).optional(),
}).passthrough();

const RunSchema = z.object({
  endpoints: z.array(EndpointSchema).min(1).max(500),
  title: z.string().max(500).optional(),
  coverage: z.enum(['essential', 'standard', 'exhaustive']).optional(),
  layers: z.array(z.string()).optional(),
  environmentId: z.string().optional(),
  execute: z.boolean().optional(),
  heal: z.boolean().optional(),
  requirements: z.string().max(4000).optional(),
});

const ImportSchema = z.object({
  /** openapi | postman | curl | url | graphql | mcp | connector | text */
  kind: z.enum(['text', 'url', 'curl', 'graphql', 'mcp', 'connector']).default('text'),
  text: z.string().optional(),
  url: z.string().url().optional(),
  format: z.string().optional(),
  name: z.string().max(200).optional(),
  headers: z.record(z.string()).optional(),
  auth: z.object({ type: z.string(), value: z.string().optional() }).optional(),
  manifest: z.unknown().optional(),
});

function toEndpoints(list: z.infer<typeof EndpointSchema>[]): ImportedEndpoint[] {
  return list.map((e) => ({
    title: e.title || `${(e.method || 'GET').toUpperCase()} ${e.url}`,
    method: (e.method || 'GET').toUpperCase(),
    url: e.url,
    headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value || '' })),
    auth: { type: e.auth?.type || 'none', value: e.auth?.value, headerName: e.auth?.headerName },
    body: e.body,
    expectedStatus: e.expectedStatus,
    expectedResponse: e.expectedResponse,
    resource: e.resource,
    pathTemplate: e.pathTemplate,
    style: e.style as any,
  }));
}

function badRequest(res: Response, err: unknown): void {
  if (err instanceof z.ZodError) { res.status(400).json({ error: 'Invalid request body', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }); return; }
  res.status(400).json({ error: (err as Error)?.message || 'Bad request' });
}

const page = (q: any) => ({ page: Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1), pageSize: Math.min(100, Math.max(1, parseInt(String(q.pageSize ?? '20'), 10) || 20)) });

/* ── Projects ── */
router.get('/projects', async (req: Request, res: Response) => {
  try {
    const runs = await listApiRuns(req.user!.tenantId, 1, 100);
    const groups = new Map<string, { name: string; builds: number; scenarios: number; lastBuildAt: string; lastPassRate: number | null; endpoints: number }>();
    for (const r of runs.items) {
      const g = groups.get(r.title) || { name: r.title, builds: 0, scenarios: 0, lastBuildAt: r.createdAt, lastPassRate: r.stats?.passRate ?? null, endpoints: r.endpoints };
      g.builds++; g.scenarios += r.caseCount;
      groups.set(r.title, g);
    }
    res.json({ data: [...groups.values()], meta: { total: groups.size } });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

/* ── Plans (saved scenario suites) ── */
router.get('/plans', async (req: Request, res: Response) => {
  try {
    const { page: p, pageSize } = page(req.query);
    const runs = await listApiRuns(req.user!.tenantId, p, pageSize);
    res.json({
      data: runs.items.map((r) => ({ id: r.runId, title: r.title, createdAt: r.createdAt, createdBy: r.createdBy, scenarios: r.caseCount, categories: r.categories, endpoints: r.endpoints, executed: !!r.stats })),
      meta: { total: runs.total, page: p, pageSize },
    });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.get('/plans/:id', async (req: Request, res: Response) => {
  try {
    const run = await getApiRunDetail(req.user!.tenantId, String(req.params.id));
    if (!run) { res.status(404).json({ error: 'Plan not found' }); return; }
    res.json({ data: { id: run.runId, title: run.title, createdAt: run.createdAt, createdBy: run.createdBy, cases: run.cases.map((c) => ({ id: c.id, title: c.title, type: c.type, priority: c.priority, feature: c.feature, request: c.api })) } });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

/* ── Builds (executions) & sessions ── */
router.get('/builds', async (req: Request, res: Response) => {
  try {
    const { page: p, pageSize } = page(req.query);
    const runs = await listApiRuns(req.user!.tenantId, 1, 500);
    const executed = runs.items.filter((r) => r.stats);
    const slice = executed.slice((p - 1) * pageSize, p * pageSize);
    res.json({
      data: slice.map((r) => ({ id: r.runId, planId: r.runId, title: r.title, startedAt: r.createdAt, status: r.stats!.failed === 0 ? 'passed' : 'failed', stats: r.stats, reportUrl: r.reportUrl })),
      meta: { total: executed.length, page: p, pageSize },
    });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.get('/builds/:id', async (req: Request, res: Response) => {
  try {
    const run = await getApiRunDetail(req.user!.tenantId, String(req.params.id));
    if (!run) { res.status(404).json({ error: 'Build not found' }); return; }
    res.json({ data: { id: run.runId, title: run.title, startedAt: run.createdAt, stats: run.stats, reportUrl: run.reportUrl, sessions: run.cases.map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.status, durationMs: c.durationMs, request: c.api })) } });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.get('/builds/:id/sessions/:tc', async (req: Request, res: Response) => {
  try {
    const run = await getApiRunDetail(req.user!.tenantId, String(req.params.id));
    const c = run?.cases.find((x) => x.id.toUpperCase() === String(req.params.tc).toUpperCase());
    if (!run || !c) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({ data: { buildId: run.runId, id: c.id, title: c.title, type: c.type, priority: c.priority, status: c.status, durationMs: c.durationMs, request: c.api, reportUrl: run.reportUrl } });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

/* ── Runs (headless pipeline) ── */
router.post('/runs', async (req: Request, res: Response) => {
  try {
    const input = RunSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const username = req.user!.username;
    const jobId = startJob(tenantId, (id) => runHeadlessApiRun(tenantId, username, { ...input, endpoints: toEndpoints(input.endpoints) }, id));
    res.status(202).json({ data: { jobId, status: 'running', pollUrl: `/api/v1/public/api-automation/runs/${jobId}` } });
  } catch (err) { badRequest(res, err); }
});

router.get('/runs/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.user!.tenantId, String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Run not found (it may have expired or the server restarted)' }); return; }
  res.json({ data: job });
});

/* ── Imports ── */
router.post('/imports', async (req: Request, res: Response) => {
  try {
    const input = ImportSchema.parse(req.body);
    const llm = (await getTenantLlm(req.user!.tenantId)) || undefined;
    let result;
    if (input.kind === 'url') {
      if (!input.url) throw new Error('url is required for kind "url"');
      result = await importFromUrl(input.url, { formatHint: input.format, llm, headers: input.headers });
    } else if (input.kind === 'curl') {
      result = parseCurlCommands(input.text || '', input.name || 'cURL');
    } else if (input.kind === 'graphql') {
      if (!input.url) throw new Error('url is required for kind "graphql"');
      result = await introspectGraphql(input.url, input.headers || {}, input.auth);
    } else if (input.kind === 'mcp') {
      if (!input.url) throw new Error('url is required for kind "mcp"');
      result = await discoverMcpTools(input.url, input.headers || {}, input.auth);
    } else if (input.kind === 'connector') {
      result = parseConnectorManifest(input.manifest ?? (input.text ? JSON.parse(input.text) : null), input.name);
    } else {
      if (!input.text) throw new Error('text is required for kind "text"');
      result = await importFromText(input.text, { fileName: input.name || 'api-import', formatHint: input.format, llm });
    }
    const endpoints = dedupeEndpoints(result.endpoints);
    if (!endpoints.length) { res.status(422).json({ error: result.warnings[0] || 'No endpoints were found.' }); return; }
    await recordImport(req.user!.tenantId, req.user!.username, { method: input.kind === 'url' ? 'docs-url' : input.kind === 'text' ? 'file' : input.kind, name: input.name || input.url || 'cli-import', format: result.format, parser: result.parser, endpointCount: endpoints.length, warnings: result.warnings });
    res.json({ data: { endpoints, format: result.format, parser: result.parser, warnings: result.warnings, profile: analyzeApiSurface(endpoints) }, meta: { count: endpoints.length } });
  } catch (err) { badRequest(res, err); }
});

router.get('/imports', async (req: Request, res: Response) => {
  try { const items = await listImports(req.user!.tenantId, Number(req.query.limit) || 50); res.json({ data: items, meta: { total: items.length } }); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

/* ── Analysis ── */
router.post('/analyze', (req: Request, res: Response) => {
  try {
    const list = z.array(EndpointSchema).min(1).max(500).parse(req.body?.endpoints);
    res.json({ data: analyzeApiSurface(toEndpoints(list)) });
  } catch (err) { badRequest(res, err); }
});

/* ── Environments ── */
router.get('/environments', async (req: Request, res: Response) => {
  try { const envs = await listEnvironments(req.user!.tenantId); res.json({ data: envs, meta: { total: envs.length } }); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

/* ── Whoami — lets the CLI confirm its token ── */
router.get('/me', async (req: Request, res: Response) => {
  const u = req.user!;
  let tenantSlug = '';
  try { const { rows } = await pool.query(`SELECT slug FROM tenants WHERE id = $1`, [u.tenantId]); tenantSlug = rows[0]?.slug || ''; } catch { /* optional */ }
  res.json({ data: { username: u.username, role: u.role, tenant: { id: u.tenantId, name: u.tenantName, slug: tenantSlug } } });
});

export default router;
