/**
 * api-fuzz.service.ts
 * ───────────────────
 * AI-guided fuzzing / property-based robustness testing.
 *
 * From each endpoint's own parameters it derives a battery of boundary, type-
 * confusion and malformed inputs (empty, huge, negative, unicode, injection-
 * shaped, traversal, template-injection…), fires them one parameter at a time,
 * and reports where the API breaks: 5xx crashes, leaked stack traces, reflected
 * payloads, hangs, and weak validation (an invalid value accepted with 2xx).
 * This is the property-based counterpart to the hand-written negative scenarios
 * the generator designs — it finds the unhandled cases nobody wrote a test for.
 *
 * Safety: strictly non-destructive. Only READ methods (GET/HEAD) are fuzzed by
 * mutating query parameters; write methods (POST/PUT/PATCH/DELETE) are never
 * replayed with mutated bodies and are reported as skipped. Standalone, opt-in,
 * no pipeline coupling.
 */
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';

export interface FuzzEndpointInput extends HttpEndpoint {
  id: string;
  title?: string;
  queryParams?: { name: string; example?: string; required?: boolean }[];
}

export type FuzzSeverity = 'high' | 'medium' | 'low' | 'info';
export type FuzzKind = 'server-error' | 'info-leak' | 'reflection' | 'timeout' | 'weak-validation' | 'handled' | 'unreachable' | 'skipped';
export type FuzzCategory = 'boundary' | 'type' | 'injection' | 'traversal' | 'overflow' | 'unicode' | 'template';

export interface FuzzCase { param: string; category: FuzzCategory; label: string; value: string }

export interface FuzzFinding {
  endpointId: string;
  title: string;
  method: string;
  url: string;
  param: string;
  category: FuzzCategory;
  payload: string;
  status?: number;
  kind: FuzzKind;
  severity: FuzzSeverity;
  detail: string;
}

export interface FuzzReport {
  findings: FuzzFinding[];
  summary: {
    endpoints: number;
    cases: number;
    crashes: number;      // 5xx
    leaks: number;        // stack traces / DB errors
    reflections: number;  // unencoded echo
    timeouts: number;
    weakValidation: number;
    handled: number;      // properly rejected
    issues: number;       // high+medium+low findings (non-info)
  };
}

const MAX_ENDPOINTS = 12;
const MAX_PARAMS = 3;
const MAX_CASES_PER_ENDPOINT = 24;
// Bounded so the worst case (every request hitting its timeout) stays under the
// client's 180s ceiling: 120 / 8 workers × 8s ≈ 120s. Typical runs finish in seconds.
const MAX_TOTAL_CASES = 120;
const CONCURRENCY = 8;
const TIMEOUT_MS = 8_000;

const STACK_RE = /(at [\w.$]+\([^)]*:\d+:\d+\))|Traceback \(most recent call last\)|Exception in thread|System\.[A-Za-z.]+Exception|ORA-\d{5}|SQLSTATE|syntax error at or near|You have an error in your SQL syntax|NullPointerException|undefined method|panic:/i;

/** The property-based payload catalogue — each probes a different failure mode. */
export const PAYLOADS: { category: FuzzCategory; label: string; value: string }[] = [
  { category: 'boundary', label: 'empty', value: '' },
  { category: 'boundary', label: 'whitespace', value: '   ' },
  { category: 'boundary', label: 'negative', value: '-1' },
  { category: 'overflow', label: 'int overflow', value: '2147483648' },
  { category: 'overflow', label: 'huge number', value: '99999999999999999999' },
  { category: 'overflow', label: 'very long string', value: 'A'.repeat(5000) },
  { category: 'type', label: 'boolean where value expected', value: 'true' },
  { category: 'type', label: 'array-shaped', value: 'a,b,c' },
  { category: 'type', label: 'json-shaped', value: '{"x":1}' },
  { category: 'unicode', label: 'unicode / emoji', value: '💥𝕏你好\u0000' },
  { category: 'injection', label: 'sql-shaped', value: "' OR '1'='1" },
  { category: 'injection', label: 'xss-shaped', value: '<script>alert(1)</script>' },
  { category: 'traversal', label: 'path traversal', value: '../../../../etc/passwd' },
  { category: 'template', label: 'template injection', value: '{{7*7}}' },
];

/** Values whose only legitimate response is a rejection — a 2xx here is weak validation. */
const INVALID_CATEGORIES = new Set<FuzzCategory>(['injection', 'traversal', 'template', 'overflow']);

/** Build the fuzz cases for one endpoint from its declared parameters. Pure. */
export function buildFuzzCases(ep: FuzzEndpointInput): FuzzCase[] {
  if (isWriteMethod(ep.method)) return []; // write methods are not body-fuzzed
  const declared = (ep.queryParams || []).map((p) => p?.name).filter((n): n is string => !!n);
  const params = (declared.length ? declared : ['q']).slice(0, MAX_PARAMS);
  const cases: FuzzCase[] = [];
  for (const param of params) {
    for (const p of PAYLOADS) {
      cases.push({ param, category: p.category, label: p.label, value: p.value });
      if (cases.length >= MAX_CASES_PER_ENDPOINT) return cases;
    }
  }
  return cases;
}

/** Classify one fuzzed response into a finding kind + severity. Pure. */
export function classifyFuzzResponse(
  res: { status?: number; bodyText: string; error?: string },
  c: FuzzCase,
): { kind: FuzzKind; severity: FuzzSeverity; detail: string } {
  if (res.error) {
    if (/timeout|abort|timed out/i.test(res.error)) {
      return { kind: 'timeout', severity: 'medium', detail: `Request timed out on a ${c.label} value — possible unbounded processing.` };
    }
    return { kind: 'unreachable', severity: 'info', detail: `Could not complete the request: ${res.error}.` };
  }
  const status = res.status ?? 0;
  if (status >= 500) {
    return { kind: 'server-error', severity: 'high', detail: `A ${c.label} value in "${c.param}" caused a ${status} — the input is not handled safely.` };
  }
  if (STACK_RE.test(res.bodyText)) {
    return { kind: 'info-leak', severity: 'high', detail: `A ${c.label} value surfaced a stack trace / database error — internal details leaked.` };
  }
  if (c.value.length >= 8 && /[<>{}$']/.test(c.value) && res.bodyText.includes(c.value)) {
    return { kind: 'reflection', severity: 'medium', detail: `The ${c.label} payload was reflected verbatim in the response — check output encoding (XSS risk).` };
  }
  if (status >= 200 && status < 300 && INVALID_CATEGORIES.has(c.category)) {
    return { kind: 'weak-validation', severity: 'low', detail: `A clearly-invalid ${c.label} value was accepted with ${status} — input validation looks weak.` };
  }
  return { kind: 'handled', severity: 'info', detail: `Rejected/handled a ${c.label} value with ${status || 'no error'}.` };
}

function withQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

export function normalizeFuzzInput(raw: unknown): FuzzEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: FuzzEndpointInput[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, any>;
    const url = String(ep.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id: String(ep.id || url),
      title: ep.title ? String(ep.title) : undefined,
      method: String(ep.method || 'GET'),
      url,
      headers: Array.isArray(ep.headers) ? ep.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
      auth: ep.auth && typeof ep.auth === 'object' ? { type: String(ep.auth.type || 'none'), value: ep.auth.value ? String(ep.auth.value) : undefined, headerName: ep.auth.headerName ? String(ep.auth.headerName) : undefined } : undefined,
      queryParams: Array.isArray(ep.queryParams) ? ep.queryParams.filter((p: any) => p?.name).map((p: any) => ({ name: String(p.name), example: p.example != null ? String(p.example) : undefined, required: !!p.required })) : [],
    });
  }
  return out;
}

const mk = (ep: FuzzEndpointInput, c: FuzzCase, extra: Partial<FuzzFinding>): FuzzFinding => ({
  endpointId: ep.id,
  title: ep.title || `${(ep.method || 'GET').toUpperCase()} ${ep.url}`,
  method: (ep.method || 'GET').toUpperCase(),
  url: ep.url,
  param: c.param,
  category: c.category,
  payload: c.value.length > 60 ? `${c.value.slice(0, 57)}…` : c.value,
  kind: 'handled',
  severity: 'info',
  detail: '',
  ...extra,
});

export async function runApiFuzz(rawEndpoints: unknown): Promise<FuzzReport> {
  const endpoints = normalizeFuzzInput(rawEndpoints);

  // Flatten to a global, capped work queue so wall-clock stays bounded.
  type Job = { ep: FuzzEndpointInput; c: FuzzCase };
  const jobs: Job[] = [];
  const skipped: FuzzFinding[] = [];
  for (const ep of endpoints) {
    if (isWriteMethod(ep.method)) {
      skipped.push(mk(ep, { param: '—', category: 'boundary', label: '', value: '' } as FuzzCase, { kind: 'skipped', severity: 'info', param: '—', payload: '', detail: 'Write method — not fuzzed to avoid mutating data.' }));
      continue;
    }
    for (const c of buildFuzzCases(ep)) {
      if (jobs.length >= MAX_TOTAL_CASES) break;
      jobs.push({ ep, c });
    }
  }

  const results: FuzzFinding[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const i = next++;
      const { ep, c } = jobs[i]!;
      try {
        const base = buildRequestInit({ ...ep, url: withQueryParam(ep.url, c.param, c.value) });
        const res = await fetchFull(base.url, base.init, TIMEOUT_MS);
        const verdict = classifyFuzzResponse(res, c);
        results[i] = mk(ep, c, { status: res.status, ...verdict });
      } catch (e) {
        results[i] = mk(ep, c, { kind: 'unreachable', severity: 'info', detail: `Fuzz error: ${(e as Error).message}` });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const findings = [...results.filter(Boolean), ...skipped];
  const by = (k: FuzzKind) => findings.filter((f) => f.kind === k).length;
  return {
    findings,
    summary: {
      endpoints: endpoints.length,
      cases: jobs.length,
      crashes: by('server-error'),
      leaks: by('info-leak'),
      reflections: by('reflection'),
      timeouts: by('timeout'),
      weakValidation: by('weak-validation'),
      handled: by('handled'),
      issues: findings.filter((f) => f.severity === 'high' || f.severity === 'medium' || f.severity === 'low').length,
    },
  };
}
