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
import type { GitFile, GitProvider, GitProviderConfig, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

export const githubProvider: GitProvider = {
  id: 'github',
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
      throw new Error(`Could not create branch '${opts.branch}': ${err.message || err}`);
    }

    // 3. Commit each file onto the new branch.
    let committed = 0;
    for (const file of files) {
      try {
        await octokit.repos.createOrUpdateFileContents({
          owner, repo,
          path: file.path,
          message: opts.commitMessage,
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
          branch: opts.branch,
        });
        committed++;
      } catch (err: any) {
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
      };
    } catch (err: any) {
      throw new Error(`Branch '${opts.branch}' was created with ${committed} file(s) but the PR could not be opened: ${err.message || err}`);
    }
  },
};
