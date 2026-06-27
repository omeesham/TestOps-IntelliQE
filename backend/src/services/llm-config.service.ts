/**
 * LLM configuration resolver.
 *
 * Single source of truth for "which Anthropic API key should the pipeline use".
 * The key is configured by an admin in the UI (System Configuration → LLM
 * Configuration) and stored, AES-encrypted at rest, in `client_configurations`.
 * This service resolves and decrypts it so the rest of the backend can talk to
 * the Anthropic API directly — the durable, headless path that replaced the
 * legacy `claude` CLI login (which expired periodically).
 *
 * Resolution order (mirrors the LLM Configuration UI's own logic):
 *   1. llm-settings.activeEnvironment + llm-settings.defaults[env]  →
 *      llm-<provider>-<env>  (provider must be 'anthropic', row enabled, key set)
 *   2. any enabled `llm-anthropic-*` row that has a key
 *   3. tenants.anthropic_api_key  (the HIPAA "customer-owned key" column)
 *   4. process.env.ANTHROPIC_API_KEY (explicit env override, e.g. CI)
 *
 * `hydrateAnthropicEnv()` pushes the resolved key into process.env so the
 * Anthropic SDK (claude-runner.ts) and the sync preflight checks pick it up
 * without threading a key through every agent. It is called at startup, when an
 * LLM config row is saved, and as a preflight in the generate route.
 */
import pool from '../db.js';
import { decryptConfigData, decryptStored } from '../utils/crypto.js';

export interface ResolvedAiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Where the key came from — for logging/diagnostics only. */
  source: string;
}

const CACHE_TTL_MS = 30_000;
let cache: { at: number; tenantKey: string; value: ResolvedAiConfig | null } | null = null;

/** Monotonic-ish clock guard: db.ts has no Date.now restriction here. */
function now(): number {
  return Date.now();
}

async function getCfg(tenantId: string, integrationId: string): Promise<Record<string, any> | null> {
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId],
  );
  if (!rows.length) return null;
  try {
    return decryptConfigData(rows[0].config_data || {});
  } catch {
    return null;
  }
}

function usableAnthropicRow(row: Record<string, any> | null): boolean {
  return !!row && row.enabled !== false && typeof row.apiKey === 'string' && row.apiKey.length > 0;
}

async function resolveForTenant(tenantId: string): Promise<ResolvedAiConfig | null> {
  // 1. Honour the LLM Configuration default for the active environment.
  const settings = (await getCfg(tenantId, 'llm-settings')) || {};
  const env: string = settings.activeEnvironment || 'production';
  const defaults: Record<string, string> = settings.defaults || {};
  const providerId = defaults[env];
  if (providerId === 'anthropic') {
    const row = await getCfg(tenantId, `llm-anthropic-${env}`);
    if (usableAnthropicRow(row)) {
      return { apiKey: row!.apiKey, model: row!.model, baseUrl: row!.endpoint, source: `llm-anthropic-${env}` };
    }
  }

  // 2. Any enabled anthropic provider row (covers env mismatches / no explicit default).
  const { rows } = await pool.query(
    `SELECT integration_id, config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id LIKE 'llm-anthropic-%'`,
    [tenantId],
  );
  for (const r of rows) {
    let dec: Record<string, any> | null = null;
    try { dec = decryptConfigData(r.config_data || {}); } catch { dec = null; }
    if (usableAnthropicRow(dec)) {
      return { apiKey: dec!.apiKey, model: dec!.model, baseUrl: dec!.endpoint, source: r.integration_id };
    }
  }

  // 3. Tenant-owned key column (tenant-settings page).
  try {
    const t = await pool.query(`SELECT anthropic_api_key FROM tenants WHERE id = $1`, [tenantId]);
    const stored = t.rows[0]?.anthropic_api_key;
    if (typeof stored === 'string' && stored.length > 0) {
      const key = decryptStored(stored);
      if (key) return { apiKey: key, source: 'tenants.anthropic_api_key' };
    }
  } catch { /* column may not exist on older schemas */ }

  return null;
}

/**
 * Resolve the Anthropic config for a tenant. When `tenantId` is null (startup,
 * worker), scan tenants (platform first) for the first usable config. Falls back
 * to an explicit ANTHROPIC_API_KEY env var if nothing is configured in the DB.
 */
export async function resolveAnthropicConfig(tenantId: string | null): Promise<ResolvedAiConfig | null> {
  const cacheKey = tenantId || '*';
  if (cache && cache.tenantKey === cacheKey && now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  let value: ResolvedAiConfig | null = null;
  try {
    if (tenantId) value = await resolveForTenant(tenantId);
    if (!value) {
      const { rows } = await pool.query(`SELECT id FROM tenants ORDER BY is_platform DESC, created_at`);
      for (const r of rows) {
        value = await resolveForTenant(r.id);
        if (value) break;
      }
    }
  } catch (err: any) {
    console.error('[llm-config] DB resolution failed:', err?.message || err);
  }

  // Explicit env override is a last resort (e.g. CI without a DB row).
  if (!value && process.env.ANTHROPIC_API_KEY) {
    value = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      source: 'env',
    };
  }

  cache = { at: now(), tenantKey: cacheKey, value };
  return value;
}

/** Drop the resolver cache (call after an LLM config row is created/updated/removed). */
export function invalidateAiConfigCache(): void {
  cache = null;
}

function maskKey(key: string): string {
  if (key.length < 12) return '(short)';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Resolve the active Anthropic key and push it into process.env so the
 * Anthropic SDK and the sync auth preflights use it. The DB-configured key is
 * authoritative — it overwrites any stale env value when present. Returns the
 * resolved config (or null) for logging.
 */
export async function hydrateAnthropicEnv(tenantId: string | null = null): Promise<ResolvedAiConfig | null> {
  try {
    const cfg = await resolveAnthropicConfig(tenantId);
    if (cfg?.apiKey) {
      process.env.ANTHROPIC_API_KEY = cfg.apiKey;
      // Configured model becomes the default for agents that don't pin one; the
      // runner still lets a per-call model win (cheap stages stay on sonnet).
      if (cfg.model) process.env.ANTHROPIC_MODEL = cfg.model;
      if (cfg.baseUrl) process.env.ANTHROPIC_BASE_URL = cfg.baseUrl;
      return cfg;
    }
  } catch (err: any) {
    console.error('[llm-config] hydrateAnthropicEnv failed:', err?.message || err);
  }
  return null;
}

/** True when an Anthropic key is available (in env or resolvable from the DB). */
export async function isAnthropicConfigured(tenantId: string | null = null): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const cfg = await resolveAnthropicConfig(tenantId);
  return !!cfg?.apiKey;
}

/** Human-readable one-liner for startup logs (never logs the raw key). */
export function describeResolved(cfg: ResolvedAiConfig | null): string {
  if (!cfg) return 'none';
  return `${maskKey(cfg.apiKey)} (model=${cfg.model || 'default'}, source=${cfg.source})`;
}
