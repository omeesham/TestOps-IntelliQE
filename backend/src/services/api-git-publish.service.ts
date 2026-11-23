/**
 * api-git-publish.service.ts
 * ──────────────────────────
 * Multi-provider CODE PUSH for the API-automation path. The old API git surfaces
 * (catalogue git-sync, remediation PR) were GitHub/GitLab-only; this gives the
 * API path the SAME five providers the Web path already has — GitHub, GitLab,
 * Bitbucket Cloud, Bitbucket Server/Data Center and Azure DevOps Repos — by
 * reusing the proven `services/git/*` provider layer, the shared credential
 * resolver, and the pre-push secret scan. Additive: it never touches the
 * generate→execute→heal pipeline, and leaves the existing git-sync/remediation
 * routes in place.
 */
import pool from '../db.js';
import { parseRepoUrl, type GitProvider, type PublishResult } from './git/git.types.js';
import { githubProvider } from './git/github.provider.js';
import { gitlabProvider } from './git/gitlab.provider.js';
import { bitbucketProvider } from './git/bitbucket.provider.js';
import { bitbucketServerProvider } from './git/bitbucket-server.provider.js';
import { azureProvider } from './git/azure.provider.js';
import { loadGitConfig, isFrameworkRepo, resolvePublishBranch } from './git/credentials.js';
import { scanFilesForSecrets, formatSecretFindings } from './git/secret-scan.js';
import { assembleApiFiles, type ApiPublishInput } from '../utils/api-git-assemble.js';

export type { ApiPublishInput, ApiPublishScript } from '../utils/api-git-assemble.js';

const PROVIDERS: Record<string, GitProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
  'bitbucket-server': bitbucketServerProvider,
  azure: azureProvider,
};

export interface ApiPublishResult extends PublishResult { integrationId: string; provider: PublishResult['provider'] }

export async function publishApiTestsToGit(tenantId: string, username: string, input: ApiPublishInput): Promise<ApiPublishResult> {
  // 1. Resolve the connected git-repo integration (same resolver the Web path uses).
  const loaded = await loadGitConfig(tenantId, input.integrationId);
  if (!loaded) throw new Error('No connected git-repo integration found. Connect GitHub, GitLab, Bitbucket, or Azure DevOps Repos in System Configuration first.');
  const { integrationId, config } = loaded;
  if (!config.repoUrl) throw new Error('Connected integration is missing the repository URL.');
  if (!config.accessToken && !config.authHeader) throw new Error('Connected integration is missing the access token.');

  // 2. Assemble the files and fail fast on an empty payload.
  const files = assembleApiFiles(input, config.scriptsPath || 'tests/api');
  if (!files.length) throw new Error('Nothing to publish — provide scripts, files, or a catalogue.');

  // 3. Pick the provider from the repo URL (authoritative over the saved kind).
  const coords = parseRepoUrl(config.repoUrl);
  const provider = PROVIDERS[coords.provider];
  if (!provider) throw new Error(`No provider implementation for ${coords.provider}`);

  // 4. IP guard — never push into the IntelliQE framework monorepo.
  if (isFrameworkRepo(coords.repo)) {
    throw new Error(`Refusing to publish into "${coords.owner}/${coords.repo}" — this looks like the IntelliQE framework repository. Use a dedicated client repository.`);
  }

  // 5. Secret scan before any push (same scanner the Web path uses).
  const scan = scanFilesForSecrets(files);
  if (!scan.clean) {
    throw new Error(
      `Push blocked: ${scan.findings.length} possible secret${scan.findings.length === 1 ? '' : 's'} found in the files to be committed. ` +
      `Move the value(s) into an environment variable and reference them from the scripts, then push again.\n` +
      formatSecretFindings(scan.findings),
    );
  }

  // 6. Publish (branch + PR/MR, or direct commit on GitHub when mode:'direct').
  const mode = (input.mode === 'pr' || input.mode === 'direct') ? input.mode : undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branch = resolvePublishBranch({ mode, requestedBranch: input.branch, provider: coords.provider, defaultBranch: config.defaultBranch, ts });
  const title = (input.title && String(input.title).trim()) || `IntelliQE: ${files.length} API test file(s)`;
  const commitMessage = (input.commitMessage && String(input.commitMessage).trim()) || title;
  const body = (input.body && String(input.body).trim()) || `IntelliQE API-automation code push by ${username} — ${files.length} file(s).`;

  const result = await provider.publish(config, files, { branch, title, body, commitMessage });

  // 7. Best-effort: bump the integration's last-sync timestamp.
  await pool.query(
    `UPDATE client_configurations SET last_sync_at = NOW() WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId],
  ).catch(() => { /* non-fatal */ });

  return { ...result, integrationId };
}
