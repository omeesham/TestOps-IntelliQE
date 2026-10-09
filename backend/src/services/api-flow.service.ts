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
import pool from '../db.js';
import { buildRequestInit, fetchFull, isWriteMethod, clampInt, type HttpEndpoint, type HttpAuth, type HttpFormField } from '../utils/api-http.js';
import { resolveHttpAuth } from './api-oauth.service.js';
import { queryPath, compareJson, type CompareMode } from '../utils/assert-engine.js';

export interface FlowExtract {
  /** Variable name to bind, usable as {{name}} in later steps. */
  name: string;
  /** Where to read from: a dotted path in the JSON body, a response header, or the status code. */
  from: 'body' | 'header' | 'status';
  /** body: dotted path ("data.0.id", "" = whole body). header: header name. status: ignored. */
  path?: string;
}

export interface FlowCheck {
  kind: 'status' | 'jsonPathExists' | 'jsonPathEquals' | 'bodyContains' | 'responseTimeUnderMs'
    // ── richer assertions ──
    | 'header'        // assert a response header (exists | equals | contains)
    | 'bodyMatches'   // structural JSON compare vs an expected body, with a compareMode
    | 'xpath';        // XPath over an XML/SOAP response (exists | equals | contains)
  equals?: number | string;
  oneOf?: number[];
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
}

export type FlowStepType = 'request' | 'if' | 'loop' | 'wait' | 'group';
export type FlowConditionOp = 'eq' | 'ne' | 'exists' | 'notExists' | 'contains' | 'gt' | 'lt';
export interface FlowCondition { var: string; op: FlowConditionOp; value?: string }
export interface FlowLoop { mode: 'times' | 'while'; times?: number; while?: FlowCondition; maxIterations?: number }

export interface FlowStep {
  id?: string;
  name?: string;
  /** Step kind. Omitted ⇒ 'request' (a plain HTTP step — the original behaviour). */
  type?: FlowStepType;
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
  // ── control-flow fields ──
  condition?: FlowCondition;   // if
  then?: FlowStep[];           // if branch
  else?: FlowStep[];           // else branch
  loop?: FlowLoop;             // loop spec
  steps?: FlowStep[];          // loop body, or inline group body
  waitMs?: number;             // wait
  groupId?: string;            // reference a saved step group
}

export interface FlowStepResult {
  index: number;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  error?: string;
  extracted: Record<string, string>;
  checks: { kind: string; label: string; pass: boolean; detail?: string }[];
  bodyPreview: string;
}

export interface FlowRunResult {
  passed: boolean;
  steps: FlowStepResult[];
  variables: Record<string, string>;
  durationMs: number;
  stepsRun: number;
  stepsTotal: number;
}

const MAX_STEPS = 40;          // authored top-level steps kept per saved flow
const EXEC_BUDGET = 100;       // hard cap on HTTP requests actually issued per run (bounds loops)
const MAX_DEPTH = 8;           // nesting depth cap for if/loop/group
const MAX_ITERATIONS = 200;    // per-loop iteration cap
const MAX_WAIT_MS = 15_000;    // per wait-step cap

/** Substitute {{var}} occurrences in a string from the running variable bag. */
function substitute(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => (k in vars ? vars[k]! : `{{${k}}}`));
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

async function runChecks(checks: FlowCheck[] | undefined, res: { status?: number; bodyText: string; elapsedMs: number; headers?: Record<string, string> }, parsed: unknown): Promise<FlowStepResult['checks']> {
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
      const expected = typeof c.value === 'string' ? (tryParse(c.value) ?? c.value) : c.value;
      const mode = (c.compareMode || 'lenient') as CompareMode;
      const r = compareJson(parsed, expected, mode);
      out.push({ kind: c.kind, label: `body matches (${mode})`, pass: r.pass, detail: r.detail.slice(0, 120) });
    } else if (c.kind === 'xpath') {
      const op = c.op || 'exists';
      const want = String(c.value ?? c.text ?? c.equals ?? '');
      const r = await evalXPath(res.bodyText, String(c.path || ''));
      if ('error' in r) out.push({ kind: c.kind, label: `xpath ${String(c.path || '').slice(0, 40)}`, pass: false, detail: r.error });
      else {
        const pass = op === 'equals' ? r.value === want : op === 'contains' ? r.value.includes(want) : r.matched;
        out.push({ kind: c.kind, label: `xpath ${String(c.path || '').slice(0, 40)} ${op}${op === 'exists' ? '' : ` "${want.slice(0, 30)}"`}`, pass, detail: r.matched ? `got "${r.value.slice(0, 80)}"` : 'no match' });
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Evaluate a control-flow condition against the running variable bag. */
function evalCondition(c: FlowCondition | undefined, vars: Record<string, string>): boolean {
  if (!c || !c.var) return false;
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

interface ExecCtx {
  vars: Record<string, string>;
  results: FlowStepResult[];
  allowWrites: boolean;
  budget: { used: number };
  groups: Record<string, FlowStep[]>;
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
      ctx.results.push({ index: ctx.results.length, name: s.name || `wait ${ms}ms`, method: 'WAIT', url: '', ok: true, elapsedMs: ms, extracted: {}, checks: [], bodyPreview: '' });
      continue;
    }

    if (kind === 'if') {
      const branch = evalCondition(s.condition, ctx.vars) ? (s.then || []) : (s.else || []);
      const r = await execSteps(branch, ctx, depth + 1);
      if (r === 'abort') return 'abort';
      continue;
    }

    if (kind === 'loop') {
      const spec = s.loop || { mode: 'times' as const };
      const body = s.steps || [];
      const cap = Math.min(MAX_ITERATIONS, Math.max(0, Number(spec.times ?? spec.maxIterations ?? 0) || (spec.mode === 'while' ? MAX_ITERATIONS : 0)));
      let i = 0;
      while (i < cap) {
        if (spec.mode === 'while' && !evalCondition(spec.while, ctx.vars)) break;
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

    // ── request ──
    const method = (s.method || 'GET').toUpperCase();
    if (isWriteMethod(method) && !ctx.allowWrites) {
      throw new Error(`A ${method} step performs a write. Re-run with writes explicitly allowed if that is safe against this environment.`);
    }
    const auth = await resolveHttpAuth(s.auth);   // resolves oauth2 → bearer; no-op otherwise
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
    const res = await fetchFull(url, init);
    ctx.budget.used++;
    const parsed = tryParse(res.bodyText);

    const extracted: Record<string, string> = {};
    for (const ex of s.extract || []) {
      if (!ex?.name) continue;
      let v: unknown;
      if (ex.from === 'status') v = res.status;
      else if (ex.from === 'header') v = res.headers[String(ex.path || '').toLowerCase()];
      else v = readPath(parsed, ex.path);
      const sv = toStr(v);
      extracted[ex.name] = sv;
      ctx.vars[ex.name] = sv;
    }

    const checks = await runChecks(s.checks, res, parsed);
    const stepOk = !res.error && (res.status == null || res.status < 400) && checks.every((c) => c.pass);
    ctx.results.push({
      index: ctx.results.length,
      name: s.name || `${method} ${url}`,
      method,
      url,
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
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw new Error('A flow needs at least one step.');
  const started = Date.now();
  const ctx: ExecCtx = {
    vars: { ...(input.variables || {}) },
    results: [],
    allowWrites: !!input.allowWrites,
    budget: { used: 0 },
    groups: input.groups && typeof input.groups === 'object' ? input.groups : {},
  };
  await execSteps(steps, ctx, 0);
  const passed = ctx.results.length > 0 && ctx.results.every((r) => r.ok);
  return {
    passed,
    steps: ctx.results,
    variables: ctx.vars,
    durationMs: Date.now() - started,
    stepsRun: ctx.results.length,
    stepsTotal: steps.length,
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
