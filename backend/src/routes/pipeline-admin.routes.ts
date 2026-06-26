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
    const { provider, authMethod, cliPath, integrationId } = req.body;
    let { apiKey, model, baseUrl } = req.body;
    const norm = String(provider || '').toLowerCase();

    // Claude CLI auth — test by running `claude --version`
    if (authMethod === 'claude-cli') {
      const { execSync } = await import('child_process');
      const os = await import('os');
      const path = await import('path');

      // Build candidate paths: user-specified, bare command, and common npm global locations
      const npmGlobalBin = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');
      const candidates = [
        cliPath,                         // user-specified path
        'claude',                        // bare command (if in PATH)
        npmGlobalBin,                    // Windows npm global default
      ].filter(Boolean) as string[];

      let resolved: string | null = null;
      let version = '';
      for (const cmd of candidates) {
        try {
          version = execSync(`"${cmd}" --version`, { timeout: 10000, encoding: 'utf-8' }).trim();
          resolved = cmd;
          break;
        } catch (_) { /* try next candidate */ }
      }
      if (!resolved) {
        res.status(400).json({
          error: `Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code — then add the npm global bin to your PATH:\n  setx PATH "%PATH%;${path.dirname(npmGlobalBin)}"\nThen restart your terminal and run: claude auth login --claudeai`,
        });
        return;
      }

      // Detecting the binary is not enough — `claude -p` fails (and the pipeline
      // silently falls back to template generation) when the CLI is logged out.
      // Verify real authentication via `claude auth status`, which prints JSON
      // { loggedIn, authMethod, ... } without consuming any tokens.
      let loggedIn = false;
      let authMethod = 'none';
      try {
        const statusRaw = execSync(`"${resolved}" auth status`, { timeout: 10000, encoding: 'utf-8' }).trim();
        const status = JSON.parse(statusRaw);
        loggedIn = status.loggedIn === true;
        authMethod = status.authMethod || 'none';
      } catch (_) { /* treat as logged out */ }

      if (!loggedIn) {
        res.status(400).json({
          error: `Claude CLI detected (${version}) but NOT logged in — the pipeline would fall back to template generation. Authenticate once as the user that runs the backend:\n  claude auth login --claudeai\nThen click Test Connection again.`,
          resolvedPath: resolved,
        });
        return;
      }

      res.json({ ok: true, message: `Claude CLI ready: ${version} (authenticated via ${authMethod})`, resolvedPath: resolved });
      return;
    }

    // When the UI tests an already-saved provider it sends no inline key (the
    // browser only ever holds the mask). Resolve the real credential from the
    // stored, at-rest-encrypted config so we test exactly what's persisted.
    if ((!apiKey || apiKey === '__KEEP_EXISTING__') && integrationId) {
      const tenantId = (req as any).user?.tenantId;
      if (tenantId) {
        const existing = await getConfig(tenantId, integrationId);
        if (existing?.configData) {
          const dec = decryptConfigData(existing.configData);
          if (dec.apiKey) apiKey = dec.apiKey;
          if (!baseUrl && dec.endpoint) baseUrl = dec.endpoint;
          if (!model && dec.model) model = dec.model;
        }
      }
    }

    const keyless = norm === 'ollama';
    if (!apiKey && !keyless) {
      res.status(400).json({ ok: false, status: 'not-configured', error: 'API key is required' });
      return;
    }

    // Map an HTTP error code onto one of the UI's connection states.
    const statusForHttp = (code: number): 'invalid-key' | 'failed' =>
      (code === 401 || code === 403) ? 'invalid-key' : 'failed';

    try {
      if (norm === 'claude' || norm === 'anthropic') {
        const testRes = await fetchWithTimeout(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say hello in one word.' }],
          }),
        });
        if (testRes.ok) {
          res.json({ ok: true, status: 'connected', message: `Connected to ${model || 'Claude'} successfully!` });
        } else {
          const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
          res.status(400).json({ ok: false, status: statusForHttp(testRes.status), error: err.error?.message || `API returned ${testRes.status}` });
        }
      } else if (norm === 'openai' || norm === 'groq' || norm === 'mistral') {
        // OpenAI-compatible providers expose GET /models — a cheap key check.
        const base = baseUrl || (norm === 'groq' ? 'https://api.groq.com/openai/v1'
          : norm === 'mistral' ? 'https://api.mistral.ai/v1'
          : 'https://api.openai.com/v1');
        const testRes = await fetchWithTimeout(`${base}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (testRes.ok) {
          res.json({ ok: true, status: 'connected', message: `Connected to ${provider} successfully!` });
        } else {
          const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
          res.status(400).json({ ok: false, status: statusForHttp(testRes.status), error: err.error?.message || `API returned ${testRes.status}` });
        }
      } else if (norm === 'gemini' || norm === 'google') {
        const base = baseUrl || 'https://generativelanguage.googleapis.com';
        const testRes = await fetchWithTimeout(`${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`, { method: 'GET' });
        if (testRes.ok) {
          res.json({ ok: true, status: 'connected', message: `Connected to ${model || 'Gemini'} successfully!` });
        } else {
          const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
          res.status(400).json({ ok: false, status: statusForHttp(testRes.status), error: err.error?.message || `API returned ${testRes.status}` });
        }
      } else if (norm === 'ollama') {
        const base = baseUrl || 'http://localhost:11434';
        const testRes = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' });
        if (testRes.ok) {
          res.json({ ok: true, status: 'connected', message: 'Connected to Ollama host successfully!' });
        } else {
          res.status(400).json({ ok: false, status: 'failed', error: `Ollama host returned ${testRes.status}` });
        }
      } else {
        // Provider without a live probe yet — accept the key, defer validation.
        res.json({ ok: true, status: 'connected', message: `API key saved for ${provider}. Live validation is not available for this provider yet.` });
      }
    } catch (inner: any) {
      if (inner?.name === 'AbortError') {
        res.status(504).json({ ok: false, status: 'timeout', error: `Connection timed out after ${TIMEOUT_MS / 1000}s` });
      } else {
        res.status(502).json({ ok: false, status: 'failed', error: inner?.message || 'Connection failed' });
      }
    }
  } catch (err: any) {
    res.status(500).json({ ok: false, status: 'failed', error: err.message || 'Connection test failed' });
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
