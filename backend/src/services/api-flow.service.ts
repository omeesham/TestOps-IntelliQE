/**
 * api-flow.service.ts
 * ───────────────────
 * Visual flow / journey runner. A "flow" is an ordered list of HTTP steps where
 * each step can EXTRACT values from its response into named variables, and later
 * steps SUBSTITUTE those variables ({{name}}) into their url / headers / body.
 * This is the engine behind the no-code multi-step journey builder (ACCELQ /
 * Leapwork parity): a non-engineer assembles a journey, we run it end-to-end and
 * report per-step results.
 *
 * Standalone and opt-in: it reuses only the shared HTTP helper and never the
 * generate → execute → heal pipeline. Saved flows live in their own table and
 * are never read by generation. Write steps are refused unless explicitly allowed.
 */
import { randomUUID } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import pool from '../db.js';
import { buildRequestInit, fetchFull, isWriteMethod, clampInt, type HttpEndpoint, type HttpAuth, type HttpFormField } from '../utils/api-http.js';
import { resolveHttpAuth } from './api-oauth.service.js';
import { queryPath, compareJson, type CompareMode } from '../utils/assert-engine.js';
import { evalExpressionSafe } from '../utils/expr-engine.js';

// JSON Schema (contract) validation for the `schema` check kind. One Ajv instance,
// with compiled validators cached by schema text so repeated runs don't recompile.
const schemaAjv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats(schemaAjv);
const MAX_SCHEMA_LEN = 20_000;
const schemaCache = new Map<string, ValidateFunction | { error: string }>();
function getSchemaValidator(schemaText: string): ValidateFunction | { error: string } {
  const hit = schemaCache.get(schemaText);
  if (hit) return hit;
  let compiled: ValidateFunction | { error: string };
  try { compiled = schemaAjv.compile(JSON.parse(schemaText)); }
  catch (e) { compiled = { error: e instanceof Error ? e.message : 'invalid JSON Schema' }; }
  if (schemaCache.size > 100) schemaCache.clear();   // bound memory; recompiles are cheap
  schemaCache.set(schemaText, compiled);
  return compiled;
}

export interface FlowExtract {
  /** Variable name to bind, usable as {{name}} in later steps. */
  name: string;
  /** Where to read from: a dotted path in the JSON body, a response header, or the status code. */
  from: 'body' | 'header' | 'status';
  /** body: dotted path ("data.0.id", "" = whole body). header: header name. status: ignored. */
  path?: string;
  /**
   * Optional regex applied to the string value read from `from`/`path`, binding
   * capture group 1 (or the whole match). The classic use is pulling an id out of
   * a `Location: /posts/123` header, or a token embedded in a text body. With
   * `from:'body'` and no `path`, the regex runs over the RAW response body text.
   */
  regex?: string;
}

export interface FlowCheck {
  kind: 'status' | 'jsonPathExists' | 'jsonPathEquals' | 'bodyContains' | 'responseTimeUnderMs'
    // ── richer assertions ──
    | 'header'        // assert a response header (exists | equals | contains)
    | 'bodyMatches'   // structural JSON compare vs an expected body, with a compareMode
    | 'xpath'         // XPath over an XML/SOAP response (exists | equals | contains)
    | 'expr'          // a boolean expression over status/timing/headers/body + captured vars
    | 'schema'        // validate the body (or a path-selected part) against a JSON Schema (ajv)
    | 'graphql'       // GraphQL envelope has no `errors` (a failed query still returns HTTP 200)
    | 'noSecrets'     // the response body leaks no credential-named field (password/secret/apiKey/…)
    | 'noError';      // the body is not a "200 but failed" REST error envelope (error/errors/success:false/status:'error')
  equals?: number | string;
  oneOf?: number[];
  /** expr: the boolean expression to assert, e.g. `status >= 200 && status < 300`. */
  expr?: string;
  /** jsonPath*: a rich JSONPath (dotted, [*], slices, ..recursion, [?(@.k==v)] filters). xpath: an XPath expression. */
  path?: string;
  value?: unknown;
  text?: string;
  ms?: number;
  /** header: the header name. */
  name?: string;
  /** header / xpath operator. Defaults to 'exists'. */
  op?: 'equals' | 'contains' | 'exists';
  /** bodyMatches: how strict the structural comparison is. Defaults to 'lenient'. */
  compareMode?: CompareMode;
  /**
   * bodyMatches: dotted paths stripped from BOTH the actual and expected body
   * before comparing — so volatile fields (ids, timestamps) don't break a golden
   * match. Supports `*` as a wildcard segment (every array element / object value),
   * e.g. `createdAt`, `items.*.id`, `data[*].updatedAt`.
   */
  ignore?: string[];
  /** schema: a JSON Schema (as text) the response body — or the `path`-selected part — must satisfy. */
  schema?: string;
}

export type FlowStepType = 'request' | 'if' | 'loop' | 'wait' | 'group' | 'retry';
/**
 * Lifecycle phase of a step. `setup` runs first (fixtures, login); `main` is the
 * journey under test; `teardown` ALWAYS runs at the end — even when setup or main
 * failed or aborted — so data created along the way is cleaned up. Omitted ⇒ main,
 * which keeps every existing flow behaving exactly as before.
 */
export type StepPhase = 'setup' | 'main' | 'teardown';
export type FlowConditionOp = 'eq' | 'ne' | 'exists' | 'notExists' | 'contains' | 'gt' | 'lt';
/**
 * A branch/loop condition. Either the simple `var op value` form, or a richer
 * boolean `expr` (e.g. `status >= 200 && status < 300`) evaluated by the safe
 * expression engine against the variable bag. `expr` wins when both are present.
 */
export interface FlowCondition { var?: string; op?: FlowConditionOp; value?: string; expr?: string }
/**
 * Loop spec. `times` repeats a fixed count; `while` repeats until a condition
 * stops holding; `forEach` fans out over a JSON array — each element is bound
 * into the var bag so the body can run once per item (e.g. GET /users → verify
 * every returned user). For `forEach`, `items` names the array source and `var`
 * the binding name (default `item`); see `resolveForEachItems`.
 */
export interface FlowLoop { mode: 'times' | 'while' | 'forEach'; times?: number; while?: FlowCondition; maxIterations?: number; items?: string; var?: string }
/**
 * Retry/poll spec: run the step's inner `steps` block, then re-run it up to
 * `attempts` times (waiting `delayMs` between attempts) until `until` holds.
 * With no `until`, the block is retried until every inner step passes (a flaky-
 * step retry). The last attempt's results are what the flow reports; captures
 * persist across attempts. Models eventual consistency — poll a resource until
 * it appears / reaches a state.
 */
export interface FlowRetry { until?: FlowCondition; attempts?: number; delayMs?: number }

export interface FlowStep {
  id?: string;
  name?: string;
  /** Step kind. Omitted ⇒ 'request' (a plain HTTP step — the original behaviour). */
  type?: FlowStepType;
  /** Lifecycle phase. Omitted ⇒ 'main'. */
  phase?: StepPhase;
  // ── request fields ──
  method?: string;
  url?: string;
  headers?: { key: string; value: string }[];
  auth?: HttpAuth;
  body?: string;
  /** Rich body (omitted ⇒ raw/json, unchanged). */
  bodyMode?: 'raw' | 'json' | 'form-data' | 'urlencoded' | 'binary';
  formFields?: HttpFormField[];
  bodyBase64?: string;
  bodyContentType?: string;
  extract?: FlowExtract[];
  checks?: FlowCheck[];
  /** Per-request timeout in ms (100–120000). Omitted ⇒ 15000. A slow/stuck dependency fails the step instead of hanging. */
  timeoutMs?: number;
  // ── control-flow fields ──
  condition?: FlowCondition;   // if
  then?: FlowStep[];           // if branch
  else?: FlowStep[];           // else branch
  loop?: FlowLoop;             // loop spec
  retry?: FlowRetry;           // retry/poll spec
  steps?: FlowStep[];          // loop body, retry body, or inline group body
  waitMs?: number;             // wait
  groupId?: string;            // reference a saved step group
}

export interface FlowStepResult {
  index: number;
  name: string;
  method: string;
  url: string;
  /** The phase this step ran in. */
  phase: StepPhase;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  error?: string;
  extracted: Record<string, string>;
  checks: { kind: string; label: string; pass: boolean; detail?: string }[];
  bodyPreview: string;
}

/** At-a-glance aggregates over a run, for CI/dashboards (latency, pass/fail, check counts). */
export interface FlowRunSummary {
  requests: number;      // HTTP request rows (excludes wait / retry-marker rows)
  passed: number;        // step rows that passed
  failed: number;        // step rows that failed
  checks: number;        // total assertions run
  checksPassed: number;
  maxStepMs: number;     // slowest request step
  avgStepMs: number;     // mean latency over request steps
  slowestStep?: string;  // its name
}

export interface FlowRunResult {
  passed: boolean;
  steps: FlowStepResult[];
  variables: Record<string, string>;
  durationMs: number;
  stepsRun: number;
  stepsTotal: number;
  summary?: FlowRunSummary;
}

const MAX_STEPS = 40;          // authored top-level steps kept per saved flow
const EXEC_BUDGET = 100;       // hard cap on HTTP requests actually issued per run (bounds loops)
const MAX_DEPTH = 8;           // nesting depth cap for if/loop/group
const MAX_ITERATIONS = 200;    // per-loop iteration cap
const MAX_WAIT_MS = 15_000;    // per wait-step cap

/**
 * Substitute {{var}} occurrences in a string from the running variable bag.
 * A token may carry a pipe-chain of transforms — `{{creds | base64}}`,
 * `{{id | urlencode}}`, `{{name | jsonstring}}` — applied left to right, so a
 * captured value can be re-encoded for the next request (Basic auth header,
 * url-safe path/query, JSON-embedded string). An unresolved var is left literal.
 */
function substitute(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w$.-]+)\s*((?:\|\s*[\w]+(?::[^|}]*)?\s*)*)\}\}/g, (_m, k: string, filters: string) => {
    let v: string;
    if (k[0] === '$') v = dynamicVar(k);                 // {{$uuid}}, {{$timestamp}}, …
    else if (k in vars) v = vars[k]!;                    // captured variable
    else return _m;                                      // unresolved ⇒ leave the whole token (with its filters) literal
    for (const f of parseFilters(filters)) v = applyVarFilter(v, f);
    return v;
  });
}

/** Split a `| a | b:arg` filter tail into trimmed filter expressions. */
function parseFilters(tail: string): string[] {
  if (!tail) return [];
  return tail.split('|').map((f) => f.trim()).filter(Boolean);
}

/** Apply one transform filter to a substituted value. Unknown filters pass through unchanged. */
function applyVarFilter(v: string, f: string): string {
  const i = f.indexOf(':');
  const name = (i === -1 ? f : f.slice(0, i)).trim().toLowerCase();
  switch (name) {
    case 'base64': case 'base64encode': return Buffer.from(v, 'utf8').toString('base64');
    case 'base64decode': try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return v; }
    case 'urlencode': return encodeURIComponent(v);
    case 'urldecode': try { return decodeURIComponent(v); } catch { return v; }
    case 'upper': return v.toUpperCase();
    case 'lower': return v.toLowerCase();
    case 'trim': return v.trim();
    case 'jsonstring': case 'jsonstringify': return JSON.stringify(v);   // quote + escape for safe embedding in a JSON body
    default: return v;
  }
}

/**
 * Resolve a dynamic variable (Postman-style) at request time, so a flow can mint
 * UNIQUE data each run — e.g. `{{$uuid}}` / `{{$randomEmail}}` for a create step
 * whose uniqueness constraint would otherwise reject a repeat run. Each occurrence
 * resolves independently. Unknown names are left literal.
 */
function dynamicVar(name: string): string {
  switch (name) {
    case '$uuid': return randomUUID();
    case '$timestamp': return String(Date.now());
    case '$isoTimestamp': return new Date().toISOString();
    case '$randomInt': return String(Math.floor(Math.random() * 1000));
    case '$randomString': return Math.random().toString(36).slice(2, 10);
    case '$randomEmail': return `test_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`;
    default: return `{{${name}}}`;
  }
}

/**
 * Read a path out of a parsed JSON value via the rich reader. A plain dotted
 * path ("data.0.id", "" = whole body) returns the single value, byte-compatible
 * with the old split-on-dot reader; a wildcard/slice/recursive/filter path
 * returns the array of matches.
 */
function readPath(obj: unknown, path: string | undefined): unknown {
  const r = queryPath(obj, path);
  return r.deterministic ? r.values[0] : r.values;
}

/** Resolve the optional xml deps and evaluate an XPath expression against an XML body. */
async function evalXPath(xml: string, expr: string): Promise<{ value: string; matched: boolean } | { error: string }> {
  try {
    const xmldomSpec = '@xmldom/xmldom';
    const xpathSpec = 'xpath';
    const { DOMParser } = await import(xmldomSpec);
    const xpathMod: any = await import(xpathSpec);
    const doc = new DOMParser({ onError: () => { /* tolerate malformed xml */ } }).parseFromString(xml, 'text/xml');
    const result = xpathMod.select(expr, doc);
    if (Array.isArray(result)) {
      if (!result.length) return { value: '', matched: false };
      const n = result[0];
      const v = (n && (n.nodeValue ?? n.textContent ?? n.data)) ?? String(n);
      return { value: String(v ?? ''), matched: true };
    }
    return { value: String(result ?? ''), matched: result != null && result !== false && result !== '' };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return { error: /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg) ? 'XPath support is not installed on the server (npm i @xmldom/xmldom xpath).' : msg };
  }
}

function toStr(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Apply a regex to a value, returning capture group 1 (or the whole match). '' on no match / bad pattern. */
function applyRegex(pattern: string, text: string): string {
  try {
    const m = new RegExp(pattern).exec(String(text).slice(0, 100_000));   // bound input
    if (!m) return '';
    return m[1] !== undefined ? m[1] : m[0];
  } catch { return ''; }
}

/** Split a dotted/bracket path into segments: `data[*].id` → ['data','*','id']. */
function pathSegs(path: string): string[] {
  return path.replace(/\[(\w+|\*)\]/g, '.$1').split('.').filter(Boolean);
}

/** Delete one path (possibly with `*` wildcard segments) from a mutable node tree. */
function stripOne(node: unknown, segs: string[]): void {
  if (node == null || typeof node !== 'object' || segs.length === 0) return;
  const [head, ...rest] = segs;
  if (head === '*') {
    const children = Array.isArray(node) ? node : Object.values(node as object);
    if (rest.length === 0) return;                 // trailing '*' is a no-op (delete the parent key instead)
    for (const child of children) stripOne(child, rest);
    return;
  }
  if (rest.length === 0) {
    if (Array.isArray(node)) { const i = Number(head); if (Number.isInteger(i) && i >= 0 && i < node.length) node.splice(i, 1); }
    else delete (node as Record<string, unknown>)[head!];
    return;
  }
  const child = Array.isArray(node) ? node[Number(head)] : (node as Record<string, unknown>)[head!];
  stripOne(child, rest);
}

/** Return a deep clone of `obj` with every listed path removed (used to ignore volatile fields in a golden match). */
function stripPaths(obj: unknown, paths: string[]): unknown {
  let clone: unknown;
  try { clone = structuredClone(obj); } catch { try { clone = JSON.parse(JSON.stringify(obj)); } catch { return obj; } }
  for (const p of paths) stripOne(clone, pathSegs(p));
  return clone;
}

async function runChecks(checks: FlowCheck[] | undefined, res: { status?: number; bodyText: string; elapsedMs: number; headers?: Record<string, string> }, parsed: unknown, vars: Record<string, string> = {}): Promise<FlowStepResult['checks']> {
  const out: FlowStepResult['checks'] = [];
  const headers = res.headers || {};
  for (const c of checks || []) {
    if (c.kind === 'status') {
      const codes = c.oneOf && c.oneOf.length ? c.oneOf : (c.equals != null ? [Number(c.equals)] : []);
      const pass = codes.length ? codes.includes(res.status ?? -1) : (res.status != null && res.status < 400);
      out.push({ kind: c.kind, label: `status ${codes.length ? codes.join('/') : '<400'}`, pass, detail: `got ${res.status ?? '—'}` });
    } else if (c.kind === 'jsonPathExists') {
      // Rich JSONPath: exists ⇒ at least one non-null match.
      const { values } = queryPath(parsed, c.path);
      const pass = values.some((v) => v !== undefined && v !== null);
      out.push({ kind: c.kind, label: `${c.path || '.'} exists`, pass, detail: values.length > 1 ? `${values.length} matches` : undefined });
    } else if (c.kind === 'jsonPathEquals') {
      // Rich JSONPath: equals ⇒ any match equals the expected value.
      const want = String(c.value ?? c.equals ?? '');
      const { values } = queryPath(parsed, c.path);
      const pass = values.some((v) => toStr(v) === want);
      out.push({ kind: c.kind, label: `${c.path || '.'} = ${want}`, pass, detail: `got ${toStr(values[0]).slice(0, 80)}${values.length > 1 ? ` (+${values.length - 1})` : ''}` });
    } else if (c.kind === 'bodyContains') {
      const pass = res.bodyText.includes(String(c.text ?? ''));
      out.push({ kind: c.kind, label: `body contains "${String(c.text ?? '').slice(0, 40)}"`, pass });
    } else if (c.kind === 'responseTimeUnderMs') {
      const limit = Number(c.ms ?? 0);
      out.push({ kind: c.kind, label: `response < ${limit}ms`, pass: res.elapsedMs <= limit, detail: `${res.elapsedMs}ms` });
    } else if (c.kind === 'header') {
      const name = String(c.name || '').toLowerCase();
      const hv = headers[name];
      const op = c.op || 'exists';
      const want = String(c.value ?? c.text ?? c.equals ?? '');
      const pass = op === 'equals' ? hv === want : op === 'contains' ? (hv || '').includes(want) : hv !== undefined;
      out.push({ kind: c.kind, label: `header ${c.name || ''} ${op}${op === 'exists' ? '' : ` "${want.slice(0, 40)}"`}`, pass, detail: hv !== undefined ? `got "${String(hv).slice(0, 80)}"` : 'header absent' });
    } else if (c.kind === 'bodyMatches') {
      // Expected body may embed captured vars ({{id}}), so a golden match can
      // assert against a value produced earlier in the flow.
      const rawExpected = typeof c.value === 'string' ? substitute(c.value, vars) : c.value;
      let expected = typeof rawExpected === 'string' ? (tryParse(rawExpected) ?? rawExpected) : rawExpected;
      const mode = (c.compareMode || 'lenient') as CompareMode;
      // Drop volatile fields (ids/timestamps) from both sides so they don't break the match.
      const ignore = Array.isArray(c.ignore) ? c.ignore.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : [];
      let actual: unknown = parsed;
      if (ignore.length) { actual = stripPaths(parsed, ignore); expected = stripPaths(expected, ignore); }
      const r = compareJson(actual, expected, mode);
      out.push({ kind: c.kind, label: `body matches (${mode})${ignore.length ? ` · ignore ${ignore.length}` : ''}`, pass: r.pass, detail: r.detail.slice(0, 120) });
    } else if (c.kind === 'xpath') {
      const op = c.op || 'exists';
      const want = String(c.value ?? c.text ?? c.equals ?? '');
      const r = await evalXPath(res.bodyText, String(c.path || ''));
      if ('error' in r) out.push({ kind: c.kind, label: `xpath ${String(c.path || '').slice(0, 40)}`, pass: false, detail: r.error });
      else {
        const pass = op === 'equals' ? r.value === want : op === 'contains' ? r.value.includes(want) : r.matched;
        out.push({ kind: c.kind, label: `xpath ${String(c.path || '').slice(0, 40)} ${op}${op === 'exists' ? '' : ` "${want.slice(0, 30)}"`}`, pass, detail: r.matched ? `got "${r.value.slice(0, 80)}"` : 'no match' });
      }
    } else if (c.kind === 'expr') {
      // Evaluate a boolean expression over a bag of the response (status,
      // responseTimeMs, header.<name>, flattened body fields) plus captured vars.
      const expr = String(c.expr ?? c.value ?? '');
      const bag = exprBag(res, parsed, vars);
      const pass = evalExpressionSafe(expr, bag);
      out.push({ kind: c.kind, label: `expr: ${expr.slice(0, 60)}`, pass, detail: `status ${res.status ?? '—'}, ${res.elapsedMs}ms` });
    } else if (c.kind === 'schema') {
      // Contract check: validate the body (or a sub-part at `path`) vs a JSON Schema.
      const schemaText = String(c.schema ?? c.value ?? c.text ?? '').trim();
      if (!schemaText) { out.push({ kind: c.kind, label: 'matches schema', pass: false, detail: 'no schema provided' }); continue; }
      if (schemaText.length > MAX_SCHEMA_LEN) { out.push({ kind: c.kind, label: 'matches schema', pass: false, detail: 'schema too large' }); continue; }
      const v = getSchemaValidator(schemaText);
      if ('error' in v) { out.push({ kind: c.kind, label: 'matches schema', pass: false, detail: `bad schema: ${v.error.slice(0, 90)}` }); continue; }
      // Whole body by default; a `path` narrows to e.g. each item or a sub-object.
      const target = c.path ? queryPath(parsed, c.path).values[0] : parsed;
      const ok = v(target) === true;
      const e0 = !ok && v.errors && v.errors[0] ? `${v.errors[0].instancePath || '(root)'} ${v.errors[0].message ?? ''}`.trim() : '';
      out.push({ kind: c.kind, label: `matches schema${c.path ? ` @ ${c.path}` : ''}`, pass: ok, detail: ok ? undefined : (e0.slice(0, 120) || 'does not match schema') });
    } else if (c.kind === 'graphql') {
      // GraphQL replies 200 even when a query fails — the failure is a non-empty
      // `errors` array in the body (data usually null). The default status gate
      // would pass that, so assert the envelope is error-free.
      const errs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).errors : undefined;
      const list = Array.isArray(errs) ? errs : [];
      const first = list[0];
      const firstMsg = first && typeof first === 'object' ? String((first as Record<string, unknown>).message ?? '') : String(first ?? '');
      out.push({ kind: c.kind, label: 'graphql: no errors', pass: list.length === 0, detail: list.length ? `${list.length} error(s): ${firstMsg.slice(0, 100)}` : undefined });
    } else if (c.kind === 'noSecrets') {
      // Fail if the body exposes a credential-named field with a real value — an
      // API should never return a password/secret/private key. (`token` and
      // `authorization` are intentionally NOT flagged: often legitimately returned.)
      const hits: string[] = [];
      findLeaks(parsed, '', hits, 0);
      out.push({ kind: c.kind, label: 'no leaked secrets', pass: hits.length === 0, detail: hits.length ? `leaked: ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` (+${hits.length - 6})` : ''}` : undefined });
    } else if (c.kind === 'noError') {
      // Catch a "200 but failed" body (common in REST APIs that always return 200).
      const reason = errorEnvelope(parsed);
      out.push({ kind: c.kind, label: 'no error envelope', pass: !reason, detail: reason || undefined });
    }
  }
  return out;
}

const LEAK_NAME_RE = /(password|passwd|pwd|pass_?hash|secret|private[_-]?key|client[_-]?secret|access[_-]?key|api[_-]?key|apikey)/i;
/** Collect dotted paths of credential-named fields that carry a real (non-empty string / number) value. */
function findLeaks(node: unknown, path: string, hits: string[], depth: number): void {
  if (node == null || depth > 8 || hits.length >= 20) return;
  if (Array.isArray(node)) { for (let i = 0; i < node.length && hits.length < 20; i++) findLeaks(node[i], `${path}[${i}]`, hits, depth + 1); return; }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    const real = (typeof v === 'string' && v.trim().length >= 4) || typeof v === 'number';
    if (LEAK_NAME_RE.test(k) && real) hits.push(p);
    findLeaks(v, p, hits, depth + 1);
  }
}

/** True when a top-level `error` value signals a real error (not null/''/false/0/empty). */
function truthyError(err: unknown): boolean {
  if (err == null || err === false || err === 0) return false;
  if (typeof err === 'string') return err.trim() !== '';
  if (Array.isArray(err)) return err.length > 0;
  if (typeof err === 'object') return Object.keys(err).length > 0;
  return !!err;
}
/** Detect a "HTTP 200 but failed" REST error envelope; return the reason or null. */
function errorEnvelope(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const b = parsed as Record<string, unknown>;
  if (truthyError(b.error)) {
    const e = b.error;
    const msg = typeof e === 'string' ? e : (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string' ? (e as Record<string, unknown>).message : JSON.stringify(e));
    return `error: ${String(msg).slice(0, 100)}`;
  }
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const f = b.errors[0] as Record<string, unknown> | string;
    const msg = f && typeof f === 'object' && typeof f.message === 'string' ? f.message : String(f);
    return `${b.errors.length} error(s): ${String(msg).slice(0, 80)}`;
  }
  if (b.success === false) return 'success: false';
  if (b.ok === false) return 'ok: false';
  if (typeof b.status === 'string' && /^(error|fail|failure)$/i.test(b.status)) return `status: ${b.status}`;
  return null;
}

/** Build the variable bag an `expr` check evaluates against. */
function exprBag(res: { status?: number; elapsedMs: number; headers?: Record<string, string> }, parsed: unknown, vars: Record<string, string>): Record<string, string> {
  const bag: Record<string, string> = {};
  flattenInto(bag, parsed, '', 0);
  for (const [k, v] of Object.entries(vars)) bag[k] = v;                      // captured vars
  for (const [k, v] of Object.entries(res.headers || {})) bag[`header.${k.toLowerCase()}`] = String(v);
  bag.status = res.status != null ? String(res.status) : '';                  // response meta wins
  bag.responseTimeMs = String(res.elapsedMs);
  return bag;
}

/** Flatten a JSON value into dotted keys (`data.0.id`, `total`, `items.length`). */
function flattenInto(bag: Record<string, string>, val: unknown, prefix: string, depth: number): void {
  if (val === null || val === undefined) { if (prefix) bag[prefix] = ''; return; }
  if (typeof val !== 'object') { if (prefix) bag[prefix] = String(val); return; }
  if (depth >= 4) return;
  if (Array.isArray(val)) {
    bag[prefix ? `${prefix}.length` : 'length'] = String(val.length);
    val.slice(0, 25).forEach((item, i) => flattenInto(bag, item, prefix ? `${prefix}.${i}` : String(i), depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) flattenInto(bag, v, prefix ? `${prefix}.${k}` : k, depth + 1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Evaluate a control-flow condition. The `expr` form evaluates over a bag that
 * includes the last response's `status` / `responseTimeMs` / `header.<name>` and
 * flattened body fields (plus captured vars) — so `until: status == 200` works
 * without a prior extract. The simple var/op/value form stays on the var bag.
 */
function evalCondition(c: FlowCondition | undefined, vars: Record<string, string>, last?: LastResponse): boolean {
  if (!c) return false;
  // Expression form takes precedence over the simple var/op/value form.
  if (c.expr) return evalExpressionSafe(c.expr, last ? exprBag(last, last.parsed, vars) : vars);
  if (!c.var) return false;
  const has = c.var in vars;
  const left = has ? vars[c.var]! : '';
  const right = String(c.value ?? '');
  switch (c.op) {
    case 'exists': return has && left !== '';
    case 'notExists': return !has || left === '';
    case 'eq': return String(left) === right;
    case 'ne': return String(left) !== right;
    case 'contains': return String(left).includes(right);
    case 'gt': return Number(left) > Number(right);
    case 'lt': return Number(left) < Number(right);
    default: return false;
  }
}

/** The most recent request's response — so a condition can read status/time/body without an explicit extract. */
interface LastResponse { status?: number; elapsedMs: number; headers?: Record<string, string>; parsed: unknown }

interface ExecCtx {
  vars: Record<string, string>;
  results: FlowStepResult[];
  allowWrites: boolean;
  budget: { used: number };
  groups: Record<string, FlowStep[]>;
  /** Shared holder (by reference, like `budget`) so a retry sub-context's request updates reach the parent's `until`. */
  resp: { last?: LastResponse };
}

/**
 * Resolve the array a `forEach` loop iterates. `items` is either an explicit
 * variable reference `{{name}}` (the var holds a JSON-array string, e.g. a step
 * that captured the whole body), or a dotted path into the LAST response's
 * parsed body ('' / '.' = the whole body, so a top-level array works). Anything
 * that isn't an array ⇒ no iterations.
 */
function resolveForEachItems(spec: FlowLoop, ctx: ExecCtx): unknown[] {
  const src = (spec.items ?? '').trim();
  let val: unknown;
  const m = src.match(/^\{\{\s*([\w$.-]+)\s*\}\}$/);
  if (m) {
    const raw = ctx.vars[m[1]!];
    val = typeof raw === 'string' ? tryParse(raw) : undefined;
  } else {
    val = readPath(ctx.resp.last?.parsed, src);
  }
  return Array.isArray(val) ? val : [];
}

/**
 * Bind one `forEach` element into the var bag: `{{<base>}}` = the element
 * (scalar as-is, object/array as JSON), each own field flattened one level as
 * `{{<base>.<field>}}` (so `{{item.id}}` works), and `{{<base>.$index}}` /
 * `{{__loopIndex}}` = the 0-based index. Previous element's `<base>.*` keys are
 * cleared first so a field missing on this element doesn't leak from the last.
 */
function bindForEachVars(vars: Record<string, string>, base: string, el: unknown, i: number): void {
  for (const k of Object.keys(vars)) if (k === base || k.startsWith(`${base}.`)) delete vars[k];
  vars.__loopIndex = String(i);
  vars[`${base}.$index`] = String(i);
  vars[base] = toStr(el);
  if (el != null && typeof el === 'object' && !Array.isArray(el)) {
    for (const [k, v] of Object.entries(el as Record<string, unknown>)) vars[`${base}.${k}`] = toStr(v);
  }
}

/** Execute a step list in order. Returns 'abort' on a hard transport error (stop the journey). */
async function execSteps(steps: FlowStep[], ctx: ExecCtx, depth: number): Promise<'ok' | 'abort'> {
  if (depth > MAX_DEPTH) return 'ok';
  for (const s of steps || []) {
    if (ctx.budget.used >= EXEC_BUDGET) return 'ok';
    const kind: FlowStepType = s.type || 'request';

    if (kind === 'wait') {
      const ms = Math.min(MAX_WAIT_MS, Math.max(0, Number(s.waitMs) || 0));
      await sleep(ms);
      ctx.results.push({ index: ctx.results.length, name: s.name || `wait ${ms}ms`, method: 'WAIT', url: '', phase: 'main', ok: true, elapsedMs: ms, extracted: {}, checks: [], bodyPreview: '' });
      continue;
    }

    if (kind === 'if') {
      const branch = evalCondition(s.condition, ctx.vars, ctx.resp.last) ? (s.then || []) : (s.else || []);
      const r = await execSteps(branch, ctx, depth + 1);
      if (r === 'abort') return 'abort';
      continue;
    }

    if (kind === 'loop') {
      const spec = s.loop || { mode: 'times' as const };
      const body = s.steps || [];

      if (spec.mode === 'forEach') {
        // Fan out over an array captured from the collection endpoint before the
        // loop. The array is resolved ONCE (from `ctx.resp.last` / a var), so the
        // inner steps' own responses don't change what we iterate.
        const items = resolveForEachItems(spec, ctx);
        const base = (spec.var || 'item').trim() || 'item';
        const limit = Number(spec.maxIterations) > 0 ? Number(spec.maxIterations) : items.length;
        const cap = Math.min(MAX_ITERATIONS, items.length, limit);
        for (let i = 0; i < cap; i++) {
          if (ctx.budget.used >= EXEC_BUDGET) break;
          bindForEachVars(ctx.vars, base, items[i], i);
          const r = await execSteps(body, ctx, depth + 1);
          if (r === 'abort') return 'abort';
        }
        continue;
      }

      const cap = Math.min(MAX_ITERATIONS, Math.max(0, Number(spec.times ?? spec.maxIterations ?? 0) || (spec.mode === 'while' ? MAX_ITERATIONS : 0)));
      let i = 0;
      while (i < cap) {
        if (spec.mode === 'while' && !evalCondition(spec.while, ctx.vars, ctx.resp.last)) break;
        if (ctx.budget.used >= EXEC_BUDGET) break;
        ctx.vars.__loopIndex = String(i);
        const r = await execSteps(body, ctx, depth + 1);
        if (r === 'abort') return 'abort';
        i++;
      }
      continue;
    }

    if (kind === 'group') {
      const expanded = s.groupId ? (ctx.groups[s.groupId] || []) : (s.steps || []);
      const r = await execSteps(expanded, ctx, depth + 1);
      if (r === 'abort') return 'abort';
      continue;
    }

    if (kind === 'retry') {
      const spec = s.retry || {};
      const body = s.steps || [];
      const attempts = Math.min(MAX_ITERATIONS, Math.max(1, Number(spec.attempts) || 1));
      const delay = Math.min(MAX_WAIT_MS, Math.max(0, Number(spec.delayMs) || 0));
      let lastResults: FlowStepResult[] = [];
      let satisfied = false;
      let aborted = false;
      let used = 0;
      for (let a = 0; a < attempts; a++) {
        if (ctx.budget.used >= EXEC_BUDGET) break;
        // Each attempt runs the block into its own buffer, sharing the vars bag
        // and request budget — so captures persist and the budget still bounds
        // the total work, but a failed attempt's step rows are discardable.
        const attemptResults: FlowStepResult[] = [];
        const r = await execSteps(body, { ...ctx, results: attemptResults }, depth + 1);
        lastResults = attemptResults;
        used = a + 1;
        if (r === 'abort') { aborted = true; break; }
        // With an `until`, poll until it holds; without one, until the block passes.
        satisfied = spec.until ? evalCondition(spec.until, ctx.vars, ctx.resp.last) : attemptResults.every((x) => x.ok);
        if (satisfied) break;
        if (a < attempts - 1 && delay) await sleep(delay);
      }
      // Commit the settled attempt's step rows (re-indexed into the parent list).
      for (const rr of lastResults) { rr.index = ctx.results.length; ctx.results.push(rr); }
      // Record the poll outcome itself, so the flow verdict reflects it.
      ctx.results.push({
        index: ctx.results.length,
        name: s.name || (spec.until ? 'retry until condition' : 'retry until steps pass'),
        method: 'RETRY', url: '', phase: 'main',
        ok: satisfied, elapsedMs: 0, extracted: {},
        checks: [{ kind: 'retry', label: `${satisfied ? 'satisfied' : 'exhausted'} after ${used}/${attempts} attempt${attempts === 1 ? '' : 's'}`, pass: satisfied }],
        bodyPreview: '',
      });
      if (aborted) return 'abort';
      continue;
    }

    // ── request ──
    const method = (s.method || 'GET').toUpperCase();
    if (isWriteMethod(method) && !ctx.allowWrites) {
      throw new Error(`A ${method} step performs a write. Re-run with writes explicitly allowed if that is safe against this environment.`);
    }
    const resolvedAuth = await resolveHttpAuth(s.auth);   // resolves oauth2 → bearer; no-op otherwise
    // Substitute {{vars}} in the auth value/headerName too (like url/headers/body),
    // so a seeded or captured token works in structured auth (e.g. bearer {{token}}).
    const auth = resolvedAuth
      ? { ...resolvedAuth,
          value: resolvedAuth.value != null ? substitute(resolvedAuth.value, ctx.vars) : resolvedAuth.value,
          headerName: resolvedAuth.headerName != null ? substitute(resolvedAuth.headerName, ctx.vars) : resolvedAuth.headerName }
      : resolvedAuth;
    const ep: HttpEndpoint = {
      method,
      url: substitute(s.url || '', ctx.vars),
      headers: (s.headers || []).map((h) => ({ key: h.key, value: substitute(h.value ?? '', ctx.vars) })),
      auth,
      body: s.body ? substitute(s.body, ctx.vars) : undefined,
      bodyMode: s.bodyMode,
      formFields: (s.formFields || []).map((f) => ({ ...f, value: f.value != null ? substitute(f.value, ctx.vars) : f.value })),
      bodyBase64: s.bodyBase64,
      bodyContentType: s.bodyContentType,
    };
    const { url, init } = buildRequestInit(ep);
    // Per-step timeout (default 15s) so a slow/stuck dependency fails fast instead of hanging the journey.
    const res = await fetchFull(url, init, clampInt(s.timeoutMs, 15_000, 100, 120_000));
    ctx.budget.used++;
    const parsed = tryParse(res.bodyText);
    // Record this as the "last response" so later conditions (if / loop / retry)
    // can assert on its status / timing / body without an explicit extract.
    ctx.resp.last = { status: res.status, elapsedMs: res.elapsedMs, headers: res.headers, parsed };

    const extracted: Record<string, string> = {};
    for (const ex of s.extract || []) {
      if (!ex?.name) continue;
      let v: unknown;
      if (ex.from === 'status') v = res.status;
      else if (ex.from === 'header') v = res.headers[String(ex.path || '').toLowerCase()];
      else if (ex.regex && !ex.path) v = res.bodyText;   // regex over the raw body text
      else v = readPath(parsed, ex.path);
      // Optional regex post-process: capture group 1 (or the whole match) from the value.
      const sv = ex.regex ? applyRegex(ex.regex, toStr(v)) : toStr(v);
      extracted[ex.name] = sv;
      ctx.vars[ex.name] = sv;
    }

    const checks = await runChecks(s.checks, res, parsed, ctx.vars);
    // A step passes when the transport succeeded and every check passed. The
    // status<400 gate is only the DEFAULT success rule: when the step carries an
    // explicit `status` check (e.g. a confirm-gone step asserting 404, or any
    // negative case), that check owns the status verdict, so a documented 4xx/5xx
    // counts as a pass instead of failing the step.
    const hasStatusCheck = (s.checks || []).some((c) => c.kind === 'status');
    const stepOk = !res.error && (hasStatusCheck || res.status == null || res.status < 400) && checks.every((c) => c.pass);
    ctx.results.push({
      index: ctx.results.length,
      name: s.name || `${method} ${url}`,
      method,
      url,
      phase: 'main',
      ok: stepOk,
      status: res.status,
      elapsedMs: res.elapsedMs,
      error: res.error,
      extracted,
      checks,
      bodyPreview: res.bodyText.slice(0, 1200),
    });
    if (res.error) return 'abort';   // later steps usually depend on this one
  }
  return 'ok';
}

export async function runFlow(input: { steps: FlowStep[]; variables?: Record<string, string>; allowWrites?: boolean; groups?: Record<string, FlowStep[]> }): Promise<FlowRunResult> {
  const all = Array.isArray(input.steps) ? input.steps : [];
  if (!all.length) throw new Error('A flow needs at least one step.');

  // Partition by lifecycle phase (a step with no phase is 'main' — unchanged).
  const setup = all.filter((s) => s.phase === 'setup');
  const teardown = all.filter((s) => s.phase === 'teardown');
  const main = all.filter((s) => !s.phase || s.phase === 'main');

  const started = Date.now();
  const ctx: ExecCtx = {
    vars: { ...(input.variables || {}) },
    results: [],
    allowWrites: !!input.allowWrites,
    budget: { used: 0 },
    groups: input.groups && typeof input.groups === 'object' ? input.groups : {},
    resp: {},
  };

  // Run a phase and tag the results it produced with that phase.
  const runPhase = async (list: FlowStep[], phase: StepPhase): Promise<'ok' | 'abort'> => {
    if (!list.length) return 'ok';
    const before = ctx.results.length;
    const outcome = await execSteps(list, ctx, 0);
    for (let i = before; i < ctx.results.length; i++) ctx.results[i]!.phase = phase;
    return outcome;
  };

  try {
    await runPhase(setup, 'setup');
    // Setup must fully pass for the journey to proceed — a failed fixture/login
    // means main cannot run meaningfully. Teardown still runs in `finally`.
    const setupOk = ctx.results.every((r) => r.ok);
    if (setupOk) await runPhase(main, 'main');
  } finally {
    if (teardown.length) {
      // Cleanup must run even if earlier phases spent the request budget, so give
      // teardown a fresh allowance (still bounded by EXEC_BUDGET / loop caps).
      ctx.budget.used = 0;
      await runPhase(teardown, 'teardown');
    }
  }

  const passed = ctx.results.length > 0 && ctx.results.every((r) => r.ok);
  return {
    passed,
    steps: ctx.results,
    variables: ctx.vars,
    durationMs: Date.now() - started,
    stepsRun: ctx.results.length,
    stepsTotal: all.length,
    summary: summarize(ctx.results),
  };
}

/** Aggregate a run's step rows into at-a-glance metrics (latency over request rows only). */
function summarize(rows: FlowStepResult[]): FlowRunSummary {
  const reqs = rows.filter((r) => r.method !== 'WAIT' && r.method !== 'RETRY');
  const lat = reqs.map((r) => r.elapsedMs || 0);
  const slow = reqs.reduce<FlowStepResult | null>((a, r) => (!a || (r.elapsedMs || 0) > (a.elapsedMs || 0) ? r : a), null);
  return {
    requests: reqs.length,
    passed: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    checks: rows.reduce((n, r) => n + r.checks.length, 0),
    checksPassed: rows.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0),
    maxStepMs: lat.length ? Math.max(...lat) : 0,
    avgStepMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
    slowestStep: slow?.name,
  };
}

/* ────────────────────────────────────────────────────────────────
   Suite runner — several flows in order, sharing one variable bag.
   ────────────────────────────────────────────────────────────────
   Suite-level shared fixtures: each flow runs with the variables captured by
   every flow before it, so a "log in" or "create tenant" flow at the front of
   the suite seeds the token / id that the rest reuse. The shared bag threads
   forward (a later flow's extracts override earlier ones of the same name). A
   flow's own `variables` seed only that flow. With `stopOnFailure`, the suite
   halts at the first failing flow (the usual "fixtures must hold" behaviour).
   ──────────────────────────────────────────────────────────────── */

export type SuiteFlowRole = 'setup' | 'flow' | 'teardown';
export interface SuiteFlowInput { name?: string; steps: FlowStep[]; variables?: Record<string, string> }
export interface SuiteFlowResult { name: string; passed: boolean; run: FlowRunResult; role: SuiteFlowRole }
export interface SuiteRunResult {
  passed: boolean;
  flows: SuiteFlowResult[];
  /** The shared bag after the last flow ran — the suite's accumulated fixtures. */
  variables: Record<string, string>;
  durationMs: number;
  flowsRun: number;
  flowsTotal: number;
}

const MAX_SUITE_FLOWS = 30;

/**
 * Run a suite: an optional `setup` flow once first (its captures seed every
 * flow), the ordered `flows` threading variables forward, and an optional
 * `teardown` flow once at the end — which ALWAYS runs (in `finally`), even if
 * setup or a flow failed. The suite's pass verdict covers setup + flows only;
 * teardown is reported but does not gate it (cleanup failing ≠ tests failing).
 */
export async function runSuite(input: { flows: SuiteFlowInput[]; setup?: SuiteFlowInput; teardown?: SuiteFlowInput; variables?: Record<string, string>; allowWrites?: boolean; groups?: Record<string, FlowStep[]>; stopOnFailure?: boolean }): Promise<SuiteRunResult> {
  const flows = (Array.isArray(input.flows) ? input.flows : []).slice(0, MAX_SUITE_FLOWS);
  const hasSetup = !!input.setup?.steps?.length;
  const hasTeardown = !!input.teardown?.steps?.length;
  if (!flows.length && !hasSetup) throw new Error('A suite needs at least one flow.');
  const started = Date.now();
  let shared: Record<string, string> = { ...(input.variables || {}) };
  const results: SuiteFlowResult[] = [];

  const runOne = async (f: SuiteFlowInput, role: SuiteFlowRole): Promise<boolean> => {
    const run = await runFlow({
      steps: f.steps,
      variables: { ...shared, ...(f.variables || {}) },
      allowWrites: input.allowWrites,
      groups: input.groups,
    });
    const fallback = role === 'setup' ? 'Setup' : role === 'teardown' ? 'Teardown' : 'Flow';
    results.push({ name: String(f.name || fallback), passed: run.passed, run, role });
    shared = { ...shared, ...run.variables };   // thread captures forward
    return run.passed;
  };

  try {
    const setupOk = hasSetup ? await runOne(input.setup!, 'setup') : true;
    if (setupOk) {
      for (const f of flows) {
        const ok = await runOne(f, 'flow');
        if (input.stopOnFailure && !ok) break;
      }
    }
  } finally {
    if (hasTeardown) await runOne(input.teardown!, 'teardown');
  }

  const gating = results.filter((r) => r.role !== 'teardown');
  const passed = gating.length > 0 && gating.every((r) => r.passed);
  return {
    passed,
    flows: results,
    variables: shared,
    durationMs: Date.now() - started,
    flowsRun: results.length,
    flowsTotal: flows.length + (hasSetup ? 1 : 0) + (hasTeardown ? 1 : 0),
  };
}

/* ────────────────────────────────────────────────────────────────
   Data-driven runner — one flow run per row of a dataset.
   ────────────────────────────────────────────────────────────────
   The same flow is executed once per dataset row; each row's key/value
   pairs seed that run's variable bag ({{var}}), so one authored flow
   becomes a parameterised test matrix (e.g. a login+checkout flow driven
   by 20 user rows). Rows are independent — captures do NOT leak between
   rows (unlike a suite, which threads them forward). `stopOnFailure`
   stops after the first failing row. */

export interface DatasetRowResult { index: number; row: Record<string, string>; passed: boolean; run: FlowRunResult }
export interface DatasetRunResult {
  passed: boolean;
  rows: DatasetRowResult[];
  rowsRun: number;
  rowsTotal: number;
  rowsPassed: number;
  durationMs: number;
}

const MAX_DATASET_ROWS = 200;

/**
 * Run one flow across a dataset: `dataset[i]` is merged over the base
 * `variables` for run i, so the flow is parameterised per row. Each row is
 * isolated (its own fresh variable bag — captures never cross rows). The run
 * passes only when every executed row passed. `stopOnFailure` halts after the
 * first failing row (the rest are left un-run).
 */
export async function runFlowDataset(input: { steps: FlowStep[]; variables?: Record<string, string>; allowWrites?: boolean; groups?: Record<string, FlowStep[]>; dataset: Record<string, string>[]; stopOnFailure?: boolean }): Promise<DatasetRunResult> {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw new Error('A flow needs at least one step.');
  const rows = (Array.isArray(input.dataset) ? input.dataset : []).slice(0, MAX_DATASET_ROWS);
  if (!rows.length) throw new Error('A data-driven run needs at least one dataset row.');

  const started = Date.now();
  const base = { ...(input.variables || {}) };
  const results: DatasetRowResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] && typeof rows[i] === 'object' ? rows[i]! : {};
    // Stringify each cell — the engine's substitute() expects string values.
    const seeded: Record<string, string> = { ...base };
    for (const [k, v] of Object.entries(row)) seeded[k] = v == null ? '' : String(v);
    const run = await runFlow({ steps, variables: seeded, allowWrites: input.allowWrites, groups: input.groups });
    results.push({ index: i, row, passed: run.passed, run });
    if (input.stopOnFailure && !run.passed) break;
  }

  const rowsPassed = results.filter((r) => r.passed).length;
  return {
    passed: results.length > 0 && results.every((r) => r.passed),
    rows: results,
    rowsRun: results.length,
    rowsTotal: rows.length,
    rowsPassed,
    durationMs: Date.now() - started,
  };
}

/* ────────────────────────────────────────────────────────────────
   Saved flows (own table; never read by the pipeline)
   ──────────────────────────────────────────────────────────────── */

export interface SavedFlow {
  id: string;
  name: string;
  steps: FlowStep[];
  variables: Record<string, string>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function mapFlow(r: any): SavedFlow {
  let steps: FlowStep[] = [];
  let variables: Record<string, string> = {};
  try { steps = typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps || []); } catch { /* ignore */ }
  try { variables = typeof r.variables === 'string' ? JSON.parse(r.variables) : (r.variables || {}); } catch { /* ignore */ }
  return {
    id: String(r.id),
    name: r.name || 'Flow',
    steps: Array.isArray(steps) ? steps : [],
    variables: variables && typeof variables === 'object' ? variables : {},
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listFlows(tenantId: string): Promise<SavedFlow[]> {
  const { rows } = await pool.query(`SELECT * FROM api_flows WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapFlow);
}

export async function getFlow(tenantId: string, id: string): Promise<SavedFlow | null> {
  const { rows } = await pool.query(`SELECT * FROM api_flows WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? mapFlow(rows[0]) : null;
}

export async function saveFlow(tenantId: string, username: string, input: { id?: string; name: unknown; steps: unknown; variables?: unknown }): Promise<SavedFlow> {
  const name = String(input.name || '').trim().slice(0, 200) || 'Untitled flow';
  const steps = JSON.stringify(Array.isArray(input.steps) ? (input.steps as FlowStep[]).slice(0, MAX_STEPS) : []);
  const variables = JSON.stringify(input.variables && typeof input.variables === 'object' ? input.variables : {});
  if (input.id) {
    const { rows } = await pool.query(
      `UPDATE api_flows SET name = $3, steps = $4, variables = $5, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, steps, variables],
    );
    if (!rows.length) throw new Error('Flow not found.');
    return mapFlow(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_flows (tenant_id, name, steps, variables, created_by)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, name, steps, variables, username || ''],
  );
  return mapFlow(rows[0]);
}

export async function deleteFlow(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_flows WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ────────────────────────────────────────────────────────────────
   Reusable step groups (own table; referenced by flows via groupId)
   ──────────────────────────────────────────────────────────────── */

export interface StepGroup {
  id: string;
  name: string;
  steps: FlowStep[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function mapGroup(r: any): StepGroup {
  let steps: FlowStep[] = [];
  try { steps = typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps || []); } catch { /* ignore */ }
  return {
    id: String(r.id),
    name: r.name || 'Step group',
    steps: Array.isArray(steps) ? steps : [],
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listStepGroups(tenantId: string): Promise<StepGroup[]> {
  const { rows } = await pool.query(`SELECT * FROM api_step_groups WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapGroup);
}

/** id → steps map for the flow runner to expand `group` references. */
export async function getStepGroupMap(tenantId: string): Promise<Record<string, FlowStep[]>> {
  const groups = await listStepGroups(tenantId);
  const map: Record<string, FlowStep[]> = {};
  for (const g of groups) map[g.id] = g.steps;
  return map;
}

export async function saveStepGroup(tenantId: string, username: string, input: { id?: string; name: unknown; steps: unknown }): Promise<StepGroup> {
  const name = String(input.name || '').trim().slice(0, 200) || 'Untitled group';
  const steps = JSON.stringify(Array.isArray(input.steps) ? (input.steps as FlowStep[]).slice(0, MAX_STEPS) : []);
  if (input.id) {
    const { rows } = await pool.query(
      `UPDATE api_step_groups SET name = $3, steps = $4, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, steps],
    );
    if (!rows.length) throw new Error('Step group not found.');
    return mapGroup(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_step_groups (tenant_id, name, steps, created_by)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`,
    [tenantId, name, steps, username || ''],
  );
  return mapGroup(rows[0]);
}

export async function deleteStepGroup(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_step_groups WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export { clampInt };
