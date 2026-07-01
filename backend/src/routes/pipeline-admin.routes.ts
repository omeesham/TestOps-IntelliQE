import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { loadPipelineDefinition, loadPipelineDefinitionForClient, savePipelineDefinition } from '../orchestrator/orchestrator.js';
import { getUsageStats, isWorkerConnected, getLastHeartbeat, setPendingWorkerCommand } from '../services/pipeline-queries.js';

const SCHEMA = '"JBSTestOpsAI"';
const router = Router();

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
    const { provider, authMethod, apiKey, model, baseUrl, cliPath } = req.body;

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
  }
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
