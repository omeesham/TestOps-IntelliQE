/**
 * api-env-readiness.service.ts
 * ────────────────────────────
 * Pre-run Environment Readiness Gate (roadmap Feature 5 / Gate 4).
 *
 * Before a run executes against an environment, this service actively PROBES the
 * target — base URL reachable, health paths green, dependencies reachable,
 * required variables set, an authenticated call not rejected, and a production
 * safety check — and, when the environment's readiness is enabled with
 * `blockOnFail`, BLOCKS the run so an environment problem surfaces as
 * "environment_not_ready" rather than as a pile of product-defect test failures.
 *
 * Additive and opt-in, in the shape of the other API services: readiness config
 * lives on the environment row (its own JSON column); every evaluation is
 * snapshotted into `api_env_readiness_runs` as audit evidence. When an
 * environment has no readiness config, nothing changes — the run proceeds as
 * before. Reuses the dependency-free HTTP helpers (`api-http.ts`); never fires a
 * write request while probing.
 */
import pool from '../db.js';
import { getEnvironment, type ApiEnvironment } from './api-environments.service.js';
import { buildRequestInit, timedFetch } from '../utils/api-http.js';

export type ReadinessContext = 'preview' | 'pre-run';

export interface ReadinessConfig {
  enabled: boolean;
  /** When true, a failed mandatory check blocks the run; else it only warns. */
  blockOnFail: boolean;
  /** Probe the environment base URL is reachable. */
  checkBaseUrl: boolean;
  /** Relative paths expected to return 2xx (e.g. "/health", "/ready"). */
  healthPaths: string[];
  /** Absolute dependency URLs that must be reachable (downstream services). */
  dependencies: string[];
  /** Environment variable keys that must be present and non-empty. */
  requiredVars: string[];
  /** Probe an authenticated endpoint and require it is not 401/403. */
  checkAuth: boolean;
  authType: 'bearer' | 'basic' | 'apikey';
  authHeaderName?: string;
  /** Relative path for the auth probe (e.g. "/api/v1/me"). */
  authProbePath?: string;
  /** This environment is production-like. */
  production: boolean;
  /** With `production`, block a run that intends to send write requests. */
  blockWritesOnProduction: boolean;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  pass: boolean;
  actual: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface ReadinessResult {
  environmentId: string;
  environmentName: string;
  enabled: boolean;
  blockOnFail: boolean;
  ready: boolean;
  blocked: boolean;
  checks: ReadinessCheck[];
  blockers: string[];
  evaluatedAt: string;
  context: ReadinessContext;
}

const DEFAULT_CONFIG: ReadinessConfig = {
  enabled: false,
  blockOnFail: true,
  checkBaseUrl: true,
  healthPaths: [],
  dependencies: [],
  requiredVars: [],
  checkAuth: false,
  authType: 'bearer',
  authHeaderName: undefined,
  authProbePath: undefined,
  production: false,
  blockWritesOnProduction: true,
};

const PROBE_TIMEOUT_MS = 12_000;
const MAX_LIST = 20;

function strList(v: unknown, max = MAX_LIST): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, max);
}

export function sanitizeConfig(input: unknown): ReadinessConfig {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const authType = ['bearer', 'basic', 'apikey'].includes(String(i.authType))
    ? (i.authType as ReadinessConfig['authType'])
    : 'bearer';
  return {
    enabled: !!i.enabled,
    blockOnFail: i.blockOnFail === undefined ? true : !!i.blockOnFail,
    checkBaseUrl: i.checkBaseUrl === undefined ? true : !!i.checkBaseUrl,
    healthPaths: strList(i.healthPaths),
    dependencies: strList(i.dependencies),
    requiredVars: strList(i.requiredVars),
    checkAuth: !!i.checkAuth,
    authType,
    authHeaderName: i.authHeaderName ? String(i.authHeaderName).slice(0, 80) : undefined,
    authProbePath: i.authProbePath ? String(i.authProbePath).slice(0, 400) : undefined,
    production: !!i.production,
    blockWritesOnProduction: i.blockWritesOnProduction === undefined ? true : !!i.blockWritesOnProduction,
  };
}

export async function getReadinessConfig(tenantId: string, envId: string): Promise<ReadinessConfig> {
  const { rows } = await pool.query(
    `SELECT readiness_config FROM api_environments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, envId],
  );
  if (!rows.length) return { ...DEFAULT_CONFIG };
  const raw = rows[0].readiness_config;
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    return sanitizeConfig(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveReadinessConfig(
  tenantId: string,
  envId: string,
  input: unknown,
): Promise<ReadinessConfig | null> {
  const config = sanitizeConfig(input);
  const { rowCount } = await pool.query(
    `UPDATE api_environments SET readiness_config = $1, updated_at = SYSUTCDATETIME() WHERE tenant_id = $2 AND id = $3`,
    [JSON.stringify(config), tenantId, envId],
  );
  return rowCount ? config : null;
}

// ── Probing ──────────────────────────────────────────────────────────────

/** Join a possibly-relative path onto the environment base URL. */
function joinUrl(baseUrl: string, path: string): string | null {
  const p = (path || '').trim();
  if (/^https?:\/\//i.test(p)) return p;
  if (!baseUrl) return null;
  try {
    return new URL(p || '/', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
  } catch {
    return null;
  }
}

/** The environment's variables as a flat map (plus baseUrl aliases). */
function varMap(env: ApiEnvironment): Record<string, string> {
  const m: Record<string, string> = {};
  for (const v of env.variables) m[v.key] = v.value;
  if (env.baseUrl) {
    m.baseUrl = m.baseUrl ?? env.baseUrl;
    m.BASE_URL = m.BASE_URL ?? env.baseUrl;
  }
  return m;
}

/** Resolve a credential value from conventional env variable names. */
function resolveAuthValue(type: ReadinessConfig['authType'], vars: Record<string, string>): string | undefined {
  const candidates =
    type === 'bearer' ? ['token', 'accessToken', 'access_token', 'bearerToken', 'bearer', 'jwt', 'authToken']
    : type === 'basic' ? ['basicAuth', 'basic', 'credentials']
    : ['apiKey', 'api_key', 'apikey', 'x-api-key', 'key'];
  for (const c of candidates) if (vars[c]) return vars[c];
  return undefined;
}

async function probe(url: string, auth?: { type: string; value?: string; headerName?: string }): Promise<{ ok: boolean; status?: number; error?: string; elapsedMs: number }> {
  const { url: u, init } = buildRequestInit(
    { method: 'GET', url, ...(auth ? { auth } : {}) },
    {},
  );
  return timedFetch(u, init, PROBE_TIMEOUT_MS);
}

/**
 * Evaluate readiness for an environment. `intent.allowWrites` drives the
 * production-safety check. Always records an evidence row.
 */
export async function evaluateReadiness(
  tenantId: string,
  username: string | undefined,
  envId: string,
  opts: { context?: ReadinessContext; allowWrites?: boolean } = {},
): Promise<ReadinessResult> {
  const context: ReadinessContext = opts.context || 'preview';
  const env = await getEnvironment(tenantId, envId, { reveal: true });
  if (!env) throw new Error('Environment not found.');
  const config = await getReadinessConfig(tenantId, envId);
  const checks: ReadinessCheck[] = [];
  const vars = varMap(env);

  if (config.checkBaseUrl) {
    if (!env.baseUrl) {
      checks.push({ id: 'base_url', label: 'Base URL set', pass: false, actual: 'no base URL configured', severity: 'critical' });
    } else {
      const r = await probe(env.baseUrl);
      const pass = !r.error && (r.status === undefined || r.status < 500);
      checks.push({ id: 'base_url', label: `Base URL reachable (${env.baseUrl})`, pass, actual: r.error ? r.error : `HTTP ${r.status} in ${r.elapsedMs}ms`, severity: 'critical' });
    }
  }

  for (const path of config.healthPaths) {
    const url = joinUrl(env.baseUrl, path);
    if (!url) { checks.push({ id: `health:${path}`, label: `Health ${path}`, pass: false, actual: 'could not form URL', severity: 'critical' }); continue; }
    const r = await probe(url);
    const pass = !r.error && !!r.status && r.status >= 200 && r.status < 300;
    checks.push({ id: `health:${path}`, label: `Health ${path} → 2xx`, pass, actual: r.error ? r.error : `HTTP ${r.status} in ${r.elapsedMs}ms`, severity: 'critical' });
  }

  for (const dep of config.dependencies) {
    const r = await probe(dep);
    const pass = !r.error && (r.status === undefined || r.status < 500);
    checks.push({ id: `dep:${dep}`, label: `Dependency reachable (${dep})`, pass, actual: r.error ? r.error : `HTTP ${r.status} in ${r.elapsedMs}ms`, severity: 'critical' });
  }

  for (const key of config.requiredVars) {
    const present = key === 'baseUrl' ? !!env.baseUrl : !!(vars[key] && vars[key].trim());
    checks.push({ id: `var:${key}`, label: `Variable "${key}" set`, pass: present, actual: present ? 'present' : 'missing or empty', severity: 'critical' });
  }

  if (config.checkAuth) {
    const url = joinUrl(env.baseUrl, config.authProbePath || '/');
    const value = resolveAuthValue(config.authType, vars);
    if (!url) {
      checks.push({ id: 'auth', label: 'Auth probe', pass: false, actual: 'could not form probe URL', severity: 'critical' });
    } else if (!value) {
      checks.push({ id: 'auth', label: 'Auth credential available', pass: false, actual: `no ${config.authType} credential in environment variables`, severity: 'critical' });
    } else {
      const r = await probe(url, { type: config.authType, value, headerName: config.authHeaderName });
      const pass = !r.error && r.status !== 401 && r.status !== 403;
      checks.push({ id: 'auth', label: `Authenticated call accepted (${config.authProbePath || '/'})`, pass, actual: r.error ? r.error : `HTTP ${r.status} in ${r.elapsedMs}ms`, severity: 'critical' });
    }
  }

  if (config.production && config.blockWritesOnProduction && opts.allowWrites) {
    checks.push({ id: 'safety', label: 'Write-safety on production environment', pass: false, actual: 'run requested writes against a production-flagged environment', severity: 'critical' });
  }

  const failed = checks.filter((c) => !c.pass);
  const ready = failed.length === 0;
  const blocked = config.enabled && config.blockOnFail && !ready;
  const result: ReadinessResult = {
    environmentId: env.id,
    environmentName: env.name,
    enabled: config.enabled,
    blockOnFail: config.blockOnFail,
    ready,
    blocked,
    checks,
    blockers: failed.map((c) => `${c.label}: ${c.actual}`),
    evaluatedAt: new Date().toISOString(),
    context,
  };

  await recordEvidence(tenantId, username, result).catch(() => { /* evidence is best-effort */ });
  return result;
}

/**
 * Gate helper for the run endpoints. Returns `blocked:false` immediately when
 * readiness is disabled (no probing, no behaviour change). Only when enabled
 * does it probe and possibly block.
 */
export async function enforceReadiness(
  tenantId: string,
  username: string | undefined,
  envId: string,
  opts: { allowWrites?: boolean } = {},
): Promise<{ blocked: boolean; readiness?: ReadinessResult }> {
  const config = await getReadinessConfig(tenantId, envId);
  if (!config.enabled) return { blocked: false };
  const readiness = await evaluateReadiness(tenantId, username, envId, { context: 'pre-run', allowWrites: opts.allowWrites });
  return { blocked: readiness.blocked, readiness };
}

async function recordEvidence(tenantId: string, username: string | undefined, r: ReadinessResult): Promise<void> {
  await pool.query(
    `INSERT INTO api_env_readiness_runs (tenant_id, environment_id, environment_name, ready, blocked, context, checks, blockers, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, r.environmentId, r.environmentName, r.ready ? 1 : 0, r.blocked ? 1 : 0, r.context, JSON.stringify(r.checks), JSON.stringify(r.blockers), username || null],
  );
}

export interface ReadinessHistoryRow {
  id: string;
  environmentId: string;
  environmentName: string;
  ready: boolean;
  blocked: boolean;
  context: string;
  checks: ReadinessCheck[];
  blockers: string[];
  createdBy?: string;
  createdAt: string;
}

export async function listReadinessHistory(tenantId: string, envId: string, limit = 50): Promise<ReadinessHistoryRow[]> {
  const n = Math.min(200, Math.max(1, Math.round(limit) || 50));
  const { rows } = await pool.query(
    `SELECT TOP (${n}) * FROM api_env_readiness_runs WHERE tenant_id = $1 AND environment_id = $2 ORDER BY created_at DESC`,
    [tenantId, envId],
  );
  return rows.map((r: any) => ({
    id: String(r.id),
    environmentId: String(r.environment_id),
    environmentName: r.environment_name || '',
    ready: r.ready === true || r.ready === 1,
    blocked: r.blocked === true || r.blocked === 1,
    context: r.context || 'preview',
    checks: safeParse(r.checks, []),
    blockers: safeParse(r.blockers, []),
    createdBy: r.created_by || undefined,
    createdAt: r.created_at,
  }));
}

function safeParse<T>(raw: unknown, fallback: T): T {
  try {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : ((raw as T) ?? fallback);
  } catch {
    return fallback;
  }
}
