/**
 * LLM credential resolution — Azure Key Vault first, never the database.
 *
 * LLM API keys are NOT entered in the UI or stored in the DB. They live in the
 * customer's Azure Key Vault and the backend reads them at call time using its
 * Managed Identity (DefaultAzureCredential → `az login` locally). The UI only
 * picks models and runs "Test Connection".
 *
 * Secret names (Key Vault names allow only letters, digits and dashes):
 *   anthropic  → ANTHROPIC_KV_SECRET_NAME  (default `anthropic-api-key`)
 *   openai     → OPENAI_KV_SECRET_NAME     (default `openai-api-key`)
 *   gemini     → GEMINI_KV_SECRET_NAME     (default `gemini-api-key`)
 *
 * Per-tenant keys are optional: `<tenant-slug>-<secret-name>` (e.g.
 * `acme-anthropic-api-key`) is tried first, then the shared secret.
 *
 * Resolution order:
 *   1. Azure Key Vault          (when AZURE_KEY_VAULT_URL is set)
 *   2. Environment variable     (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)
 *      — for local development without a vault; in Azure these can themselves
 *      be Key Vault-referenced Container App secrets.
 *
 * Values are cached in-process for KV_CACHE_TTL_SECONDS (default 300) so a
 * rotation in Key Vault is picked up without a redeploy. "Test Connection"
 * bypasses the cache.
 */
import pool from '../db.js';

export type LlmProviderId = 'anthropic' | 'gemini' | 'openai';

export type CredentialSource = 'key-vault' | 'env' | 'none';

export interface LlmCredential {
  value: string | null;
  source: CredentialSource;
  /** Key Vault secret name, or env var name, the value came from (or would come from). */
  reference: string;
  /** Vault host, e.g. `kv-intelliqe.vault.azure.net` (no secret data). */
  vault: string | null;
  /** Why no value was found (access denied, secret missing, …). */
  error?: string;
}

const DEFAULT_SECRET_NAMES: Record<LlmProviderId, { kv: string; kvEnv: string; env: string }> = {
  anthropic: { kv: 'anthropic-api-key', kvEnv: 'ANTHROPIC_KV_SECRET_NAME', env: 'ANTHROPIC_API_KEY' },
  openai:    { kv: 'openai-api-key',    kvEnv: 'OPENAI_KV_SECRET_NAME',    env: 'OPENAI_API_KEY' },
  gemini:    { kv: 'gemini-api-key',    kvEnv: 'GEMINI_KV_SECRET_NAME',    env: 'GEMINI_API_KEY' },
};

export function kvSecretName(provider: LlmProviderId): string {
  const d = DEFAULT_SECRET_NAMES[provider];
  return (process.env[d.kvEnv] || d.kv).trim();
}

function vaultUrl(): string | null {
  const url = process.env.AZURE_KEY_VAULT_URL?.trim();
  return url ? url : null;
}

function vaultHost(): string | null {
  const url = vaultUrl();
  if (!url) return null;
  try { return new URL(url).host; } catch { return url; }
}

/* ─────────────────────────────────────────────────────────────
   Key Vault client + TTL cache
   ───────────────────────────────────────────────────────────── */
let clientPromise: Promise<any> | null = null;

async function getClient(): Promise<any> {
  const url = vaultUrl();
  if (!url) throw new Error('AZURE_KEY_VAULT_URL is not set');
  if (!clientPromise) {
    clientPromise = (async () => {
      const { DefaultAzureCredential } = await import('@azure/identity');
      const { SecretClient } = await import('@azure/keyvault-secrets');
      // AZURE_CLIENT_ID selects a user-assigned managed identity when set.
      return new SecretClient(url, new DefaultAzureCredential());
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

interface CacheEntry { value: string | null; at: number; error?: string }
const cache = new Map<string, CacheEntry>();

function ttlMs(): number {
  const s = Number(process.env.KV_CACHE_TTL_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 300) * 1000;
}

/** Read one secret. Returns null when it does not exist; throws on access errors. */
async function readSecret(name: string, fresh: boolean): Promise<string | null> {
  const hit = cache.get(name);
  if (!fresh && hit && Date.now() - hit.at < ttlMs()) {
    if (hit.error) throw new Error(hit.error);
    return hit.value;
  }
  try {
    const client = await getClient();
    const secret = await client.getSecret(name);
    const value = (secret?.value || '').trim() || null;
    cache.set(name, { value, at: Date.now() });
    return value;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.code === 'SecretNotFound') {
      cache.set(name, { value: null, at: Date.now() });
      return null;
    }
    const msg = describeKvError(err);
    // Cache failures briefly so a misconfigured vault doesn't hammer Azure.
    cache.set(name, { value: null, at: Date.now() - ttlMs() + 30_000, error: msg });
    throw new Error(msg);
  }
}

function describeKvError(err: any): string {
  if (err?.statusCode === 403 || err?.code === 'Forbidden') {
    return 'Access denied — grant the app\'s managed identity the "Key Vault Secrets User" role on the vault.';
  }
  if (err?.name === 'CredentialUnavailableError' || /CredentialUnavailable|ManagedIdentityCredential|AzureCliCredential/i.test(err?.message || '')) {
    return 'No Azure identity available — enable a managed identity on the app (or run `az login` locally).';
  }
  if (err?.code === 'ENOTFOUND' || /getaddrinfo/i.test(err?.message || '')) {
    return 'Key Vault host not reachable — check AZURE_KEY_VAULT_URL and network access (private endpoint / firewall).';
  }
  return err?.message || 'Key Vault request failed.';
}

export function clearLlmCredentialCache(): void {
  cache.clear();
}

async function tenantSlug(tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId) return null;
  try {
    const { rows } = await pool.query(`SELECT slug FROM tenants WHERE id = $1`, [tenantId]);
    const slug = rows[0]?.slug;
    return typeof slug === 'string' && /^[a-z0-9-]+$/i.test(slug) ? slug.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the API key for a provider (optionally scoped to a tenant).
 * `fresh: true` skips the cache — used by "Test Connection".
 */
export async function resolveLlmCredential(
  provider: LlmProviderId,
  tenantId?: string | null,
  opts: { fresh?: boolean } = {},
): Promise<LlmCredential> {
  const base = kvSecretName(provider);
  const envName = DEFAULT_SECRET_NAMES[provider].env;
  const vault = vaultHost();
  let kvError: string | undefined;

  if (vault) {
    const slug = await tenantSlug(tenantId);
    const candidates = slug ? [`${slug}-${base}`, base] : [base];
    for (const name of candidates) {
      try {
        const value = await readSecret(name, !!opts.fresh);
        if (value) return { value, source: 'key-vault', reference: name, vault };
      } catch (err) {
        kvError = (err as Error).message;
        break; // access problem applies to every name — don't retry
      }
    }
  }

  const envValue = process.env[envName]?.trim();
  if (envValue) return { value: envValue, source: 'env', reference: envName, vault, error: kvError };

  return {
    value: null,
    source: 'none',
    reference: vault ? base : envName,
    vault,
    error: kvError || (vault
      ? `Secret "${base}" not found in Key Vault ${vault}.`
      : `AZURE_KEY_VAULT_URL is not set and ${envName} is empty.`),
  };
}
