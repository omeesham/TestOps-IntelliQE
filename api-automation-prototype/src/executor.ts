/**
 * executor.ts — the deterministic execution engine.
 *
 * Ported from the production flow runner (backend/src/services/api-flow.service.ts
 * `runChecks` + the request step). Given an ExecutableCase it issues ONE HTTP
 * request and evaluates each typed ApiCheck against the response. No browser, no
 * Playwright, no model. This is the half of the invariant proven live.
 *
 * The HTTP + check-eval helpers (fetchResponse / evalChecks / getPath) are
 * exported so the multi-step flow engine (flow.ts) reuses the exact same check
 * logic — one definition of what each ApiCheck means.
 */
import type { ApiCheck, CheckResult, NormalizedCase, RunResult, RunSummary } from './types';
import type { ExecutableCase } from './renderer';

const DEFAULT_TIMEOUT_MS = 15_000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/** Read a dotted path out of a parsed JSON value. "" / undefined = the whole body. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function toStr(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** A human-readable label for a check, for the report. Ported from describeCheck. */
export function describeCheck(c: ApiCheck): string {
  switch (c.kind) {
    case 'status':
      if (typeof c.equals === 'number') return `status is ${c.equals}`;
      if (Array.isArray(c.oneOf)) return `status is one of ${c.oneOf.join(', ')}`;
      if (typeof c.lessThan === 'number') return `status is under ${c.lessThan}`;
      return 'response is 2xx';
    case 'ok':
      return 'response is 2xx';
    case 'notOk':
      return 'response is a non-2xx error';
    case 'jsonProperty': {
      const p = c.path || 'root';
      if ('value' in c && c.value !== undefined) return `JSON "${p}" equals ${JSON.stringify(c.value)}`;
      if (c.type) return `JSON "${p}" is of type ${c.type}`;
      return `JSON "${p}" is present`;
    }
    case 'jsonArrayNotEmpty':
      return `${c.path ? `"${c.path}"` : 'body'} is a non-empty array`;
    case 'header':
      return c.contains ? `header "${c.name}" contains "${c.contains}"` : `header "${c.name}" is present`;
    case 'bodyContains':
      return `body contains "${c.text}"`;
    case 'responseTimeUnderMs':
      return `response time under ${c.ms} ms`;
  }
}

export interface ResponseView {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  parsed: unknown;
  elapsedMs: number;
}

/** Evaluate one check against the response. Pure — this is the deterministic core. */
function evalCheck(c: ApiCheck, res: ResponseView): CheckResult {
  const label = describeCheck(c);
  switch (c.kind) {
    case 'status': {
      const codes = c.oneOf?.length ? c.oneOf : c.equals != null ? [c.equals] : [];
      if (typeof c.lessThan === 'number')
        return { label, pass: res.status < c.lessThan, actual: String(res.status) };
      const pass = codes.length ? codes.includes(res.status) : res.status < 400;
      return { label, pass, actual: String(res.status) };
    }
    case 'ok':
      return { label, pass: res.status >= 200 && res.status < 300, actual: String(res.status) };
    case 'notOk':
      return { label, pass: res.status < 200 || res.status >= 300, actual: String(res.status) };
    case 'jsonProperty': {
      const v = getPath(res.parsed, c.path);
      let pass = true;
      if (c.exists) pass = pass && v !== undefined && v !== null;
      if ('value' in c && c.value !== undefined) pass = pass && JSON.stringify(v) === JSON.stringify(c.value);
      if (c.type) pass = pass && (c.type === 'array' ? Array.isArray(v) : typeof v === c.type);
      // A bare jsonProperty with no modifier means "exists".
      if (!c.exists && !('value' in c && c.value !== undefined) && !c.type) pass = v !== undefined && v !== null;
      return { label, pass, actual: toStr(v).slice(0, 120) };
    }
    case 'jsonArrayNotEmpty': {
      const v = getPath(res.parsed, c.path);
      const pass = Array.isArray(v) && v.length > 0;
      return { label, pass, actual: Array.isArray(v) ? `array[${v.length}]` : typeof v };
    }
    case 'header': {
      const hv = res.headers[String(c.name || '').toLowerCase()];
      const pass = c.contains ? (hv || '').toLowerCase().includes(c.contains.toLowerCase()) : hv !== undefined;
      return { label, pass, actual: hv !== undefined ? String(hv).slice(0, 120) : '(absent)' };
    }
    case 'bodyContains': {
      const pass = res.bodyText.includes(String(c.text ?? ''));
      return { label, pass, actual: pass ? 'found' : 'not found' };
    }
    case 'responseTimeUnderMs': {
      const limit = Number(c.ms) || 10_000;
      return { label, pass: res.elapsedMs < limit, actual: `${res.elapsedMs}ms` };
    }
  }
}

/** Evaluate a list of checks against one response. Shared by single-case and flow execution. */
export function evalChecks(checks: ApiCheck[], res: ResponseView): CheckResult[] {
  return checks.map((c) => evalCheck(c, res));
}

/** Issue one HTTP request and read the full response into a ResponseView (with timeout). */
export async function fetchResponse(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ResponseView> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await resp.text();
    const elapsedMs = Date.now() - started;
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    return { status: resp.status, headers, bodyText, parsed, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

const CRED_HEADER_RE = /^(authorization|x-api-key|api-key|apikey|cookie|x-auth-token)$/i;

/** Mask credential header values before they are echoed/logged. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (CRED_HEADER_RE.test(k) || /(secret|token|api[-_]?key)/i.test(k)) {
      const scheme = /^(bearer|basic)\s/i.exec(v)?.[1];
      out[k] = scheme ? `${scheme} ********` : '********';
    } else out[k] = v;
  }
  return out;
}

export interface RunOptions {
  /** Write methods are refused unless this is explicitly true. */
  allowWrites?: boolean;
  timeoutMs?: number;
}

/** Run one case: issue the request, evaluate every check, return a RunResult. */
export async function runCase(ec: ExecutableCase, opts: RunOptions = {}): Promise<RunResult> {
  const c = ec.case;
  const base = { id: c.id, title: c.title, category: c.category, method: c.method, url: c.url };

  // Write-safety guard (ported from the flow engine). A write never executes
  // without an explicit opt-in — the prototype must not mutate someone's data.
  if (isWriteMethod(c.method) && !opts.allowWrites) {
    return {
      ...base,
      ok: false,
      durationMs: 0,
      checks: [],
      error: `Refused: ${c.method} is a write. Re-run with "allow writes" to execute it against this environment.`,
    };
  }

  const started = Date.now();
  try {
    const init: RequestInit = { method: c.method, headers: c.headers };
    if (c.body && isWriteMethod(c.method)) init.body = c.body;
    const res = await fetchResponse(c.url, init, opts.timeoutMs);
    const checks = evalChecks(c.checks, res);

    // A case passes when every check passed. When no explicit status check is
    // present, a transport-level non-2xx also fails it (the default gate).
    const hasStatusGate = c.checks.some((x) => x.kind === 'status' || x.kind === 'ok' || x.kind === 'notOk');
    const statusDefaultOk = hasStatusGate || (res.status >= 200 && res.status < 400);
    const ok = statusDefaultOk && checks.every((x) => x.pass);

    return { ...base, ok, status: res.status, durationMs: res.elapsedMs, checks, bodyPreview: res.bodyText.slice(0, 300) };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'request timed out' : e.message) : String(e);
    return { ...base, ok: false, durationMs: elapsedMs, checks: [], error: msg };
  }
}

/** Run a whole suite sequentially and summarize it. */
export async function runSuite(cases: ExecutableCase[], opts: RunOptions = {}): Promise<{ results: RunResult[]; summary: RunSummary }> {
  const results: RunResult[] = [];
  for (const ec of cases) results.push(await runCase(ec, opts));
  return { results, summary: summarize(results) };
}

export function summarize(results: RunResult[]): RunSummary {
  const slow = results.reduce<RunResult | null>((a, r) => (!a || r.durationMs > a.durationMs ? r : a), null);
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    checks: results.reduce((n, r) => n + r.checks.length, 0),
    checksPassed: results.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0),
    slowestMs: slow?.durationMs ?? 0,
    slowestCase: slow?.title,
  };
}

export type { NormalizedCase };
