/**
 * api-automation.routes.ts
 * ────────────────────────
 * The API Automation workspace's own route group — /api/api-automation.
 *
 *   Intake (12 methods, one normalised result shape)
 *     POST /import/files      multipart, up to 20 files — OpenAPI, Postman, Bruno, HAR,
 *                             WSDL/XML, PDF, Word, Excel/CSV, JSON, YAML, Markdown, text
 *     POST /import/text       { text, format?, name? }            — paste anything
 *     POST /import/url        { url, format?, headers? }          — OpenAPI/Postman URL or a docs page
 *     POST /import/endpoint   { url, method?, headers?, auth?, body?, discover? } — probe + auto-discover
 *     POST /import/curl       { curl }
 *     POST /import/graphql    { url, headers?, auth? }            — introspection
 *     POST /import/mcp        { url, headers?, auth? }            — tools/list
 *     POST /import/connector  { manifest }                        — custom connector JSON
 *     POST /import/webhook    { url, events:[{name,payload}], secret?, signatureHeader? }
 *     POST /import/sdk        { text | file }                     — SDK source (AI-read)
 *     POST /import/middleware { text | file }                     — route definitions (AI-read)
 *     GET  /imports           import history
 *
 *   Intelligence
 *     POST /analyze           { endpoints, deep? } → ApiProfile
 *
 *   Environments
 *     GET/POST /environments · PUT/DELETE /environments/:id · GET /environments/:id/resolve
 *
 *   Dashboard & history
 *     GET /overview · GET /runs · GET /runs/:id
 *
 *   Headless run (the same pipeline the UI drives, as one job)
 *     POST /runs → { jobId } · GET /jobs/:jobId
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { parseDocument } from '../services/document-parser.service.js';
import { getTenantLlm } from '../services/llm.service.js';
import {
  importFromText, importFromUrl, parseCurlCommands, introspectGraphql, discoverMcpTools,
  parseConnectorManifest, endpointsFromWebhook, probeEndpoint, parseStructured, dedupeEndpoints,
  type ImportResult, type ImportedEndpoint, type ImportMethod,
} from '../services/api-import.service.js';
import { analyzeApiSurface, enrichProfileWithLlm } from '../services/api-intelligence.service.js';
import {
  listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment, applyEnvironment,
} from '../services/api-environments.service.js';
import { getApiOverview, listApiRuns, getApiRunDetail, recordImport, listImports } from '../services/api-dashboard.service.js';
import { runHeadlessApiRun } from '../services/api-run.service.js';
import { startJob, getJob, setJobProgress } from '../services/async-jobs.service.js';
import { runGenerationOnly } from '../agents/pipeline.js';
import { sanitizeApiSpec } from '../utils/api-spec.js';
import type { ApiSpec } from '../agents/state.js';

const router = Router();

/* ── Upload config ── */
const IMPORT_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'wsdl', 'bru', 'har', 'ts', 'js', 'py', 'java', 'cs', 'go', 'rb', 'php', 'kt', 'graphql', 'gql'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    if (IMPORT_EXTS.includes(ext) || /json|xml|yaml|text|pdf|spreadsheet|excel|word|octet-stream/i.test(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: .${ext}. Accepted: OpenAPI/Postman/Bruno/HAR (json, yaml, bru, har), WSDL/XML, PDF, Word, Excel/CSV, Markdown/text, and SDK/route source files.`));
  },
});

function fail(res: Response, err: unknown, status = 400): void {
  const message = (err as Error)?.message || 'Request failed';
  res.status(status).json({ error: message });
}

/** Endpoints as the client sends them back (its catalogue) → trusted shape. */
function endpointsFromBody(raw: unknown, max = 500): ImportedEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedEndpoint[] = [];
  for (const e of raw.slice(0, max)) {
    if (!e || typeof e !== 'object') continue;
    const url = String((e as any).url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const method = String((e as any).method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    out.push({
      title: String((e as any).title || `${method} ${url}`).slice(0, 160),
      method,
      url: url.slice(0, 4000),
      headers: Array.isArray((e as any).headers) ? (e as any).headers.filter((h: any) => h && String(h.key || '').trim()).slice(0, 40).map((h: any) => ({ key: String(h.key).slice(0, 200), value: String(h.value ?? '').slice(0, 2000) })) : [],
      auth: { type: (['none', 'bearer', 'basic', 'apikey'].includes(String((e as any).auth?.type)) ? (e as any).auth.type : 'none'), value: (e as any).auth?.value ? String((e as any).auth.value).slice(0, 4000) : undefined, headerName: (e as any).auth?.headerName ? String((e as any).auth.headerName).slice(0, 100) : undefined },
      body: typeof (e as any).body === 'string' ? (e as any).body.slice(0, 20000) : undefined,
      expectedStatus: Number.isInteger(Number((e as any).expectedStatus)) ? Number((e as any).expectedStatus) : undefined,
      expectedResponse: typeof (e as any).expectedResponse === 'string' ? (e as any).expectedResponse.slice(0, 20000) : undefined,
      description: typeof (e as any).description === 'string' ? (e as any).description.slice(0, 2000) : undefined,
      tags: Array.isArray((e as any).tags) ? (e as any).tags.map(String).slice(0, 10) : undefined,
      resource: typeof (e as any).resource === 'string' ? (e as any).resource.slice(0, 80) : undefined,
      pathTemplate: typeof (e as any).pathTemplate === 'string' ? (e as any).pathTemplate.slice(0, 500) : undefined,
      pathParams: Array.isArray((e as any).pathParams) ? (e as any).pathParams.slice(0, 20) : undefined,
      queryParams: Array.isArray((e as any).queryParams) ? (e as any).queryParams.slice(0, 30) : undefined,
      style: (e as any).style,
      source: (e as any).source,
      deprecated: !!(e as any).deprecated,
      discovered: !!(e as any).discovered,
    });
  }
  return out;
}

async function respondImport(req: Request, res: Response, method: ImportMethod, name: string, result: ImportResult): Promise<void> {
  const endpoints = dedupeEndpoints(result.endpoints);
  await recordImport(req.user!.tenantId, req.user!.username, {
    method, name, format: result.format, parser: result.parser, endpointCount: endpoints.length, warnings: result.warnings,
  });
  res.json({
    endpoints,
    count: endpoints.length,
    parser: result.parser,
    format: result.format,
    warnings: result.warnings,
    notice: result.notice,
    // Pattern intelligence comes back with every import so the UI can show
    // what was understood immediately, without a second round-trip.
    profile: endpoints.length ? analyzeApiSurface(endpoints) : null,
  });
}

function bodyHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) for (const h of raw) if (h && String(h.key || '').trim()) out[String(h.key).trim()] = String(h.value ?? '');
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as unknown as Record<string, unknown>)) if (k.trim()) out[k.trim()] = String(v ?? '');
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   Intake
   ═══════════════════════════════════════════════════════════════ */

/** Bulk file import — every file is read, the results are merged. */
router.post('/import/files', upload.array('files', 20), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (!files.length) { res.status(400).json({ error: 'No files uploaded. Send multipart/form-data with one or more "files" fields.' }); return; }
  const formatHint = typeof req.body?.format === 'string' ? req.body.format : 'auto';
  const llm = (await getTenantLlm(req.user!.tenantId)) || undefined;

  const perFile: { fileName: string; count: number; parser?: string; format?: string; error?: string; warnings: string[] }[] = [];
  const all: ImportedEndpoint[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  for (const f of files) {
    try {
      const parsed = await parseDocument(f.buffer, f.mimetype, f.originalname);
      if (!parsed.text?.trim()) throw new Error('No extractable text (image-only or password-protected?)');
      const result = await importFromText(parsed.text, { fileName: f.originalname, formatHint, llm, sourceMethod: 'file' });
      all.push(...result.endpoints);
      perFile.push({ fileName: f.originalname, count: result.endpoints.length, parser: result.parser, format: result.format, warnings: [...result.warnings, ...(parsed.warning ? [parsed.warning] : [])] });
      warnings.push(...result.warnings.map((w) => `${f.originalname}: ${w}`));
      if (parsed.warning) warnings.push(`${f.originalname}: ${parsed.warning}`);
      if (result.notice) notices.push(result.notice);
      await recordImport(req.user!.tenantId, req.user!.username, { method: 'file', name: f.originalname, format: result.format, parser: result.parser, endpointCount: result.endpoints.length, warnings: result.warnings });
    } catch (err) {
      perFile.push({ fileName: f.originalname, count: 0, error: (err as Error).message, warnings: [] });
    }
  }
  const endpoints = dedupeEndpoints(all);
  if (!endpoints.length) {
    res.status(400).json({ error: perFile.map((p) => `${p.fileName}: ${p.error || 'no endpoints found'}`).join(' · '), files: perFile });
    return;
  }
  res.json({
    endpoints, count: endpoints.length, files: perFile, warnings, notice: notices.join(' '),
    parser: perFile.find((p) => p.parser)?.parser || 'llm', format: perFile.map((p) => p.format).filter(Boolean).join(', '),
    profile: analyzeApiSurface(endpoints),
  });
});

router.post('/import/text', async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text || '');
    if (text.trim().length < 5) { res.status(400).json({ error: 'Paste an API description first.' }); return; }
    const llm = (await getTenantLlm(req.user!.tenantId)) || undefined;
    const method = (['sdk', 'middleware', 'connector', 'curl', 'openapi', 'postman'].includes(String(req.body?.method)) ? req.body.method : 'manual') as ImportMethod;
    const result = await importFromText(text, { fileName: String(req.body?.name || 'pasted text').slice(0, 200), formatHint: String(req.body?.format || 'auto'), llm, sourceMethod: method, variables: req.body?.variables });
    await respondImport(req, res, method, String(req.body?.name || 'pasted text').slice(0, 200), result);
  } catch (err) { fail(res, err); }
});

router.post('/import/url', async (req: Request, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) { res.status(400).json({ error: 'A URL is required.' }); return; }
    const llm = (await getTenantLlm(req.user!.tenantId)) || undefined;
    const result = await importFromUrl(url, { formatHint: String(req.body?.format || 'auto'), llm, headers: bodyHeaders(req.body?.headers), baseUrl: req.body?.baseUrl, sourceMethod: 'docs-url' });
    await respondImport(req, res, result.parser === 'llm' ? 'docs-url' : 'openapi', url, result);
  } catch (err) { fail(res, err); }
});

router.post('/import/endpoint', async (req: Request, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'Enter a full absolute URL, e.g. https://api.mycompany.com/v1/users' }); return; }
    const result = await probeEndpoint({
      url, method: req.body?.method, headers: Array.isArray(req.body?.headers) ? req.body.headers : [],
      auth: req.body?.auth, body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      discover: req.body?.discover !== false,
    });
    res.json({ ...result, count: result.endpoints.length, profile: result.endpoints.length ? analyzeApiSurface(result.endpoints) : null });
    void recordImport(req.user!.tenantId, req.user!.username, { method: 'endpoint', name: url, format: result.format, parser: result.parser, endpointCount: result.endpoints.length, warnings: result.warnings });
  } catch (err) { fail(res, err); }
});

router.post('/import/curl', async (req: Request, res: Response) => {
  try {
    const curl = String(req.body?.curl || req.body?.text || '');
    if (!/curl\s/i.test(curl)) { res.status(400).json({ error: 'Paste one or more cURL commands.' }); return; }
    const result = parseCurlCommands(curl, 'cURL');
    if (!result.endpoints.length) { res.status(400).json({ error: result.warnings[0] || 'No request could be parsed.' }); return; }
    await respondImport(req, res, 'curl', `${result.endpoints.length} cURL command${result.endpoints.length === 1 ? '' : 's'}`, result);
  } catch (err) { fail(res, err); }
});

router.post('/import/graphql', async (req: Request, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'Enter the GraphQL endpoint URL.' }); return; }
    const result = await introspectGraphql(url, bodyHeaders(req.body?.headers), req.body?.auth);
    await respondImport(req, res, 'graphql', url, result);
  } catch (err) { fail(res, err); }
});

router.post('/import/mcp', async (req: Request, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'Enter the MCP server URL (Streamable HTTP endpoint).' }); return; }
    const result = await discoverMcpTools(url, bodyHeaders(req.body?.headers), req.body?.auth);
    await respondImport(req, res, 'mcp', url, result);
  } catch (err) { fail(res, err); }
});

router.post('/import/connector', async (req: Request, res: Response) => {
  try {
    let manifest = req.body?.manifest;
    if (typeof manifest === 'string') {
      const parsed = parseStructured(manifest);
      if (!parsed) { res.status(400).json({ error: 'The manifest is not valid JSON or YAML.' }); return; }
      manifest = parsed.doc;
    }
    if (!manifest) { res.status(400).json({ error: 'A connector manifest is required.' }); return; }
    const result = parseConnectorManifest(manifest, String(req.body?.name || 'Custom connector'));
    if (!result.endpoints.length) { res.status(400).json({ error: result.warnings[0] || 'No endpoints in the manifest.' }); return; }
    await respondImport(req, res, 'connector', String(manifest?.name || req.body?.name || 'Custom connector'), result);
  } catch (err) { fail(res, err); }
});

router.post('/import/webhook', async (req: Request, res: Response) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'Enter the webhook consumer URL your system exposes.' }); return; }
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50).map((e: any) => ({
      name: String(e?.name || 'event').slice(0, 80),
      payload: typeof e?.payload === 'string' ? (parseStructured(e.payload)?.doc ?? e.payload) : (e?.payload ?? {}),
      description: e?.description ? String(e.description).slice(0, 500) : undefined,
    })) : [];
    const result = endpointsFromWebhook({
      url, method: req.body?.method, events, secret: req.body?.secret ? String(req.body.secret) : undefined,
      signatureHeader: req.body?.signatureHeader ? String(req.body.signatureHeader).slice(0, 100) : undefined,
      headers: Array.isArray(req.body?.headers) ? req.body.headers : undefined,
      expectedStatus: Number(req.body?.expectedStatus) || undefined,
    });
    await respondImport(req, res, 'webhook', url, result);
  } catch (err) { fail(res, err); }
});

/** SDK source and middleware/route files — text or an uploaded file, AI-read. */
for (const method of ['sdk', 'middleware'] as const) {
  router.post(`/import/${method}`, upload.single('file'), async (req: Request, res: Response) => {
    try {
      let text = String(req.body?.text || '');
      let name = String(req.body?.name || (method === 'sdk' ? 'SDK source' : 'Route definitions')).slice(0, 200);
      if (req.file) {
        const parsed = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname).catch(() => ({ text: req.file!.buffer.toString('utf8') }));
        text = parsed.text || req.file.buffer.toString('utf8');
        name = req.file.originalname;
      }
      if (text.trim().length < 20) { res.status(400).json({ error: `Paste the ${method === 'sdk' ? 'SDK / client source' : 'route or controller source'} or upload the file.` }); return; }
      const llm = (await getTenantLlm(req.user!.tenantId)) || undefined;
      if (!llm) { res.status(400).json({ error: 'Reading source code needs the tenant LLM. Add an Anthropic API key in System Configuration → LLM Configuration.' }); return; }
      const result = await importFromText(text, { fileName: name, formatHint: method, llm, sourceMethod: method });
      await respondImport(req, res, method, name, result);
    } catch (err) { fail(res, err); }
  });
}

router.get('/imports', async (req: Request, res: Response) => {
  try { res.json({ items: await listImports(req.user!.tenantId, Number(req.query.limit) || 50) }); }
  catch (err) { fail(res, err, 500); }
});

/* ═══════════════════════════════════════════════════════════════
   Intelligence
   ═══════════════════════════════════════════════════════════════ */

router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const endpoints = endpointsFromBody(req.body?.endpoints);
    if (!endpoints.length) { res.status(400).json({ error: 'Send the endpoints to analyse.' }); return; }
    const profile = analyzeApiSurface(endpoints);
    if (req.body?.deep) {
      const llm = await getTenantLlm(req.user!.tenantId);
      if (llm) {
        try { profile.insights = await enrichProfileWithLlm(profile, endpoints, llm); }
        catch (err) { profile.insights = [`AI review unavailable: ${(err as Error).message}`]; }
      } else {
        profile.insights = ['AI review needs an LLM — add an Anthropic API key under System Configuration → LLM Configuration.'];
      }
    }
    res.json({ profile });
  } catch (err) { fail(res, err); }
});

/* ═══════════════════════════════════════════════════════════════
   Environments
   ═══════════════════════════════════════════════════════════════ */

router.get('/environments', async (req: Request, res: Response) => {
  try { res.json({ environments: await listEnvironments(req.user!.tenantId) }); }
  catch (err) { fail(res, err, 500); }
});

router.post('/environments', async (req: Request, res: Response) => {
  try { res.status(201).json({ environment: await createEnvironment(req.user!.tenantId, req.user!.username, req.body || {}) }); }
  catch (err) { fail(res, err); }
});

router.put('/environments/:id', async (req: Request, res: Response) => {
  try {
    const env = await updateEnvironment(req.user!.tenantId, String(req.params.id), req.body || {});
    if (!env) { res.status(404).json({ error: 'Environment not found.' }); return; }
    res.json({ environment: env });
  } catch (err) { fail(res, err); }
});

router.delete('/environments/:id', async (req: Request, res: Response) => {
  try {
    const ok = await deleteEnvironment(req.user!.tenantId, String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Environment not found.' }); return; }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/**
 * Resolve endpoints against an environment — secrets revealed server-side and
 * substituted, so the run sends real values without the browser ever holding
 * the plaintext list.
 */
router.post('/environments/:id/resolve', async (req: Request, res: Response) => {
  try {
    const env = await getEnvironment(req.user!.tenantId, String(req.params.id), { reveal: true });
    if (!env) { res.status(404).json({ error: 'Environment not found.' }); return; }
    const endpoints = endpointsFromBody(req.body?.endpoints).map((e) => applyEnvironment(e, env));
    res.json({ endpoints, environment: { id: env.id, name: env.name, baseUrl: env.baseUrl } });
  } catch (err) { fail(res, err); }
});

/* ═══════════════════════════════════════════════════════════════
   Dashboard & history
   ═══════════════════════════════════════════════════════════════ */

router.get('/overview', async (req: Request, res: Response) => {
  try { res.json(await getApiOverview(req.user!.tenantId)); }
  catch (err) { fail(res, err, 500); }
});

router.get('/runs', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    res.json(await listApiRuns(req.user!.tenantId, page, pageSize));
  } catch (err) { fail(res, err, 500); }
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) { res.status(404).json({ error: 'Run not found.' }); return; }
    const run = await getApiRunDetail(req.user!.tenantId, id);
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    res.json(run);
  } catch (err) { fail(res, err, 500); }
});

/* ═══════════════════════════════════════════════════════════════
   Design (async)
   One model call per endpoint means a large catalogue takes minutes —
   longer than any request may live (Azure ingress: ~240s). Design
   therefore runs as a job: 202 + jobId now, poll /jobs/:jobId for
   progress ({done, total}) and the finished result.
   ═══════════════════════════════════════════════════════════════ */

router.post('/design', async (req: Request, res: Response) => {
  const rawSpecs: unknown[] = Array.isArray(req.body?.apiSpecs) ? req.body.apiSpecs : [];
  const specs = rawSpecs.slice(0, 400).map((r) => sanitizeApiSpec(r)).filter((s): s is ApiSpec => !!s);
  if (!specs.length) { res.status(400).json({ error: 'Send at least one endpoint with an absolute http(s) URL.' }); return; }
  const tenantId = req.user!.tenantId;
  const llm = await getTenantLlm(tenantId);
  if (!llm) { res.status(400).json({ error: 'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.' }); return; }

  const rawLayers = req.body?.apiLayers;
  const rawProfile = req.body?.apiProfile;
  const requirements = typeof req.body?.requirements === 'string' ? req.body.requirements.slice(0, 4000) : '';
  const jobId = startJob(tenantId, async (id) => {
    setJobProgress(id, { phase: 'design', done: 0, total: specs.length, message: 'Starting…' });
    const state = await runGenerationOnly(requirements, {
      llm, tenantId,
      apiSpecs: specs,
      apiLayers: Array.isArray(rawLayers) ? rawLayers.map((l: unknown) => String(l)).slice(0, 12) : null,
      apiProfile: rawProfile && typeof rawProfile === 'object' && Array.isArray(rawProfile.insights)
        ? { insights: rawProfile.insights.map((i: unknown) => String(i)).slice(0, 8) }
        : null,
      appContext: { targetUrl: specs[0]!.baseUrl, appName: 'API', environment: undefined, explorePrompt: undefined, roles: undefined },
      onProgress: (p) => setJobProgress(id, p),
    });
    return {
      testCases: state.testCases,
      automationScripts: state.automationScripts,
      pageObjects: state.pageObjects || [],
      apiProfile: state.apiProfile || null,
      summary: { totalTestCases: state.testCases.length, totalScripts: state.automationScripts.length },
    };
  });
  res.status(202).json({ jobId, status: 'running', pollUrl: `/api/api-automation/jobs/${jobId}` });
});

/* ═══════════════════════════════════════════════════════════════
   Headless run
   ═══════════════════════════════════════════════════════════════ */

router.post('/runs', async (req: Request, res: Response) => {
  const endpoints = endpointsFromBody(req.body?.endpoints);
  if (!endpoints.length) { res.status(400).json({ error: 'Send at least one endpoint with an absolute http(s) URL.' }); return; }
  const tenantId = req.user!.tenantId;
  const username = req.user!.username;
  const input = {
    endpoints,
    title: typeof req.body?.title === 'string' ? req.body.title : undefined,
    coverage: ['essential', 'standard', 'exhaustive'].includes(String(req.body?.coverage)) ? req.body.coverage : undefined,
    layers: Array.isArray(req.body?.layers) ? req.body.layers.map(String) : undefined,
    environmentId: typeof req.body?.environmentId === 'string' ? req.body.environmentId : undefined,
    execute: req.body?.execute !== false,
    heal: req.body?.heal !== false,
    requirements: typeof req.body?.requirements === 'string' ? req.body.requirements.slice(0, 4000) : undefined,
  };
  const jobId = startJob(tenantId, (id) => runHeadlessApiRun(tenantId, username, input, id));
  res.status(202).json({ jobId, status: 'running', pollUrl: `/api/api-automation/jobs/${jobId}` });
});

router.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.user!.tenantId, String(req.params.jobId));
  if (!job) { res.status(404).json({ error: 'Job not found (it may have expired or the server restarted).' }); return; }
  res.json(job);
});

/* ── multer errors → JSON ── */
router.use((err: any, _req: Request, res: Response, _next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: 'File too large. Maximum upload size is 15 MB per file.' }); return; }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') { res.status(400).json({ error: 'Too many files — upload at most 20 at a time.' }); return; }
  res.status(400).json({ error: err?.message || 'Upload failed' });
});

export default router;
