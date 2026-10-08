/**
 * api-mcp-public.routes.ts
 * ────────────────────────
 * PUBLIC MCP endpoint. Mounted at /mcp (in index.ts, OUTSIDE auth) so an MCP
 * client (Claude Code, Cursor, …) can reach IntelliQE's tools with just its
 * per-tenant token — the unguessable :token is the capability. The token
 * resolves to a tenant, and every tool runs scoped to that tenant.
 *
 *   POST /mcp/:token   → JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /mcp/:token   → a small human-readable info payload
 *
 * Never reads a login session; the pipeline is never involved.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveMcpToken, handleMcpRpc, MCP_TOOLS } from '../services/api-mcp.service.js';

const router = Router();

router.get('/:token', async (req: Request, res: Response) => {
  const tenantId = await resolveMcpToken(String(req.params.token || ''));
  if (!tenantId) { res.status(404).json({ error: 'Unknown MCP token.' }); return; }
  res.json({
    server: 'IntelliQE API Automation (MCP)',
    transport: 'streamable-http (JSON-RPC over POST)',
    tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    hint: 'POST JSON-RPC messages to this same URL.',
  });
});

router.post('/:token', async (req: Request, res: Response) => {
  const tenantId = await resolveMcpToken(String(req.params.token || ''));
  if (!tenantId) { res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown MCP token.' } }); return; }
  try {
    const body = req.body;
    // Support a JSON-RPC batch (array) as well as a single message.
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMcpRpc(tenantId, m)))).filter((r) => r !== null);
      res.json(out);
      return;
    }
    const result = await handleMcpRpc(tenantId, body);
    if (result === null) { res.status(202).end(); return; } // notification → no content
    res.json(result);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: (err as Error).message } });
  }
});

export default router;
