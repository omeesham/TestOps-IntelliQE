/**
 * api-mcp.service.ts
 * ──────────────────
 * MCP server surface. Exposes IntelliQE's API-testing capabilities as Model
 * Context Protocol tools so coding agents (Claude Code, Cursor, etc.) can call
 * them directly: probe an endpoint, import an OpenAPI spec into endpoints, run a
 * quick load test, list capture sessions, compute coverage gaps.
 *
 * Standalone and opt-in: each tool REUSES an existing service and the pipeline is
 * never involved. Access is gated by a per-tenant bearer token (its own table);
 * deleting the token revokes access. Implements the Streamable-HTTP JSON-RPC
 * subset MCP clients need: initialize, tools/list, tools/call.
 */
import { randomBytes } from 'crypto';
import pool from '../db.js';
import { fetchFull, buildRequestInit, type HttpEndpoint } from '../utils/api-http.js';
import { runLoadTest } from './api-loadtest.service.js';
import { listCaptureSessions } from './api-capture.service.js';
import { analyzeCoverageGaps } from './api-coverage-gaps.service.js';
import { importFromText, type ImportedEndpoint } from './api-import.service.js';
import { getTenantLlm } from './llm.service.js';

export interface McpToken {
  id: string;
  token: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function mapToken(r: any): McpToken {
  return { id: String(r.id), token: r.token, name: r.name || 'MCP token', createdBy: r.created_by || '', createdAt: r.created_at, lastUsedAt: r.last_used_at || null };
}

export async function listMcpTokens(tenantId: string): Promise<McpToken[]> {
  const { rows } = await pool.query(`SELECT * FROM api_mcp_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapToken);
}

export async function createMcpToken(tenantId: string, username: string, name: unknown): Promise<McpToken> {
  const clean = String(name || '').trim().slice(0, 200) || 'MCP token';
  const token = `mcp_${randomBytes(18).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO api_mcp_tokens (tenant_id, token, name, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`,
    [tenantId, token, clean, username || ''],
  );
  return mapToken(rows[0]);
}

export async function deleteMcpToken(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_mcp_tokens WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Resolve a token → tenantId (and touch last_used). null when unknown. */
export async function resolveMcpToken(token: string): Promise<string | null> {
  if (!token || !/^mcp_[a-f0-9]{36}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT tenant_id FROM api_mcp_tokens WHERE token = $1`, [token]);
  if (!rows.length) return null;
  await pool.query(`UPDATE api_mcp_tokens SET last_used_at = SYSUTCDATETIME() WHERE token = $1`, [token]).catch(() => {});
  return String(rows[0].tenant_id);
}

/* ── Tool registry ── */

export const MCP_TOOLS = [
  {
    name: 'probe_endpoint',
    description: 'Issue a single HTTP request to an API endpoint and return status, headers and a truncated body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method', default: 'GET' },
        url: { type: 'string', description: 'Absolute http(s) URL' },
        headers: { type: 'object', description: 'Optional request headers as a name→value map' },
        body: { type: 'string', description: 'Optional raw request body for write methods' },
      },
      required: ['url'],
    },
  },
  {
    name: 'import_openapi',
    description: 'Parse an OpenAPI/Swagger spec (JSON or YAML text) into a list of testable endpoints.',
    inputSchema: { type: 'object', properties: { spec: { type: 'string', description: 'The OpenAPI document text' } }, required: ['spec'] },
  },
  {
    name: 'load_test',
    description: 'Run a quick bounded load test against one endpoint and return latency percentiles and throughput.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', default: 'GET' },
        url: { type: 'string' },
        totalRequests: { type: 'number', description: '1–500', default: 50 },
        concurrency: { type: 'number', description: '1–50', default: 10 },
        allowWrites: { type: 'boolean', description: 'Required to load-test a write method' },
      },
      required: ['url'],
    },
  },
  { name: 'list_capture_sessions', description: 'List recorded traffic-capture sessions for the tenant.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'coverage_gaps',
    description: 'Compare a list of tested endpoints against recorded traffic and return the endpoints with real traffic but no test.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoints: { type: 'array', description: 'Tested endpoints: [{method,url}]', items: { type: 'object' } },
        sessionId: { type: 'string', description: 'Optional capture session id; omit to use all recordings' },
      },
    },
  },
];

function headerMap(raw: unknown): { key: string; value: string }[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).slice(0, 40).map(([k, v]) => ({ key: String(k), value: String(v ?? '') }));
}

async function callTool(tenantId: string, name: string, args: any): Promise<unknown> {
  args = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'probe_endpoint': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be an absolute http(s) URL');
      const ep: HttpEndpoint = { method: String(args.method || 'GET'), url, headers: headerMap(args.headers), body: typeof args.body === 'string' ? args.body : undefined };
      const { url: u, init } = buildRequestInit(ep);
      const r = await fetchFull(u, init);
      return { ok: r.ok, status: r.status, elapsedMs: r.elapsedMs, headers: r.headers, bodyPreview: r.bodyText.slice(0, 2000), error: r.error };
    }
    case 'import_openapi': {
      const spec = String(args.spec || '');
      if (spec.trim().length < 10) throw new Error('spec is empty');
      const llm = (await getTenantLlm(tenantId)) || undefined;
      const result = await importFromText(spec, { fileName: 'openapi', formatHint: 'openapi', llm, sourceMethod: 'openapi' });
      return { count: result.endpoints.length, parser: result.parser, format: result.format, endpoints: result.endpoints.slice(0, 200).map((e: ImportedEndpoint) => ({ method: e.method, url: e.url, title: e.title })) };
    }
    case 'load_test': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be an absolute http(s) URL');
      return runLoadTest({ endpoint: { method: String(args.method || 'GET'), url }, totalRequests: Number(args.totalRequests) || 50, concurrency: Number(args.concurrency) || 10, allowWrites: !!args.allowWrites });
    }
    case 'list_capture_sessions':
      return { sessions: await listCaptureSessions(tenantId) };
    case 'coverage_gaps': {
      const tested: ImportedEndpoint[] = (Array.isArray(args.endpoints) ? args.endpoints : [])
        .filter((e: any) => e && /^https?:\/\//i.test(String(e.url || '')))
        .map((e: any) => ({ title: `${e.method || 'GET'} ${e.url}`, method: String(e.method || 'GET'), url: String(e.url), headers: [], auth: { type: 'none' } }));
      return analyzeCoverageGaps(tenantId, tested, typeof args.sessionId === 'string' ? args.sessionId : undefined);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Handle one JSON-RPC request object; returns the response object (or null for notifications). */
export async function handleMcpRpc(tenantId: string, msg: any): Promise<any | null> {
  const id = msg?.id;
  const method = String(msg?.method || '');
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const errorReply = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'IntelliQE API Automation', version: '1.0.0' },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null; // no response to notifications
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: MCP_TOOLS });
    if (method === 'tools/call') {
      const name = String(msg?.params?.name || '');
      try {
        const out = await callTool(tenantId, name, msg?.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    return errorReply(-32601, `Method not found: ${method}`);
  } catch (err) {
    return errorReply(-32603, (err as Error).message);
  }
}
