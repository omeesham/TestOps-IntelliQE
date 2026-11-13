/**
 * azure.provider.ts
 * ─────────────────
 * Azure DevOps Repos push + pull request creation using the native `fetch`
 * API against the ADO Git REST API. We avoid an SDK — the handful of
 * endpoints we need are stable and well documented.
 *
 * Base (per repo): https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}
 *   1. GET  {base}?api-version=7.1
 *        — repo reachable + credentials valid + default branch
 *   2. GET  {base}/refs?filter=heads/{branch}&api-version=7.1
 *        — the branch tip objectId used as the push's oldObjectId (commit base)
 *   3. GET  {base}/items?recursionLevel=Full&versionDescriptor.version={branch}&...
 *        — existing file paths, so each change is 'add' (new) or 'edit' (exists)
 *   4. POST {base}/pushes?api-version=7.1
 *        — ONE atomic push that creates the new branch AND commits every file
 *   5. POST {base}/pullrequests?api-version=7.1
 *        — opens the PR from the new branch back to the default branch
 *
 * Authentication: Basic with an empty username and the PAT as the password —
 * `Basic base64(":{PAT}")`. The code-push integration can also reuse the
 * `Basic` header already stored by the work-item (`azure-devops`) connection,
 * supplied via `config.authHeader` (IQE-056.1 crit 6).
 *
 * Azure DevOps always uses the branch+PR flow (like Bitbucket/GitLab) — the
 * default branch is the PR target, never a direct commit.
 */
import type { GitFile, GitProvider, GitProviderConfig, GitTestResult, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

const API_VERSION = '7.1';
const EMPTY_SHA = '0000000000000000000000000000000000000000';

/** Build the `{org}/{project}/_apis/git/repositories/{repo}` REST base for a parsed ADO repo URL. */
function repoApiBase(org: string, project: string, repo: string): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}` +
    `/_apis/git/repositories/${encodeURIComponent(repo)}`
  );
}

/** Derive the `Basic <base64>` header: prefer a supplied header, else build one from the PAT. */
function authHeaderFor(config: GitProviderConfig): string {
  if (config.authHeader && config.authHeader.trim()) return config.authHeader.trim();
  if (!config.accessToken) {
    throw new Error('Azure DevOps requires a Personal Access Token (with Code read/write scope).');
  }
  return 'Basic ' + Buffer.from(`:${config.accessToken}`).toString('base64');
}

/** Read the tip commit objectId of a branch; null when the branch does not exist. */
async function branchTip(base: string, branch: string, headers: Record<string, string>): Promise<string | null> {
  const r = await fetch(
    `${base}/refs?filter=${encodeURIComponent(`heads/${branch}`)}&api-version=${API_VERSION}`,
    { headers },
  );
  if (!r.ok) {
    if (r.status === 401 || r.status === 203) {
      throw new Error('Authentication failed — the Azure DevOps PAT is invalid, expired, or lacks Code (Read) scope.');
    }
    if (r.status === 404) return null;
    const t = await r.text().catch(() => '');
    throw new Error(`Could not read branches: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  const data = (await r.json()) as any;
  const ref = Array.isArray(data?.value)
    ? data.value.find((v: any) => v?.name === `refs/heads/${branch}`) || data.value[0]
    : null;
  return ref?.objectId || null;
}

/** Collect the set of file paths (leading-slash form) that already exist on `branch`. */
async function existingPaths(base: string, branch: string, headers: Record<string, string>): Promise<Set<string>> {
  const url =
    `${base}/items?recursionLevel=Full` +
    `&versionDescriptor.version=${encodeURIComponent(branch)}` +
    `&versionDescriptor.versionType=branch&api-version=${API_VERSION}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return new Set(); // best-effort: on failure, treat everything as new ('add')
  const data = (await r.json()) as any;
  const set = new Set<string>();
  for (const it of data?.value || []) {
    if (it?.isFolder) continue;
    if (typeof it?.path === 'string') set.add(it.path);
  }
  return set;
}

export const azureProvider: GitProvider = {
  id: 'azure',

  async test(config): Promise<GitTestResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'azure') {
      throw new Error(`Expected an Azure DevOps URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const headers = { Authorization: authHeaderFor(config) };
    const base = repoApiBase(coords.owner, coords.project || coords.repo, coords.repo);

    // 1. Repo reachable + credentials valid.
    const repoRes = await fetch(`${base}?api-version=${API_VERSION}`, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 401 || repoRes.status === 203) {
        throw new Error('Authentication failed — the Azure DevOps PAT is invalid, expired, or lacks Code (Read) scope.');
      }
      if (repoRes.status === 404) {
        throw new Error(
          `Repository "${coords.project}/${coords.repo}" not found in organization "${coords.owner}", ` +
          `or the PAT lacks Code (Read) access. Check the Organization, Project and Repository names.`,
        );
      }
      const t = await repoRes.text().catch(() => '');
      throw new Error(`Could not reach ${coords.owner}/${coords.project}/${coords.repo}: HTTP ${repoRes.status} ${t.slice(0, 200)}`);
    }
    const repo = (await repoRes.json()) as any;
    const repoDefault = String(repo?.defaultBranch || '').replace(/^refs\/heads\//, '');

    // 2. The PR target branch must exist (no branch/commit/PR is created here).
    const tip = await branchTip(base, config.defaultBranch, headers);
    if (!tip) {
      const hint = repoDefault ? ` The repository's default branch is '${repoDefault}'.` : '';
      throw new Error(
        `Default branch '${config.defaultBranch}' does not exist on ${coords.project}/${coords.repo}.` +
        `${hint} Set "Default Branch" to an existing branch.`,
      );
    }

    return {
      ok: true,
      canPush: true,
      message:
        `Connected to ${coords.owner}/${coords.project}/${coords.repo}. ` +
        `Target branch '${config.defaultBranch}' found. Ready to push a branch and raise a pull request.`,
    };
  },

  async publish(config, files, opts): Promise<PublishResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'azure') {
      throw new Error(`Expected an Azure DevOps URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const headers = { Authorization: authHeaderFor(config) };
    const base = repoApiBase(coords.owner, coords.project || coords.repo, coords.repo);

    // 1. Resolve the default branch tip — the push's oldObjectId and the PR target.
    const parentSha = await branchTip(base, config.defaultBranch, headers);
    if (!parentSha) {
      throw new Error(
        `Could not read default branch '${config.defaultBranch}' on ${coords.project}/${coords.repo}. ` +
        `Set "Default Branch" to an existing branch (e.g. main).`,
      );
    }

    // 2. Decide 'add' vs 'edit' per file from what already exists on the base branch
    //    (a single wrong changeType fails the whole atomic push).
    const existing = await existingPaths(base, config.defaultBranch, headers);

    // 3. ONE push creates the new branch (refUpdates) and commits every file (changes).
    const changes = files.map((f) => {
      const itemPath = f.path.startsWith('/') ? f.path : `/${f.path}`;
      return {
        changeType: existing.has(itemPath) ? 'edit' : 'add',
        item: { path: itemPath },
        newContent: { content: f.content, contentType: 'rawtext' },
      };
    });
    {
      const r = await fetch(`${base}/pushes?api-version=${API_VERSION}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refUpdates: [{ name: `refs/heads/${opts.branch}`, oldObjectId: parentSha }],
          commits: [{ comment: opts.commitMessage, changes }],
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 401 || r.status === 203 || r.status === 403) {
          throw new Error(
            `Push to ${coords.project}/${coords.repo} was refused (HTTP ${r.status}) — the PAT lacks Code (Read & Write) scope. ` +
            `Recreate the PAT with "Code (Read & Write)" and reconnect.`,
          );
        }
        throw new Error(
          `Could not push ${files.length} file(s) to ${coords.project}/${coords.repo}@${opts.branch}: HTTP ${r.status} ${t.slice(0, 300)}`,
        );
      }
    }

    // 4. Open the pull request from the new branch back to the default branch.
    {
      const r = await fetch(`${base}/pullrequests?api-version=${API_VERSION}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRefName: `refs/heads/${opts.branch}`,
          targetRefName: `refs/heads/${config.defaultBranch}`,
          title: opts.title,
          description: opts.body,
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(
          `Branch '${opts.branch}' was created with ${files.length} file(s) but the pull request could not be opened: ` +
          `HTTP ${r.status} ${t.slice(0, 300)}`,
        );
      }
      const pr = (await r.json()) as any;
      const prId = pr?.pullRequestId;
      const webUrl =
        `https://dev.azure.com/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.project || coords.repo)}` +
        `/_git/${encodeURIComponent(coords.repo)}/pullrequest/${prId}`;
      return {
        provider: 'azure',
        mode: 'pr',
        prUrl: webUrl,
        prNumber: typeof prId === 'number' ? prId : 0,
        branch: opts.branch,
        fileCount: files.length,
      };
    }
  },
};

// Suppress unused warnings for the shared types.
export type _AzureProviderConfig = GitProviderConfig;
export type _AzureGitFile = GitFile;
