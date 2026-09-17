/**
 * api-intelligence.service.ts
 * ───────────────────────────
 * Understands an API BEFORE anything is automated.
 *
 * Given the imported endpoint catalogue it derives an `ApiProfile`: the API
 * style (REST / GraphQL / SOAP / JSON-RPC / webhook / MCP), how its resources
 * are shaped (which paths form a CRUD set, what the id parameter is), how it
 * is protected, whether it paginates, which endpoints depend on which (a POST
 * that mints the id a GET/PUT/DELETE needs), the end-to-end flows those
 * dependencies imply, the risks a reviewer should know about, and — from all
 * of that — a recommended test strategy with per-layer estimates.
 *
 * The profile feeds three consumers:
 *   • the dashboard, which renders it as "Insights" so the reviewer sees what
 *     the platform understood;
 *   • the scenario generator, which receives it as pattern context so every
 *     suite is grounded in the API's real shape (realistic ids, sibling
 *     endpoints, the auth scheme, pagination parameters);
 *   • flow generation, which turns each lifecycle dependency chain into a
 *     multi-step scenario.
 *
 * Everything here is deterministic. An optional LLM pass adds a short
 * narrative on top — never a substitute for the structural analysis.
 */
import { runLLM, parseJsonFromResponse, coerceJsonArray, type LlmConfig } from '../agents/claude-runner.js';
import type { ImportedEndpoint, ApiStyle } from './api-import.service.js';

/* ────────────────────────────────────────────────────────────────
   Types
   ──────────────────────────────────────────────────────────────── */

export type CrudOp = 'list' | 'create' | 'read' | 'update' | 'delete';

export interface ApiResource {
  name: string;
  /** Normalised path template, e.g. `/v1/users/{id}`. */
  pattern: string;
  host: string;
  /** Indices into the endpoint list. */
  endpoints: number[];
  operations: Partial<Record<CrudOp, number>> & { other: number[] };
  /** How many of the five CRUD operations are present. */
  crudScore: number;
  idParam?: string;
  /** Parent resource name when the path nests (`/users/{id}/orders`). */
  parent?: string;
}

export interface ApiDependency {
  from: number;
  to: number;
  kind: 'creates-id' | 'parent-child' | 'auth-token';
  reason: string;
}

export interface ApiFlow {
  id: string;
  name: string;
  resource: string;
  /** Ordered endpoint indices. */
  steps: number[];
  description: string;
}

export interface ApiRisk {
  level: 'high' | 'medium' | 'low';
  text: string;
  endpoints?: number[];
}

export type StrategyLayerId = 'smoke' | 'contract' | 'schema' | 'negative' | 'auth' | 'security' | 'performance' | 'flow';

export interface StrategyLayer {
  id: StrategyLayerId;
  label: string;
  enabled: boolean;
  estimatedCases: number;
  rationale: string;
}

export interface ApiProfile {
  style: ApiStyle | 'mixed';
  styles: Record<string, number>;
  hosts: string[];
  versions: string[];
  totalEndpoints: number;
  methods: Record<string, number>;
  resources: ApiResource[];
  auth: { schemes: Record<string, number>; protected: number; public: number; mixed: boolean };
  pagination: { detected: boolean; params: string[]; endpoints: number[] };
  filtering: { params: string[] };
  contentTypes: string[];
  withExamples: number;
  dependencies: ApiDependency[];
  flows: ApiFlow[];
  risks: ApiRisk[];
  /** Short, human-readable statements of what was recognised. */
  patterns: string[];
  strategy: {
    layers: StrategyLayer[];
    recommendedCoverage: 'essential' | 'standard' | 'exhaustive';
    estimatedTotal: number;
    rationale: string;
  };
  summary: string;
  /** Optional narrative from the LLM pass. */
  insights?: string[];
  analyzedAt: string;
}

/* ────────────────────────────────────────────────────────────────
   Path normalisation
   ──────────────────────────────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function isIdSegment(seg: string): boolean {
  return /^\{.+\}$/.test(seg) || /^:[A-Za-z_]/.test(seg) || /^\d+$/.test(seg) || UUID_RE.test(seg) || OBJECT_ID_RE.test(seg) || /^<.+>$/.test(seg);
}

function isVersionSegment(seg: string): boolean {
  return /^v\d+(\.\d+)*$/i.test(seg);
}

/** `/v1/users/123/orders/{orderId}` → `/v1/users/{id}/orders/{id}` */
export function normalisePath(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean);
  return '/' + segs.map((s) => (isIdSegment(s) ? '{id}' : s.toLowerCase())).join('/');
}

function splitUrl(url: string): { host: string; path: string; query: URLSearchParams } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname, query: u.searchParams };
  } catch {
    return { host: '', path: url, query: new URLSearchParams() };
  }
}

/* ────────────────────────────────────────────────────────────────
   Analysis
   ──────────────────────────────────────────────────────────────── */

const PAGINATION_PARAMS = ['page', 'limit', 'offset', 'per_page', 'perpage', 'pagesize', 'page_size', 'cursor', 'after', 'before', 'next', 'skip', 'top', '$top', '$skip', 'start', 'size', 'pagetoken', 'page_token'];
const FILTER_PARAMS = ['sort', 'order', 'orderby', 'order_by', 'filter', 'q', 'query', 'search', 'fields', 'include', 'expand', 'status', 'type', 'from', 'to', 'since', 'until'];

export function analyzeApiSurface(endpoints: ImportedEndpoint[]): ApiProfile {
  const n = endpoints.length;
  const styles: Record<string, number> = {};
  const methods: Record<string, number> = {};
  const hosts = new Set<string>();
  const versions = new Set<string>();
  const authSchemes: Record<string, number> = {};
  const contentTypes = new Set<string>();
  const paginationParams = new Set<string>();
  const paginationEndpoints: number[] = [];
  const filterParams = new Set<string>();
  let withExamples = 0;
  let protectedCount = 0;

  // Resource buckets: keyed by host + collection pattern (the path with a
  // trailing {id} removed), so `/users` and `/users/{id}` land together.
  const buckets = new Map<string, ApiResource>();

  endpoints.forEach((ep, i) => {
    const style = ep.style || (ep.body && /"query"\s*:/.test(ep.body) ? 'graphql' : 'rest');
    styles[style] = (styles[style] || 0) + 1;
    const m = (ep.method || 'GET').toUpperCase();
    methods[m] = (methods[m] || 0) + 1;
    const { host, path, query } = splitUrl(ep.url);
    if (host) hosts.add(host);
    for (const seg of path.split('/')) if (isVersionSegment(seg)) versions.add(seg.toLowerCase());
    const scheme = ep.auth?.type || 'none';
    authSchemes[scheme] = (authSchemes[scheme] || 0) + 1;
    if (scheme !== 'none') protectedCount++;
    if (ep.expectedResponse?.trim()) withExamples++;
    const ct = (ep.headers || []).find((h) => h.key.toLowerCase() === 'content-type')?.value;
    if (ct) contentTypes.add(ct.split(';')[0]!.trim().toLowerCase());

    const qNames = [...query.keys(), ...(ep.queryParams || []).map((q) => q.name)].map((k) => k.toLowerCase());
    let paginates = false;
    for (const k of qNames) {
      if (PAGINATION_PARAMS.includes(k)) { paginationParams.add(k); paginates = true; }
      if (FILTER_PARAMS.includes(k)) filterParams.add(k);
    }
    if (paginates) paginationEndpoints.push(i);

    if (style !== 'rest' && style !== 'webhook') {
      // GraphQL / MCP / SOAP operations are grouped by their own resource label.
      const key = `${host}|${ep.resource || style}`;
      const r = buckets.get(key) || { name: ep.resource || style, pattern: normalisePath(path), host, endpoints: [], operations: { other: [] }, crudScore: 0 };
      r.endpoints.push(i);
      r.operations.other.push(i);
      buckets.set(key, r);
      return;
    }

    const norm = normalisePath(ep.pathTemplate ? ep.pathTemplate.split('?')[0]! : path);
    const segs = norm.split('/').filter(Boolean);
    const endsWithId = segs.length > 0 && segs[segs.length - 1] === '{id}';
    const collectionSegs = endsWithId ? segs.slice(0, -1) : segs;
    const collectionPattern = '/' + collectionSegs.join('/');
    const nameSeg = [...collectionSegs].reverse().find((s) => s !== '{id}' && !isVersionSegment(s)) || 'root';
    const parentSeg = (() => {
      const idx = collectionSegs.lastIndexOf('{id}');
      if (idx <= 0) return undefined;
      return [...collectionSegs.slice(0, idx)].reverse().find((s) => s !== '{id}' && !isVersionSegment(s));
    })();
    const key = `${host}|${collectionPattern}`;
    const r = buckets.get(key) || {
      name: nameSeg, pattern: collectionPattern, host, endpoints: [], operations: { other: [] }, crudScore: 0,
      parent: parentSeg,
    };
    r.endpoints.push(i);
    const op: CrudOp | null =
      m === 'GET' && !endsWithId ? 'list'
      : m === 'GET' && endsWithId ? 'read'
      : m === 'POST' && !endsWithId ? 'create'
      : (m === 'PUT' || m === 'PATCH') && endsWithId ? 'update'
      : m === 'DELETE' && endsWithId ? 'delete'
      : null;
    if (op && r.operations[op] === undefined) r.operations[op] = i;
    else r.operations.other.push(i);
    if (endsWithId) {
      const raw = (ep.pathTemplate || path).split('/').filter(Boolean);
      const last = raw[raw.length - 1] || '';
      if (/^\{.+\}$|^:/.test(last)) r.idParam = last.replace(/[{}:]/g, '');
      else if (!r.idParam) r.idParam = 'id';
    }
    buckets.set(key, r);
  });

  const resources = [...buckets.values()].map((r) => ({
    ...r,
    crudScore: (['list', 'create', 'read', 'update', 'delete'] as CrudOp[]).filter((k) => r.operations[k] !== undefined).length,
  })).sort((a, b) => b.endpoints.length - a.endpoints.length || a.pattern.localeCompare(b.pattern));

  /* ── Dependencies & flows ── */
  const dependencies: ApiDependency[] = [];
  const flows: ApiFlow[] = [];
  const byName = new Map(resources.map((r) => [`${r.host}|${r.name}`, r]));
  for (const r of resources) {
    const { create, read, update, delete: del, list } = r.operations;
    if (create !== undefined) {
      for (const [op, idx] of [['read', read], ['update', update], ['delete', del]] as const) {
        if (idx !== undefined) dependencies.push({ from: create, to: idx, kind: 'creates-id', reason: `${op} needs the ${r.idParam || 'id'} that create returns` });
      }
    }
    if (r.parent) {
      const parent = byName.get(`${r.host}|${r.parent}`);
      if (parent?.operations.create !== undefined) {
        for (const idx of r.endpoints) dependencies.push({ from: parent.operations.create, to: idx, kind: 'parent-child', reason: `nested under ${parent.name} — needs an existing ${parent.name} id` });
      }
    }
    // Lifecycle flow: create → read → update → read (verify) → delete → read (gone)
    if (create !== undefined && (read !== undefined || update !== undefined || del !== undefined)) {
      const steps: number[] = [create];
      const names: string[] = ['create'];
      if (read !== undefined) { steps.push(read); names.push('read'); }
      if (update !== undefined) { steps.push(update); names.push('update'); if (read !== undefined) { steps.push(read); names.push('verify'); } }
      if (del !== undefined) { steps.push(del); names.push('delete'); if (read !== undefined) { steps.push(read); names.push('confirm-gone'); } }
      flows.push({
        id: `flow-${r.name}-lifecycle`,
        name: `${r.name} lifecycle`,
        resource: r.name,
        steps,
        description: `${names.join(' → ')}: exercise the full ${r.name} lifecycle on the ${r.idParam || 'id'} minted by create.`,
      });
    } else if (list !== undefined && read !== undefined) {
      flows.push({
        id: `flow-${r.name}-browse`,
        name: `${r.name} browse`,
        resource: r.name,
        steps: [list, read],
        description: `list → read: take an ${r.idParam || 'id'} from the collection and fetch it individually, asserting the two agree.`,
      });
    }
  }

  /* ── Risks ── */
  const risks: ApiRisk[] = [];
  const placeholderHosts = endpoints.map((e, i) => ({ e, i })).filter(({ e }) => /^https?:\/\/(api\.example\.com|example\.(com|org|net)|localhost:0)(\/|$)/i.test(e.url)).map(({ i }) => i);
  if (placeholderHosts.length) risks.push({ level: 'high', text: `${placeholderHosts.length} endpoint${placeholderHosts.length === 1 ? ' uses' : 's use'} a placeholder host (api.example.com) — the import had no server URL. Set the real base URL in an Environment before executing.`, endpoints: placeholderHosts });
  const unprotectedWrites = endpoints.map((e, i) => ({ e, i })).filter(({ e }) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method) && (e.auth?.type || 'none') === 'none' && e.style !== 'webhook').map(({ i }) => i);
  if (unprotectedWrites.length && protectedCount > 0) risks.push({ level: 'medium', text: `${unprotectedWrites.length} write endpoint${unprotectedWrites.length === 1 ? '' : 's'} declare no authentication while the rest of the API is protected — verify these are genuinely public.`, endpoints: unprotectedWrites });
  const insecure = endpoints.map((e, i) => ({ e, i })).filter(({ e }) => /^http:\/\//i.test(e.url) && !/localhost|127\.0\.0\.1/.test(e.url)).map(({ i }) => i);
  if (insecure.length) risks.push({ level: 'medium', text: `${insecure.length} endpoint${insecure.length === 1 ? ' is' : 's are'} served over plain HTTP.`, endpoints: insecure });
  const noExample = n - withExamples;
  if (noExample > 0 && n > 0) risks.push({ level: 'low', text: `${noExample} of ${n} endpoints carry no example response — schema assertions for them are inferred from the live response on the first run.` });
  const missingCreds = endpoints.map((e, i) => ({ e, i })).filter(({ e }) => (e.auth?.type || 'none') !== 'none' && !e.auth?.value).map(({ i }) => i);
  if (missingCreds.length) risks.push({ level: 'high', text: `${missingCreds.length} protected endpoint${missingCreds.length === 1 ? ' has' : 's have'} no credential configured — authenticated scenarios will fail with 401 until one is supplied (Environments → secrets).`, endpoints: missingCreds });
  const deprecated = endpoints.map((e, i) => ({ e, i })).filter(({ e }) => e.deprecated).map(({ i }) => i);
  if (deprecated.length) risks.push({ level: 'low', text: `${deprecated.length} endpoint${deprecated.length === 1 ? ' is' : 's are'} marked deprecated in the spec.`, endpoints: deprecated });
  const deletesNoFlow = resources.filter((r) => r.operations.delete !== undefined && r.operations.create === undefined);
  if (deletesNoFlow.length) risks.push({ level: 'medium', text: `DELETE exists without a matching create for: ${deletesNoFlow.map((r) => r.name).join(', ')} — destructive scenarios will target existing data. Point the run at a disposable environment.` });

  /* ── Patterns (what was recognised) ── */
  const patterns: string[] = [];
  const styleKeys = Object.keys(styles);
  const style: ApiProfile['style'] = styleKeys.length === 1 ? (styleKeys[0] as ApiStyle) : styleKeys.length ? 'mixed' : 'rest';
  patterns.push(style === 'mixed' ? `Mixed API styles: ${styleKeys.map((k) => `${k} (${styles[k]})`).join(', ')}` : `${labelStyle(style)} API`);
  const fullCrud = resources.filter((r) => r.crudScore >= 4);
  const partialCrud = resources.filter((r) => r.crudScore >= 2 && r.crudScore < 4);
  if (fullCrud.length) patterns.push(`Full CRUD resource${fullCrud.length === 1 ? '' : 's'}: ${fullCrud.slice(0, 6).map((r) => `${r.name} (${r.crudScore}/5)`).join(', ')}${fullCrud.length > 6 ? '…' : ''}`);
  if (partialCrud.length) patterns.push(`Partial CRUD: ${partialCrud.slice(0, 6).map((r) => `${r.name} (${r.crudScore}/5)`).join(', ')}${partialCrud.length > 6 ? '…' : ''}`);
  const nested = resources.filter((r) => r.parent);
  if (nested.length) patterns.push(`Nested resources: ${nested.slice(0, 5).map((r) => `${r.parent} → ${r.name}`).join(', ')}`);
  if (versions.size) patterns.push(`Versioned paths (${[...versions].join(', ')})`);
  if (paginationParams.size) patterns.push(`Pagination via ${[...paginationParams].join(', ')} on ${paginationEndpoints.length} endpoint${paginationEndpoints.length === 1 ? '' : 's'}`);
  if (filterParams.size) patterns.push(`Filtering/sorting via ${[...filterParams].slice(0, 6).join(', ')}`);
  const schemeNames = Object.keys(authSchemes).filter((k) => k !== 'none');
  if (schemeNames.length) patterns.push(`${schemeNames.map(labelAuth).join(' + ')} protected (${protectedCount}/${n})`);
  else if (n) patterns.push('No authentication declared');
  if (hosts.size > 1) patterns.push(`${hosts.size} hosts: ${[...hosts].slice(0, 3).join(', ')}${hosts.size > 3 ? '…' : ''}`);
  if (contentTypes.size) patterns.push(`Content types: ${[...contentTypes].join(', ')}`);
  if (flows.length) patterns.push(`${flows.length} end-to-end flow${flows.length === 1 ? '' : 's'} inferred from create/read/update/delete chains`);

  /* ── Strategy ── */
  const writes = endpoints.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)).length;
  const reads = n - writes;
  const withParams = endpoints.filter((e) => /[?{:]/.test(e.pathTemplate || '') || splitUrl(e.url).query.toString() || (e.pathParams?.length || 0) > 0 || /\/\d+(\/|$)/.test(splitUrl(e.url).path)).length;
  const layers: StrategyLayer[] = [
    { id: 'smoke', label: 'Smoke', enabled: true, estimatedCases: n, rationale: 'One documented happy-path request per endpoint — proves reachability and the expected status.' },
    { id: 'contract', label: 'Contract', enabled: true, estimatedCases: n, rationale: 'Status code, content-type and response-time guard on every endpoint.' },
    { id: 'schema', label: 'Schema', enabled: withExamples > 0, estimatedCases: withExamples, rationale: withExamples ? `Field-level type and value assertions for the ${withExamples} endpoints that carry an example response.` : 'No example responses were imported — schema checks are inferred on the first run.' },
    { id: 'negative', label: 'Negative', enabled: true, estimatedCases: writes * 3 + reads * 2, rationale: 'Unknown ids, malformed input, missing required fields, wrong method, malformed JSON on writes.' },
    { id: 'auth', label: 'Auth', enabled: protectedCount > 0, estimatedCases: protectedCount * 2, rationale: protectedCount ? `Missing and malformed credentials on the ${protectedCount} protected endpoints → 401/403.` : 'Nothing is protected — no auth scenarios apply.' },
    { id: 'security', label: 'Security', enabled: withParams > 0, estimatedCases: withParams, rationale: 'Injection-shaped values in path/query/body must be rejected cleanly and never echoed back.' },
    { id: 'performance', label: 'Performance', enabled: true, estimatedCases: n, rationale: 'Response-time ceiling on the happy path of every endpoint; trends surface on the dashboard.' },
    { id: 'flow', label: 'Flows', enabled: flows.length > 0, estimatedCases: flows.length, rationale: flows.length ? `${flows.length} lifecycle flow${flows.length === 1 ? '' : 's'} chaining create → read → update → delete on real ids.` : 'No create/read/update/delete chains were detected.' },
  ];
  const recommendedCoverage: ApiProfile['strategy']['recommendedCoverage'] = n <= 6 ? 'exhaustive' : n <= 40 ? 'standard' : 'essential';
  const estimatedTotal = layers.filter((l) => l.enabled).reduce((s, l) => s + l.estimatedCases, 0);
  const strategyRationale =
    recommendedCoverage === 'exhaustive' ? 'A small surface — every validation angle is affordable, so exhaustive depth is recommended.'
    : recommendedCoverage === 'standard' ? 'A medium surface — a professional regression suite per endpoint keeps the run under control.'
    : 'A large surface — start with the critical path per endpoint (essential depth) and widen once the smoke layer is green.';

  const summary = `${n} endpoint${n === 1 ? '' : 's'} across ${resources.length} resource${resources.length === 1 ? '' : 's'} on ${hosts.size || 1} host${hosts.size === 1 || hosts.size === 0 ? '' : 's'} — ${labelStyle(style)}, ${schemeNames.length ? schemeNames.map(labelAuth).join('/') : 'no'} auth, ${flows.length} flow${flows.length === 1 ? '' : 's'}, ${risks.filter((r) => r.level === 'high').length} high-risk finding${risks.filter((r) => r.level === 'high').length === 1 ? '' : 's'}.`;

  return {
    style,
    styles,
    hosts: [...hosts],
    versions: [...versions],
    totalEndpoints: n,
    methods,
    resources,
    auth: { schemes: authSchemes, protected: protectedCount, public: n - protectedCount, mixed: protectedCount > 0 && protectedCount < n },
    pagination: { detected: paginationParams.size > 0, params: [...paginationParams], endpoints: paginationEndpoints },
    filtering: { params: [...filterParams] },
    contentTypes: [...contentTypes],
    withExamples,
    dependencies,
    flows,
    risks,
    patterns,
    strategy: { layers, recommendedCoverage, estimatedTotal, rationale: strategyRationale },
    summary,
    analyzedAt: new Date().toISOString(),
  };
}

function labelStyle(s: string): string {
  return s === 'rest' ? 'REST' : s === 'graphql' ? 'GraphQL' : s === 'soap' ? 'SOAP' : s === 'jsonrpc' ? 'JSON-RPC' : s === 'mcp' ? 'MCP' : s === 'webhook' ? 'Webhook' : s;
}
function labelAuth(s: string): string {
  return s === 'bearer' ? 'Bearer' : s === 'basic' ? 'Basic' : s === 'apikey' ? 'API-key' : s;
}

/* ────────────────────────────────────────────────────────────────
   Pattern context for the generator
   ──────────────────────────────────────────────────────────────── */

/**
 * The profile, rendered as prompt context for ONE endpoint. Tells the scenario
 * designer what the API looks like around this endpoint — its resource's other
 * operations, the id it uses, the auth scheme, pagination parameters — so the
 * negative and edge cases it designs are grounded in the real API rather than
 * generic guesses.
 */
export function profileContextFor(profile: ApiProfile, endpoints: ImportedEndpoint[], index: number): string {
  const ep = endpoints[index];
  if (!ep) return '';
  const res = profile.resources.find((r) => r.endpoints.includes(index));
  const lines: string[] = [];
  lines.push(`API PATTERN CONTEXT (derived by analysing the whole imported surface — ${profile.totalEndpoints} endpoints):`);
  lines.push(`- Style: ${labelStyle(profile.style)}${profile.versions.length ? `; versioned paths (${profile.versions.join(', ')})` : ''}`);
  lines.push(`- Auth across the API: ${Object.entries(profile.auth.schemes).map(([k, v]) => `${labelAuth(k)} ×${v}`).join(', ')}${profile.auth.mixed ? ' (mixed — some endpoints are public)' : ''}`);
  if (profile.pagination.detected) lines.push(`- Pagination parameters in use: ${profile.pagination.params.join(', ')} — for list endpoints add boundary cases (page 0, negative limit, oversized limit, non-numeric).`);
  if (profile.filtering.params.length) lines.push(`- Filtering/sorting parameters in use: ${profile.filtering.params.join(', ')} — invalid sort fields and filter values are valid negative cases.`);
  if (res) {
    const ops = (['list', 'create', 'read', 'update', 'delete'] as CrudOp[]).filter((k) => res.operations[k] !== undefined);
    lines.push(`- This endpoint belongs to the "${res.name}" resource (${res.pattern}) which exposes: ${ops.length ? ops.join(', ') : 'non-CRUD operations'}${res.idParam ? `; id parameter "${res.idParam}"` : ''}${res.parent ? `; nested under "${res.parent}"` : ''}.`);
    const siblings = res.endpoints.filter((i) => i !== index).slice(0, 6).map((i) => `${endpoints[i]!.method} ${splitUrl(endpoints[i]!.url).path}`);
    if (siblings.length) lines.push(`- Sibling operations on the same resource: ${siblings.join('; ')}`);
    const deps = profile.dependencies.filter((d) => d.to === index || d.from === index);
    if (deps.length) lines.push(`- Dependencies: ${deps.slice(0, 4).map((d) => `${d.from === index ? 'this endpoint' : `${endpoints[d.from]!.method} ${splitUrl(endpoints[d.from]!.url).path}`} → ${d.to === index ? 'this endpoint' : `${endpoints[d.to]!.method} ${splitUrl(endpoints[d.to]!.url).path}`} (${d.reason})`).join('; ')}`);
  }
  const risk = profile.risks.find((r) => r.endpoints?.includes(index));
  if (risk) lines.push(`- Reviewer note: ${risk.text}`);
  lines.push('Use this context to choose REALISTIC ids, parameters and negative variations; never invent endpoints that are not listed.');
  return lines.join('\n');
}

/* ────────────────────────────────────────────────────────────────
   Optional LLM narrative
   ──────────────────────────────────────────────────────────────── */

export async function enrichProfileWithLlm(profile: ApiProfile, endpoints: ImportedEndpoint[], llm: LlmConfig): Promise<string[]> {
  const catalogue = endpoints.slice(0, 80).map((e, i) => `${i + 1}. ${e.method} ${splitUrl(e.url).path}${e.title ? ` — ${e.title.slice(0, 60)}` : ''}`).join('\n');
  const prompt = `You are a principal API test architect reviewing an API surface before automation. Below is the structural profile our analyser derived and the endpoint catalogue. Return a STRICT JSON ARRAY of 4 to 7 short strings (each one sentence, max 200 characters) with the insights a senior engineer would add: the business domain this API serves, the riskiest areas to test first, data-setup considerations, sequencing/ordering concerns, and anything the structural analysis likely missed. No markdown, no prose outside the array.

PROFILE:
${JSON.stringify({ style: profile.style, hosts: profile.hosts, resources: profile.resources.map((r) => ({ name: r.name, pattern: r.pattern, crud: r.crudScore, parent: r.parent })), auth: profile.auth, pagination: profile.pagination, flows: profile.flows.map((f) => f.name), risks: profile.risks.map((r) => r.text) }, null, 1).slice(0, 6000)}

ENDPOINTS:
${catalogue}

Return the JSON array now.`;
  const res = await runLLM(prompt, { maxTokens: 1500, llm });
  try {
    const arr = coerceJsonArray<unknown>(parseJsonFromResponse<unknown>(res)) || [];
    return arr.map((x) => String(x)).filter((s) => s.trim()).slice(0, 8);
  } catch {
    return res.split('\n').map((l) => l.replace(/^[-*\d.\s"]+|["\s,]+$/g, '').trim()).filter((l) => l.length > 20).slice(0, 6);
  }
}
