/**
 * Tenant LLM resolver.
 *
 * The synchronous chat pipeline (requirement → plan → generate → script →
 * heal) needs an LLM to run. Two halves, stored separately:
 *
 *   - Credential  → Azure Key Vault (see llm-credentials.service.ts). Never
 *                   entered in the UI, never stored in the database.
 *   - Settings    → client_configurations `llm-anthropic` (model, per-agent
 *                   models, effort, thinking, endpoint) — chosen by the admin
 *                   in System Configuration → LLM Configuration.
 *
 * A Claude Code OAuth token (sk-ant-oat…) stored in the same secret is
 * detected by its prefix and sent as a Bearer token instead of x-api-key.
 */
import pool from '../db.js';
import { resolveLlmCredential } from './llm-credentials.service.js';

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
 * Resolve the tenant's Anthropic LLM: key from Key Vault + model settings
 * from the DB. Returns null when no credential is available — callers should
 * surface a clear "configure an LLM" message rather than silently failing.
 */
export async function getTenantLlm(tenantId: string): Promise<TenantLlm | null> {
  const cred = await resolveLlmCredential('anthropic', tenantId);
  if (!cred.value) {
    console.warn(`[llm.service] No Anthropic credential: ${cred.error || 'not configured'}`);
    return null;
  }

  let cfg: Record<string, any> = {};
  try {
    const { rows } = await pool.query(
      `SELECT config_data FROM client_configurations
        WHERE tenant_id = $1 AND integration_id = 'llm-anthropic'`,
      [tenantId],
    );
    cfg = rows[0]?.config_data || {};
  } catch (err) {
    console.warn('[llm.service] llm-anthropic settings lookup failed:', (err as Error).message);
  }

  const agentModels =
    cfg.agentModels && typeof cfg.agentModels === 'object' && !Array.isArray(cfg.agentModels)
      ? (cfg.agentModels as Record<string, string>)
      : undefined;
  const model = (cfg.model && String(cfg.model)) || DEFAULT_MODEL;
  const baseUrl = (cfg.baseUrl && String(cfg.baseUrl)) || DEFAULT_BASE_URL;
  const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const effort = VALID_EFFORTS.includes(cfg.effort) ? (cfg.effort as TenantLlm['effort']) : undefined;
  const extendedThinking = cfg.extendedThinking === true;

  if (/^sk-ant-oat/i.test(cred.value)) {
    return {
      provider: 'anthropic', authMethod: 'claude_code', oauthToken: cred.value, claudeCodeMode: 'api',
      model, baseUrl, agentModels, effort, extendedThinking,
    };
  }
  return { provider: 'anthropic', authMethod: 'api_key', apiKey: cred.value, model, baseUrl, agentModels, effort, extendedThinking };
}
