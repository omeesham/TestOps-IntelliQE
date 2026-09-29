/**
 * Centralized LLM Configuration — per-tenant model choices for the platform's
 * AI capabilities (Planner, Test Generator, Healer, Test Data Generator, etc.).
 *
 * Credentials are NOT managed here. API keys live in the customer's Azure Key
 * Vault and are read by the backend's managed identity at call time (see
 * services/llm-credentials.service.ts). This API only:
 *   - reports where each provider's key comes from (vault + secret name),
 *   - tests connectivity with that key and lists the provider's live models,
 *   - saves the non-secret settings: model, per-agent models, effort,
 *     thinking, endpoint and the default provider.
 *
 * Storage: `client_configurations` rows keyed by integration_id `llm-<provider>`
 * hold only those settings — never a key.
 *
 * Endpoints (all admin-only):
 *   GET    /api/llm-config                  -> { providers: [...], defaultProvider }
 *   POST   /api/llm-config/:provider/test   -> fresh Key Vault read + live model list
 *   PUT    /api/llm-config/:provider        -> save model settings
 *   POST   /api/llm-config/:provider/default-> mark as the default provider
 *   DELETE /api/llm-config/:provider        -> reset model settings
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { logAudit } from '../utils/audit.js';
import { resolveLlmCredential, type LlmCredential } from '../services/llm-credentials.service.js';

const router = Router();

type ProviderId = 'anthropic' | 'gemini' | 'openai';

const PROVIDERS: Record<ProviderId, { label: string; defaultBaseUrl: string }> = {
  anthropic: { label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com' },
  gemini:    { label: 'Google Gemini',    defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  openai:    { label: 'OpenAI ChatGPT',   defaultBaseUrl: 'https://api.openai.com/v1' },
};

type ConnStatus = 'connected' | 'not_configured' | 'invalid_credentials' | 'connection_failed';

function requireAdmin(req: Request, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return false;
  }
  return true;
}

function isProvider(p: string): p is ProviderId {
  return p === 'anthropic' || p === 'gemini' || p === 'openai';
}

const integrationId = (p: ProviderId) => `llm-${p}`;

// Pipeline stages the admin can assign a model to (must match the agents).
const AGENT_STAGES = ['requirement', 'audit', 'planner', 'generator', 'script', 'heal', 'explore'] as const;

/** Keep only known stage keys with non-empty string model values. */
function sanitizeAgentModels(input: any, fallback: Record<string, string>): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;
  const out: Record<string, string> = {};
  for (const stage of AGENT_STAGES) {
    const v = input[stage];
    if (typeof v === 'string' && v.trim()) out[stage] = v.trim();
  }
  return out;
}

interface LlmRow {
  status: string;
  config_data: Record<string, any>;
  connected_by: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  updated_at: string | null;
}

async function getRow(tenantId: string, provider: ProviderId): Promise<LlmRow | null> {
  const { rows } = await pool.query(
    `SELECT status, config_data, connected_by, connected_at, last_sync_at, updated_at
       FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId(provider)],
  );
  return rows[0] || null;
}

/** Only the non-secret settings — strips any legacy apiKey/oauthToken left in the row. */
function settingsOf(row: LlmRow | null): Record<string, any> {
  const { apiKey: _k, oauthToken: _t, authMethod: _a, claudeCodeMode: _m, ...rest } = row?.config_data || {};
  return rest;
}

/** Public, secret-free description of where a provider's key comes from. */
function credentialInfo(cred: LlmCredential) {
  return {
    source: cred.source,
    reference: cred.reference,
    vault: cred.vault,
    found: !!cred.value,
    kind: cred.value && /^sk-ant-oat/i.test(cred.value) ? 'oauth_token' : 'api_key',
    error: cred.value ? undefined : cred.error,
  };
}

/* ─────────────────────────────────────────────────────────────
   Live model catalogue
   ───────────────────────────────────────────────────────────── */
interface ModelList { ok: boolean; status: ConnStatus; message: string; models: string[] }

/**
 * Validate the key by listing the account's models. A successful list is a
 * strong credential check and yields the live model dropdown in one call —
 * so newly released models appear without a code change.
 */
async function listModels(provider: ProviderId, apiKey: string, baseUrl: string): Promise<ModelList> {
  const base = (baseUrl || PROVIDERS[provider].defaultBaseUrl).replace(/\/+$/, '');
  try {
    if (provider === 'anthropic') {
      // sk-ant-oat… is a Claude Code OAuth token (Bearer + beta header);
      // everything else is a regular x-api-key.
      const cred = apiKey.trim();
      const headers: Record<string, string> = /^sk-ant-oat/i.test(cred)
        ? { authorization: `Bearer ${cred}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' }
        : { 'x-api-key': cred, 'anthropic-version': '2023-06-01' };
      // The API returns models newest-first; one page of 1000 covers the catalogue.
      const r = await fetch(`${base}/v1/models?limit=1000`, { headers });
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid_credentials', message: 'Key Vault key was rejected by Anthropic (invalid or revoked).', models: [] };
      if (!r.ok) return { ok: false, status: 'connection_failed', message: `Anthropic returned ${r.status}.`, models: [] };
      const j: any = await r.json();
      const models = (j.data || []).map((m: any) => m.id).filter(Boolean);
      return { ok: true, status: 'connected', message: `Connected. ${models.length} models available.`, models };
    }
    if (provider === 'openai') {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid_credentials', message: 'Key Vault key was rejected by OpenAI.', models: [] };
      if (!r.ok) return { ok: false, status: 'connection_failed', message: `OpenAI returned ${r.status}.`, models: [] };
      const j: any = await r.json();
      const models = (j.data || [])
        .filter((m: any) => /^(gpt|o1|o3|o4|chatgpt)/i.test(m.id || ''))
        .sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
        .map((m: any) => m.id);
      return { ok: true, status: 'connected', message: `Connected. ${models.length} models available.`, models };
    }
    // gemini — key goes in a header, not the URL, so it never lands in logs.
    const r = await fetch(`${base}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
    if (r.status === 401 || r.status === 403 || r.status === 400) return { ok: false, status: 'invalid_credentials', message: 'Key Vault key was rejected by Google.', models: [] };
    if (!r.ok) return { ok: false, status: 'connection_failed', message: `Google returned ${r.status}.`, models: [] };
    const j: any = await r.json();
    const models = (j.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort()
      .reverse();
    return { ok: true, status: 'connected', message: `Connected. ${models.length} models available.`, models };
  } catch (err: any) {
    return { ok: false, status: 'connection_failed', message: err?.message || 'Connection failed.', models: [] };
  }
}

// Model lists are cached per tenant+provider so opening the page doesn't hit
// every provider each time. Test Connection refreshes the entry.
const MODEL_TTL_MS = 10 * 60 * 1000;
const modelCache = new Map<string, { at: number; result: ModelList }>();

async function cachedModels(tenantId: string, provider: ProviderId, key: string, baseUrl: string, fresh = false): Promise<ModelList> {
  const ck = `${tenantId}:${provider}:${baseUrl}`;
  const hit = modelCache.get(ck);
  if (!fresh && hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.result;
  const result = await listModels(provider, key, baseUrl);
  modelCache.set(ck, { at: Date.now(), result });
  return result;
}

// ─── GET /api/llm-config ───────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const tenantId = req.user!.tenantId;
    let defaultProvider: ProviderId | null = null;

    const providers = await Promise.all((Object.keys(PROVIDERS) as ProviderId[]).map(async (p) => {
      const row = await getRow(tenantId, p);
      const cfg = settingsOf(row);
      const baseUrl = cfg.baseUrl || PROVIDERS[p].defaultBaseUrl;
      const cred = await resolveLlmCredential(p, tenantId);
      const configured = !!cred.value;
      const live = cred.value ? await cachedModels(tenantId, p, cred.value, baseUrl) : null;
      const status: ConnStatus = !configured ? 'not_configured' : live!.status;

      if (configured && cfg.isDefault) defaultProvider = p;
      return {
        provider: p,
        label: PROVIDERS[p].label,
        configured,
        status,
        statusMessage: live?.message ?? credentialInfo(cred).error ?? null,
        credential: credentialInfo(cred),
        models: live?.models ?? [],
        model: cfg.model || null,
        agentModels: (cfg.agentModels && typeof cfg.agentModels === 'object') ? cfg.agentModels : {},
        effort: cfg.effort || null,
        extendedThinking: cfg.extendedThinking === true,
        baseUrl,
        isDefault: !!cfg.isDefault,
        updatedBy: row?.connected_by || null,
        updatedAt: row?.last_sync_at || row?.connected_at || row?.updated_at || null,
      };
    }));

    res.json({ providers, defaultProvider });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/llm-config/:provider/test ───────────────────────────────
router.post('/:provider/test', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const provider = req.params.provider as string;
  if (!isProvider(provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  try {
    const tenantId = req.user!.tenantId;
    const row = await getRow(tenantId, provider);
    const baseUrl = (req.body?.baseUrl || '').trim() || settingsOf(row).baseUrl || PROVIDERS[provider].defaultBaseUrl;

    // Fresh read so a secret just added/rotated in Key Vault is picked up.
    const cred = await resolveLlmCredential(provider, tenantId, { fresh: true });
    const credential = credentialInfo(cred);
    if (!cred.value) {
      res.status(400).json({ ok: false, status: 'not_configured', message: cred.error || 'No key found.', models: [], credential });
      return;
    }

    const result = await cachedModels(tenantId, provider, cred.value, baseUrl, true);
    const where = cred.source === 'key-vault'
      ? `Key Vault ${cred.vault} → secret "${cred.reference}"`
      : `environment variable ${cred.reference}`;
    res.status(result.ok ? 200 : 400).json({ ...result, message: `${result.message}\nKey source: ${where}`, credential });
  } catch (err: any) {
    res.status(500).json({ ok: false, status: 'connection_failed', message: err.message || 'Connection test failed.' });
  }
});

// ─── PUT /api/llm-config/:provider ─────────────────────────────────────
router.put('/:provider', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const provider = req.params.provider as string;
  if (!isProvider(provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  if (req.body?.apiKey || req.body?.oauthToken) {
    res.status(400).json({ error: 'API keys are managed in Azure Key Vault and cannot be saved here.' });
    return;
  }
  try {
    const tenantId = req.user!.tenantId;
    const prevCfg = settingsOf(await getRow(tenantId, provider));

    const baseUrl = (req.body?.baseUrl ?? prevCfg.baseUrl ?? PROVIDERS[provider].defaultBaseUrl) as string;
    const model = (req.body?.model ?? prevCfg.model ?? null) as string | null;
    if (!model) { res.status(400).json({ error: 'Choose a model.' }); return; }
    // Per-agent model overrides — preserve existing when the caller omits them.
    const agentModels = sanitizeAgentModels(req.body?.agentModels, prevCfg.agentModels || {});

    // Reasoning effort + extended ("ultra") thinking. Anthropic only; preserved
    // when the caller omits them. Applied per-model-capability at call time.
    const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const effort = VALID_EFFORTS.includes(req.body?.effort) ? req.body.effort : (prevCfg.effort ?? undefined);
    const extendedThinking = typeof req.body?.extendedThinking === 'boolean'
      ? req.body.extendedThinking
      : (prevCfg.extendedThinking ?? false);

    // Settings only. Rewriting the row also drops any legacy key that an older
    // version stored in config_data.
    const configData = { baseUrl, model, agentModels, effort, extendedThinking, isDefault: !!prevCfg.isDefault };

    await pool.query(
      `MERGE INTO client_configurations WITH (HOLDLOCK) AS t
       USING (SELECT $1 AS tenant_id, $2 AS integration_id) AS s
         ON t.tenant_id = s.tenant_id AND t.integration_id = s.integration_id
       WHEN MATCHED THEN
         UPDATE SET status = $3, config_data = $4, connected_by = $5,
                    connected_at = SYSUTCDATETIME(), last_sync_at = SYSUTCDATETIME(),
                    updated_at = SYSUTCDATETIME(), category = 'settings'
       WHEN NOT MATCHED THEN
         INSERT (tenant_id, integration_id, status, config_data, connected_by, connected_at, last_sync_at, category)
         VALUES ($1, $2, $3, $4, $5, SYSUTCDATETIME(), SYSUTCDATETIME(), 'settings');`,
      [tenantId, integrationId(provider), 'connected', JSON.stringify(configData), req.user!.username],
    );

    void logAudit(req, 'update', `llm-config.${provider}`, tenantId, { op: 'save', model });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/llm-config/:provider/default ────────────────────────────
router.post('/:provider/default', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const provider = req.params.provider as string;
  if (!isProvider(provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  try {
    const tenantId = req.user!.tenantId;
    const cred = await resolveLlmCredential(provider, tenantId);
    if (!cred.value) { res.status(400).json({ error: 'Add this provider\'s key to Key Vault before making it the default.' }); return; }

    for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
      const row = await getRow(tenantId, p);
      if (!row) continue;
      const cfg = { ...settingsOf(row), isDefault: p === provider };
      await pool.query(
        `UPDATE client_configurations SET config_data = $1, updated_at = SYSUTCDATETIME()
          WHERE tenant_id = $2 AND integration_id = $3`,
        [JSON.stringify(cfg), tenantId, integrationId(p)],
      );
    }

    void logAudit(req, 'update', `llm-config.${provider}`, tenantId, { op: 'set_default' });
    res.json({ ok: true, defaultProvider: provider });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/llm-config/:provider ──────────────────────────────────
// Resets the model settings. The key itself stays in Key Vault.
router.delete('/:provider', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const provider = req.params.provider as string;
  if (!isProvider(provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  try {
    const tenantId = req.user!.tenantId;
    await pool.query(
      `DELETE FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
      [tenantId, integrationId(provider)],
    );
    void logAudit(req, 'delete', `llm-config.${provider}`, tenantId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
