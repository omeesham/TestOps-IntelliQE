/**
 * gitlab.provider.ts
 * ──────────────────
 * GitLab Merge Request creation via Gitbeaker. GitLab differs from
 * GitHub in three useful ways:
 *   1. It uses a single "commits" API call to push multiple files
 *      atomically — no need to do one-PUT-per-file like GitHub.
 *   2. Branch creation is a separate POST, but supports `ref` to
 *      branch off any existing branch.
 *   3. MRs are called Merge Requests, not Pull Requests, but Gitbeaker
 *      provides the same `MergeRequests.create()` shape.
 *
 * Gitbeaker accepts either the full project path (`group/sub/project`)
 * or the numeric project ID. We use the path form since we parsed it
 * out of the URL.
 */
import type { GitFile, GitProvider, GitProviderConfig, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

export const gitlabProvider: GitProvider = {
  id: 'gitlab',
  async publish(config, files, opts): Promise<PublishResult> {
    const { Gitlab } = await import('@gitbeaker/rest');
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'gitlab') {
      throw new Error(`Expected a GitLab URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const projectPath = coords.projectPath || `${coords.owner}/${coords.repo}`;
    const host = `https://${coords.host}`;
    const api = new Gitlab({ host, token: config.accessToken });

    // 1. Create the new branch from the default branch.
    try {
      await api.Branches.create(projectPath, opts.branch, config.defaultBranch);
    } catch (err: any) {
      const status = err?.cause?.response?.status || err?.response?.status;
      if (status === 400 || status === 409) {
        throw new Error(`Branch '${opts.branch}' already exists on ${projectPath}. Choose a different branch name.`);
      }
      throw new Error(`Could not create branch '${opts.branch}' on ${projectPath}: ${err.message || err}`);
    }

    // 2. Push all files in a single atomic commit. GitLab accepts
    // multiple actions per commit — much faster than per-file PUTs.
    try {
      const actions = files.map((f) => ({
        action: 'create' as const,
        filePath: f.path,
        content: f.content,
      }));
      await api.Commits.create(projectPath, opts.branch, opts.commitMessage, actions);
    } catch (err: any) {
      throw new Error(`Could not commit ${files.length} file(s) to ${projectPath}@${opts.branch}: ${err.message || err}`);
    }

    // 3. Open the merge request.
    try {
      const mr = await api.MergeRequests.create(
        projectPath,
        opts.branch,
        config.defaultBranch,
        opts.title,
        { description: opts.body, removeSourceBranch: false },
      );
      return {
        provider: 'gitlab',
        prUrl: (mr as any).web_url,
        prNumber: (mr as any).iid,
        branch: opts.branch,
        fileCount: files.length,
      };
    } catch (err: any) {
      throw new Error(`Branch '${opts.branch}' was created with ${files.length} file(s) but the MR could not be opened: ${err.message || err}`);
    }
  },
};

// Suppress unused warning for the GitProviderConfig import in declaration files.
export type _GitlabProviderConfig = GitProviderConfig;
