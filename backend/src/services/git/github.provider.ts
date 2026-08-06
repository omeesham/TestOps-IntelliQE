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

/**
 * A brand-new client repo often has NO commits yet. The git-data API answers
 * 409 ("Git Repository is empty") for such repos — but the Contents API still
 * works and creates the branch with the first commit. So an empty repo is a
 * VALID publish target (direct mode), not an error.
 */
const isEmptyRepo = (err: any): boolean =>
  err?.status === 409 || /repository is empty/i.test(String(err?.message || ''));

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

    // 2. Default branch (the PR target) must exist — EXCEPT when the repo is
    // brand-new and empty: that's the normal client-onboarding case, and the
    // first publish will initialize the branch with its initial commit.
    try {
      await octokit.git.getRef({ owner, repo, ref: `heads/${config.defaultBranch}` });
    } catch (err: any) {
      if (isEmptyRepo(err)) {
        return {
          ok: true,
          canPush,
          message: canPush
            ? `Connected to ${owner}/${repo}. The repository is empty — the first publish will initialize branch '${config.defaultBranch}' with the test suite.`
            : `Connected to ${owner}/${repo} (empty repository), but the token cannot push. Grant Contents write access.`,
        };
      }
      if (err.status === 404) {
        throw new Error(`Default branch '${config.defaultBranch}' does not exist on ${owner}/${repo}. Set "Default Branch" to an existing branch (e.g. main).`);
      }
      throw new Error(`Could not read default branch '${config.defaultBranch}': ${err.message || err}`);
    }

    // CAVEAT for fine-grained tokens (github_pat_*): repos.get `permissions`
    // reflects the token OWNER's repo permission, NOT the token's own grants.
    // A fine-grained token without "Contents: Read and write" for THIS repo
    // still shows push:true here yet gets 403 on the actual commit — so warn.
    const fineGrained = config.accessToken.startsWith('github_pat_');
    const fineGrainedNote = fineGrained
      ? ` NOTE: this is a fine-grained token — make sure the token itself grants "${owner}/${repo}" Contents (Read and write), or commits will be refused even though push access shows here.`
      : '';
    return {
      ok: true,
      canPush,
      message: canPush
        ? `Connected to ${owner}/${repo}. Default branch '${config.defaultBranch}' found and the token can push. Ready to raise PRs.${fineGrainedNote}`
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

    // 1. Verify the base branch exists and get its tip SHA. An EMPTY repo has
    // no refs at all — that's fine in direct mode (the Contents API creates the
    // branch with the first commit), but PR mode is impossible (no base).
    let baseSha = '';
    let emptyRepo = false;
    try {
      const baseRef = await octokit.git.getRef({
        owner, repo, ref: `heads/${config.defaultBranch}`,
      });
      baseSha = baseRef.data.object.sha;
    } catch (err: any) {
      if (isEmptyRepo(err)) {
        if (!direct) {
          throw new Error(
            `${owner}/${repo} is empty, so a PR cannot be opened (base branch '${config.defaultBranch}' does not exist yet). ` +
            `Publish directly to '${config.defaultBranch}' first to initialize the repository.`,
          );
        }
        emptyRepo = true; // first commit below will create the branch
      } else {
        throw new Error(`Could not read default branch '${config.defaultBranch}' on ${owner}/${repo}: ${err.message || err}`);
      }
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
        // Skip the lookup entirely while the repo has no commits yet — the
        // Contents API would 404/409 on every path anyway.
        if (!emptyRepo) {
          try {
            const existing = await octokit.repos.getContent({
              owner, repo, path: file.path, ref: opts.branch,
            });
            if (!Array.isArray(existing.data) && 'sha' in existing.data) {
              sha = existing.data.sha;
            }
          } catch (e: any) {
            if (e?.status !== 404 && !isEmptyRepo(e)) throw e; // 404 = new file, no sha needed
          }
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
