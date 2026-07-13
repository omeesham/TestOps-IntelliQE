/**
 * Tenant LLM resolver.
 *
 * The synchronous chat pipeline (requirement → plan → generate → script →
 * heal) needs an LLM to run. The credentials live in the DB — saved by the
 * admin in System Configuration → LLM Configuration — NOT in env vars and NOT
 * tied to a local `claude` CLI login. This resolves the tenant's Anthropic key
 * and chosen model so the agents can call the Messages API directly.
 *
 * Resolution order:
 *   1. client_configurations `llm-anthropic` (carries the apiKey + selected model)
 *   2. tenants.anthropic_api_key (the column the worker also uses)
 */
import pool from '../db.js';
import { decryptStored } from '../utils/crypto.js';

export interface TenantLlm {
  provider: 'anthropic';
  /** 'api_key' (x-api-key, API credits) or 'claude_code' (OAuth/subscription). */
  authMethod: 'api_key' | 'claude_code';
  apiKey?: string;
  /** Claude Code OAuth token — present when authMethod is 'claude_code'. */
  oauthToken?: string;
  /** Claude Code transport: 'api' (OAuth→Messages API) or 'cli' (local claude CLI). */
  claudeCodeMode?: 'api' | 'cli';
  model: string;
  baseUrl: string;
  /** Per-agent model overrides (stage → model), chosen by the admin in the UI. */
  agentModels?: Record<string, string>;
  /** Reasoning effort (low|medium|high|xhigh|max), applied where the model supports it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Extended ("ultra") thinking — adaptive thinking on supported models. */
  extendedThinking?: boolean;
}

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Resolve the tenant's configured Anthropic LLM (key + model) from the DB.
 * Returns null when nothing is configured — callers should surface a clear
 * "configure an LLM" message rather than silently failing.
 */
export async function getTenantLlm(tenantId: string): Promise<TenantLlm | null> {
  // 1) Centralized LLM config (preferred — includes the model the admin picked).
  try {
    const { rows } = await pool.query(
      `SELECT config_data FROM client_configurations
        WHERE tenant_id = $1 AND integration_id = 'llm-anthropic' AND status = 'connected'`,
      [tenantId],
    );
    if (rows.length > 0) {
      const cfg = rows[0].config_data || {};
      const agentModels =
        cfg.agentModels && typeof cfg.agentModels === 'object' && !Array.isArray(cfg.agentModels)
          ? (cfg.agentModels as Record<string, string>)
          : undefined;
      const model = (cfg.model && String(cfg.model)) || DEFAULT_MODEL;
      const baseUrl = (cfg.baseUrl && String(cfg.baseUrl)) || DEFAULT_BASE_URL;
      const authMethod: 'api_key' | 'claude_code' = cfg.authMethod === 'claude_code' ? 'claude_code' : 'api_key';
      const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
      const effort = VALID_EFFORTS.includes(cfg.effort) ? (cfg.effort as TenantLlm['effort']) : undefined;
      const extendedThinking = cfg.extendedThinking === true;

      if (authMethod === 'claude_code') {
        // Subscription auth: an OAuth token (preferred) or, when blank, a
        // logged-in local `claude` CLI (handled downstream in runLLM).
        let oauthToken: string | undefined;
        if (cfg.oauthToken && typeof cfg.oauthToken === 'string') {
          oauthToken = decryptStored(cfg.oauthToken) || undefined;
        }
        const claudeCodeMode: 'api' | 'cli' = cfg.claudeCodeMode === 'cli' ? 'cli' : 'api';
        return { provider: 'anthropic', authMethod, oauthToken, claudeCodeMode, model, baseUrl, agentModels, effort, extendedThinking };
      }

      const rawKey = cfg.apiKey;
      if (rawKey && typeof rawKey === 'string') {
        const apiKey = decryptStored(rawKey);
        if (apiKey) {
          return { provider: 'anthropic', authMethod: 'api_key', apiKey, model, baseUrl, agentModels, effort, extendedThinking };
        }
      }
    }
  } catch (err) {
    console.warn('[llm.service] llm-anthropic lookup failed:', (err as Error).message);
  }

  // 2) Legacy fallback — the per-tenant key column the worker uses.
  try {
    const { rows } = await pool.query(
      `SELECT anthropic_api_key FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const rawKey = rows[0]?.anthropic_api_key;
    if (rawKey && typeof rawKey === 'string') {
      const apiKey = decryptStored(rawKey);
      if (apiKey) {
        return { provider: 'anthropic', authMethod: 'api_key', apiKey, model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL };
      }
    }
  } catch (err) {
    console.warn('[llm.service] tenants.anthropic_api_key lookup failed:', (err as Error).message);
  }

  return null;
}
