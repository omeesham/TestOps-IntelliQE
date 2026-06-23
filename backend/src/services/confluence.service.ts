/**
 * confluence.service.ts
 * ─────────────────────
 * Confluence Cloud REST v2 client. Mirrors the jira.service.ts pattern:
 *   • Credentials read from `client_configurations` for the tenant.
 *   • Basic-auth header built from email + API token.
 *   • Two functional endpoints: list pages and get a single page as
 *     plain text (storage-format HTML → htmlToPlain conversion).
 *
 * Public Confluence Cloud API:
 *   GET /wiki/rest/api/content?type=page&expand=body.storage,version,space&limit=50
 *   GET /wiki/rest/api/content/{id}?expand=body.storage,version,space
 *   GET /wiki/rest/api/space    (for the space picker)
 *
 * Self-hosted Confluence Data Center uses the same paths under /wiki
 * or directly at /rest/api — we try the cloud path first and fall back
 * if it 404s.
 */
import axios from 'axios';
import pool from '../db.js';
import { decryptConfigData } from '../utils/crypto.js';

export interface ConfluenceCreds {
  /** Full wiki base URL — e.g., https://acme.atlassian.net/wiki */
  baseUrl: string;
  /** Basic auth header value, "Basic <base64(email:token)>" */
  authHeader: string;
}

export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceKey?: string;
  spaceName?: string;
  /** ISO timestamp of last update */
  updatedAt?: string;
  url?: string;
}

export interface ConfluencePageDetails {
  id: string;
  title: string;
  /** Storage-format HTML converted to clean plain text */
  body: string;
  spaceKey?: string;
  spaceName?: string;
}

// ───── DB helpers (tenant-scoped) ─────

export async function getCredsForTenant(tenantId: string): Promise<ConfluenceCreds | null> {
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'confluence' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  const cfg = decryptConfigData(rows[0].config_data);
  const url = String(cfg.url || cfg.confluence_url || '').trim().replace(/\/$/, '');
  if (!url) return null;
  const email = String(cfg.email || '').trim();
  const token = String(cfg.api_token || cfg.apiToken || '').trim();
  if (!email || !token) return null;
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  // Always include /wiki for the API path — most Cloud URLs end with /wiki already
  // but users sometimes paste the root URL. Normalise without doubling.
  const baseUrl = /\/wiki$/i.test(url) ? url : `${url}/wiki`;
  return { baseUrl, authHeader };
}

export async function getConnectionStatus(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT config_data, connected_by, connected_at, last_sync_at
       FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'confluence' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return { connected: false };
  const cfg = decryptConfigData(rows[0].config_data);
  return {
    connected: true,
    url: cfg.url,
    email: cfg.email,
    connectedBy: rows[0].connected_by,
    connectedAt: rows[0].connected_at,
    lastSyncAt: rows[0].last_sync_at,
  };
}

// ───── HTTP helper ─────

async function request<T>(creds: ConfluenceCreds, path: string, params?: Record<string, any>): Promise<T> {
  const url = `${creds.baseUrl}${path}`;
  const resp = await axios.get<T>(url, {
    params,
    headers: { Authorization: creds.authHeader, Accept: 'application/json' },
    timeout: 30_000,
  });
  return resp.data;
}

// ───── HTML → plain text helpers (shared shape with jira.service) ─────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function htmlToPlain(html: string): string {
  if (!html) return '';
  let out = html;
  // Confluence storage format adds <ac:*> macros — strip them as best we can.
  out = out.replace(/<ac:structured-macro[^>]*name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, body) => {
    const plain = body.replace(/<[^>]+>/g, '').trim();
    return '\n```\n' + plain + '\n```\n';
  });
  out = out.replace(/<ac:[^>]+\/>/gi, '');
  out = out.replace(/<\/?ac:[^>]+>/gi, '');
  out = out.replace(/<\/?ri:[^>]+>/gi, '');
  // Standard HTML structure
  out = out.replace(/<\/li>\s*<li>/gi, '</li>\n<li>');
  out = out.replace(/<li[^>]*>/gi, '\n- ');
  out = out.replace(/<\/li>/gi, '');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  out = out.replace(/<p[^>]*>/gi, '');
  out = out.replace(/<\/p>/gi, '\n');
  out = out.replace(/<h[1-6][^>]*>/gi, '\n\n## ');
  out = out.replace(/<\/h[1-6]>/gi, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeHtmlEntities(out)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

// ───── Public API ─────

/** Verify the supplied credentials by hitting the lightweight `/space` endpoint. */
export async function testConnection(creds: ConfluenceCreds): Promise<{ accountName?: string; spaceCount: number }> {
  const data = await request<any>(creds, '/rest/api/space', { limit: 1 });
  return { spaceCount: data?.size ?? (data?.results?.length ?? 0) };
}

/**
 * List recent Confluence pages, newest first. Returns up to 50 entries.
 * If `spaceKey` is provided, results are restricted to that space.
 */
export async function listPages(creds: ConfluenceCreds, spaceKey?: string): Promise<ConfluencePageSummary[]> {
  const params: Record<string, any> = {
    type: 'page',
    limit: 50,
    expand: 'version,space',
    orderby: '-modified',
  };
  if (spaceKey) params.spaceKey = spaceKey;
  const data = await request<any>(creds, '/rest/api/content', params);
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results.map((p) => ({
    id: String(p.id),
    title: String(p.title || ''),
    spaceKey: p.space?.key,
    spaceName: p.space?.name,
    updatedAt: p.version?.when,
    url: p._links?.webui ? `${creds.baseUrl}${p._links.webui}` : undefined,
  }));
}

/** Fetch a single page and convert its storage-format body to plain text. */
export async function getPage(creds: ConfluenceCreds, pageId: string): Promise<ConfluencePageDetails> {
  const data = await request<any>(creds, `/rest/api/content/${encodeURIComponent(pageId)}`, {
    expand: 'body.storage,version,space',
  });
  const storage = data?.body?.storage?.value || '';
  return {
    id: String(data.id),
    title: String(data.title || ''),
    body: htmlToPlain(storage),
    spaceKey: data.space?.key,
    spaceName: data.space?.name,
  };
}
