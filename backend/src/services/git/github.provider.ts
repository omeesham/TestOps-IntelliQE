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

/** True for the GitHub 403 that means "the token is valid but lacks WRITE scope". */
function isWritePermissionError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return err?.status === 403 || /resource not accessible|not accessible by (personal|integration)|forbidden/i.test(msg);
}

/**
 * Actionable guidance for the #1 push blocker: a token that can READ the repo
 * (so the connection test passes) but cannot WRITE. GitHub's account-level
 * `permissions.push` flag reads true even for a fine-grained token that has no
 * Contents/Pull-requests permission, so this only surfaces at push time.
 */
function writePermissionHint(owner: string, repo: string): string {
  return (
    `The access token cannot write to ${owner}/${repo} — GitHub refused it with ` +
    `"Resource not accessible by personal access token". The connection can READ the repo but not PUSH. Grant write access, then push again:\n` +
    `• Fine-grained token (github_pat_…): github.com/settings/personal-access-tokens → edit this token → make sure ${owner}/${repo} is in "Repository access", then under "Repository permissions" set Contents = Read and write AND Pull requests = Read and write.\n` +
    `• Classic token (ghp_…): enable the "repo" scope (or at least "public_repo" for a public repo).\n` +
    `Then re-save the token in System Configuration → Code Repositories and try again.`
  );
}

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
      if (err.status === 404) throw new Error(`Repository ${owner}/${repo} not found, or the token has no access to it.`);
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
        // NOTE: `permissions.push` is an ACCOUNT-level flag — it reads true even
        // for a fine-grained token that has no Contents/Pull-requests permission,
        // so it can't guarantee a push will succeed. Say so instead of promising.
        ? `Connected to ${owner}/${repo}; default branch '${config.defaultBranch}' found. If pushing fails, make sure the token has write access — a fine-grained token needs Contents = Read and write AND Pull requests = Read and write on this repo (a classic token needs the "repo" scope).`
        : `Connected to ${owner}/${repo} and branch '${config.defaultBranch}' found, but the token cannot push to this repo. Grant Contents = Read and write and Pull requests = Read and write (fine-grained token) or the "repo" scope (classic token).`,
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
    const htmlHost = coords.host === 'api.github.com' ? 'github.com' : coords.host;

    // DIRECT-COMMIT mode — commit each file straight onto the default branch,
    // with no new branch and no PR. This is the one-click "Push to GitHub" path:
    // the code lands on the branch the user browses (e.g. main) and is visible
    // immediately, rather than sitting in a PR waiting to be merged.
    if (opts.directCommit) {
      const branch = config.defaultBranch;
      let committed = 0;
      let lastCommitUrl = '';
      for (const file of files) {
        try {
          // Existing path needs its current blob sha to update (see PR path note).
          let sha: string | undefined;
          try {
            const existing = await octokit.repos.getContent({ owner, repo, path: file.path, ref: branch });
            if (!Array.isArray(existing.data) && 'sha' in existing.data) sha = existing.data.sha;
          } catch (e: any) {
            if (e?.status !== 404) throw e;
          }
          const res = await octokit.repos.createOrUpdateFileContents({
            owner, repo,
            path: file.path,
            message: opts.commitMessage,
            content: Buffer.from(file.content, 'utf-8').toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
          });
          lastCommitUrl = res.data.commit?.html_url || lastCommitUrl;
          committed++;
        } catch (err: any) {
          if (isWritePermissionError(err)) {
            throw new Error(writePermissionHint(owner, repo));
          }
          if (/protected branch|not permitted|required status|changes must be made through a pull request|review/i.test(String(err?.message))) {
            throw new Error(
              `The '${branch}' branch is protected, so a direct commit was refused (${err.message}). ` +
              `Either allow direct pushes to '${branch}' in the repo's branch-protection settings, or use "Create Pull Request" to open a PR instead.`,
            );
          }
          throw new Error(`Could not commit ${file.path} to ${branch}: ${err.message || err}`);
        }
      }
      return {
        provider: 'github',
        prUrl: lastCommitUrl || `https://${htmlHost}/${owner}/${repo}/tree/${branch}`,
        prNumber: 0,
        branch,
        fileCount: committed,
        mode: 'commit',
      };
    }

    // 1. Get the SHA of the default branch tip.
    let baseSha: string;
    try {
      const baseRef = await octokit.git.getRef({
        owner, repo, ref: `heads/${config.defaultBranch}`,
      });
      baseSha = baseRef.data.object.sha;
    } catch (err: any) {
      throw new Error(`Could not read default branch '${config.defaultBranch}' on ${owner}/${repo}: ${err.message || err}`);
    }

    // 2. Create the new branch.
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
      // The token can read the repo (the connection test passed) but can't
      // create a branch — it lacks write scope. Give the exact fix.
      if (isWritePermissionError(err)) {
        throw new Error(writePermissionHint(owner, repo));
      }
      throw new Error(`Could not create branch '${opts.branch}': ${err.message || err}`);
    }

    // 3. Commit each file onto the new branch.
    let committed = 0;
    for (const file of files) {
      try {
        // The new branch is cut from the default-branch tip, so a path that
        // already exists there is already present on this branch. GitHub's
        // Contents API rejects an update to an existing path with HTTP 422
        // ("sha wasn't supplied") unless the current blob sha is passed. Look
        // it up (absent for new files) so re-publishes / non-empty repos work.
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
        if (isWritePermissionError(err)) {
          throw new Error(writePermissionHint(owner, repo));
        }
        throw new Error(`Could not commit ${file.path}: ${err.message || err}`);
      }
    }

    // 4. Open the PR.
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
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        branch: opts.branch,
        fileCount: committed,
        mode: 'pr',
      };
    } catch (err: any) {
      if (isWritePermissionError(err)) {
        throw new Error(
          `Files were committed to '${opts.branch}', but the pull request was refused. ${writePermissionHint(owner, repo)} ` +
          `(Opening a PR specifically needs "Pull requests: Read and write".)`,
        );
      }
      throw new Error(`Branch '${opts.branch}' was created with ${committed} file(s) but the PR could not be opened: ${err.message || err}`);
    }
  },
};
