/**
 * api-environments.service.ts
 * ───────────────────────────
 * Test-environment management for API Automation.
 *
 * An environment is a named target — dev, staging, prod-like — carrying a base
 * URL and a set of variables. Imported endpoints reference values as `{{name}}`
 * (a Postman collection's `{{baseUrl}}`, an OpenAPI server variable, a token
 * placeholder), and the run resolves them against the selected environment
 * right before generation/execution. Variables flagged `secret` are AES-encrypted
 * at rest and masked on every read except the explicit `resolve` call the run
 * uses; a masked value posted back on save means "keep what is stored".
 */
import pool from '../db.js';
import { encryptAtRest, decryptStored, maskSecret, isMaskedSecret } from '../utils/crypto.js';

export interface EnvVariable {
  key: string;
  value: string;
  secret: boolean;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  baseUrl: string;
  /** Optional Postman-style colour tag (`#rrggbb`) — purely visual. */
  color?: string;
  variables: EnvVariable[];
  isDefault: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const NAME_MAX = 120;
const VARS_MAX = 100;

/** A colour tag is kept only when it is a `#rrggbb` hex string; anything else
 *  (empty, a name, junk) resolves to no colour rather than failing the save. */
function sanitizeColor(input: unknown): string | null {
  const c = String(input ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
}

function rowToEnv(row: any, opts: { reveal: boolean }): ApiEnvironment {
  let vars: EnvVariable[] = [];
  const raw = row.variables;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) vars = parsed;
  } catch { /* corrupt row — expose no variables rather than fail the list */ }
  return {
    id: String(row.id),
    name: row.name,
    baseUrl: row.base_url || '',
    color: row.color || undefined,
    variables: vars.map((v) => ({
      key: String(v.key || ''),
      secret: !!v.secret,
      value: v.secret
        ? (opts.reveal ? decryptStored(String(v.value || '')) : maskSecret(decryptStored(String(v.value || ''))))
        : String(v.value ?? ''),
    })),
    isDefault: !!row.is_default,
    createdBy: row.created_by || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeVariables(input: unknown, previous: EnvVariable[] = []): EnvVariable[] {
  if (!Array.isArray(input)) return [];
  const prevByKey = new Map(previous.map((v) => [v.key, v]));
  const out: EnvVariable[] = [];
  const seen = new Set<string>();
  for (const v of input.slice(0, VARS_MAX)) {
    if (!v || typeof v !== 'object') continue;
    const key = String((v as any).key || '').trim().replace(/[^A-Za-z0-9_.\-]/g, '').slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const secret = !!(v as any).secret;
    let value = String((v as any).value ?? '').slice(0, 4000);
    if (secret) {
      // A masked value round-tripped from the UI keeps the stored secret.
      if (isMaskedSecret(value)) value = prevByKey.get(key)?.value || '';
      else value = encryptAtRest(value);
    }
    out.push({ key, value, secret });
  }
  return out;
}

export async function listEnvironments(tenantId: string): Promise<ApiEnvironment[]> {
  const { rows } = await pool.query(
    `SELECT * FROM api_environments WHERE tenant_id = $1 ORDER BY is_default DESC, name ASC`,
    [tenantId],
  );
  return rows.map((r: any) => rowToEnv(r, { reveal: false }));
}

/** Stored (encrypted) variables — used to preserve secrets across an update. */
async function storedVariables(tenantId: string, id: string): Promise<EnvVariable[]> {
  const { rows } = await pool.query(`SELECT variables FROM api_environments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) return [];
  try {
    const parsed = typeof rows[0].variables === 'string' ? JSON.parse(rows[0].variables) : rows[0].variables;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function getEnvironment(tenantId: string, id: string, opts: { reveal: boolean } = { reveal: false }): Promise<ApiEnvironment | null> {
  const { rows } = await pool.query(`SELECT * FROM api_environments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? rowToEnv(rows[0], opts) : null;
}

export async function createEnvironment(
  tenantId: string,
  username: string,
  input: { name: string; baseUrl?: string; color?: string; variables?: unknown; isDefault?: boolean },
): Promise<ApiEnvironment> {
  const name = String(input.name || '').trim().slice(0, NAME_MAX);
  if (!name) throw new Error('An environment needs a name.');
  const baseUrl = String(input.baseUrl || '').trim().slice(0, 1000);
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must be an absolute http(s) URL.');
  const color = sanitizeColor(input.color);
  const vars = sanitizeVariables(input.variables);
  if (input.isDefault) await pool.query(`UPDATE api_environments SET is_default = 0 WHERE tenant_id = $1`, [tenantId]);
  const { rows } = await pool.query(
    `INSERT INTO api_environments (tenant_id, name, base_url, color, variables, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, name, baseUrl || null, color, JSON.stringify(vars), input.isDefault ? 1 : 0, username],
  );
  return rowToEnv(rows[0], { reveal: false });
}

export async function updateEnvironment(
  tenantId: string,
  id: string,
  input: { name?: string; baseUrl?: string; color?: string; variables?: unknown; isDefault?: boolean },
): Promise<ApiEnvironment | null> {
  const existing = await getEnvironment(tenantId, id);
  if (!existing) return null;
  const name = input.name !== undefined ? String(input.name).trim().slice(0, NAME_MAX) : existing.name;
  if (!name) throw new Error('An environment needs a name.');
  const baseUrl = input.baseUrl !== undefined ? String(input.baseUrl).trim().slice(0, 1000) : existing.baseUrl;
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must be an absolute http(s) URL.');
  const color = input.color !== undefined ? sanitizeColor(input.color) : (existing.color ?? null);
  const vars = input.variables !== undefined ? sanitizeVariables(input.variables, await storedVariables(tenantId, id)) : await storedVariables(tenantId, id);
  const isDefault = input.isDefault !== undefined ? !!input.isDefault : existing.isDefault;
  if (isDefault) await pool.query(`UPDATE api_environments SET is_default = 0 WHERE tenant_id = $1 AND id <> $2`, [tenantId, id]);
  const { rows } = await pool.query(
    `UPDATE api_environments SET name = $1, base_url = $2, color = $3, variables = $4, is_default = $5, updated_at = SYSUTCDATETIME()
     WHERE tenant_id = $6 AND id = $7 RETURNING *`,
    [name, baseUrl || null, color, JSON.stringify(vars), isDefault ? 1 : 0, tenantId, id],
  );
  return rows.length ? rowToEnv(rows[0], { reveal: false }) : null;
}

export async function deleteEnvironment(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_environments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (rowCount || 0) > 0;
}

/* ────────────────────────────────────────────────────────────────
   Resolution — apply an environment to endpoint definitions
   ──────────────────────────────────────────────────────────────── */

/** `{{name}}` placeholders → values; unknown names are left in place. */
export function fillTemplate(text: string | undefined, vars: Record<string, string>): string | undefined {
  if (!text) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g, (m, k: string) => (vars[k] !== undefined ? vars[k]! : m));
}

/** The environment's variables as a flat map, with the base-URL convenience
 *  aliases (`baseUrl`/`BASE_URL`/`host`) so `{{baseUrl}}` resolves too. */
function envVarMap(env: ApiEnvironment): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const v of env.variables) vars[v.key] = v.value;
  if (env.baseUrl) {
    vars.baseUrl = vars.baseUrl ?? env.baseUrl;
    vars.BASE_URL = vars.BASE_URL ?? env.baseUrl;
    vars.host = vars.host ?? env.baseUrl;
  }
  return vars;
}

/** Re-home an absolute URL onto the environment's origin, keeping the path and
 *  query and prepending the environment's base path unless already present. */
function rehomeUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl || !/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    const b = new URL(baseUrl);
    const basePath = b.pathname.replace(/\/+$/, '');
    const path = basePath && !u.pathname.startsWith(basePath) ? `${basePath}${u.pathname}` : u.pathname;
    // `new URL` percent-encodes `{{ }}`, which would break a runtime flow
    // placeholder (`{{orderId}}`) left in the path or query. Restore the braces.
    return `${b.origin}${path}${u.search}`.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return url;
  }
}

/** Base auth carried as `Basic user:password` (from a filled `{{basicAuth}}`)
 *  is base64-encoded to a valid header; an already-encoded value is left alone. */
function encodeBasicIfNeeded(key: string, value: string): string {
  if (/^authorization$/i.test(key) && /^Basic\s+/i.test(value)) {
    const cred = value.replace(/^Basic\s+/i, '');
    if (cred.includes(':')) {
      try { return `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`; } catch { /* keep as-is */ }
    }
  }
  return value;
}

/**
 * Apply an environment to an already-DESIGNED case (post-generation): resolve
 * `{{vars}}` in the URL, header values and body, and re-home the URL onto the
 * environment's base URL. Flow steps are resolved the same way — a step's own
 * extracted `{{vars}}` are not environment variables, so `fillTemplate` leaves
 * them in place for the runtime to fill.
 *
 * This is the render-time counterpart to `applyEnvironment` (which works on raw
 * endpoints before generation). Keeping the designed cases templated and
 * resolving here lets a run retarget to another environment with no model call.
 */
export function resolveApiCase<T extends { url: string; headers: Record<string, string>; body?: string; steps?: unknown[] }>(
  nc: T,
  env: ApiEnvironment | null | undefined,
): T {
  if (!env) return nc;
  const vars = envVarMap(env);
  const resolveHeaders = (h: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(h || {})) out[k] = encodeBasicIfNeeded(k, fillTemplate(val, vars) || '');
    return out;
  };
  const steps = Array.isArray(nc.steps)
    ? nc.steps.map((st: any) => ({
        ...st,
        url: rehomeUrl(fillTemplate(st.url, vars) || st.url, env.baseUrl),
        headers: resolveHeaders(st.headers),
        body: fillTemplate(st.body, vars),
      }))
    : nc.steps;
  return {
    ...nc,
    url: rehomeUrl(fillTemplate(nc.url, vars) || nc.url, env.baseUrl),
    headers: resolveHeaders(nc.headers),
    body: fillTemplate(nc.body, vars),
    ...(steps ? { steps } : {}),
  };
}

/**
 * Apply an environment to an endpoint: substitute variables everywhere a value
 * can carry them, and re-home the URL on the environment's base URL when one
 * is set (the path and query are kept; only scheme + host + base path move).
 */
export function applyEnvironment<T extends { url: string; headers?: { key: string; value: string }[]; body?: string; auth?: { type: string; value?: string; headerName?: string } }>(
  endpoint: T,
  env: ApiEnvironment | null | undefined,
): T {
  if (!env) return endpoint;
  const vars = envVarMap(env);
  const url = rehomeUrl(fillTemplate(endpoint.url, vars) || endpoint.url, env.baseUrl);
  const headers = (endpoint.headers || []).map((h) => ({ key: h.key, value: fillTemplate(h.value, vars) || '' }));
  const auth = endpoint.auth
    ? { ...endpoint.auth, value: endpoint.auth.value ? fillTemplate(endpoint.auth.value, vars) : resolveAuthFromEnv(endpoint.auth.type, vars) }
    : endpoint.auth;
  return { ...endpoint, url, headers, body: fillTemplate(endpoint.body, vars), auth };
}

/** Conventional variable names an environment can use to supply a credential. */
function resolveAuthFromEnv(type: string, vars: Record<string, string>): string | undefined {
  const candidates =
    type === 'bearer' ? ['token', 'accessToken', 'access_token', 'bearerToken', 'bearer', 'jwt', 'authToken']
    : type === 'basic' ? ['basicAuth', 'basic', 'credentials']
    : type === 'apikey' ? ['apiKey', 'api_key', 'apikey', 'x-api-key', 'key']
    : [];
  for (const c of candidates) if (vars[c]) return vars[c];
  return undefined;
}
