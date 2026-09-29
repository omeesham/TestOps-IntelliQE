/**
 * api-security.service.ts
 * ───────────────────────
 * An in-house OWASP-API-flavoured security scan — no ZAP/Nuclei binary. For
 * each endpoint it runs a bounded set of non-destructive checks and reports
 * findings with severity + evidence.
 *
 * Safety first: destructive verbs (POST/PUT/PATCH/DELETE) are NOT replayed with
 * attack payloads. For a write endpoint only the safe, read-only checks run
 * (an OPTIONS preflight for CORS + a header inspection); the request-issuing
 * checks are marked "skipped". Standalone and opt-in — no pipeline code touched.
 */
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';

export interface SecurityEndpointInput extends HttpEndpoint {
  id: string;
  title?: string;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'vulnerable' | 'ok' | 'info' | 'skipped';

export interface SecurityFinding {
  endpointId: string;
  title: string;
  method: string;
  url: string;
  check: string;
  severity: Severity;
  status: FindingStatus;
  detail: string;
}

export interface SecurityReport {
  findings: SecurityFinding[];
  summary: { endpoints: number; vulnerable: number; high: number; medium: number; low: number; info: number };
}

const MAX_ENDPOINTS = 40;
const CONCURRENCY = 4;
const INJECTION = "' OR '1'='1";
const STACK_RE = /(at [\w.$]+\([^)]*:\d+:\d+\))|Traceback \(most recent call last\)|Exception in thread|System\.[A-Za-z.]+Exception|ORA-\d{5}|SQLSTATE|syntax error at or near|You have an error in your SQL syntax/i;

function addQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

async function scanOne(ep: SecurityEndpointInput): Promise<SecurityFinding[]> {
  const method = (ep.method || 'GET').toUpperCase();
  const title = ep.title || `${method} ${ep.url}`;
  const out: SecurityFinding[] = [];
  const mk = (check: string, severity: Severity, status: FindingStatus, detail: string): SecurityFinding =>
    ({ endpointId: ep.id, title, method, url: ep.url, check, severity, status, detail });

  const write = isWriteMethod(method);
  const hasAuth = !!(ep.auth && ep.auth.type !== 'none' && ep.auth.value);

  // Baseline (with auth). For write methods use a safe OPTIONS preflight instead.
  const baseReq = write ? buildRequestInit(ep, { method: 'OPTIONS' }) : buildRequestInit(ep);
  const base = await fetchFull(baseReq.url, baseReq.init);

  if (base.error && !write) {
    return [mk('reachability', 'info', 'info', `Endpoint could not be reached: ${base.error}`)];
  }

  // ── Transport security ──
  if (/^http:\/\//i.test(ep.url)) {
    out.push(mk('transport-security', 'medium', 'vulnerable', 'Endpoint is served over plain HTTP — traffic and any credentials are unencrypted.'));
  } else if (base.headers && !base.headers['strict-transport-security']) {
    out.push(mk('hsts', 'low', 'vulnerable', 'HTTPS endpoint is missing the Strict-Transport-Security header.'));
  }

  // ── Security headers ──
  const missing: string[] = [];
  if (!base.headers['x-content-type-options']) missing.push('X-Content-Type-Options');
  if (!base.headers['x-frame-options'] && !base.headers['content-security-policy']) missing.push('X-Frame-Options / Content-Security-Policy');
  if (missing.length) out.push(mk('security-headers', 'low', 'vulnerable', `Missing hardening headers: ${missing.join(', ')}.`));
  else out.push(mk('security-headers', 'low', 'ok', 'Core hardening headers are present.'));

  // ── CORS ──
  const cors = base.headers['access-control-allow-origin'];
  if (cors === '*' && hasAuth) {
    out.push(mk('cors', 'medium', 'vulnerable', 'Access-Control-Allow-Origin: * on an authenticated endpoint — any origin can read responses.'));
  }

  // ── Server banner / verbose errors ──
  if (STACK_RE.test(base.bodyText)) {
    out.push(mk('info-leak', 'medium', 'vulnerable', 'Response body contains a stack trace or database error — internal details are exposed.'));
  }

  if (write) {
    out.push(mk('broken-auth', 'info', 'skipped', 'Auth-bypass and injection checks skipped for a write method to avoid mutating data.'));
    return out;
  }

  // ── Broken authentication (missing credentials) ──
  if (hasAuth) {
    const noAuthReq = buildRequestInit(ep, { omitAuth: true });
    const noAuth = await fetchFull(noAuthReq.url, noAuthReq.init);
    if (!noAuth.error && noAuth.status !== undefined && noAuth.status >= 200 && noAuth.status < 300) {
      out.push(mk('broken-auth', 'high', 'vulnerable', `Endpoint returned ${noAuth.status} with NO credentials — authentication may not be enforced (BOLA/BFLA risk).`));
    } else {
      out.push(mk('broken-auth', 'high', 'ok', `Rejected the unauthenticated request (${noAuth.status ?? noAuth.error}).`));
    }
  }

  // ── Injection handling ──
  const injReq = buildRequestInit({ ...ep, url: addQueryParam(ep.url, 'q', INJECTION) });
  const inj = await fetchFull(injReq.url, injReq.init);
  if (!inj.error) {
    if (inj.status === 500) {
      out.push(mk('injection', 'medium', 'vulnerable', 'A SQL-shaped value triggered a 500 — input may not be safely parameterised.'));
    } else if (inj.bodyText.includes(INJECTION)) {
      out.push(mk('injection', 'medium', 'vulnerable', 'The injected value was reflected verbatim in the response — check output encoding (XSS risk).'));
    } else if (STACK_RE.test(inj.bodyText)) {
      out.push(mk('injection', 'medium', 'vulnerable', 'A malformed value surfaced a database/stack error.'));
    } else {
      out.push(mk('injection', 'medium', 'ok', 'Handled a SQL-shaped value cleanly (no 500, no reflection).'));
    }
  }

  return out;
}

export function normalizeSecurityInput(raw: unknown): SecurityEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: SecurityEndpointInput[] = [];
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
      body: ep.body ? String(ep.body) : undefined,
    });
  }
  return out;
}

export async function runSecurityScan(rawEndpoints: unknown): Promise<SecurityReport> {
  const endpoints = normalizeSecurityInput(rawEndpoints);
  const all: SecurityFinding[][] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      try { all[i] = await scanOne(endpoints[i]!); }
      catch (e) { all[i] = [{ endpointId: endpoints[i]!.id, title: endpoints[i]!.title || endpoints[i]!.url, method: (endpoints[i]!.method || 'GET').toUpperCase(), url: endpoints[i]!.url, check: 'scan', severity: 'info', status: 'info', detail: `Scan error: ${(e as Error).message}` }]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const findings = all.flat().filter(Boolean);
  const vuln = findings.filter((f) => f.status === 'vulnerable');
  return {
    findings,
    summary: {
      endpoints: endpoints.length,
      vulnerable: vuln.length,
      high: vuln.filter((f) => f.severity === 'high').length,
      medium: vuln.filter((f) => f.severity === 'medium').length,
      low: vuln.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.status === 'info').length,
    },
  };
}
