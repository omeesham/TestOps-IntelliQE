/**
 * api-data-correctness.service.ts
 * ───────────────────────────────
 * Distributed data-correctness verification — the depth beyond "the endpoint
 * returned 200". A write rarely lives in one place: it should propagate to a
 * read API, a downstream service, a database, a cache. This tool fires ONE
 * write, optionally waits for propagation, then runs a set of VERIFICATION
 * PROBES across services and databases and asserts the write actually landed
 * everywhere it should.
 *
 *   write (POST/PUT/PATCH/DELETE)  →  extract ids/values into {{vars}}
 *        → wait (eventual consistency)
 *        → probe A: GET the read model, assert the new value is reflected
 *        → probe B: GET a downstream service, assert it saw the change
 *        → probe C: SELECT from the database, assert the row/column matches
 *   ⇒ propagated = every probe passed.
 *
 * Reuses the shared HTTP helper, the assert-engine path reader, and the
 * read-only DB-validate module. The write is gated behind allowWrites (it sends
 * a real state-changing request). Standalone, opt-in; the pipeline is untouched.
 */
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint, type HttpAuth } from '../utils/api-http.js';
import { queryPath } from '../utils/assert-engine.js';
import { runDbValidation } from './api-db-validate.service.js';

export interface DcExtract { name: string; from: 'body' | 'header' | 'status'; path?: string }
export interface DcApiCheck { path?: string; op?: 'equals' | 'contains' | 'exists' | 'notEquals'; value?: string }
export interface DcWrite extends HttpEndpoint { extract?: DcExtract[] }

export interface DcApiProbe {
  kind: 'api';
  name?: string;
  method?: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: HttpAuth;
  body?: string;
  expectStatus?: number;
  checks?: DcApiCheck[];
}
export interface DcDbProbe {
  kind: 'db';
  name?: string;
  connectionId?: string;
  config?: unknown;
  query: string;
  expect?: { minRows?: number; maxRows?: number; column?: string; equals?: string };
}
export type DcProbe = DcApiProbe | DcDbProbe;

export interface DcProbeResult {
  name: string;
  kind: 'api' | 'db';
  target: string;
  passed: boolean;
  status?: number;
  detail: string;
  checks: { label: string; pass: boolean; detail?: string }[];
}
export interface DcResult {
  write: { method: string; url: string; status?: number; ok: boolean; error?: string; extracted: Record<string, string> };
  waitedMs: number;
  probes: DcProbeResult[];
  propagated: boolean;
  summary: { probes: number; passed: number; failed: number };
  notes: string[];
}

const MAX_PROBES = 20;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function substitute(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => (k in vars ? vars[k]! : `{{${k}}}`));
}
function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }
function tryParse(t: string): unknown { try { return JSON.parse(t); } catch { return undefined; } }

function subAuth(a: HttpAuth | undefined, vars: Record<string, string>): HttpAuth | undefined {
  if (!a) return a;
  return { ...a, value: a.value ? substitute(a.value, vars) : a.value };
}

async function runApiProbe(p: DcApiProbe, vars: Record<string, string>): Promise<DcProbeResult> {
  const method = (p.method || 'GET').toUpperCase();
  const name = p.name || `${method} ${p.url}`;
  const ep: HttpEndpoint = {
    method,
    url: substitute(p.url, vars),
    headers: (p.headers || []).map((h) => ({ key: h.key, value: substitute(h.value ?? '', vars) })),
    auth: subAuth(p.auth, vars),
    body: p.body ? substitute(p.body, vars) : undefined,
  };
  const { url, init } = buildRequestInit(ep);
  const r = await fetchFull(url, init);
  const checks: DcProbeResult['checks'] = [];
  if (p.expectStatus != null) checks.push({ label: `status == ${p.expectStatus}`, pass: r.status === p.expectStatus, detail: `got ${r.status ?? r.error ?? '—'}` });
  const parsed = tryParse(r.bodyText);
  for (const c of p.checks || []) {
    const want = substitute(String(c.value ?? ''), vars);
    const { values } = queryPath(parsed, c.path);
    const op = c.op || 'exists';
    let pass = false;
    if (op === 'exists') pass = values.some((v) => v !== undefined && v !== null);
    else if (op === 'equals') pass = values.some((v) => toStr(v) === want);
    else if (op === 'notEquals') pass = values.length > 0 && values.every((v) => toStr(v) !== want);
    else if (op === 'contains') pass = values.some((v) => toStr(v).includes(want));
    checks.push({ label: `${c.path || '.'} ${op}${op === 'exists' ? '' : ` ${want}`}`, pass, detail: `got ${toStr(values[0]).slice(0, 80)}` });
  }
  const passed = !r.error && (p.expectStatus == null ? (r.status != null && r.status < 400) : true) && checks.every((c) => c.pass);
  return { name, kind: 'api', target: url, passed, status: r.status, detail: r.error ? r.error : `HTTP ${r.status}`, checks };
}

async function runDbProbe(tenantId: string, p: DcDbProbe, vars: Record<string, string>): Promise<DcProbeResult> {
  const name = p.name || 'DB check';
  const query = substitute(p.query || '', vars);
  const expect = p.expect ? { ...p.expect, equals: p.expect.equals != null ? substitute(String(p.expect.equals), vars) : undefined } : undefined;
  try {
    const r = await runDbValidation(tenantId, { connectionId: p.connectionId, config: p.config, query, expect } as any);
    const passed = !!(r as any).passed;
    const detail = (r as any).detail || (r as any).message || `${(r as any).rowCount ?? '?'} row(s)`;
    const checks = Array.isArray((r as any).checks) ? (r as any).checks : [{ label: 'db assertion', pass: passed, detail }];
    return { name, kind: 'db', target: query.slice(0, 80), passed, detail: String(detail).slice(0, 200), checks };
  } catch (e) {
    return { name, kind: 'db', target: query.slice(0, 80), passed: false, detail: (e as Error).message, checks: [{ label: 'db assertion', pass: false, detail: (e as Error).message }] };
  }
}

export async function runDataCorrectness(
  tenantId: string,
  input: { write?: DcWrite; probes?: DcProbe[]; waitMs?: number; allowWrites?: boolean },
): Promise<DcResult> {
  const notes: string[] = [];
  const write = input.write;
  if (!write || !/^https?:\/\//i.test(String(write.url || ''))) throw new Error('Provide a write action with an http(s) URL.');
  const probes = (Array.isArray(input.probes) ? input.probes : []).slice(0, MAX_PROBES);
  if (!probes.length) throw new Error('Provide at least one verification probe (an API read or a DB SELECT).');

  const method = (write.method || 'POST').toUpperCase();
  if (!isWriteMethod(method)) notes.push(`The "write" uses ${method} — usually a write is POST/PUT/PATCH/DELETE. Proceeding anyway.`);
  if (isWriteMethod(method) && !input.allowWrites) {
    throw new Error('The write action sends a real state-changing request. Re-run with "allow writes" enabled once it is safe against this environment.');
  }

  // 1) Fire the write, extract vars.
  const vars: Record<string, string> = {};
  const { url: wUrl, init: wInit } = buildRequestInit(write);
  const wRes = await fetchFull(wUrl, wInit);
  const parsed = tryParse(wRes.bodyText);
  for (const ex of write.extract || []) {
    if (!ex?.name) continue;
    let v: unknown;
    if (ex.from === 'status') v = wRes.status;
    else if (ex.from === 'header') v = wRes.headers[String(ex.path || '').toLowerCase()];
    else { const { values } = queryPath(parsed, ex.path); v = values.length > 1 ? values : values[0]; }
    vars[ex.name] = toStr(v);
  }
  const writeOk = !wRes.error && wRes.status != null && wRes.status < 400;

  // 2) Wait for eventual consistency.
  const waitedMs = Math.min(30_000, Math.max(0, Number(input.waitMs) || 0));
  if (waitedMs) await sleep(waitedMs);

  // 3) Run every verification probe.
  const results: DcProbeResult[] = [];
  for (const p of probes) {
    if (p.kind === 'db') results.push(await runDbProbe(tenantId, p, vars));
    else results.push(await runApiProbe(p as DcApiProbe, vars));
  }

  const passed = results.filter((r) => r.passed).length;
  const propagated = writeOk && results.length > 0 && results.every((r) => r.passed);
  if (!writeOk) notes.push(`The write itself did not succeed (${wRes.status ?? wRes.error}) — propagation can't be confirmed.`);

  return {
    write: { method, url: wUrl, status: wRes.status, ok: writeOk, error: wRes.error, extracted: vars },
    waitedMs,
    probes: results,
    propagated,
    summary: { probes: results.length, passed, failed: results.length - passed },
    notes,
  };
}
