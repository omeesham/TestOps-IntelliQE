/**
 * api-cicd-connectors.service.ts
 * ──────────────────────────────
 * Native CI/CD pipeline connectors: Jenkins, GitHub Actions, GitLab CI,
 * Azure Pipelines and CircleCI. Each tenant can register one or more
 * connectors (base/instance URL + an org/workspace + credentials, encrypted
 * at rest). From a connector we can TEST the credentials against the provider's
 * REST API and LIST the user's repositories / projects / jobs so they can be
 * linked to IntelliQE for pipeline-triggered testing.
 *
 * Mirrors api-tm-connectors.service.ts deliberately — its own table
 * (`api_cicd_connectors`), every DB query filtered by `tenant_id`, every
 * provider call guarded so a provider outage or auth error returns a clean
 * result rather than throwing. Credentials are only ever stored (never
 * returned); responses expose which credential keys are set, not their values.
 */
import pool from '../db.js';
import { encryptAtRest, decryptStored } from '../utils/crypto.js';
import { fetchFull } from '../utils/api-http.js';

export type CiVendor = 'jenkins' | 'github' | 'gitlab' | 'azuredevops' | 'circleci';
const VENDORS: CiVendor[] = ['jenkins', 'github', 'gitlab', 'azuredevops', 'circleci'];
export const VENDOR_LABELS: Record<CiVendor, string> = {
  jenkins: 'Jenkins', github: 'GitHub Actions', gitlab: 'GitLab CI',
  azuredevops: 'Azure Pipelines', circleci: 'CircleCI',
};

/** A repository / project / job linked from the provider. */
export interface CiRepo { id: string; name: string; url: string }

export interface CiConnector {
  id: string; vendor: CiVendor; name: string; baseUrl: string; orgKey: string;
  enabled: boolean; authFields: string[]; // which credential keys are set (never values)
  linkedRepos: CiRepo[];
  createdBy: string; createdAt: string; updatedAt: string;
}

/** Sensible default endpoints — the SaaS providers need no base URL. */
const DEFAULT_BASE: Record<CiVendor, string> = {
  jenkins: '', // tenant-specific, e.g. https://jenkins.acme.com
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com',
  azuredevops: '', // tenant-specific, e.g. https://dev.azure.com/acme
  circleci: 'https://circleci.com',
};

function readAuth(r: any): Record<string, string> {
  if (!r.auth) return {};
  try { return JSON.parse(decryptStored(String(r.auth))) || {}; } catch { return {}; }
}
function readRepos(r: any): CiRepo[] {
  if (!r.linked_repos) return [];
  try {
    const parsed = typeof r.linked_repos === 'string' ? JSON.parse(r.linked_repos) : r.linked_repos;
    return Array.isArray(parsed) ? parsed.filter((x: any) => x && x.id).map((x: any) => ({ id: String(x.id), name: String(x.name || x.id), url: String(x.url || '') })) : [];
  } catch { return []; }
}
function toConnector(r: any): CiConnector {
  const auth = readAuth(r);
  return {
    id: String(r.id), vendor: (VENDORS.includes(r.vendor) ? r.vendor : 'jenkins') as CiVendor,
    name: r.name || '', baseUrl: r.base_url || '', orgKey: r.org_key || '',
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
function cleanRepoInput(arr: any): CiRepo[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && (x.id !== undefined && x.id !== null && String(x.id)))
    .slice(0, 200)
    .map((x) => ({ id: String(x.id).slice(0, 300), name: String(x.name || x.id).slice(0, 300), url: String(x.url || '').slice(0, 1000) }));
}

async function loadRow(tenantId: string, id: string): Promise<any | null> {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT * FROM api_cicd_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? rows[0] : null;
}

export async function listConnectors(tenantId: string): Promise<CiConnector[]> {
  const { rows } = await pool.query(`SELECT * FROM api_cicd_connectors WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toConnector);
}

export async function saveConnector(tenantId: string, username: string, input: any): Promise<CiConnector> {
  const vendor: CiVendor = VENDORS.includes(input?.vendor) ? input.vendor : 'jenkins';
  const name = String(input?.name || '').trim().slice(0, 200) || VENDOR_LABELS[vendor];
  const baseUrl = String(input?.baseUrl || '').trim().slice(0, 500) || DEFAULT_BASE[vendor];
  const orgKey = String(input?.orgKey || '').trim().slice(0, 200);
  const enabled = input?.enabled !== false;
  const provided = cleanAuthInput(input?.auth);

  if (input?.id) {
    const existing = await loadRow(tenantId, String(input.id));
    if (!existing) throw new Error('Connector not found.');
    const merged = { ...readAuth(existing), ...provided }; // partial update keeps untouched secrets
    // linkedRepos: only replace when the caller sends an array (keeps the stored selection otherwise)
    const repos = Array.isArray(input?.linkedRepos) ? cleanRepoInput(input.linkedRepos) : readRepos(existing);
    const { rows } = await pool.query(
      `UPDATE api_cicd_connectors SET vendor = $3, name = $4, base_url = $5, org_key = $6, auth = $7, linked_repos = $8, enabled = $9, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, vendor, name, baseUrl, orgKey, encryptAtRest(JSON.stringify(merged)), JSON.stringify(repos), enabled],
    );
    return toConnector(rows[0]);
  }
  const repos = cleanRepoInput(input?.linkedRepos);
  const { rows } = await pool.query(
    `INSERT INTO api_cicd_connectors (tenant_id, vendor, name, base_url, org_key, auth, linked_repos, enabled, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, vendor, name, baseUrl, orgKey, encryptAtRest(JSON.stringify(provided)), JSON.stringify(repos), enabled, username],
  );
  return toConnector(rows[0]);
}

export async function deleteConnector(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_cicd_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── provider plumbing ──────────────────────────────────────────────────────

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const UA = 'IntelliQE-CI-Connector';
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }

/** api.github.com vs a GitHub Enterprise Server base (…/api/v3). */
function githubApiBase(baseUrl: string): string {
  const b = trimSlash(baseUrl || DEFAULT_BASE.github);
  if (/api\.github\.com$/i.test(b) || /\/api\/v3$/i.test(b)) return b;
  if (/github\.com$/i.test(b)) return 'https://api.github.com';
  return `${b}/api/v3`; // Enterprise Server host
}

export interface CiTestResult { ok: boolean; detail: string }

/** Lightweight connection check per provider. */
export async function testConnector(tenantId: string, id: string): Promise<CiTestResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  try {
    if (c.vendor === 'jenkins') {
      if (!c.baseUrl) throw new Error('Set the Jenkins base URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/api/json?tree=mode`, { method: 'GET', headers: { Authorization: basic(auth.username || '', auth.apiToken || ''), accept: 'application/json' } }, 20_000, 2000);
      return r.ok ? { ok: true, detail: 'Authenticated with Jenkins.' } : { ok: false, detail: `Jenkins returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    if (c.vendor === 'github') {
      const r = await fetchFull(`${githubApiBase(c.baseUrl)}/user`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}`, accept: 'application/vnd.github+json', 'user-agent': UA } }, 20_000, 2000);
      const login = safeJson(r.bodyText)?.login;
      return r.ok ? { ok: true, detail: `Authenticated with GitHub${login ? ` as ${login}` : ''}.` } : { ok: false, detail: `GitHub returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    if (c.vendor === 'gitlab') {
      const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.gitlab)}/api/v4/user`, { method: 'GET', headers: { 'PRIVATE-TOKEN': auth.token || '', accept: 'application/json' } }, 20_000, 2000);
      const uname = safeJson(r.bodyText)?.username;
      return r.ok ? { ok: true, detail: `Authenticated with GitLab${uname ? ` as ${uname}` : ''}.` } : { ok: false, detail: `GitLab returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    if (c.vendor === 'azuredevops') {
      if (!c.baseUrl) throw new Error('Set the Azure DevOps organization URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/_apis/projects?api-version=7.0&$top=1`, { method: 'GET', headers: { Authorization: basic('', auth.pat || ''), accept: 'application/json' } }, 20_000, 2000);
      return r.ok ? { ok: true, detail: 'Authenticated with Azure DevOps.' } : { ok: false, detail: `Azure DevOps returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
    }
    // circleci
    const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.circleci)}/api/v2/me`, { method: 'GET', headers: { 'Circle-Token': auth.token || '', accept: 'application/json' } }, 20_000, 2000);
    const name = safeJson(r.bodyText)?.name || safeJson(r.bodyText)?.login;
    return r.ok ? { ok: true, detail: `Authenticated with CircleCI${name ? ` as ${name}` : ''}.` } : { ok: false, detail: `CircleCI returned ${r.status || 'no status'}.${r.error ? ` ${r.error}` : ''}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export interface CiReposResult { ok: boolean; detail: string; repos: CiRepo[] }

/** List the repositories / projects / jobs the credentials can see. */
export async function listRepos(tenantId: string, id: string, limit = 100): Promise<CiReposResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  try {
    if (c.vendor === 'jenkins') {
      if (!c.baseUrl) throw new Error('Set the Jenkins base URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/api/json?tree=jobs[name,url]`, { method: 'GET', headers: { Authorization: basic(auth.username || '', auth.apiToken || ''), accept: 'application/json' } }, 30_000, 200_000);
      if (!r.ok) return { ok: false, detail: `Jenkins returned ${r.status || 'no status'}.`, repos: [] };
      const jobs = safeJson(r.bodyText)?.jobs || [];
      const repos: CiRepo[] = jobs.slice(0, cap).map((j: any) => ({ id: String(j.name || ''), name: String(j.name || ''), url: String(j.url || '') }));
      return { ok: true, detail: `Found ${repos.length} Jenkins job(s).`, repos };
    }
    if (c.vendor === 'github') {
      const base = githubApiBase(c.baseUrl);
      const perPage = Math.min(cap, 100);
      const url = c.orgKey
        ? `${base}/orgs/${encodeURIComponent(c.orgKey)}/repos?per_page=${perPage}&sort=updated`
        : `${base}/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`;
      const r = await fetchFull(url, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}`, accept: 'application/vnd.github+json', 'user-agent': UA } }, 30_000, 400_000);
      if (!r.ok) return { ok: false, detail: `GitHub returned ${r.status || 'no status'}.`, repos: [] };
      const arr = safeJson(r.bodyText) || [];
      const repos: CiRepo[] = (Array.isArray(arr) ? arr : []).slice(0, cap).map((x: any) => ({ id: String(x.full_name || x.id || ''), name: String(x.full_name || x.name || ''), url: String(x.html_url || '') }));
      return { ok: true, detail: `Found ${repos.length} GitHub repo(s).`, repos };
    }
    if (c.vendor === 'gitlab') {
      const base = trimSlash(c.baseUrl || DEFAULT_BASE.gitlab);
      const perPage = Math.min(cap, 100);
      const url = c.orgKey
        ? `${base}/api/v4/groups/${encodeURIComponent(c.orgKey)}/projects?per_page=${perPage}&order_by=last_activity_at`
        : `${base}/api/v4/projects?membership=true&per_page=${perPage}&order_by=last_activity_at`;
      const r = await fetchFull(url, { method: 'GET', headers: { 'PRIVATE-TOKEN': auth.token || '', accept: 'application/json' } }, 30_000, 400_000);
      if (!r.ok) return { ok: false, detail: `GitLab returned ${r.status || 'no status'}.`, repos: [] };
      const arr = safeJson(r.bodyText) || [];
      const repos: CiRepo[] = (Array.isArray(arr) ? arr : []).slice(0, cap).map((x: any) => ({ id: String(x.id || ''), name: String(x.path_with_namespace || x.name || ''), url: String(x.web_url || '') }));
      return { ok: true, detail: `Found ${repos.length} GitLab project(s).`, repos };
    }
    if (c.vendor === 'azuredevops') {
      if (!c.baseUrl) throw new Error('Set the Azure DevOps organization URL first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/_apis/projects?api-version=7.0&$top=${cap}`, { method: 'GET', headers: { Authorization: basic('', auth.pat || ''), accept: 'application/json' } }, 30_000, 400_000);
      if (!r.ok) return { ok: false, detail: `Azure DevOps returned ${r.status || 'no status'}.`, repos: [] };
      const vals = safeJson(r.bodyText)?.value || [];
      const org = trimSlash(c.baseUrl);
      const repos: CiRepo[] = vals.slice(0, cap).map((x: any) => ({ id: String(x.id || x.name || ''), name: String(x.name || ''), url: `${org}/${encodeURIComponent(String(x.name || ''))}` }));
      return { ok: true, detail: `Found ${repos.length} Azure DevOps project(s).`, repos };
    }
    // circleci — list the projects the token follows (v1.1 is the only simple listing endpoint)
    const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.circleci)}/api/v1.1/projects`, { method: 'GET', headers: { 'Circle-Token': auth.token || '', accept: 'application/json' } }, 30_000, 400_000);
    if (!r.ok) return { ok: false, detail: `CircleCI returned ${r.status || 'no status'}.`, repos: [] };
    const arr = safeJson(r.bodyText) || [];
    const repos: CiRepo[] = (Array.isArray(arr) ? arr : []).slice(0, cap).map((x: any) => {
      const slug = x.vcs_url ? String(x.vcs_url).replace(/^https?:\/\/[^/]+\//, '') : `${x.username || ''}/${x.reponame || ''}`;
      return { id: slug, name: String(x.reponame || slug), url: String(x.vcs_url || '') };
    });
    return { ok: true, detail: `Found ${repos.length} CircleCI project(s).`, repos };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, repos: [] };
  }
}
