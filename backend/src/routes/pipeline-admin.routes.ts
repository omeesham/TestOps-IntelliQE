import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { loadPipelineDefinition, loadPipelineDefinitionForClient, savePipelineDefinition } from '../orchestrator/orchestrator.js';
import { getUsageStats, isWorkerConnected, getLastHeartbeat, setPendingWorkerCommand } from '../services/pipeline-queries.js';

const SCHEMA = '"JBSTestOpsAI"';
const router = Router();

// Pipeline administration is part of System Configuration, which is restricted
// to admin and QA-engineer roles. Block any other authenticated role from
// reading/writing pipeline config or controlling the worker.
router.use((req: Request, res: Response, next) => {
  const role = (req as any).user?.role;
  const isPlatform = (req as any).user?.isPlatform;
  if (isPlatform || role === 'admin' || role === 'qa_engineer') { next(); return; }
  res.status(403).json({ error: 'Forbidden' });
});

/** Reject values that could break out of a shell command (cmd.exe / POSIX metacharacters).
 *  Backslash and colon are allowed so Windows paths like C:\\tools\\claude.cmd still work. */
function isShellSafe(value: string): boolean {
  return !/[&|;<>^"'`$(){}\n\r]/.test(value);
}

/** Guard against SSRF: only allow http(s) to public hosts; block loopback,
 *  private, and link-local/metadata addresses. */
function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid base URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL must use http or https');
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||              // link-local / cloud metadata
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) ||      // IPv6 unique-local
    /^fe80:/.test(host);                       // IPv6 link-local
  if (blocked) throw new Error('Base URL host is not allowed');
  return url;
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
    const { provider, authMethod, apiKey, model, baseUrl, cliPath } = req.body;

    // Reject a user-supplied CLI path that could break out of the shell command.
    if (cliPath && (typeof cliPath !== 'string' || !isShellSafe(cliPath))) {
      res.status(400).json({ error: 'Invalid CLI path' });
      return;
    }
    // Reject a base URL that points at internal/private hosts (SSRF guard).
    if (baseUrl) {
      try { assertPublicHttpUrl(String(baseUrl)); }
      catch (e: any) { res.status(400).json({ error: e.message }); return; }
    }

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

    if (!apiKey && authMethod === 'api-key') { res.status(400).json({ error: 'API key is required' }); return; }

    if (provider === 'claude' || provider === 'anthropic') {
      // Test Anthropic API
      const testRes = await fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
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
        res.json({ ok: true, message: `Connected to ${model || 'Claude'} successfully!` });
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `API returned ${testRes.status}` });
      }
    } else if (provider === 'openai') {
      const testRes = await fetch(`${baseUrl || 'https://api.openai.com/v1'}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say hello in one word.' }],
        }),
      });
      if (testRes.ok) {
        res.json({ ok: true, message: `Connected to ${model || 'OpenAI'} successfully!` });
      } else {
        const err = await testRes.json().catch(() => ({ error: { message: 'Unknown error' } }));
        res.status(400).json({ error: err.error?.message || `API returned ${testRes.status}` });
      }
    } else {
      // For other providers, just validate the key format
      res.json({ ok: true, message: `API key saved for ${provider}. Connection test not implemented for this provider.` });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Connection test failed' });
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
