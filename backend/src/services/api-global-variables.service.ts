/**
 * api-global-variables.service.ts
 * ───────────────────────────────
 * Workspace-scoped GLOBAL variables — the broadest scope in the `{{var}}`
 * resolution hierarchy:
 *
 *     globals → environment → run/extracted → dynamic   (narrower wins)
 *
 * One shared set per tenant, resolved by `{{name}}` exactly like an environment
 * variable, so a value common to every environment — a shared header, a fixed
 * client id, a correlation prefix — is defined ONCE instead of copied into each
 * environment. An ENVIRONMENT variable of the same name overrides a global
 * (narrower scope wins), matching Postman's precedence.
 *
 * Secrets are AES-encrypted at rest and masked on read exactly like environment
 * secrets (a masked value round-tripped on save keeps the stored secret — the
 * `sanitizeVariables` path from the environments service is reused verbatim).
 *
 * Stored one row per tenant in `api_global_variables` (tenant_id PK).
 */
import pool from '../db.js';
import { decryptStored, maskSecret } from '../utils/crypto.js';
import { sanitizeVariables, type EnvVariable, type ApiEnvironment } from './api-environments.service.js';

/** The tenant's stored (encrypted) global variables — raw, for the update-preserve path. */
async function storedGlobals(tenantId: string): Promise<EnvVariable[]> {
  const { rows } = await pool.query(`SELECT variables FROM api_global_variables WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return [];
  try {
    const parsed = typeof rows[0].variables === 'string' ? JSON.parse(rows[0].variables) : rows[0].variables;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; /* corrupt row — expose nothing rather than throw */ }
}

/** The tenant's global variables, secrets masked unless `reveal` (the run path). */
export async function listGlobalVariables(
  tenantId: string,
  opts: { reveal: boolean } = { reveal: false },
): Promise<EnvVariable[]> {
  const stored = await storedGlobals(tenantId);
  return stored.map((v) => ({
    key: String(v.key || ''),
    secret: !!v.secret,
    value: v.secret
      ? (opts.reveal ? decryptStored(String(v.value || '')) : maskSecret(decryptStored(String(v.value || ''))))
      : String(v.value ?? ''),
  }));
}

/**
 * Replace the tenant's global variables (upsert — one row per tenant). Secrets
 * are encrypted at rest; a masked secret round-tripped from the UI keeps the
 * stored value. Returns the saved set, masked.
 */
export async function saveGlobalVariables(tenantId: string, username: string, input: unknown): Promise<EnvVariable[]> {
  const vars = sanitizeVariables(input, await storedGlobals(tenantId));
  const json = JSON.stringify(vars);
  // UPDATE-then-INSERT upsert (one low-contention row per tenant) keeps the
  // Postgres-style pg-shim params; no dialect-heavy MERGE needed here.
  const upd = await pool.query(
    `UPDATE api_global_variables SET variables = $1, updated_by = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $3`,
    [json, username, tenantId],
  );
  if (!upd.rowCount) {
    await pool.query(
      `INSERT INTO api_global_variables (tenant_id, variables, updated_by) VALUES ($1, $2, $3)`,
      [tenantId, json, username],
    );
  }
  return listGlobalVariables(tenantId, { reveal: false });
}

/**
 * Merge globals UNDER an environment: the environment's own variables WIN on a
 * key clash (narrower scope). Returns a NEW ApiEnvironment — the input and the
 * stored rows are untouched, so a merged env is never persisted back. Base URL,
 * default flag and auth setup are the environment's; only the variable list is
 * widened with the globals the environment doesn't already define.
 */
export function withGlobals(env: ApiEnvironment, globals: EnvVariable[]): ApiEnvironment {
  if (!globals.length) return env;
  const byKey = new Map<string, EnvVariable>();
  for (const v of globals) byKey.set(v.key, { key: v.key, value: v.value, secret: v.secret });
  for (const v of env.variables) byKey.set(v.key, { key: v.key, value: v.value, secret: v.secret }); // env overrides global
  return { ...env, variables: [...byKey.values()] };
}

/**
 * Fetch the tenant's globals (revealed) and merge them under `env` for a run.
 * A null env (no environment active / run-as-imported) is returned unchanged —
 * globals apply only when an environment is actually resolving `{{vars}}`, so
 * explicit "no environment" runs stay byte-identical to before. Call this right
 * after revealing the environment and BEFORE minting its login token, so the
 * login request can reference a global variable too.
 */
export async function applyGlobals<E extends ApiEnvironment | null | undefined>(tenantId: string, env: E): Promise<E> {
  if (!env) return env;
  const globals = await listGlobalVariables(tenantId, { reveal: true });
  return withGlobals(env, globals) as E;
}
