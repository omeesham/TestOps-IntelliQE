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

export interface FlowExtract {
  /** Variable name to bind, usable as {{name}} in later steps. */
  name: string;
  /** Where to read from: a dotted path in the JSON body, a response header, or the status code. */
  from: 'body' | 'header' | 'status';
  /** body: dotted path ("data.0.id", "" = whole body). header: header name. status: ignored. */
  path?: string;
}

export interface FlowCheck {
  kind: 'status' | 'jsonPathExists' | 'jsonPathEquals' | 'bodyContains' | 'responseTimeUnderMs';
  equals?: number | string;
  oneOf?: number[];
  path?: string;
  value?: unknown;
  text?: string;
  ms?: number;
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

/** Read a dotted path out of a parsed JSON value. "" or "." → the whole value. */
function readPath(obj: unknown, path: string | undefined): unknown {
  if (!path || path === '.') return obj;
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function toStr(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function runChecks(checks: FlowCheck[] | undefined, res: { status?: number; bodyText: string; elapsedMs: number }, parsed: unknown): FlowStepResult['checks'] {
  const out: FlowStepResult['checks'] = [];
  for (const c of checks || []) {
    if (c.kind === 'status') {
      const codes = c.oneOf && c.oneOf.length ? c.oneOf : (c.equals != null ? [Number(c.equals)] : []);
      const pass = codes.length ? codes.includes(res.status ?? -1) : (res.status != null && res.status < 400);
      out.push({ kind: c.kind, label: `status ${codes.length ? codes.join('/') : '<400'}`, pass, detail: `got ${res.status ?? '—'}` });
    } else if (c.kind === 'jsonPathExists') {
      const v = readPath(parsed, c.path);
      out.push({ kind: c.kind, label: `${c.path || '.'} exists`, pass: v !== undefined && v !== null });
    } else if (c.kind === 'jsonPathEquals') {
      const v = readPath(parsed, c.path);
      const pass = toStr(v) === String(c.value ?? c.equals ?? '');
      out.push({ kind: c.kind, label: `${c.path || '.'} = ${String(c.value ?? c.equals ?? '')}`, pass, detail: `got ${toStr(v).slice(0, 80)}` });
    } else if (c.kind === 'bodyContains') {
      const pass = res.bodyText.includes(String(c.text ?? ''));
      out.push({ kind: c.kind, label: `body contains "${String(c.text ?? '').slice(0, 40)}"`, pass });
    } else if (c.kind === 'responseTimeUnderMs') {
      const limit = Number(c.ms ?? 0);
      out.push({ kind: c.kind, label: `response < ${limit}ms`, pass: res.elapsedMs <= limit, detail: `${res.elapsedMs}ms` });
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

    const checks = runChecks(s.checks, res, parsed);
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
