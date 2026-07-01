/**
 * Centralized LLM Configuration — per-tenant connectivity for the platform's
 * AI capabilities (Planner, Test Generator, Healer, Test Data Generator, etc.).
 *
 * Supports three providers, each authenticated by API key:
 *   - anthropic  (Anthropic Claude)
 *   - gemini     (Google Gemini)
 *   - openai     (OpenAI ChatGPT)
 *
 * Storage: rows in `client_configurations` keyed by integration_id
 * `llm-<provider>`. The API key lives under the `apiKey` field, which is a
 * recognised sensitive key — encrypted at rest (AES-256-GCM) and only ever
 * returned masked. One provider may be flagged the tenant default.
 *
 * To keep the existing pipeline worker functional (it reads
 * `tenants.anthropic_api_key`), saving/removing the Anthropic key is mirrored
 * into that column.
 *
 * Endpoints (all admin-only):
 *   GET    /api/llm-config                  -> { providers: [...], defaultProvider }
 *   POST   /api/llm-config/:provider/test   -> validate creds + list models
 *   PUT    /api/llm-config/:provider        -> save / update (key preserved if omitted)
 *   POST   /api/llm-config/:provider/default-> mark as the default provider
 *   DELETE /api/llm-config/:provider        -> remove the configuration
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import {
  decryptField,
  decryptStored,
  encryptAtRest,
  maskSecret,
} from '../utils/crypto.js';
import { logAudit } from '../utils/audit.js';
import { isClaudeCliAvailable, runClaudePrompt } from '../agents/claude-runner.js';

type AuthMethod = 'api_key' | 'claude_code';

const router = Router();

type ProviderId = 'anthropic' | 'gemini' | 'openai';

const PROVIDERS: Record<ProviderId, { label: string; defaultBaseUrl: string }> = {
  anthropic: { label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com' },
  gemini:    { label: 'Google Gemini',    defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  openai:    { label: 'OpenAI ChatGPT',   defaultBaseUrl: 'https://api.openai.com/v1' },
};

type ConnStatus = 'connected' | 'not_configured' | 'invalid_credentials' | 'connection_failed';

// Current Anthropic Claude models exposed via the Messages API. Merged with the
// account's live /v1/models so the dropdown always lists the full lineup even
// when an account's models endpoint returns a narrower set.
const ANTHROPIC_KNOWN_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

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

/** Resolve the usable plaintext API key for a provider (stored, decrypted). */
function storedKey(row: LlmRow | null): string | null {
  const v = row?.config_data?.apiKey;
  if (!v || typeof v !== 'string') return null;
  try { return decryptStored(v); } catch { return null; }
}

/** Resolve the stored Claude Code OAuth token (decrypted). */
function storedToken(row: LlmRow | null): string | null {
  const v = row?.config_data?.oauthToken;
  if (!v || typeof v !== 'string') return null;
  try { return decryptStored(v); } catch { return null; }
}

/** The saved auth method for a row (Anthropic only); defaults to 'api_key'. */
function authMethodOf(row: LlmRow | null): AuthMethod {
  return row?.config_data?.authMethod === 'claude_code' ? 'claude_code' : 'api_key';
}

type TestOutcome = { ok: boolean; status: ConnStatus; message: string; models: string[]; raw?: string };

function classify(msg: string): ConnStatus {
  return /401|403|invalid|unauthor|expired|bearer/i.test(msg) ? 'invalid_credentials' : 'connection_failed';
}

/**
 * Test path #1 — the OAuth token against the Anthropic Messages **API**
 * (Authorization: Bearer + OAuth beta). This is the path the pipeline uses when
 * a token is saved, so a green result here guarantees generation works.
 */
async function validateClaudeCodeApi(token: string | null, baseUrl: string): Promise<TestOutcome> {
  if (!token) {
    return { ok: false, status: 'not_configured', message: 'Enter a Claude Code OAuth token (run `claude setup-token`) to test the API.', models: [] };
  }
  // listModels routes an sk-ant-oat… token to /v1/models with Bearer + the OAuth
  // beta header — a single call that both validates the token AND returns the
  // LIVE model lineup the account can use.
  const result = await listModels('anthropic', token, baseUrl);
  if (result.ok) {
    return { ...result, message: 'Connected to the Anthropic API with your Claude Code token.' };
  }
  return result;
}

/**
 * Test path #2 — the local `claude` **CLI**. Runs `claude -p`, passing the saved
 * OAuth token via CLAUDE_CODE_OAUTH_TOKEN so it authenticates non-interactively.
 * Surfaces the CLI's RAW stdout/stderr on failure so the cause is obvious.
 */
function validateClaudeCli(token: string | null): TestOutcome {
  if (!isClaudeCliAvailable()) {
    return { ok: false, status: 'connection_failed', message: 'The `claude` CLI is not installed/visible to the server (`claude --version` failed).', models: [], raw: '' };
  }
  try {
    const out = runClaudePrompt('Reply with the single word: ok', { model: 'claude-haiku-4-5', oauthToken: token || undefined });
    if (out && out.trim()) {
      return {
        ok: true,
        status: 'connected',
        message: `Connected via the Claude CLI${token ? ' (using your saved OAuth token)' : ' (using the CLI login on this server)'}.`,
        models: ANTHROPIC_KNOWN_MODELS,
        raw: out.slice(0, 300),
      };
    }
    return { ok: false, status: 'connection_failed', message: 'The Claude CLI returned no output.', models: [], raw: '' };
  } catch (err: any) {
    const raw = String(err?.message || 'Claude CLI failed.');
    return { ok: false, status: classify(raw), message: `Claude CLI did not connect: ${raw}`, models: [], raw };
  }
}

/**
 * Validate credentials by listing the account's models. A successful list is a
 * strong credential check and gives us the live model dropdown in one call.
 */
async function listModels(
  provider: ProviderId,
  apiKey: string,
  baseUrl: string,
): Promise<{ ok: boolean; status: ConnStatus; message: string; models: string[] }> {
  const base = (baseUrl || PROVIDERS[provider].defaultBaseUrl).replace(/\/+$/, '');
  try {
    if (provider === 'anthropic') {
      // Route by credential shape: sk-ant-oat… is an OAuth token (Bearer + beta
      // header); everything else uses x-api-key. Lets the test pass even if the
      // credential was entered under the "other" auth method.
      const cred = (apiKey || '').trim();
      const oauthHeaders = { authorization: `Bearer ${cred}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' };
      const keyHeaders = { 'x-api-key': cred, 'anthropic-version': '2023-06-01' };
      const r = await fetch(`${base}/v1/models`, {
        headers: /^sk-ant-oat/i.test(cred) ? oauthHeaders : keyHeaders,
      });
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid_credentials', message: 'Invalid API key.', models: [] };
      if (!r.ok) return { ok: false, status: 'connection_failed', message: `Provider returned ${r.status}.`, models: [] };
      const j: any = await r.json();
      const live = (j.data || []).map((m: any) => m.id).filter(Boolean);
      // Show the full current lineup, plus any extra models the account exposes.
      const models = [...ANTHROPIC_KNOWN_MODELS, ...live.filter((id: string) => !ANTHROPIC_KNOWN_MODELS.includes(id))];
      return { ok: true, status: 'connected', message: 'Connection successful.', models };
    }
    if (provider === 'openai') {
      const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid_credentials', message: 'Invalid API key.', models: [] };
      if (!r.ok) return { ok: false, status: 'connection_failed', message: `Provider returned ${r.status}.`, models: [] };
      const j: any = await r.json();
      const models = (j.data || [])
        .map((m: any) => m.id)
        .filter((id: string) => /^(gpt|o1|o3|o4|chatgpt)/i.test(id))
        .sort();
      return { ok: true, status: 'connected', message: 'Connection successful.', models };
    }
    // gemini
    const sep = base.includes('?') ? '&' : '?';
    const r = await fetch(`${base}/v1beta/models${sep}key=${encodeURIComponent(apiKey)}`);
    if (r.status === 401 || r.status === 403 || r.status === 400) return { ok: false, status: 'invalid_credentials', message: 'Invalid API key.', models: [] };
    if (!r.ok) return { ok: false, status: 'connection_failed', message: `Provider returned ${r.status}.`, models: [] };
    const j: any = await r.json();
    const models = (j.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
    return { ok: true, status: 'connected', message: 'Connection successful.', models };
  } catch (err: any) {
    return { ok: false, status: 'connection_failed', message: err?.message || 'Connection failed.', models: [] };
  }
}

/** Keep the worker's tenant key in sync with the centralized Anthropic config. */
async function syncTenantAnthropicKey(tenantId: string, plainKey: string | null): Promise<void> {
  const value = plainKey ? encryptAtRest(plainKey) : null;
  await pool.query(
    `UPDATE "JBSTestOpsAI".tenants SET anthropic_api_key = $1, updated_at = NOW() WHERE id = $2`,
    [value, tenantId],
  );
}

// ─── GET /api/llm-config ───────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const tenantId = req.user!.tenantId;
    const providers = [] as any[];
    let defaultProvider: ProviderId | null = null;

    for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
      const row = await getRow(tenantId, p);
      const cfg = row?.config_data || {};
      const key = storedKey(row);

      // Anthropic supports two auth methods; others are API-key only.
      const authMethod: AuthMethod = p === 'anthropic' ? authMethodOf(row) : 'api_key';
      const token = p === 'anthropic' ? storedToken(row) : null;
      const configured =
        authMethod === 'claude_code' ? (!!token || isClaudeCliAvailable()) : !!key;

      if (configured && cfg.isDefault) defaultProvider = p;
      providers.push({
        provider: p,
        label: PROVIDERS[p].label,
        configured,
        status: (configured ? (row?.status as ConnStatus) || 'connected' : 'not_configured') as ConnStatus,
        authMethod,
        claudeCodeMode: cfg.claudeCodeMode === 'cli' ? 'cli' : 'api',
        model: cfg.model || null,
        agentModels: (cfg.agentModels && typeof cfg.agentModels === 'object') ? cfg.agentModels : {},
        effort: cfg.effort || null,
        extendedThinking: cfg.extendedThinking === true,
        baseUrl: cfg.baseUrl || PROVIDERS[p].defaultBaseUrl,
        maskedKey: key ? maskSecret(key) : null,
        maskedToken: token ? maskSecret(token) : null,
        isDefault: !!cfg.isDefault,
        updatedBy: row?.connected_by || null,
        updatedAt: row?.last_sync_at || row?.connected_at || row?.updated_at || null,
      });
    }

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
    const baseUrl = (req.body?.baseUrl || '').trim() || PROVIDERS[provider].defaultBaseUrl;

    // Anthropic Claude Code (subscription) — validate the OAuth token / CLI.
    const requestedMethod: AuthMethod =
      req.body?.authMethod === 'claude_code' ? 'claude_code'
      : req.body?.authMethod === 'api_key' ? 'api_key'
      : (provider === 'anthropic' ? authMethodOf(row) : 'api_key');

    if (provider === 'anthropic' && requestedMethod === 'claude_code') {
      const incomingTok = (req.body?.oauthToken || '') as string;
      const token = incomingTok ? decryptField(incomingTok).trim() : storedToken(row);
      // Which path to test: 'api' (OAuth token → Messages API) or 'cli' (local
      // claude CLI). Defaults to 'api' for back-compat.
      const testMode = req.body?.mode === 'cli' ? 'cli' : 'api';
      console.log(
        `[llm-config/test] claude_code mode=${testMode}: source=${incomingTok ? 'entered-in-field' : 'saved-in-db'}, ` +
        `token=${token ? `${maskSecret(token)} (${token.length} chars, prefix ${token.slice(0, 11)})` : '(none)'}`,
      );
      const result = testMode === 'cli'
        ? validateClaudeCli(token)
        : await validateClaudeCodeApi(token, baseUrl);
      console.log(`[llm-config/test] claude_code mode=${testMode} → ${result.ok ? 'CONNECTED' : 'FAILED'}: ${result.message}`);
      res.status(result.ok ? 200 : 400).json(result);
      return;
    }

    const incoming = (req.body?.apiKey || '') as string;
    const apiKey = incoming ? decryptField(incoming).trim() : storedKey(row);
    if (!apiKey) { res.status(400).json({ ok: false, status: 'not_configured', message: 'API key is required.' }); return; }

    const result = await listModels(provider, apiKey, baseUrl);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, status: 'connection_failed', message: err.message || 'Connection test failed.' });
  }
});

// ─── PUT /api/llm-config/:provider ─────────────────────────────────────
router.put('/:provider', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const provider = req.params.provider as string;
  if (!isProvider(provider)) { res.status(400).json({ error: 'Unknown provider' }); return; }
  try {
    const tenantId = req.user!.tenantId;
    const existing = await getRow(tenantId, provider);
    const prevCfg = existing?.config_data || {};

    // Resolve the auth method (Anthropic only); other providers are API-key.
    const authMethod: AuthMethod =
      provider === 'anthropic'
        ? (req.body?.authMethod === 'claude_code' ? 'claude_code'
           : req.body?.authMethod === 'api_key' ? 'api_key'
           : (prevCfg.authMethod || 'api_key'))
        : 'api_key';

    // Preserve the stored key when the caller omits it (masked-on-load case).
    const incomingKey = (req.body?.apiKey || '') as string;
    let storedApiKey: string | null = prevCfg.apiKey || null;
    let plainForMirror = storedKey(existing);
    if (incomingKey) {
      const plain = decryptField(incomingKey).trim();
      if (plain) {
        storedApiKey = encryptAtRest(plain);
        plainForMirror = plain;
      }
    }

    // Preserve the stored OAuth token when omitted (Claude Code method).
    const incomingTok = (req.body?.oauthToken || '') as string;
    let storedOauthToken: string | null = prevCfg.oauthToken || null;
    if (incomingTok) {
      const plain = decryptField(incomingTok).trim();
      if (plain) storedOauthToken = encryptAtRest(plain);
    }

    // Method-aware requirement: api_key needs a key; claude_code needs a token
    // (or a logged-in local CLI for dev).
    if (authMethod === 'claude_code') {
      if (!storedOauthToken && !isClaudeCliAvailable()) {
        res.status(400).json({ error: 'A Claude Code OAuth token is required (run `claude setup-token`).' });
        return;
      }
    } else if (!storedApiKey) {
      res.status(400).json({ error: 'API key is required.' });
      return;
    }

    const baseUrl = (req.body?.baseUrl ?? prevCfg.baseUrl ?? PROVIDERS[provider].defaultBaseUrl) as string;
    const model = (req.body?.model ?? prevCfg.model ?? null) as string | null;
    // Per-agent model overrides — preserve existing when the caller omits them.
    const agentModels = sanitizeAgentModels(req.body?.agentModels, prevCfg.agentModels || {});

    // Reasoning effort + extended ("ultra") thinking. Anthropic only; preserved
    // when the caller omits them. Applied per-model-capability at call time.
    const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const effort = VALID_EFFORTS.includes(req.body?.effort) ? req.body.effort : (prevCfg.effort ?? undefined);
    const extendedThinking = typeof req.body?.extendedThinking === 'boolean'
      ? req.body.extendedThinking
      : (prevCfg.extendedThinking ?? false);

    // Claude Code transport (Anthropic + claude_code only): 'api' (OAuth→API) or
    // 'cli' (local claude CLI). Preserved when the caller omits it.
    const claudeCodeMode: 'api' | 'cli' =
      req.body?.claudeCodeMode === 'cli' ? 'cli'
      : req.body?.claudeCodeMode === 'api' ? 'api'
      : (prevCfg.claudeCodeMode === 'cli' ? 'cli' : 'api');

    const configData = {
      apiKey: storedApiKey,
      oauthToken: storedOauthToken,
      authMethod,
      claudeCodeMode,
      baseUrl,
      model,
      agentModels,
      effort,
      extendedThinking,
      isDefault: !!prevCfg.isDefault,
    };

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

    // Mirror only the x-api-key into the worker's column. The worker can't use an
    // OAuth (subscription) token as an x-api-key, so don't mirror in that mode.
    if (provider === 'anthropic' && authMethod === 'api_key' && plainForMirror) {
      await syncTenantAnthropicKey(tenantId, plainForMirror);
    }

    void logAudit(req, 'update', `llm-config.${provider}`, tenantId, { op: 'save', authMethod });
    const plainTok = storedOauthToken ? (decryptStored(storedOauthToken) || null) : null;
    res.json({
      ok: true,
      authMethod,
      maskedKey: plainForMirror ? maskSecret(plainForMirror) : null,
      maskedToken: plainTok ? maskSecret(plainTok) : null,
    });
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
    const target = await getRow(tenantId, provider);
    const targetConfigured =
      provider === 'anthropic' && authMethodOf(target) === 'claude_code'
        ? (!!storedToken(target) || isClaudeCliAvailable())
        : !!storedKey(target);
    if (!targetConfigured) { res.status(400).json({ error: 'Configure this provider before making it the default.' }); return; }

    for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
      const row = await getRow(tenantId, p);
      if (!row) continue;
      const cfg = { ...(row.config_data || {}), isDefault: p === provider };
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
    if (provider === 'anthropic') await syncTenantAnthropicKey(tenantId, null);
    void logAudit(req, 'delete', `llm-config.${provider}`, tenantId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
