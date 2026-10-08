/**
 * api-git-sync.service.ts
 * ───────────────────────
 * Git-synced test-as-code. Push the API catalogue (and optionally generated
 * specs) to a Git repo path, and pull it back — so tests live in version control
 * and travel with the code. Bidirectional: push commits to a branch; pull reads
 * the file and hands the parsed catalogue back to load.
 *
 * Standalone and opt-in: a per-tenant sync config (token encrypted) in its own
 * table; uses the bundled @octokit/rest / @gitbeaker/rest. The generate →
 * execute → heal pipeline is never involved.
 */
import { Octokit } from '@octokit/rest';
import { Gitlab } from '@gitbeaker/rest';
import pool from '../db.js';
import { encryptField, decryptStored } from '../utils/crypto.js';

export interface GitSyncConfigView { provider: 'github' | 'gitlab' | 'none'; repo: string; branch: string; path: string; host: string; hasToken: boolean }
interface GitSyncConfig { provider: 'github' | 'gitlab'; repo: string; branch: string; path: string; host: string; token: string }

export async function getGitSyncConfig(tenantId: string): Promise<GitSyncConfigView> {
  const { rows } = await pool.query(`SELECT config FROM api_git_sync_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { provider: 'none', repo: '', branch: 'main', path: 'intelliqe/api-catalogue.json', host: '', hasToken: false };
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  return { provider: c.provider || 'github', repo: c.repo || '', branch: c.branch || 'main', path: c.path || 'intelliqe/api-catalogue.json', host: c.host || '', hasToken: !!c.token };
}

export async function saveGitSyncConfig(tenantId: string, input: { provider?: string; repo?: string; branch?: string; path?: string; host?: string; token?: string }): Promise<GitSyncConfigView> {
  const { rows: ex } = await pool.query(`SELECT config FROM api_git_sync_config WHERE tenant_id = $1`, [tenantId]);
  const prev = ex.length ? (typeof ex[0].config === 'string' ? JSON.parse(ex[0].config) : ex[0].config) : {};
  const cfg: Record<string, unknown> = {
    provider: input.provider === 'gitlab' ? 'gitlab' : 'github',
    repo: String(input.repo ?? prev.repo ?? '').slice(0, 300),
    branch: String(input.branch ?? prev.branch ?? 'main').slice(0, 100),
    path: String(input.path ?? prev.path ?? 'intelliqe/api-catalogue.json').replace(/^\/+/, '').slice(0, 300),
    host: String(input.host ?? prev.host ?? '').slice(0, 200),
    token: prev.token,
  };
  if (input.token && !input.token.includes('•') && !input.token.includes('*')) cfg.token = encryptField(input.token);
  await pool.query(
    `MERGE INTO api_git_sync_config WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET config = $2, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, config) VALUES ($1, $2);`,
    [tenantId, JSON.stringify(cfg)],
  );
  return getGitSyncConfig(tenantId);
}

async function resolve(tenantId: string): Promise<GitSyncConfig> {
  const { rows } = await pool.query(`SELECT config FROM api_git_sync_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) throw new Error('Git sync is not configured.');
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  if (!c.token) throw new Error('No git token saved.');
  if (!c.repo) throw new Error('No repo configured.');
  return { provider: c.provider, repo: c.repo, branch: c.branch || 'main', path: c.path, host: c.host, token: decryptStored(c.token) };
}

export interface GitPushResult { url: string; path: string; branch: string; commit?: string }

export async function pushToGit(tenantId: string, content: string): Promise<GitPushResult> {
  const cfg = await resolve(tenantId);
  if (cfg.provider === 'gitlab') {
    const api = new Gitlab({ token: cfg.token, host: cfg.host || 'https://gitlab.com' });
    const projectId: string | number = /^\d+$/.test(cfg.repo) ? Number(cfg.repo) : cfg.repo;
    let exists = false;
    try { await api.RepositoryFiles.show(projectId, cfg.path, cfg.branch); exists = true; } catch { exists = false; }
    const msg = 'chore(intelliqe): sync API catalogue';
    if (exists) await api.RepositoryFiles.edit(projectId, cfg.path, cfg.branch, content, msg);
    else await api.RepositoryFiles.create(projectId, cfg.path, cfg.branch, content, msg);
    const project: any = await api.Projects.show(projectId);
    return { url: `${project.web_url}/-/blob/${cfg.branch}/${cfg.path}`, path: cfg.path, branch: cfg.branch };
  }
  const [owner, repo] = cfg.repo.split('/');
  if (!owner || !repo) throw new Error('For GitHub, repo must be "owner/repo".');
  const octokit = new Octokit({ auth: cfg.token });
  let sha: string | undefined;
  try { const ex = await octokit.repos.getContent({ owner, repo, path: cfg.path, ref: cfg.branch }); if (!Array.isArray(ex.data) && 'sha' in ex.data) sha = ex.data.sha; } catch { /* new file */ }
  const res = await octokit.repos.createOrUpdateFileContents({
    owner, repo, path: cfg.path, branch: cfg.branch, message: 'chore(intelliqe): sync API catalogue',
    content: Buffer.from(content, 'utf-8').toString('base64'), ...(sha ? { sha } : {}),
  });
  return { url: res.data.content?.html_url || '', path: cfg.path, branch: cfg.branch, commit: res.data.commit?.sha };
}

export interface GitPullResult { content: string; path: string; branch: string }

export async function pullFromGit(tenantId: string): Promise<GitPullResult> {
  const cfg = await resolve(tenantId);
  if (cfg.provider === 'gitlab') {
    const api = new Gitlab({ token: cfg.token, host: cfg.host || 'https://gitlab.com' });
    const projectId: string | number = /^\d+$/.test(cfg.repo) ? Number(cfg.repo) : cfg.repo;
    const file: any = await api.RepositoryFiles.show(projectId, cfg.path, cfg.branch);
    const content = Buffer.from(file.content, 'base64').toString('utf-8');
    return { content, path: cfg.path, branch: cfg.branch };
  }
  const [owner, repo] = cfg.repo.split('/');
  if (!owner || !repo) throw new Error('For GitHub, repo must be "owner/repo".');
  const octokit = new Octokit({ auth: cfg.token });
  const ex = await octokit.repos.getContent({ owner, repo, path: cfg.path, ref: cfg.branch });
  if (Array.isArray(ex.data) || !('content' in ex.data)) throw new Error('The configured path is not a file.');
  const content = Buffer.from(ex.data.content, 'base64').toString('utf-8');
  return { content, path: cfg.path, branch: cfg.branch };
}
