import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { loadPipelineDefinition, loadPipelineDefinitionForClient, savePipelineDefinition } from '../orchestrator/orchestrator.js';
import { getUsageStats, isWorkerConnected, getLastHeartbeat, setPendingWorkerCommand } from '../services/pipeline-queries.js';
import { getConfig } from '../services/configurations.service.js';
import { decryptConfigData } from '../utils/crypto.js';

const SCHEMA = '"JBSTestOpsAI"';
const router = Router();

// Shared fetch timeout for provider probes (connection test + model listing) —
// keeps a hung endpoint from holding the request open and lets us surface a
// clean "timeout" status to the UI.
const TIMEOUT_MS = 15000;
async function fetchWithTimeout(url: string, init: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// GET /pipeline-definition
router.get('/pipeline-definition', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const definition = await loadPipelineDefinitionForClient(pool, tenantId || null);
    res.json(definition);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /pipeline-definition
router.put('/pipeline-definition', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    await savePipelineDefinition(pool, tenantId || null, req.body, (req as any).user?.username);
    res.json({ saved: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /agent-types
router.get('/agent-types', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM ${SCHEMA}.qa_agent_types ORDER BY sort_order`);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /usage
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const stats = await getUsageStats(pool, tenantId);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /worker-status
router.get('/worker-status', async (_req: Request, res: Response) => {
  try {
    const connected = isWorkerConnected();
    const lastHb = getLastHeartbeat();
    res.json({
      connected,
      lastHeartbeat: lastHb?.timestamp?.toISOString() || null,
      currentTask: lastHb?.currentTaskId || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /worker/:action (stop, restart)
router.post('/worker/:action', async (req: Request, res: Response) => {
  try {
    const action = req.params.action as string;
    if (action !== 'stop' && action !== 'restart') { res.status(400).json({ error: 'Invalid action' }); return; }
    const lastHb = getLastHeartbeat();
    if (lastHb) { setPendingWorkerCommand(lastHb.workerId, action); }
    res.json({ sent: true, action });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /test-ai-connection — validates the AI API key by making a minimal request
router.post('/test-ai-connection', async (req: Request, res: Response) => {
  try {
    const { provider, authMethod, integrationId } = req.body;
    let { apiKey, model, baseUrl } = req.body;
    const norm = String(provider || '').toLowerCase();

    // ── CLI AUTH DISABLED (2026-06-27) ──
    // The platform standardised on API keys (LLM Configuration). The legacy
    // `claude` CLI auth path (execSync `claude --version` / `claude auth status`)
    // has been removed — it expired periodically and caused the recurring
    // "AI engine not connected" failures. Reject CLI-auth test requests with an
    // actionable message instead of probing for the binary.
    if (authMethod === 'claude-cli') {
      res.status(400).json({
        error: 'Claude CLI authentication is disabled. Configure an Anthropic API key in System Configuration → LLM Configuration and test that instead.',
      });
      return;
    }

    // ── Cloud is integrated with IntelliQE via API only ──
    // Every branch below performs a REAL, live round-trip to the provider's cloud
    // API with the supplied credentials and returns verifiable proof: the model the
    // cloud echoed back, the measured latency, the provider request-id, and a
    // server-stamped verification time. Nothing here is simulated — `ok: true`
    // means IntelliQE actually reached the cloud API and it answered.
    if (authMethod && authMethod !== 'api-key') {
      res.status(400).json({ error: 'Cloud LLMs are integrated via API only. Select "API Key" as the authentication method.' });
      return;
    }
    if (!apiKey) { res.status(400).json({ error: 'API key is required for cloud API connectivity.' }); return; }

    const verifiedAt = new Date().toISOString();
    const t0 = Date.now();

    /** Build the genuine "connected" payload from a successful live response. */
    const proof = (usedModel: string, latencyMs: number, requestId?: string) => ({
      ok: true,
      provider,
      model: usedModel,
      latencyMs,
      requestId: requestId || null,
      verifiedAt,
      message: `Live cloud API connection verified — ${usedModel} responded in ${latencyMs} ms.`,
    });

    if (provider === 'claude' || provider === 'anthropic') {
      const testRes = await fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: connected.' }],
        }),
      });
      const latencyMs = Date.now() - t0;
      if (testRes.ok) {
        const body = await testRes.json().catch(() => ({} as any));
        const requestId = testRes.headers.get('request-id') || testRes.headers.get('x-request-id') || undefined;
        res.json(proof(body?.model || model || 'claude', latencyMs, requestId));
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `Anthropic API returned HTTP ${testRes.status}.` });
      }
      return;
    }

    if (provider === 'openai' || provider === 'azure-openai') {
      // OpenAI and Azure OpenAI share the chat/completions shape; Azure routes
      // through a deployment path and uses the api-key header + api-version query.
      const isAzure = provider === 'azure-openai';
      const url = isAzure
        ? `${(baseUrl || '').replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(model || 'gpt-4o')}/chat/completions?api-version=2024-06-01`
        : `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isAzure) headers['api-key'] = apiKey; else headers['Authorization'] = `Bearer ${apiKey}`;
      const testRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: connected.' }],
        }),
      });
      const latencyMs = Date.now() - t0;
      if (testRes.ok) {
        const body = await testRes.json().catch(() => ({} as any));
        const requestId = testRes.headers.get('x-request-id') || body?.id || undefined;
        res.json(proof(body?.model || model || (isAzure ? 'azure-openai' : 'openai'), latencyMs, requestId));
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `${isAzure ? 'Azure OpenAI' : 'OpenAI'} API returned HTTP ${testRes.status}.` });
      }
      return;
    }

    if (provider === 'gemini') {
      // Google Generative Language API — an authenticated model-metadata GET is a
      // genuine round-trip that fails on a bad key without consuming generation quota.
      const base = baseUrl || 'https://generativelanguage.googleapis.com';
      const m = model || 'gemini-1.5-flash';
      const testRes = await fetch(`${base}/v1beta/models/${encodeURIComponent(m)}?key=${encodeURIComponent(apiKey)}`);
      const latencyMs = Date.now() - t0;
      if (testRes.ok) {
        const body = await testRes.json().catch(() => ({} as any));
        res.json(proof(String(body?.name || `models/${m}`).replace(/^models\//, ''), latencyMs));
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `Gemini API returned HTTP ${testRes.status}.` });
      }
      return;
    }

    if (provider === 'custom') {
      // Custom / self-hosted endpoint — still a real OpenAI-compatible round-trip.
      if (!baseUrl) { res.status(400).json({ error: 'Base URL is required for a custom cloud API endpoint.' }); return; }
      const testRes = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'custom-model',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: connected.' }],
        }),
      });
      const latencyMs = Date.now() - t0;
      if (testRes.ok) {
        const body = await testRes.json().catch(() => ({} as any));
        res.json(proof(body?.model || model || 'custom-model', latencyMs, body?.id));
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `Custom endpoint returned HTTP ${testRes.status}.` });
      }
      return;
    }

    res.status(400).json({ error: `Unsupported provider "${provider}" for cloud API connectivity.` });
  } catch (err: any) {
<<<<<<< HEAD
    // A throw here is almost always a transport failure — the cloud API host was
    // genuinely unreachable (DNS, refused, TLS, timeout). Report it as such so the
    // UI can tell the user it's a connectivity problem, not a credential one.
    const raw = String(err?.message || err || '');
    const isNetwork = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up|network/i.test(raw);
    res.status(isNetwork ? 502 : 500).json({
      error: isNetwork
        ? 'Could not reach the cloud API endpoint. Check the Base URL and your network connection, then try again.'
        : (raw || 'Connection test failed'),
    });
=======
    res.status(500).json({ ok: false, status: 'failed', error: err.message || 'Connection test failed' });
>>>>>>> 24902532bc8dc5cece07abe81ba85949b71436a4
  }
});

// POST /list-models — fetch the live model catalogue for a provider after a
// successful connection. Falls back to a curated list when the provider has no
// list endpoint or the call fails, so the UI always has something to show.
router.post('/list-models', async (req: Request, res: Response) => {
  const { provider, integrationId } = req.body || {};
  let { apiKey, baseUrl } = req.body || {};
  const norm = String(provider || '').toLowerCase();

  // Resolve the stored credential when the UI lists models for a saved provider
  // (it never holds the plaintext key). Mirrors the test-connection resolution.
  if ((!apiKey || apiKey === '__KEEP_EXISTING__') && integrationId) {
    const tenantId = (req as any).user?.tenantId;
    if (tenantId) {
      const existing = await getConfig(tenantId, integrationId);
      if (existing?.configData) {
        const dec = decryptConfigData(existing.configData);
        if (dec.apiKey) apiKey = dec.apiKey;
        if (!baseUrl && dec.endpoint) baseUrl = dec.endpoint;
      }
    }
  }

  const FALLBACKS: Record<string, string[]> = {
    anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
    claude: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
    gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    google: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    cohere: ['command-r-plus', 'command-r', 'command'],
    'azure-openai': ['gpt-4o', 'gpt-4-turbo', 'gpt-35-turbo'],
    'aws-bedrock': ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-haiku-20240307-v1:0'],
    ollama: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5'],
  };

  const respond = (models: string[], source: 'live' | 'fallback') =>
    res.json({ models: Array.from(new Set(models)).filter(Boolean), source });

  try {
    if ((norm === 'anthropic' || norm === 'claude') && apiKey) {
      const r = await fetchWithTimeout(`${baseUrl || 'https://api.anthropic.com'}/v1/models?limit=100`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (r.ok) {
        const data: any = await r.json();
        const ids = (data.data || []).map((m: any) => m.id).filter(Boolean);
        return respond(ids.length ? ids : FALLBACKS[norm], ids.length ? 'live' : 'fallback');
      }
    } else if ((norm === 'openai' || norm === 'groq' || norm === 'mistral') && apiKey) {
      const base = baseUrl || (norm === 'groq' ? 'https://api.groq.com/openai/v1'
        : norm === 'mistral' ? 'https://api.mistral.ai/v1'
        : 'https://api.openai.com/v1');
      const r = await fetchWithTimeout(`${base}/models`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (r.ok) {
        const data: any = await r.json();
        const ids = (data.data || []).map((m: any) => m.id).filter(Boolean).sort();
        return respond(ids.length ? ids : FALLBACKS[norm], ids.length ? 'live' : 'fallback');
      }
    } else if ((norm === 'gemini' || norm === 'google') && apiKey) {
      const base = baseUrl || 'https://generativelanguage.googleapis.com';
      const r = await fetchWithTimeout(`${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});
      if (r.ok) {
        const data: any = await r.json();
        const ids = (data.models || [])
          .map((m: any) => String(m.name || '').replace(/^models\//, ''))
          .filter((id: string) => id);
        return respond(ids.length ? ids : FALLBACKS[norm], ids.length ? 'live' : 'fallback');
      }
    } else if (norm === 'ollama') {
      const base = baseUrl || 'http://localhost:11434';
      const r = await fetchWithTimeout(`${base}/api/tags`, {});
      if (r.ok) {
        const data: any = await r.json();
        const ids = (data.models || []).map((m: any) => m.name).filter(Boolean);
        return respond(ids.length ? ids : FALLBACKS[norm], ids.length ? 'live' : 'fallback');
      }
    }
  } catch {
    /* fall through to curated list */
  }

  return respond(FALLBACKS[norm] || [], 'fallback');
});

// GET /ai-config — returns the saved AI configuration for use by the pipeline
router.get('/ai-config', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const { rows } = await pool.query(
      `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = 'ai-self-healing'`,
      [tenantId]
    );
    if (rows.length > 0) {
      const config = rows[0].config_data;
      res.json({
        provider: config.aiProvider || 'claude',
        model: config.aiModel || 'claude-sonnet-4-20250514',
        apiKey: config.aiApiKey ? '***configured***' : null,
        baseUrl: config.aiBaseUrl || '',
        pipelineMode: config.pipelineMode || 'auto',
        enableWorker: config.enableWorker || false,
        hasApiKey: !!config.aiApiKey,
      });
    } else {
      res.json({ provider: null, model: null, apiKey: null, pipelineMode: 'local-only', hasApiKey: false });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
