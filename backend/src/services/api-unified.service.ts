/**
 * api-unified.service.ts
 * ──────────────────────
 * The unified cross-layer test object — ONE ordered list of steps that
 * interleaves API, DB and UI (web) layers in a single test case, with a shared
 * variable bag flowing between them. This is the coherence Testsigma sells:
 * author "create via API → verify the row in the DB → confirm the UI renders
 * it" as one test, not three disconnected tools.
 *
 *   step.kind = 'api'  → HTTP request (extract {{vars}}, assert status/JSON)
 *             = 'db'   → read-only SELECT assertion (reuses DB-validate)
 *             = 'ui'   → open a real browser page and run UI checks (reuses the
 *                        Web Lab engine; degrades cleanly if Chromium is absent)
 *
 * Variables extracted by any step ({{orderId}} from an API create, say)
 * substitute into every later step's url / body / query / UI url. Reuses the
 * shared HTTP helper, the assert-engine path reader, the read-only DB-validate
 * module, and the Web Lab browser launcher. Write API steps are gated behind
 * allowWrites. Standalone and opt-in; the pipeline is never touched.
 */
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint, type HttpAuth } from '../utils/api-http.js';
import { queryPath } from '../utils/assert-engine.js';
import { runDbValidation } from './api-db-validate.service.js';
import { withPage, assertWebUrl, BrowserNotInstalledError, type WebEngine } from './web-browser.service.js';
import { evalUiCheck, substitute as subVars, type UiCheck } from './api-hybrid.service.js';

export type UnifiedStepKind = 'api' | 'db' | 'ui';
export interface UnifiedExtract { name: string; from: 'body' | 'header' | 'status'; path?: string }
export interface UnifiedApiCheck { path?: string; op?: 'equals' | 'contains' | 'exists' | 'notEquals'; value?: string }

export interface UnifiedStep {
  id?: string;
  name?: string;
  kind: UnifiedStepKind;
  // api
  method?: string;
  url?: string;
  headers?: { key: string; value: string }[];
  auth?: HttpAuth;
  body?: string;
  expectStatus?: number;
  extract?: UnifiedExtract[];
  checks?: UnifiedApiCheck[];
  // db
  connectionId?: string;
  config?: unknown;
  query?: string;
  expect?: { minRows?: number; maxRows?: number; column?: string; equals?: string };
  // ui
  uiUrl?: string;
  uiChecks?: UiCheck[];
  engine?: WebEngine;
}

export interface UnifiedStepResult {
  index: number;
  name: string;
  kind: UnifiedStepKind;
  ok: boolean;
  status?: number;
  detail: string;
  checks: { label: string; pass: boolean; detail?: string }[];
  extracted?: Record<string, string>;
  screenshotBase64?: string;
}
export interface UnifiedResult {
  passed: boolean;
  durationMs: number;
  steps: UnifiedStepResult[];
  variables: Record<string, string>;
  stepsRun: number;
  stepsTotal: number;
  notes: string[];
}

const MAX_STEPS = 40;
function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }
function tryParse(t: string): unknown { try { return JSON.parse(t); } catch { return undefined; } }
function subAuth(a: HttpAuth | undefined, vars: Record<string, string>): HttpAuth | undefined { return a ? { ...a, value: a.value ? subVars(a.value, vars) : a.value } : a; }

async function runApiStep(s: UnifiedStep, vars: Record<string, string>, allowWrites: boolean): Promise<UnifiedStepResult> {
  const index = 0; // set by caller
  const method = (s.method || 'GET').toUpperCase();
  const name = s.name || `${method} ${s.url}`;
  if (isWriteMethod(method) && !allowWrites) {
    return { index, name, kind: 'api', ok: false, detail: `${method} is a write — enable "allow writes" to run it.`, checks: [] };
  }
  const ep: HttpEndpoint = {
    method,
    url: subVars(s.url || '', vars),
    headers: (s.headers || []).map((h) => ({ key: h.key, value: subVars(h.value ?? '', vars) })),
    auth: subAuth(s.auth, vars),
    body: s.body ? subVars(s.body, vars) : undefined,
  };
  const { url, init } = buildRequestInit(ep);
  const r = await fetchFull(url, init);
  const parsed = tryParse(r.bodyText);
  const extracted: Record<string, string> = {};
  for (const ex of s.extract || []) {
    if (!ex?.name) continue;
    let v: unknown;
    if (ex.from === 'status') v = r.status;
    else if (ex.from === 'header') v = r.headers[String(ex.path || '').toLowerCase()];
    else { const { values } = queryPath(parsed, ex.path); v = values.length > 1 ? values : values[0]; }
    extracted[ex.name] = toStr(v);
    vars[ex.name] = extracted[ex.name]!;
  }
  const checks: UnifiedStepResult['checks'] = [];
  if (s.expectStatus != null) checks.push({ label: `status == ${s.expectStatus}`, pass: r.status === s.expectStatus, detail: `got ${r.status ?? r.error ?? '—'}` });
  for (const c of s.checks || []) {
    const want = subVars(String(c.value ?? ''), vars);
    const { values } = queryPath(parsed, c.path);
    const op = c.op || 'exists';
    let pass = false;
    if (op === 'exists') pass = values.some((v) => v !== undefined && v !== null);
    else if (op === 'equals') pass = values.some((v) => toStr(v) === want);
    else if (op === 'notEquals') pass = values.length > 0 && values.every((v) => toStr(v) !== want);
    else if (op === 'contains') pass = values.some((v) => toStr(v).includes(want));
    checks.push({ label: `${c.path || '.'} ${op}${op === 'exists' ? '' : ` ${want}`}`, pass, detail: `got ${toStr(values[0]).slice(0, 80)}` });
  }
  const ok = !r.error && (s.expectStatus == null ? (r.status != null && r.status < 400) : true) && checks.every((c) => c.pass);
  return { index, name, kind: 'api', ok, status: r.status, detail: r.error ? r.error : `HTTP ${r.status}`, checks, extracted };
}

async function runDbStep(tenantId: string, s: UnifiedStep, vars: Record<string, string>): Promise<UnifiedStepResult> {
  const name = s.name || 'DB check';
  const query = subVars(s.query || '', vars);
  const expect = s.expect ? { ...s.expect, equals: s.expect.equals != null ? subVars(String(s.expect.equals), vars) : undefined } : undefined;
  try {
    const r: any = await runDbValidation(tenantId, { connectionId: s.connectionId, config: s.config, query, expect } as any);
    const ok = !!r.passed;
    const detail = String(r.detail || r.message || `${r.rowCount ?? '?'} row(s)`).slice(0, 200);
    const checks = Array.isArray(r.checks) ? r.checks : [{ label: 'db assertion', pass: ok, detail }];
    return { index: 0, name, kind: 'db', ok, detail, checks };
  } catch (e) {
    return { index: 0, name, kind: 'db', ok: false, detail: (e as Error).message, checks: [{ label: 'db assertion', pass: false, detail: (e as Error).message }] };
  }
}

async function runUiStep(s: UnifiedStep, vars: Record<string, string>): Promise<UnifiedStepResult> {
  const name = s.name || `UI ${s.uiUrl}`;
  if (!String(s.uiUrl || '').trim()) return { index: 0, name, kind: 'ui', ok: false, detail: 'No UI url set.', checks: [] };
  try {
    const url = assertWebUrl(subVars(s.uiUrl!, vars));
    return await withPage(url, async (page: any) => {
      const checks: UnifiedStepResult['checks'] = [];
      for (const c of (s.uiChecks || []).slice(0, 30)) checks.push(await evalUiCheck(page, c, vars));
      let shot: string | undefined;
      try { const buf = await page.screenshot({ type: 'png', fullPage: false }); shot = Buffer.from(buf).toString('base64'); } catch { /* optional */ }
      const ok = checks.length > 0 && checks.every((c) => c.pass);
      return { index: 0, name, kind: 'ui' as const, ok, detail: `reached ${page.url()}`, checks, screenshotBase64: shot };
    }, { engine: s.engine, waitUntil: 'domcontentloaded', gotoTimeoutMs: 30_000 });
  } catch (e) {
    const msg = e instanceof BrowserNotInstalledError ? `${e.message} — install Chromium (npx playwright install chromium) to run UI steps.` : (e as Error).message;
    return { index: 0, name, kind: 'ui', ok: false, detail: msg, checks: [] };
  }
}

export async function runUnified(
  tenantId: string,
  input: { steps?: UnifiedStep[]; variables?: Record<string, string>; allowWrites?: boolean },
): Promise<UnifiedResult> {
  const steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS);
  if (!steps.length) throw new Error('A unified test needs at least one step.');
  const started = Date.now();
  const vars: Record<string, string> = { ...(input.variables || {}) };
  const allowWrites = !!input.allowWrites;
  const notes: string[] = [];
  const results: UnifiedStepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    let res: UnifiedStepResult;
    if (s.kind === 'db') res = await runDbStep(tenantId, s, vars);
    else if (s.kind === 'ui') res = await runUiStep(s, vars);
    else res = await runApiStep(s, vars, allowWrites);
    res.index = i;
    results.push(res);
    // A hard API transport failure aborts the rest (later steps usually depend on it).
    if (s.kind === 'api' && !res.ok && res.status == null) { notes.push(`Step ${i + 1} ("${res.name}") could not be reached — remaining steps skipped.`); break; }
  }

  const passed = results.length > 0 && results.every((r) => r.ok);
  return { passed, durationMs: Date.now() - started, steps: results, variables: vars, stepsRun: results.length, stepsTotal: steps.length, notes };
}
