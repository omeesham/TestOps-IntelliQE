/**
 * flow.ts — the multi-step flow engine (M4).
 *
 * The minimal slice of the production flow runner
 * (backend/src/services/api-flow.service.ts): a linear list of HTTP steps where
 * each step can EXTRACT a value from its response into the variable bag, and
 * later steps SUBSTITUTE {{name}} into their url / headers / body. This is what
 * turns stateless single-endpoint tests into stateful journeys — create → read
 * → update → delete, carrying the real id minted by the create step forward.
 *
 * It reuses the executor's check engine (evalChecks / fetchResponse / getPath),
 * so an ApiCheck means exactly the same thing in a flow as in a single case.
 * Loops, branches, retries, suites and data-driven runs (all in production) are
 * deliberately out of scope here.
 */
import { randomUUID } from 'node:crypto';
import type { FlowStep, FlowStepResult, FlowRunResult, ApiCheck } from './types';
import { evalChecks, fetchResponse, getPath, isWriteMethod, type ResponseView } from './executor';

const MAX_STEPS = 8;
const STEP_TIMEOUT_MS = 15_000;

/**
 * Resolve a dynamic variable (Postman-style) so a flow can mint UNIQUE data each
 * run — e.g. {{$timestamp}} in a create body whose uniqueness constraint would
 * otherwise reject a repeat run. Unknown names are left literal.
 */
function dynamicVar(name: string): string {
  switch (name) {
    case '$uuid':
      return randomUUID();
    case '$timestamp':
      return String(Date.now());
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(Math.random() * 1000));
    case '$randomString':
      return Math.random().toString(36).slice(2, 10);
    case '$randomEmail':
      return `test_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`;
    default:
      return `{{${name}}}`;
  }
}

/** Substitute {{var}} occurrences in a string from the variable bag. Unresolved vars stay literal. */
export function substitute(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w$.-]+)\s*\}\}/g, (_m, k: string) => {
    if (k[0] === '$') return dynamicVar(k);
    if (k in vars) return vars[k]!;
    return _m; // leave unresolved tokens literal
  });
}

function substituteHeaders(headers: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = substitute(String(v ?? ''), vars);
  return out;
}

function toStr(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Read one extract source: "header:Name", "status", or a dotted body path. */
function readExtract(source: string, res: ResponseView): string {
  if (source === 'status') return String(res.status);
  if (source.toLowerCase().startsWith('header:')) return res.headers[source.slice(7).trim().toLowerCase()] ?? '';
  return toStr(getPath(res.parsed, source));
}

export interface FlowRunOptions {
  variables?: Record<string, string>;
  /** Write methods (POST/PUT/PATCH/DELETE) are refused unless this is true. */
  allowWrites?: boolean;
  timeoutMs?: number;
}

/**
 * Run a journey end to end. Steps run in order; each step's extracts are added
 * to the shared variable bag before the next step substitutes them. A transport
 * error aborts the journey (later steps usually depend on earlier ones). The
 * journey passes only when every executed step passed.
 */
export async function runFlow(steps: FlowStep[], opts: FlowRunOptions = {}): Promise<FlowRunResult> {
  const all = (Array.isArray(steps) ? steps : []).slice(0, MAX_STEPS);
  if (!all.length) throw new Error('A flow needs at least one step.');

  const vars: Record<string, string> = { ...(opts.variables || {}) };
  const results: FlowStepResult[] = [];
  const started = Date.now();

  for (let i = 0; i < all.length; i++) {
    const s = all[i]!;
    const method = (s.method || 'GET').toUpperCase();
    const name = s.name || `${method} ${s.url}`;

    // Write-safety guard — a journey must not mutate data without an opt-in.
    if (isWriteMethod(method) && !opts.allowWrites) {
      results.push({
        index: i,
        name,
        method,
        url: s.url,
        ok: false,
        durationMs: 0,
        extracted: {},
        checks: [],
        error: `Refused: ${method} is a write. Enable "allow writes" to run this journey against the environment.`,
      });
      break; // later steps depend on this one
    }

    // Fill {{vars}} into url / headers / body from the running bag.
    const url = substitute(s.url || '', vars);
    const headers = substituteHeaders(s.headers, vars);
    const body = s.body ? substitute(s.body, vars) : undefined;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const stepStart = Date.now();
    let res: ResponseView;
    try {
      const init: RequestInit = { method, headers };
      if (body && isWriteMethod(method)) init.body = body;
      res = await fetchResponse(url, init, opts.timeoutMs ?? STEP_TIMEOUT_MS);
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'request timed out' : e.message) : String(e);
      results.push({ index: i, name, method, url, ok: false, durationMs: Date.now() - stepStart, extracted: {}, checks: [], error: msg });
      break; // abort the journey on a transport error
    }

    // Extract values for later steps.
    const extracted: Record<string, string> = {};
    for (const [varName, source] of Object.entries(s.extract || {})) {
      const value = readExtract(String(source), res);
      extracted[varName] = value;
      vars[varName] = value;
    }

    const checks = evalChecks((s.checks || []) as ApiCheck[], res);
    const hasStatusGate = (s.checks || []).some((c) => c.kind === 'status' || c.kind === 'ok' || c.kind === 'notOk');
    const statusDefaultOk = hasStatusGate || (res.status >= 200 && res.status < 400);
    const ok = statusDefaultOk && checks.every((c) => c.pass);

    results.push({
      index: i,
      name,
      method,
      url,
      ok,
      status: res.status,
      durationMs: res.elapsedMs,
      extracted,
      checks,
      bodyPreview: res.bodyText.slice(0, 300),
    });
  }

  return {
    passed: results.length > 0 && results.every((r) => r.ok),
    steps: results,
    variables: vars,
    durationMs: Date.now() - started,
    stepsRun: results.length,
    stepsTotal: all.length,
  };
}
