/**
 * api-covguide.service.ts
 * ───────────────────────
 * Coverage-GUIDED generation — the feedback layer the static stateful generator
 * (api-stateful-gen) deliberately lacks. Single-endpoint and stateful generators
 * are blind to WHAT they miss; this closes the loop:
 *
 *   1. PROBE each endpoint — the happy path plus cheap NEGATIVE variants (a bogus
 *      object id, a stripped required query param, an auth-stripped call) — and
 *      record the response "coverage signals" actually observed: which status
 *      CLASSES (2xx/4xx/5xx) came back, which response fields appeared, the
 *      content type.
 *   2. DIFF observed vs. expected branches → a list of UNCOVERED branches
 *      (an endpoint that never produced an error path, a query param never
 *      varied, a protected endpoint whose 401/403 was never seen, …).
 *   3. GENERATE new, targeted test cases aimed squarely at those uncovered
 *      branches — via the tenant LLM when available, or a deterministic
 *      template fallback (bogus-id → 404, missing-param → 4xx, boundary values).
 *   4. Optionally INGEST a real white-box coverage report (lcov or an istanbul
 *      json-summary) the system-under-test produced, report true line/branch %,
 *      and map still-uncovered source files back to the endpoints that most
 *      likely exercise them.
 *
 * Non-destructive by default: only GET/HEAD are probed; write verbs are skipped
 * unless the caller opts in. Pure analysis + live reads — the generate → execute
 * → heal pipeline is never touched. The emitted cases are REVIEWABLE and can be
 * fed to the generator / Flow builder.
 */
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface CovGuideEndpoint extends HttpEndpoint {
  id?: string;
  title?: string;
  queryParams?: { name: string }[];
}

type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'err';

export interface CoverageSignal {
  signature: string;
  method: string;
  url: string;
  probes: number;
  statusClassesSeen: StatusClass[];
  statusesSeen: number[];
  fieldsSeen: string[];
  contentType?: string;
  /** true when the endpoint produced at least one success AND one error response across probes. */
  branchComplete: boolean;
}

export type UncoveredKind = 'missing-error-path' | 'missing-success-path' | 'untested-param' | 'unverified-auth' | 'no-boundary';
export interface UncoveredBranch {
  signature: string;
  method: string;
  url: string;
  kind: UncoveredKind;
  detail: string;
  suggestion: string;
}

export interface GeneratedCase {
  title: string;
  method: string;
  url: string;
  rationale: string;
  /** signature of the endpoint / branch this case targets. */
  targets: string;
  queryParams?: { name: string; value: string }[];
  body?: string;
  expectedStatusClass?: StatusClass;
}

export interface ExternalCoverage {
  source: 'lcov' | 'istanbul-json';
  linesPct?: number;
  branchesPct?: number;
  functionsPct?: number;
  totalFiles: number;
  uncoveredFiles: { file: string; uncoveredLines?: number; branchesPct?: number }[];
  /** endpoints whose path/title best matches an uncovered source file. */
  mappedEndpoints: { file: string; endpoint: string }[];
}

export interface CovGuideResult {
  summary: {
    endpoints: number;
    probes: number;
    /** 0–100: share of probed endpoints that exercised BOTH a success and an error branch (or the external branch %, when a report is supplied). */
    responseCoveragePct: number;
    branchesIdentified: number;
    generated: number;
    usedLlm: boolean;
  };
  signals: CoverageSignal[];
  uncovered: UncoveredBranch[];
  generated: GeneratedCase[];
  external?: ExternalCoverage;
  notes: string[];
}

const MAX_ENDPOINTS = 40;
const MAX_PROBES_PER_EP = 3;
const CONCURRENCY = 6;
const PROBE_TIMEOUT = 12_000;

function statusClass(status?: number, error?: string): StatusClass {
  if (error || status === undefined) return 'err';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

function signatureOf(method: string, url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw */ }
  // id-shaped segments → :id so distinct resources collapse to one signature.
  const norm = path.split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s) ? ':id' : s)).join('/');
  return `${(method || 'GET').toUpperCase()} ${norm}`;
}

function topLevelFields(bodyText: string): { fields: string[]; isJson: boolean } {
  try {
    const v = JSON.parse(bodyText);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { fields: Object.keys(v).slice(0, 40), isJson: true };
    if (Array.isArray(v) && v[0] && typeof v[0] === 'object') return { fields: Object.keys(v[0]).slice(0, 40), isJson: true };
    return { fields: [], isJson: true };
  } catch { return { fields: [], isJson: false }; }
}

/** Replace the last id-shaped path segment with a definitely-invalid id, to flush an error path. */
function bogusIdVariant(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/');
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(segs[i]!)) { segs[i] = '999999999'; u.pathname = segs.join('/'); return u.toString(); }
      if (/^[0-9a-f-]{8,}$/i.test(segs[i]!)) { segs[i] = '00000000-0000-0000-0000-000000000000'; u.pathname = segs.join('/'); return u.toString(); }
    }
  } catch { /* ignore */ }
  return null;
}

interface Probe { url: string; omitAuth?: boolean; label: string }

/** The probes for one endpoint: happy path + cheap negative variants that flush other branches. */
function probesFor(ep: CovGuideEndpoint): Probe[] {
  const probes: Probe[] = [{ url: ep.url, label: 'happy-path' }];
  const bogus = bogusIdVariant(ep.url);
  if (bogus) probes.push({ url: bogus, label: 'bogus-id' });
  // If the endpoint carries auth, a stripped-auth probe reveals the 401/403 branch.
  if (ep.auth && ep.auth.type && ep.auth.type !== 'none' && probes.length < MAX_PROBES_PER_EP) {
    probes.push({ url: ep.url, omitAuth: true, label: 'no-auth' });
  }
  return probes.slice(0, MAX_PROBES_PER_EP);
}

async function probeEndpoint(ep: CovGuideEndpoint): Promise<CoverageSignal> {
  const method = (ep.method || 'GET').toUpperCase();
  const sig = signatureOf(method, ep.url);
  const classes = new Set<StatusClass>();
  const statuses = new Set<number>();
  const fields = new Set<string>();
  let contentType: string | undefined;
  let probes = 0;

  for (const p of probesFor(ep)) {
    const { url, init } = buildRequestInit({ ...ep, url: p.url, method }, { omitAuth: p.omitAuth });
    const r = await fetchFull(url, init, PROBE_TIMEOUT);
    probes++;
    classes.add(statusClass(r.status, r.error));
    if (r.status) statuses.add(r.status);
    if (!contentType && r.headers['content-type']) contentType = r.headers['content-type'];
    if (p.label === 'happy-path') { const { fields: f } = topLevelFields(r.bodyText); f.forEach((x) => fields.add(x)); }
  }

  const classArr = [...classes];
  const hasSuccess = classArr.includes('2xx') || classArr.includes('3xx');
  const hasError = classArr.includes('4xx') || classArr.includes('5xx');
  return {
    signature: sig,
    method,
    url: ep.url,
    probes,
    statusClassesSeen: classArr,
    statusesSeen: [...statuses].sort((a, b) => a - b),
    fieldsSeen: [...fields],
    contentType,
    branchComplete: hasSuccess && hasError,
  };
}

/** Diff observed signals → uncovered branches worth a new test. */
function findUncovered(ep: CovGuideEndpoint, sig: CoverageSignal): UncoveredBranch[] {
  const out: UncoveredBranch[] = [];
  const has = (c: StatusClass) => sig.statusClassesSeen.includes(c);

  if (!has('2xx') && !has('3xx')) {
    out.push({ signature: sig.signature, method: sig.method, url: sig.url, kind: 'missing-success-path', detail: `No success response observed (saw ${sig.statusClassesSeen.join(', ') || 'nothing'}). The happy path is untested or the request is malformed.`, suggestion: 'Add a test that exercises a valid request and asserts a 2xx.' });
  }
  if (!has('4xx') && !has('5xx')) {
    out.push({ signature: sig.signature, method: sig.method, url: sig.url, kind: 'missing-error-path', detail: 'No error response was ever produced — the endpoint\'s failure handling (bad id / bad input) is unverified.', suggestion: 'Add a negative test (invalid id or malformed input) asserting a 4xx.' });
  }
  if (ep.auth && ep.auth.type && ep.auth.type !== 'none' && !sig.statusesSeen.some((s) => s === 401 || s === 403)) {
    out.push({ signature: sig.signature, method: sig.method, url: sig.url, kind: 'unverified-auth', detail: 'The endpoint requires auth but a 401/403 was never observed — access control is unverified.', suggestion: 'Add an unauthenticated test asserting 401/403.' });
  }
  const params = (ep.queryParams || []).map((q) => q?.name).filter(Boolean);
  if (params.length) {
    out.push({ signature: sig.signature, method: sig.method, url: sig.url, kind: 'untested-param', detail: `Query parameters never varied across probes: ${params.slice(0, 8).join(', ')}.`, suggestion: 'Add tests varying each parameter (valid, boundary, invalid) and asserting the response.' });
    if (params.some((p) => /page|limit|offset|size|count|per_?page/i.test(String(p)))) {
      out.push({ signature: sig.signature, method: sig.method, url: sig.url, kind: 'no-boundary', detail: 'Pagination/size parameters present but no boundary values were tested.', suggestion: 'Add boundary tests (0, 1, max, negative) for pagination parameters.' });
    }
  }
  return out;
}

/* ── deterministic generation fallback (no LLM) ── */
function templateCases(ep: CovGuideEndpoint, branches: UncoveredBranch[]): GeneratedCase[] {
  const out: GeneratedCase[] = [];
  const method = (ep.method || 'GET').toUpperCase();
  for (const b of branches) {
    if (b.kind === 'missing-error-path') {
      const bogus = bogusIdVariant(ep.url) || ep.url;
      out.push({ title: `Negative: ${method} ${b.signature} returns 4xx for a bad id`, method, url: bogus, rationale: 'Flush the untested error branch with a non-existent resource id.', targets: b.signature, expectedStatusClass: '4xx' });
    } else if (b.kind === 'unverified-auth') {
      out.push({ title: `Auth: ${method} ${b.signature} rejects an unauthenticated request`, method, url: ep.url, rationale: 'Verify access control by calling without credentials.', targets: b.signature, expectedStatusClass: '4xx' });
    } else if (b.kind === 'untested-param' || b.kind === 'no-boundary') {
      for (const p of (ep.queryParams || []).slice(0, 3)) {
        if (!p?.name) continue;
        out.push({ title: `Param: ${method} ${b.signature} with ${p.name}=<boundary>`, method, url: ep.url, rationale: `Exercise the untested "${p.name}" parameter at a boundary value.`, targets: b.signature, queryParams: [{ name: p.name, value: /page|limit|offset|size|count/i.test(p.name) ? '0' : 'invalid' }], expectedStatusClass: '2xx' });
      }
    } else if (b.kind === 'missing-success-path') {
      out.push({ title: `Happy path: ${method} ${b.signature} returns 2xx`, method, url: ep.url, rationale: 'The success branch was never observed — assert a valid request succeeds.', targets: b.signature, expectedStatusClass: '2xx' });
    }
  }
  return out;
}

const LLM_SYSTEM = `You are IntelliQE's coverage-guided API test generator. You are given a set of endpoints, the response "coverage signals" observed when probing them, and a list of UNCOVERED branches (error paths never seen, params never varied, auth never checked). Propose concrete NEW test cases that specifically target the uncovered branches — nothing that merely repeats the happy path.
Return STRICT JSON only: {"cases":[{"title":"","method":"GET","url":"","rationale":"","targets":"<endpoint signature>","queryParams":[{"name":"","value":""}],"body":"","expectedStatusClass":"2xx|4xx|5xx"}]}
Rules: use the real URLs given; keep each rationale to one sentence; propose at most the requested number of cases; prefer negative/error/auth/boundary cases; omit body for GET/HEAD.`;

async function llmCases(endpoints: CovGuideEndpoint[], signals: CoverageSignal[], uncovered: UncoveredBranch[], llm: LlmConfig, max: number): Promise<GeneratedCase[] | null> {
  const payload = {
    endpoints: endpoints.slice(0, MAX_ENDPOINTS).map((e) => ({ method: (e.method || 'GET').toUpperCase(), url: e.url, title: e.title, queryParams: (e.queryParams || []).map((q) => q?.name).filter(Boolean) })),
    signals: signals.map((s) => ({ signature: s.signature, statusClassesSeen: s.statusClassesSeen, fieldsSeen: s.fieldsSeen.slice(0, 12), branchComplete: s.branchComplete })),
    uncovered: uncovered.slice(0, 40),
    maxCases: max,
  };
  try {
    const resp = await runLLM(JSON.stringify(payload), { system: LLM_SYSTEM, maxTokens: 4000, llm });
    const parsed = parseJsonFromResponse(resp) as { cases?: any[] } | null;
    if (!parsed || !Array.isArray(parsed.cases)) return null;
    return parsed.cases.slice(0, max).map((c: any) => ({
      title: String(c?.title || 'Generated case').slice(0, 200),
      method: String(c?.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET',
      url: String(c?.url || '').slice(0, 4000),
      rationale: String(c?.rationale || '').slice(0, 400),
      targets: String(c?.targets || '').slice(0, 200),
      queryParams: Array.isArray(c?.queryParams) ? c.queryParams.filter((q: any) => q?.name).slice(0, 10).map((q: any) => ({ name: String(q.name).slice(0, 80), value: String(q.value ?? '').slice(0, 200) })) : undefined,
      body: typeof c?.body === 'string' && c.body ? c.body.slice(0, 8000) : undefined,
      expectedStatusClass: ['2xx', '3xx', '4xx', '5xx'].includes(String(c?.expectedStatusClass)) ? c.expectedStatusClass : undefined,
    })).filter((c: GeneratedCase) => /^https?:\/\//i.test(c.url));
  } catch { return null; }
}

/* ── external coverage report ingestion ── */

/** Parse an lcov.info document into per-file line/branch coverage. */
function parseLcov(text: string): ExternalCoverage {
  const files: { file: string; lf: number; lh: number; brf: number; brh: number }[] = [];
  let cur: { file: string; lf: number; lh: number; brf: number; brh: number } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) cur = { file: line.slice(3), lf: 0, lh: 0, brf: 0, brh: 0 };
    else if (!cur) continue;
    else if (line.startsWith('LF:')) cur.lf = Number(line.slice(3)) || 0;
    else if (line.startsWith('LH:')) cur.lh = Number(line.slice(3)) || 0;
    else if (line.startsWith('BRF:')) cur.brf = Number(line.slice(4)) || 0;
    else if (line.startsWith('BRH:')) cur.brh = Number(line.slice(4)) || 0;
    else if (line === 'end_of_record') { if (cur) files.push(cur); cur = null; }
  }
  const lf = files.reduce((a, f) => a + f.lf, 0), lh = files.reduce((a, f) => a + f.lh, 0);
  const brf = files.reduce((a, f) => a + f.brf, 0), brh = files.reduce((a, f) => a + f.brh, 0);
  const uncoveredFiles = files
    .filter((f) => f.lf > f.lh)
    .map((f) => ({ file: f.file, uncoveredLines: f.lf - f.lh, branchesPct: f.brf ? Math.round((f.brh / f.brf) * 100) : undefined }))
    .sort((a, b) => (b.uncoveredLines || 0) - (a.uncoveredLines || 0))
    .slice(0, 50);
  return { source: 'lcov', linesPct: lf ? Math.round((lh / lf) * 100) : undefined, branchesPct: brf ? Math.round((brh / brf) * 100) : undefined, totalFiles: files.length, uncoveredFiles, mappedEndpoints: [] };
}

/** Parse an istanbul json-summary ({ "path": { lines:{pct}, branches:{pct}, functions:{pct} } }). */
function parseIstanbul(json: any): ExternalCoverage {
  const total = json.total || {};
  const files: { file: string; linesPct: number; branchesPct?: number }[] = [];
  for (const key of Object.keys(json)) {
    if (key === 'total') continue;
    const e = json[key];
    if (e && e.lines && typeof e.lines.pct === 'number') files.push({ file: key, linesPct: e.lines.pct, branchesPct: e.branches?.pct });
  }
  const uncoveredFiles = files
    .filter((f) => f.linesPct < 100)
    .map((f) => ({ file: f.file, branchesPct: typeof f.branchesPct === 'number' ? Math.round(f.branchesPct) : undefined, uncoveredLines: undefined }))
    .sort((a, b) => (a.branchesPct ?? 100) - (b.branchesPct ?? 100))
    .slice(0, 50);
  return {
    source: 'istanbul-json',
    linesPct: typeof total.lines?.pct === 'number' ? Math.round(total.lines.pct) : undefined,
    branchesPct: typeof total.branches?.pct === 'number' ? Math.round(total.branches.pct) : undefined,
    functionsPct: typeof total.functions?.pct === 'number' ? Math.round(total.functions.pct) : undefined,
    totalFiles: files.length,
    uncoveredFiles,
    mappedEndpoints: [],
  };
}

function ingestExternal(raw: string, endpoints: CovGuideEndpoint[]): ExternalCoverage | undefined {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  let cov: ExternalCoverage;
  if (/^\s*[{[]/.test(text)) { try { cov = parseIstanbul(JSON.parse(text)); } catch { return undefined; } }
  else if (/(^|\n)SF:/.test(text)) cov = parseLcov(text);
  else return undefined;

  // Heuristic map: an uncovered file → the endpoint whose path shares the most tokens with the file basename.
  const eps = endpoints.map((e) => { let path = e.url; try { path = new URL(e.url).pathname; } catch { /* keep */ } return { sig: `${(e.method || 'GET').toUpperCase()} ${path}`, tokens: new Set(path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) }; });
  for (const uf of cov.uncoveredFiles.slice(0, 20)) {
    const base = uf.file.toLowerCase().split(/[\\/]/).pop() || uf.file.toLowerCase();
    const fileTokens = base.replace(/\.[a-z]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    let best: { sig: string; score: number } | null = null;
    for (const e of eps) { const score = fileTokens.filter((t) => e.tokens.has(t)).length; if (score > 0 && (!best || score > best.score)) best = { sig: e.sig, score }; }
    if (best) cov.mappedEndpoints.push({ file: uf.file, endpoint: best.sig });
  }
  return cov;
}

/* ── normalisation ── */
function normalize(raw: unknown): CovGuideEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: CovGuideEndpoint[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, any>;
    const url = String(o.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id: o.id ? String(o.id) : undefined,
      title: o.title ? String(o.title) : undefined,
      method: String(o.method || 'GET').toUpperCase(),
      url,
      headers: Array.isArray(o.headers) ? o.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
      auth: o.auth && typeof o.auth === 'object' ? { type: String(o.auth.type || 'none'), value: o.auth.value ? String(o.auth.value) : undefined, headerName: o.auth.headerName ? String(o.auth.headerName) : undefined } : undefined,
      body: o.body ? String(o.body) : undefined,
      queryParams: Array.isArray(o.queryParams) ? o.queryParams.map((q: any) => ({ name: String(q?.name ?? q ?? '') })).filter((q: any) => q.name) : undefined,
    });
  }
  return out;
}

export async function runCoverageGuided(
  rawEndpoints: unknown,
  opts: { allowWrites?: boolean; externalCoverage?: string; maxGenerate?: number; llm?: LlmConfig } = {},
): Promise<CovGuideResult> {
  const all = normalize(rawEndpoints);
  const notes: string[] = [];
  if (!all.length) throw new Error('Send at least one endpoint with an http(s) URL.');

  const probeable = all.filter((e) => opts.allowWrites || !isWriteMethod(e.method));
  const skipped = all.length - probeable.length;
  if (skipped) notes.push(`${skipped} write endpoint${skipped === 1 ? '' : 's'} skipped (enable "probe writes" to include them — negative probes will send real requests).`);

  // Probe pass (bounded concurrency).
  const signals: CoverageSignal[] = new Array(probeable.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < probeable.length) {
      const i = next++;
      try { signals[i] = await probeEndpoint(probeable[i]!); }
      catch (e) { const ep = probeable[i]!; signals[i] = { signature: signatureOf(ep.method, ep.url), method: (ep.method || 'GET').toUpperCase(), url: ep.url, probes: 0, statusClassesSeen: ['err'], statusesSeen: [], fieldsSeen: [], branchComplete: false }; void e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, probeable.length) }, worker));

  const totalProbes = signals.reduce((a, s) => a + (s?.probes || 0), 0);

  // Uncovered branches.
  const uncovered: UncoveredBranch[] = [];
  for (let i = 0; i < probeable.length; i++) { if (signals[i]) uncovered.push(...findUncovered(probeable[i]!, signals[i]!)); }

  // External coverage (optional).
  const external = opts.externalCoverage ? ingestExternal(opts.externalCoverage, all) : undefined;
  if (opts.externalCoverage && !external) notes.push('External coverage report was not recognised (expected an lcov.info or an istanbul json-summary).');

  // Generation toward the uncovered branches.
  const max = Math.min(60, Math.max(0, Number(opts.maxGenerate ?? 20)));
  let generated: GeneratedCase[] = [];
  let usedLlm = false;
  if (max > 0 && uncovered.length) {
    if (opts.llm) { const g = await llmCases(probeable, signals, uncovered, opts.llm, max); if (g && g.length) { generated = g; usedLlm = true; } }
    if (!generated.length) {
      // Deterministic fallback, grouped per endpoint.
      const byEp = new Map<string, UncoveredBranch[]>();
      for (const b of uncovered) { const k = b.signature; if (!byEp.has(k)) byEp.set(k, []); byEp.get(k)!.push(b); }
      for (const ep of probeable) { const sig = signatureOf(ep.method, ep.url); const bs = byEp.get(sig); if (bs) generated.push(...templateCases(ep, bs)); }
      generated = generated.slice(0, max);
      if (opts.llm && !usedLlm) notes.push('LLM generation was unavailable or returned nothing — used deterministic templates.');
    }
  }

  const complete = signals.filter((s) => s?.branchComplete).length;
  const responseCoveragePct = external?.branchesPct ?? (probeable.length ? Math.round((complete / probeable.length) * 100) : 0);

  return {
    summary: { endpoints: all.length, probes: totalProbes, responseCoveragePct, branchesIdentified: uncovered.length, generated: generated.length, usedLlm },
    signals,
    uncovered,
    generated,
    external,
    notes,
  };
}
