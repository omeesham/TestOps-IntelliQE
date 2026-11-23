/**
 * git/credentials.ts
 * ──────────────────
 * Shared git-repo credential resolution + guards, used by BOTH code-push paths:
 * the Web-automation publish (git.routes.ts) and the API-automation publish
 * (api-git-publish.service.ts). Centralising it means both paths resolve the
 * same connected integration, reuse the Azure work-item PAT the same way, parse
 * the same provider set (GitHub, GitLab, Bitbucket Cloud/Server, Azure DevOps),
 * and apply the same framework-repo guard — so adding API-side push to Bitbucket
 * and Azure is a matter of reusing this, not re-deriving it.
 */
import pool from '../../db.js';
import { decryptConfigData } from '../../utils/crypto.js';
import type { GitProviderConfig } from './git.types.js';

/** The git-repo integration ids that back a code-push provider. */
export const GIT_REPO_INTEGRATIONS = ['github', 'gitlab', 'bitbucket', 'azure-repos'];

/**
 * Repo-name fragments that identify the IntelliQE FRAMEWORK monorepo. Pushing a
 * client deliverable there would expose framework IP, so we refuse it. Override
 * via FRAMEWORK_REPO_GUARD (comma-separated) for differently-named forks.
 */
const FRAMEWORK_REPO_MARKERS = (process.env.FRAMEWORK_REPO_GUARD || 'jbsintelliqe,intelliqe-framework,testops-intelliqe')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** True when the repo name looks like the IntelliQE framework monorepo. */
export function isFrameworkRepo(repoName: string): boolean {
  const lower = String(repoName || '').toLowerCase();
  return FRAMEWORK_REPO_MARKERS.some((m) => lower.includes(m));
}

/**
 * Reuse the existing Azure DevOps (work-item) connection's PAT for code push
 * when the code-repo config carries no token of its own. The `azure-devops`
 * connection stores a ready `Basic <base64>` auth_header; borrow it so the user
 * never re-enters the PAT (it must have Code scope).
 */
async function borrowAzureAuthHeader(tenantId: string): Promise<string | undefined> {
  const r = await pool.query(
    `SELECT config_data FROM client_configurations
      WHERE tenant_id = $1 AND integration_id = 'azure-devops' AND status = 'connected'`,
    [tenantId],
  );
  if (r.rows.length === 0) return undefined;
  const cfg = decryptConfigData(r.rows[0].config_data || {});
  return cfg.auth_header ? String(cfg.auth_header).trim() : undefined;
}

/** Translate the stored config_data shape into the provider-neutral GitProviderConfig. */
export function cfgToProvider(cfg: Record<string, any>): GitProviderConfig {
  return {
    repoUrl: String(cfg.repo_url || cfg.repoUrl || '').trim(),
    defaultBranch: String(cfg.branch || cfg.default_branch || 'main').trim(),
    accessToken: String(cfg.access_token || cfg.accessToken || cfg.app_password || cfg.pat || '').trim(),
    authHeader: cfg.auth_header ? String(cfg.auth_header).trim() : undefined,
    username: cfg.username ? String(cfg.username).trim() : undefined,
    scriptsPath: String(cfg.scripts_path || cfg.scriptsPath || '').trim() || undefined,
    baseUrl: String(cfg.base_url || cfg.baseUrl || cfg.server_url || '').trim() || undefined,
  };
}

/**
 * For the Azure code-push integration that was saved without its own PAT,
 * borrow the auth header from the existing `azure-devops` work-item connection.
 */
export async function withAzureReuse(tenantId: string, integrationId: string, config: GitProviderConfig): Promise<GitProviderConfig> {
  if (integrationId === 'azure-repos' && !config.accessToken && !config.authHeader) {
    config.authHeader = await borrowAzureAuthHeader(tenantId);
  }
  return config;
}

/**
 * Look up the user's connected git-repo integration. Prefer an explicit
 * integrationId over auto-detect so the user can pick which connection to use
 * when they have several.
 */
export async function loadGitConfig(tenantId: string, preferred?: string): Promise<{ integrationId: string; config: GitProviderConfig } | null> {
  if (preferred) {
    const r = await pool.query(
      `SELECT integration_id, config_data FROM client_configurations
        WHERE tenant_id = $1 AND integration_id = $2 AND status = 'connected'`,
      [tenantId, preferred],
    );
    if (r.rows.length > 0) {
      const cfg = decryptConfigData(r.rows[0].config_data);
      const config = await withAzureReuse(tenantId, r.rows[0].integration_id, cfgToProvider(cfg));
      return { integrationId: r.rows[0].integration_id, config };
    }
  }
  const r = await pool.query(
    `SELECT integration_id, config_data FROM client_configurations
      WHERE tenant_id = $1
        AND integration_id IN ('github','gitlab','bitbucket','azure-repos')
        AND status = 'connected'
      ORDER BY connected_at DESC
      LIMIT 1`,
    [tenantId],
  );
  if (r.rows.length === 0) return null;
  const cfg = decryptConfigData(r.rows[0].config_data);
  const config = await withAzureReuse(tenantId, r.rows[0].integration_id, cfgToProvider(cfg));
  return { integrationId: r.rows[0].integration_id, config };
}

/**
 * Resolve the branch to publish to from the requested push `mode`. Only GitHub
 * supports a direct commit onto the default branch; GitLab/Bitbucket/Azure
 * always branch + open a PR/MR. An explicit requestedBranch always wins.
 */
export function resolvePublishBranch(opts: {
  mode?: 'pr' | 'direct';
  requestedBranch?: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'bitbucket-server' | 'azure';
  defaultBranch: string;
  ts: string;
}): string {
  const explicit = opts.requestedBranch && String(opts.requestedBranch).trim();
  if (explicit) return explicit;
  const canDirect = opts.provider === 'github';
  const wantDirect = opts.mode === 'direct' && canDirect;
  return wantDirect ? opts.defaultBranch : `intelliqe/tests-${opts.ts}`;
}
