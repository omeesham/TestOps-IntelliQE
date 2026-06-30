/**
 * bitbucket.provider.ts
 * ─────────────────────
 * Bitbucket Cloud PR creation using the native `fetch` API + an App
 * Password for Basic auth. We avoid pulling in a Bitbucket SDK because
 * the few endpoints we need are stable and well-documented.
 *
 * Endpoints used:
 *   1. POST /2.0/repositories/{workspace}/{repo}/src               — commits one or more files
 *      (also creates the branch when `branch` is supplied with `parents` = default branch's commit hash)
 *   2. POST /2.0/repositories/{workspace}/{repo}/pullrequests      — opens the PR
 *
 * Authentication: Basic with `{username}:{app_password}`. The integration
 * stores the app password under `app_password` and the username under
 * `username` (mirrors the integrationCatalog Bitbucket entry).
 */
import type { GitFile, GitProvider, GitProviderConfig, GitTestResult, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

const BB_API = 'https://api.bitbucket.org/2.0';

export const bitbucketProvider: GitProvider = {
  id: 'bitbucket',

  async test(config): Promise<GitTestResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'bitbucket') {
      throw new Error(`Expected a Bitbucket URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    if (!config.username) {
      throw new Error('Bitbucket requires a username alongside the app password — fill in the Username field.');
    }
    const auth = 'Basic ' + Buffer.from(`${config.username}:${config.accessToken}`).toString('base64');
    const headers: Record<string, string> = { Authorization: auth };
    const { owner: workspace, repo } = coords;
    const base = `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`;

    // 1. Repo reachable + credentials valid.
    const repoRes = await fetch(base, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 401) throw new Error('Authentication failed — the username or app password is invalid.');
      if (repoRes.status === 404) throw new Error(`Repository ${workspace}/${repo} not found, or the app password lacks Repositories:Read access.`);
      throw new Error(`Could not reach ${workspace}/${repo}: HTTP ${repoRes.status}`);
    }

    // 2. Default branch (PR target) must exist.
    const brRes = await fetch(`${base}/refs/branches/${encodeURIComponent(config.defaultBranch)}`, { headers });
    if (!brRes.ok) {
      if (brRes.status === 404) {
        throw new Error(`Default branch '${config.defaultBranch}' does not exist on ${workspace}/${repo}. Set "Default Branch" to an existing branch (e.g. main).`);
      }
      throw new Error(`Could not read default branch '${config.defaultBranch}': HTTP ${brRes.status}`);
    }

    return { ok: true, message: `Connected to ${workspace}/${repo}. Default branch '${config.defaultBranch}' found. Ready to raise pull requests.` };
  },

  async publish(config, files, opts): Promise<PublishResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'bitbucket') {
      throw new Error(`Expected a Bitbucket URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    if (!config.username) {
      throw new Error('Bitbucket integration requires a username — re-save the connection in System Configuration.');
    }
    const auth = 'Basic ' + Buffer.from(`${config.username}:${config.accessToken}`).toString('base64');
    const headers: Record<string, string> = { Authorization: auth };
    const { owner: workspace, repo } = coords;

    // 1. Resolve the default branch's tip commit hash so we can pass it
    // as the `parents` argument when creating the new branch.
    let parentSha: string;
    {
      const r = await fetch(
        `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/refs/branches/${encodeURIComponent(config.defaultBranch)}`,
        { headers },
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Could not read default branch '${config.defaultBranch}' on ${workspace}/${repo}: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
      const data = await r.json() as any;
      parentSha = data?.target?.hash;
      if (!parentSha) throw new Error(`Default branch '${config.defaultBranch}' has no commit hash`);
    }

    // 2. Push all files in a single commit, which also creates the branch.
    // Bitbucket's /src endpoint takes multipart/form-data: one part per
    // file + branch + parents + message + author.
    {
      const form = new FormData();
      form.append('branch', opts.branch);
      form.append('parents', parentSha);
      form.append('message', opts.commitMessage);
      for (const f of files) {
        // Bitbucket treats the FIELD NAME as the file path within the repo.
        form.append(f.path, new Blob([f.content], { type: 'text/plain' }), f.path.split('/').pop() || f.path);
      }
      const r = await fetch(
        `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/src`,
        { method: 'POST', headers, body: form as any },
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Could not commit ${files.length} file(s) to ${workspace}/${repo}@${opts.branch}: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
    }

    // 3. Open the pull request.
    {
      const r = await fetch(
        `${BB_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: opts.title,
            description: opts.body,
            source: { branch: { name: opts.branch } },
            destination: { branch: { name: config.defaultBranch } },
            close_source_branch: false,
          }),
        },
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Branch '${opts.branch}' was created with ${files.length} file(s) but the PR could not be opened: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
      const pr = await r.json() as any;
      return {
        provider: 'bitbucket',
        prUrl: pr?.links?.html?.href || `https://${coords.host}/${workspace}/${repo}/pull-requests/${pr?.id}`,
        prNumber: pr?.id,
        branch: opts.branch,
        fileCount: files.length,
      };
    }
  },
};

// Suppress unused warning
export type _BitbucketProviderConfig = GitProviderConfig;
export type _BitbucketGitFile = GitFile;
