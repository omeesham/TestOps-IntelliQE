/**
 * github.provider.ts
 * ──────────────────
 * GitHub PR creation via Octokit. The flow is:
 *   1. Get the SHA of the default branch tip.
 *   2. Create a new branch ref pointing at that SHA.
 *   3. Upload each file with `createOrUpdateFileContents` on the new branch
 *      (one commit per file is acceptable for small test-script payloads;
 *      we keep it simple over building a tree manually).
 *   4. Open the PR back to the default branch.
 *
 * All API calls flow through a single Octokit instance so retries and
 * rate-limiting behave consistently.
 */
import type { GitFile, GitProvider, GitProviderConfig, GitTestResult, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

export const githubProvider: GitProvider = {
  id: 'github',

  async test(config): Promise<GitTestResult> {
    const { Octokit } = await import('@octokit/rest');
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'github') {
      throw new Error(`Expected a GitHub URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const octokit = new Octokit({
      auth: config.accessToken,
      ...(coords.host !== 'github.com' ? { baseUrl: `https://${coords.host}/api/v3` } : {}),
    });
    const { owner, repo } = coords;

    // 1. Repo reachable + token valid (also tells us push permission).
    let canPush = false;
    try {
      const r = await octokit.repos.get({ owner, repo });
      canPush = !!r.data.permissions?.push;
    } catch (err: any) {
      if (err.status === 401) throw new Error('Authentication failed — the access token is invalid or expired.');
      if (err.status === 404) {
        // GitHub answers 404 (not 403) when a VALID token cannot see a private
        // repo — identify the token's account so the mismatch is diagnosable.
        let who = '';
        try {
          const u = await octokit.users.getAuthenticated();
          who = ` The token authenticates as '${u.data.login}'.`;
        } catch { /* unauthenticated token — nothing to add */ }
        throw new Error(
          `Repository ${owner}/${repo} not found, or the token has no access to it.${who} ` +
          `Fine-grained token: grant it access to this repository with Contents and Pull requests (read/write). ` +
          `Classic token: enable the 'repo' scope.`,
        );
      }
      throw new Error(`Could not reach ${owner}/${repo}: ${err.message || err}`);
    }

    // 2. Default branch (the PR target) must exist.
    try {
      await octokit.git.getRef({ owner, repo, ref: `heads/${config.defaultBranch}` });
    } catch (err: any) {
      if (err.status === 404) {
        throw new Error(`Default branch '${config.defaultBranch}' does not exist on ${owner}/${repo}. Set "Default Branch" to an existing branch (e.g. main).`);
      }
      throw new Error(`Could not read default branch '${config.defaultBranch}': ${err.message || err}`);
    }

    return {
      ok: true,
      canPush,
      message: canPush
        ? `Connected to ${owner}/${repo}. Default branch '${config.defaultBranch}' found and the token can push. Ready to raise PRs.`
        : `Connected to ${owner}/${repo} and branch '${config.defaultBranch}' found, but the token cannot push to this repo. Grant Contents + Pull requests write access.`,
    };
  },

  async publish(config, files, opts): Promise<PublishResult> {
    const { Octokit } = await import('@octokit/rest');
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'github') {
      throw new Error(`Expected a GitHub URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const octokit = new Octokit({
      auth: config.accessToken,
      // GitHub Enterprise: derive baseUrl when host isn't github.com.
      ...(coords.host !== 'github.com' ? { baseUrl: `https://${coords.host}/api/v3` } : {}),
    });

    const { owner, repo } = coords;
    const webBase = `https://${coords.host}/${owner}/${repo}`;

    // Direct mode: the caller targets the configured branch itself — commit
    // straight onto it. No new branch is created and no PR is opened (a PR
    // needs head ≠ base). This is the default GitHub flow: the connected
    // branch IS the delivery target.
    const direct = opts.branch === config.defaultBranch;

    // A fine-grained PAT can READ a public repo but still lack write access —
    // GitHub reports that as 403 "Resource not accessible by personal access
    // token". Translate it into the exact remediation instead of a dead link.
    const writeDenied = (err: any): boolean =>
      err?.status === 403 || /not accessible by personal access token/i.test(String(err?.message || ''));
    const writeDeniedError = (action: string) =>
      new Error(
        `${action} was refused — the access token has no WRITE access to ${owner}/${repo}. ` +
        `Fine-grained token: grant this repository Contents (Read and write)${direct ? '' : ' and Pull requests (Read and write)'}. ` +
        `Classic token: enable the 'repo' scope. Then update the token under System Configuration → Code Repositories.`,
      );

    // 1. Verify the base branch exists and get its tip SHA.
    let baseSha: string;
    try {
      const baseRef = await octokit.git.getRef({
        owner, repo, ref: `heads/${config.defaultBranch}`,
      });
      baseSha = baseRef.data.object.sha;
    } catch (err: any) {
      throw new Error(`Could not read default branch '${config.defaultBranch}' on ${owner}/${repo}: ${err.message || err}`);
    }

    // 2. Create the new branch (PR mode only).
    if (!direct) {
      try {
        await octokit.git.createRef({
          owner, repo,
          ref: `refs/heads/${opts.branch}`,
          sha: baseSha,
        });
      } catch (err: any) {
        // If the ref exists already (re-publish on the same branch) we
        // surface a clear error rather than silently appending.
        if (err.status === 422) {
          throw new Error(`Branch '${opts.branch}' already exists on ${owner}/${repo}. Choose a different branch name or delete the existing one.`);
        }
        if (writeDenied(err)) throw writeDeniedError(`Creating branch '${opts.branch}'`);
        throw new Error(`Could not create branch '${opts.branch}': ${err.message || err}`);
      }
    }

    // 3. Commit each file onto the target branch.
    let committed = 0;
    for (const file of files) {
      try {
        // A path that already exists on the branch can only be updated when
        // the current blob sha is supplied — GitHub's Contents API rejects it
        // with HTTP 422 ("sha wasn't supplied") otherwise. Look it up (absent
        // for new files) so re-publishes / non-empty repos work.
        let sha: string | undefined;
        try {
          const existing = await octokit.repos.getContent({
            owner, repo, path: file.path, ref: opts.branch,
          });
          if (!Array.isArray(existing.data) && 'sha' in existing.data) {
            sha = existing.data.sha;
          }
        } catch (e: any) {
          if (e?.status !== 404) throw e; // 404 = new file, no sha needed
        }
        await octokit.repos.createOrUpdateFileContents({
          owner, repo,
          path: file.path,
          message: opts.commitMessage,
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
          branch: opts.branch,
          ...(sha ? { sha } : {}),
        });
        committed++;
      } catch (err: any) {
        if (writeDenied(err)) throw writeDeniedError(`Committing ${file.path}`);
        throw new Error(`Could not commit ${file.path}: ${err.message || err}`);
      }
    }

    if (direct) {
      return {
        provider: 'github',
        mode: 'direct',
        prUrl: `${webBase}/tree/${encodeURIComponent(opts.branch)}`,
        prNumber: 0,
        branch: opts.branch,
        fileCount: committed,
      };
    }

    // 4. Open the PR (PR mode only).
    try {
      const pr = await octokit.pulls.create({
        owner, repo,
        head: opts.branch,
        base: config.defaultBranch,
        title: opts.title,
        body: opts.body,
      });
      return {
        provider: 'github',
        mode: 'pr',
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        branch: opts.branch,
        fileCount: committed,
      };
    } catch (err: any) {
      if (writeDenied(err)) throw writeDeniedError('Opening the pull request');
      throw new Error(`Branch '${opts.branch}' was created with ${committed} file(s) but the PR could not be opened: ${err.message || err}`);
    }
  },
};
