/**
 * api-llm-providers.service.ts
 * ────────────────────────────
 * Admin surface for the opt-in multi-LLM provider override. Stores the chosen
 * provider + baseUrl + model + (encrypted) key in the SAME client_configurations
 * table every other integration uses, under integration_id 'llm-provider'. When
 * a row exists and is connected, getTenantLlm (llm.service.ts) returns it and the
 * pipeline runs through provider-runner.ts. Deleting / disconnecting the row
 * reverts cleanly to the default Anthropic path — nothing in the core changes.
 */
import pool from '../db.js';
import { encryptField, decryptStored, maskSecret } from '../utils/crypto.js';
import { upsertConfig } from './configurations.service.js';
import { runViaProvider, normalizeProvider, type LlmProvider } from '../agents/provider-runner.js';

export interface LlmProviderConfig {
  enabled: boolean;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  /** Masked for display — never returns the real key. */
  keyMasked: string;
  hasKey: boolean;
}

const INTEGRATION_ID = 'llm-provider';

export async function getProviderConfig(tenantId: string): Promise<LlmProviderConfig> {
  const { rows } = await pool.query(
    `SELECT config_data, status FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, INTEGRATION_ID],
  );
  if (!rows.length) {
    return { enabled: false, provider: 'openai', model: '', baseUrl: '', keyMasked: '', hasKey: false };
  }
  const cfg = rows[0].config_data || {};
  const rawKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
  const key = rawKey ? decryptStored(rawKey) : '';
  return {
    enabled: rows[0].status === 'connected',
    provider: normalizeProvider(cfg.provider),
    model: String(cfg.model || ''),
    baseUrl: String(cfg.baseUrl || ''),
    keyMasked: key ? maskSecret(key) : '',
    hasKey: !!key,
  };
}

export async function saveProviderConfig(
  tenantId: string,
  input: { enabled?: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string },
): Promise<LlmProviderConfig> {
  const provider = normalizeProvider(input.provider);
  const model = String(input.model || '').trim().slice(0, 200);
  const baseUrl = String(input.baseUrl || '').trim().slice(0, 500);
  const status = input.enabled ? 'connected' : 'disconnected';

  // Keep the existing (encrypted) key when the caller sends a blank/masked value.
  const { rows: existing } = await pool.query(
    `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, INTEGRATION_ID],
  );
  let storedKey: string | undefined = existing.length && typeof existing[0].config_data?.apiKey === 'string' ? existing[0].config_data.apiKey : undefined;
  const incoming = String(input.apiKey || '').trim();
  if (incoming && !incoming.includes('•') && !incoming.includes('*')) storedKey = encryptField(incoming);

  const configData = { provider, model, baseUrl, apiKey: storedKey || '' };

  // Idempotent upsert via the shared integration helper (same table/semantics
  // every other integration uses).
  await upsertConfig(tenantId, INTEGRATION_ID, status, configData, 'api-studio');
  return getProviderConfig(tenantId);
}

export async function deleteProviderConfig(tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, INTEGRATION_ID],
  );
  return rowCount > 0;
}

/** Live round-trip test against the configured (or supplied) provider. */
export async function testProvider(
  tenantId: string,
  override?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string },
): Promise<{ ok: boolean; reply?: string; error?: string; elapsedMs: number }> {
  let provider: LlmProvider;
  let model: string;
  let baseUrl: string;
  let apiKey: string;

  if (override && override.apiKey && !override.apiKey.includes('•') && !override.apiKey.includes('*')) {
    provider = normalizeProvider(override.provider);
    model = String(override.model || 'gpt-4o-mini');
    baseUrl = String(override.baseUrl || '');
    apiKey = String(override.apiKey);
  } else {
    const { rows } = await pool.query(
      `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
      [tenantId, INTEGRATION_ID],
    );
    if (!rows.length) return { ok: false, error: 'No provider configured yet.', elapsedMs: 0 };
    const cfg = rows[0].config_data || {};
    provider = normalizeProvider(override?.provider || cfg.provider);
    model = String(override?.model || cfg.model || 'gpt-4o-mini');
    baseUrl = String(override?.baseUrl || cfg.baseUrl || '');
    apiKey = typeof cfg.apiKey === 'string' && cfg.apiKey ? decryptStored(cfg.apiKey) : '';
  }

  const started = Date.now();
  try {
    const reply = await runViaProvider('Reply with exactly the word: OK', { provider, apiKey, baseUrl, model, maxTokens: 16 });
    return { ok: true, reply: reply.slice(0, 120), elapsedMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err as Error).message, elapsedMs: Date.now() - started };
  }
}
