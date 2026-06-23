/**
 * sharepoint.service.ts
 * ─────────────────────
 * Microsoft Graph integration for SharePoint document libraries.
 *
 * Authentication flow:
 *   1. Read tenantId + clientId + clientSecret from the user's connected
 *      `sharepoint` integration in `client_configurations`.
 *   2. Create an @azure/identity `ClientSecretCredential` (app-only auth,
 *      a.k.a. "daemon" flow — no user interaction).
 *   3. Wrap the credential in a Graph SDK `Client` for typed API access.
 *
 * Functional endpoints exposed to callers:
 *   - testConnection(creds): GET /sites/{siteId} (validates auth + site access)
 *   - listDocuments(creds): list files in the site's default Document library
 *   - getDocument(creds, itemId): download the file and reuse the
 *     existing document-parser to extract plain text.
 *
 * Required Graph permissions (Application, admin-consented):
 *   - Sites.Read.All   (list site + drive items)
 *   - Files.Read.All   (download item content)
 */
import { ClientSecretCredential } from '@azure/identity';
import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import pool from '../db.js';
import { decryptConfigData } from '../utils/crypto.js';
import { parseDocument } from './document-parser.service.js';

export interface SharePointCreds {
  /** Azure AD directory (tenant) ID — GUID */
  tenantId: string;
  /** Application (client) ID — GUID */
  clientId: string;
  /** Client secret — decrypted */
  clientSecret: string;
  /** Full SharePoint site URL, e.g., https://acme.sharepoint.com/sites/QA */
  siteUrl: string;
}

export interface SharePointDocSummary {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  lastModified?: string;
  mimeType?: string;
}

export interface SharePointDocDetails {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Extracted plain text (via document-parser.service) */
  text: string;
  pageCount?: number;
  warning?: string;
  webUrl?: string;
}

// ───── DB helpers (tenant-scoped) ─────

export async function getCredsForTenant(tenantId: string): Promise<SharePointCreds | null> {
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'sharepoint' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return null;
  const cfg = decryptConfigData(rows[0].config_data);
  // The integration catalog stores: siteUrl, clientId, clientSecret. We also
  // honour a tenantId field that the catalog form added in this release.
  const siteUrl = String(cfg.siteUrl || cfg.site_url || '').trim();
  const clientId = String(cfg.clientId || cfg.client_id || '').trim();
  const clientSecret = String(cfg.clientSecret || cfg.client_secret || '').trim();
  const aadTenantId = String(cfg.tenantId || cfg.tenant_id || cfg.aadTenantId || '').trim();
  if (!siteUrl || !clientId || !clientSecret || !aadTenantId) return null;
  return { tenantId: aadTenantId, clientId, clientSecret, siteUrl };
}

export async function getConnectionStatus(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT config_data, connected_by, connected_at, last_sync_at
       FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'sharepoint' AND status = 'connected'`,
    [tenantId],
  );
  if (rows.length === 0) return { connected: false };
  const cfg = decryptConfigData(rows[0].config_data);
  return {
    connected: true,
    siteUrl: cfg.siteUrl || cfg.site_url,
    connectedBy: rows[0].connected_by,
    connectedAt: rows[0].connected_at,
    lastSyncAt: rows[0].last_sync_at,
  };
}

// ───── Graph client factory ─────

function buildClient(creds: SharePointCreds): Client {
  const credential = new ClientSecretCredential(creds.tenantId, creds.clientId, creds.clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return Client.initWithMiddleware({ authProvider });
}

/**
 * Resolve `siteUrl` to a Graph site ID. The Graph "siteId" looks like:
 *     {hostname},{site-collection-id},{site-id}
 * The simplest way to get it is to call /sites/{hostname}:/{server-relative-path}
 * which returns the full object including its id.
 */
async function resolveSiteId(client: Client, siteUrl: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(siteUrl); } catch { throw new Error(`Invalid SharePoint site URL: ${siteUrl}`); }
  const host = parsed.host;
  // Strip "/sites/<name>" etc.  Graph expects the server-relative path WITHOUT a leading slash.
  const serverPath = parsed.pathname.replace(/^\/+/, '');
  // /sites/{hostname}:/{server-relative-path}   — note the literal ":" separator
  const endpoint = serverPath ? `/sites/${host}:/${serverPath}` : `/sites/${host}`;
  const site = await client.api(endpoint).get();
  if (!site?.id) throw new Error(`Could not resolve SharePoint site: ${siteUrl}`);
  return site.id as string;
}

// ───── Public API ─────

/** Verify creds + site access in one round-trip. */
export async function testConnection(creds: SharePointCreds): Promise<{ siteId: string; siteName?: string; webUrl?: string }> {
  const client = buildClient(creds);
  const siteId = await resolveSiteId(client, creds.siteUrl);
  const site = await client.api(`/sites/${siteId}`).get();
  return { siteId, siteName: site?.displayName, webUrl: site?.webUrl };
}

/**
 * List up to 50 files (recently modified first) in the site's default
 * document library. Folders are excluded from results since the
 * downstream parser only handles files.
 */
export async function listDocuments(creds: SharePointCreds): Promise<SharePointDocSummary[]> {
  const client = buildClient(creds);
  const siteId = await resolveSiteId(client, creds.siteUrl);

  // Use search inside the drive so we get recently-modified order.
  // /sites/{siteId}/drive/root/search(q='') returns all items.
  const res = await client
    .api(`/sites/${siteId}/drive/root/children`)
    .top(50)
    .orderby('lastModifiedDateTime desc')
    .get();

  const items: any[] = Array.isArray(res?.value) ? res.value : [];
  return items
    .filter((it) => it && it.file)   // exclude folders
    .map((it) => ({
      id: String(it.id),
      name: String(it.name || ''),
      webUrl: it.webUrl,
      size: typeof it.size === 'number' ? it.size : undefined,
      lastModified: it.lastModifiedDateTime,
      mimeType: it.file?.mimeType,
    }));
}

/**
 * Fetch a single file and extract its plain text using the document
 * parser. Supports the same formats as the upload endpoint:
 * PDF, DOCX, TXT, MD.
 */
export async function getDocument(creds: SharePointCreds, itemId: string): Promise<SharePointDocDetails> {
  const client = buildClient(creds);
  const siteId = await resolveSiteId(client, creds.siteUrl);

  // Get metadata so we have the original file name + mimetype for the parser.
  const meta: any = await client.api(`/sites/${siteId}/drive/items/${itemId}`).get();
  if (!meta?.file) throw new Error(`SharePoint item is not a file: ${itemId}`);

  // Download the content as a Buffer.
  const stream: any = await client.api(`/sites/${siteId}/drive/items/${itemId}/content`).getStream();
  const buffer = await streamToBuffer(stream);

  const parsed = await parseDocument(buffer, meta.file.mimeType || '', meta.name || itemId);
  return {
    id: String(meta.id),
    name: String(meta.name || ''),
    mimeType: meta.file.mimeType || 'application/octet-stream',
    sizeBytes: typeof meta.size === 'number' ? meta.size : buffer.length,
    text: parsed.text,
    pageCount: parsed.pageCount,
    warning: parsed.warning,
    webUrl: meta.webUrl,
  };
}

/** Collect a Node Readable / web stream into a single Buffer. */
async function streamToBuffer(stream: any): Promise<Buffer> {
  // The Graph SDK can return either a Node Readable or a web ReadableStream
  // depending on the runtime. Handle both.
  if (stream && typeof stream.on === 'function') {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer | Uint8Array) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(stream)) return stream;
  throw new Error('Unsupported stream type returned by Graph SDK');
}
