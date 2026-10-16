/**
 * api-apitest-connectors.service.ts
 * ─────────────────────────────────
 * Native API-testing tool connectors for the catalogue's "API Testing" section:
 * Postman, SoapUI / ReadyAPI, Insomnia, Bruno, Hoppscotch, Karate, REST Assured
 * and Pact. These tools do not share one connection model, so each connector
 * carries a `kind`:
 *
 *   • apikey  (Postman)          — Postman API key; lists the workspaces/collections.
 *   • broker  (Pact)             — Pact Broker URL + Bearer token or Basic auth; lists pacts.
 *   • git     (the rest)         — the tool's collections / test files live in a Git
 *                                  repo, so the connection is a Git host (GitHub or
 *                                  GitLab) + token; "connect to the repos" lists the
 *                                  repositories the token can see.
 *
 * Mirrors api-cicd-connectors.service.ts: its own table
 * (`api_apitest_connectors`), every query filtered by `tenant_id`, credentials
 * encrypted at rest and never returned, every provider call guarded.
 */
import pool from '../db.js';
import { encryptAtRest, decryptStored } from '../utils/crypto.js';
import { fetchFull } from '../utils/api-http.js';

export type ApiTestVendor =
  | 'postman' | 'soapui' | 'insomnia' | 'bruno' | 'hoppscotch' | 'karate' | 'restassured' | 'pact';
const VENDORS: ApiTestVendor[] = ['postman', 'soapui', 'insomnia', 'bruno', 'hoppscotch', 'karate', 'restassured', 'pact'];
export const VENDOR_LABELS: Record<ApiTestVendor, string> = {
  postman: 'Postman', soapui: 'SoapUI / ReadyAPI', insomnia: 'Insomnia', bruno: 'Bruno',
  hoppscotch: 'Hoppscotch', karate: 'Karate', restassured: 'REST Assured', pact: 'Pact',
};

/** How a given vendor connects. */
export type ApiTestKind = 'apikey' | 'broker' | 'git';
const VENDOR_KIND: Record<ApiTestVendor, ApiTestKind> = {
  postman: 'apikey', pact: 'broker',
  soapui: 'git', insomnia: 'git', bruno: 'git', hoppscotch: 'git', karate: 'git', restassured: 'git',
};
export function vendorKind(v: ApiTestVendor): ApiTestKind { return VENDOR_KIND[v] || 'git'; }

export type GitHost = 'github' | 'gitlab';
const GIT_HOSTS: GitHost[] = ['github', 'gitlab'];

/** A repository / collection / pact linked from the provider. */
export interface ApiTestRepo { id: string; name: string; url: string }

export interface ApiTestConnector {
  id: string; vendor: ApiTestVendor; kind: ApiTestKind; name: string; baseUrl: string; orgKey: string;
  gitHost: GitHost | ''; enabled: boolean; authFields: string[]; linkedRepos: ApiTestRepo[];
  createdBy: string; createdAt: string; updatedAt: string;
}

const DEFAULT_BASE: Record<ApiTestVendor, string> = {
  postman: 'https://api.getpostman.com',
  pact: '', // tenant-specific broker, e.g. https://acme.pactflow.io
  soapui: '', insomnia: '', bruno: '', hoppscotch: '', karate: '', restassured: '',
};
const GIT_DEFAULT_BASE: Record<GitHost, string> = { github: 'https://api.github.com', gitlab: 'https://gitlab.com' };

function readAuth(r: any): Record<string, string> {
  if (!r.auth) return {};
  try { return JSON.parse(decryptStored(String(r.auth))) || {}; } catch { return {}; }
}
function readRepos(r: any): ApiTestRepo[] {
  if (!r.linked_repos) return [];
  try {
    const parsed = typeof r.linked_repos === 'string' ? JSON.parse(r.linked_repos) : r.linked_repos;
    return Array.isArray(parsed) ? parsed.filter((x: any) => x && x.id).map((x: any) => ({ id: String(x.id), name: String(x.name || x.id), url: String(x.url || '') })) : [];
  } catch { return []; }
}
function toConnector(r: any): ApiTestConnector {
  const auth = readAuth(r);
  const vendor = (VENDORS.includes(r.vendor) ? r.vendor : 'postman') as ApiTestVendor;
  const gitHost = GIT_HOSTS.includes(r.git_host) ? (r.git_host as GitHost) : '';
  return {
    id: String(r.id), vendor, kind: vendorKind(vendor),
    name: r.name || '', baseUrl: r.base_url || '', orgKey: r.org_key || '', gitHost,
    enabled: r.enabled === true || r.enabled === 1,
    authFields: Object.keys(auth).filter((k) => auth[k]),
    linkedRepos: readRepos(r),
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const MASK = /•/;
function cleanAuthInput(obj: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v && !MASK.test(v)) out[String(k).slice(0, 40)] = v.slice(0, 2000);
    }
  }
  return out;
}
function cleanRepoInput(arr: any): ApiTestRepo[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && x.id !== undefined && x.id !== null && String(x.id))
    .slice(0, 200)
    .map((x) => ({ id: String(x.id).slice(0, 300), name: String(x.name || x.id).slice(0, 300), url: String(x.url || '').slice(0, 1000) }));
}

async function loadRow(tenantId: string, id: string): Promise<any | null> {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT * FROM api_apitest_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? rows[0] : null;
}

export async function listConnectors(tenantId: string): Promise<ApiTestConnector[]> {
  const { rows } = await pool.query(`SELECT * FROM api_apitest_connectors WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toConnector);
}

export async function saveConnector(tenantId: string, username: string, input: any): Promise<ApiTestConnector> {
  const vendor: ApiTestVendor = VENDORS.includes(input?.vendor) ? input.vendor : 'postman';
  const name = String(input?.name || '').trim().slice(0, 200) || VENDOR_LABELS[vendor];
  const baseUrl = String(input?.baseUrl || '').trim().slice(0, 500) || DEFAULT_BASE[vendor];
  const orgKey = String(input?.orgKey || '').trim().slice(0, 200);
  const gitHost: GitHost | '' = vendorKind(vendor) === 'git' ? (GIT_HOSTS.includes(input?.gitHost) ? input.gitHost : 'github') : '';
  const enabled = input?.enabled !== false;
  const provided = cleanAuthInput(input?.auth);

  if (input?.id) {
    const existing = await loadRow(tenantId, String(input.id));
    if (!existing) throw new Error('Connector not found.');
    const merged = { ...readAuth(existing), ...provided };
    const repos = Array.isArray(input?.linkedRepos) ? cleanRepoInput(input.linkedRepos) : readRepos(existing);
    const { rows } = await pool.query(
      `UPDATE api_apitest_connectors SET vendor = $3, name = $4, base_url = $5, org_key = $6, git_host = $7, auth = $8, linked_repos = $9, enabled = $10, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, vendor, name, baseUrl, orgKey, gitHost, encryptAtRest(JSON.stringify(merged)), JSON.stringify(repos), enabled],
    );
    return toConnector(rows[0]);
  }
  const repos = cleanRepoInput(input?.linkedRepos);
  const { rows } = await pool.query(
    `INSERT INTO api_apitest_connectors (tenant_id, vendor, name, base_url, org_key, git_host, auth, linked_repos, enabled, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, vendor, name, baseUrl, orgKey, gitHost, encryptAtRest(JSON.stringify(provided)), JSON.stringify(repos), enabled, username],
  );
  return toConnector(rows[0]);
}

export async function deleteConnector(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_apitest_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── provider plumbing ──────────────────────────────────────────────────────

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const UA = 'IntelliQE-APITest-Connector';
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }

function githubApiBase(baseUrl: string): string {
  const b = trimSlash(baseUrl || GIT_DEFAULT_BASE.github);
  if (/api\.github\.com$/i.test(b) || /\/api\/v3$/i.test(b)) return b;
  if (/github\.com$/i.test(b)) return 'https://api.github.com';
  return `${b}/api/v3`;
}

export interface ApiTestTestResult { ok: boolean; detail: string }

/** Lightweight connection check per vendor. */
export async function testConnector(tenantId: string, id: string): Promise<ApiTestTestResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  try {
    if (c.vendor === 'postman') {
      const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.postman)}/me`, { method: 'GET', headers: { 'X-Api-Key': auth.apiKey || '', accept: 'application/json' } }, 20_000, 2000);
      const user = safeJson(r.bodyText)?.user;
      return r.ok ? { ok: true, detail: `Authenticated with Postman${user?.username ? ` as ${user.username}` : ''}.` } : { ok: false, detail: `Postman returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    if (c.vendor === 'pact') {
      if (!c.baseUrl) throw new Error('Set the Pact Broker URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/`, { method: 'GET', headers: { ...pactAuthHeader(auth), accept: 'application/hal+json' } }, 20_000, 2000);
      return r.ok ? { ok: true, detail: 'Authenticated with the Pact Broker.' } : { ok: false, detail: `Pact Broker returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    // git-backed vendors
    return await testGit(c, auth);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

function pactAuthHeader(auth: Record<string, string>): Record<string, string> {
  if (auth.token) return { Authorization: `Bearer ${auth.token}` };
  if (auth.username || auth.password) return { Authorization: basic(auth.username || '', auth.password || '') };
  return {};
}

async function testGit(c: ApiTestConnector, auth: Record<string, string>): Promise<ApiTestTestResult> {
  const host = c.gitHost || 'github';
  if (host === 'github') {
    const r = await fetchFull(`${githubApiBase(c.baseUrl)}/user`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}`, accept: 'application/vnd.github+json', 'user-agent': UA } }, 20_000, 2000);
    const login = safeJson(r.bodyText)?.login;
    return r.ok ? { ok: true, detail: `Authenticated with GitHub${login ? ` as ${login}` : ''}.` } : { ok: false, detail: `GitHub returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
  }
  const r = await fetchFull(`${trimSlash(c.baseUrl || GIT_DEFAULT_BASE.gitlab)}/api/v4/user`, { method: 'GET', headers: { 'PRIVATE-TOKEN': auth.token || '', accept: 'application/json' } }, 20_000, 2000);
  const uname = safeJson(r.bodyText)?.username;
  return r.ok ? { ok: true, detail: `Authenticated with GitLab${uname ? ` as ${uname}` : ''}.` } : { ok: false, detail: `GitLab returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
}

export interface ApiTestReposResult { ok: boolean; detail: string; repos: ApiTestRepo[] }

/** List what the credentials can see: Postman collections, Pact pacts, or Git repos. */
export async function listRepos(tenantId: string, id: string, limit = 100): Promise<ApiTestReposResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  try {
    if (c.vendor === 'postman') {
      const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.postman)}/collections`, { method: 'GET', headers: { 'X-Api-Key': auth.apiKey || '', accept: 'application/json' } }, 30_000, 400_000);
      if (!r.ok) return { ok: false, detail: `Postman returned ${r.status || 'no status'}.`, repos: [] };
      const cols = safeJson(r.bodyText)?.collections || [];
      const repos: ApiTestRepo[] = cols.slice(0, cap).map((x: any) => ({ id: String(x.uid || x.id || ''), name: String(x.name || ''), url: `https://go.postman.co/collection/${encodeURIComponent(String(x.uid || x.id || ''))}` }));
      return { ok: true, detail: `Found ${repos.length} Postman collection(s).`, repos };
    }
    if (c.vendor === 'pact') {
      if (!c.baseUrl) throw new Error('Set the Pact Broker URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/pacts/latest`, { method: 'GET', headers: { ...pactAuthHeader(auth), accept: 'application/hal+json' } }, 30_000, 400_000);
      if (!r.ok) return { ok: false, detail: `Pact Broker returned ${r.status || 'no status'}.`, repos: [] };
      const pacts = safeJson(r.bodyText)?.pacts || [];
      const repos: ApiTestRepo[] = pacts.slice(0, cap).map((p: any) => {
        const consumer = p?._links?.['pb:consumer']?.name || p?._embedded?.consumer?.name || '';
        const provider = p?._links?.['pb:provider']?.name || p?._embedded?.provider?.name || '';
        const href = p?._links?.self?.href || '';
        const name = consumer && provider ? `${consumer} → ${provider}` : (consumer || provider || 'pact');
        return { id: href || name, name, url: String(href || '') };
      });
      return { ok: true, detail: `Found ${repos.length} pact(s).`, repos };
    }
    // git-backed vendors
    return await listGitRepos(c, auth, cap);
  } catch (e) {
    return { ok: false, detail: (e as Error).message, repos: [] };
  }
}

async function listGitRepos(c: ApiTestConnector, auth: Record<string, string>, cap: number): Promise<ApiTestReposResult> {
  const host = c.gitHost || 'github';
  if (host === 'github') {
    const base = githubApiBase(c.baseUrl);
    const perPage = Math.min(cap, 100);
    const url = c.orgKey
      ? `${base}/orgs/${encodeURIComponent(c.orgKey)}/repos?per_page=${perPage}&sort=updated`
      : `${base}/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`;
    const r = await fetchFull(url, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}`, accept: 'application/vnd.github+json', 'user-agent': UA } }, 30_000, 400_000);
    if (!r.ok) return { ok: false, detail: `GitHub returned ${r.status || 'no status'}.`, repos: [] };
    const arr = safeJson(r.bodyText) || [];
    const repos: ApiTestRepo[] = (Array.isArray(arr) ? arr : []).slice(0, cap).map((x: any) => ({ id: String(x.full_name || x.id || ''), name: String(x.full_name || x.name || ''), url: String(x.html_url || '') }));
    return { ok: true, detail: `Found ${repos.length} GitHub repo(s).`, repos };
  }
  const base = trimSlash(c.baseUrl || GIT_DEFAULT_BASE.gitlab);
  const perPage = Math.min(cap, 100);
  const url = c.orgKey
    ? `${base}/api/v4/groups/${encodeURIComponent(c.orgKey)}/projects?per_page=${perPage}&order_by=last_activity_at`
    : `${base}/api/v4/projects?membership=true&per_page=${perPage}&order_by=last_activity_at`;
  const r = await fetchFull(url, { method: 'GET', headers: { 'PRIVATE-TOKEN': auth.token || '', accept: 'application/json' } }, 30_000, 400_000);
  if (!r.ok) return { ok: false, detail: `GitLab returned ${r.status || 'no status'}.`, repos: [] };
  const arr = safeJson(r.bodyText) || [];
  const repos: ApiTestRepo[] = (Array.isArray(arr) ? arr : []).slice(0, cap).map((x: any) => ({ id: String(x.id || ''), name: String(x.path_with_namespace || x.name || ''), url: String(x.web_url || '') }));
  return { ok: true, detail: `Found ${repos.length} GitLab project(s).`, repos };
}
