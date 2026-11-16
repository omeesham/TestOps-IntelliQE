/**
 * bitbucket-server.provider.ts
 * ────────────────────────────
 * Bitbucket Server / Data Center (self-hosted) PR creation (IQE-055.1 #5).
 *
 * Server/DC exposes a DIFFERENT REST API than Bitbucket Cloud, so this is a
 * separate client rather than a base-URL swap of bitbucket.provider.ts:
 *   base     : {baseUrl}/rest/api/1.0/projects/{KEY}/repos/{slug}
 *   branches : {baseUrl}/rest/branch-utils/1.0/projects/{KEY}/repos/{slug}/branches
 *   files    : PUT  .../browse/{path}   (multipart: content, message, branch, sourceCommitId?)
 *   PR       : POST .../pull-requests   ({ fromRef, toRef } with refs/heads/… ids)
 *
 * Auth: an HTTP access token (Bearer) when no username is set, else Basic
 * `{username}:{password}`. The self-hosted base URL comes from `config.baseUrl`
 * or, failing that, the repo URL's host. Project key = coords.owner, slug = coords.repo.
 */
import type { GitFile, GitProvider, GitProviderConfig, GitTestResult, PublishResult } from './git.types.js';
import { parseRepoUrl } from './git.types.js';

function authHeaderFor(config: GitProviderConfig): string {
  if (config.authHeader) return config.authHeader;
  // HTTP access token → Bearer; app-password style → Basic username:password.
  return config.username
    ? 'Basic ' + Buffer.from(`${config.username}:${config.accessToken}`).toString('base64')
    : `Bearer ${config.accessToken}`;
}

function baseUrls(config: GitProviderConfig, host: string) {
  const root = (config.baseUrl || `https://${host}`).replace(/\/+$/, '');
  return { root, api: `${root}/rest/api/1.0`, branchUtils: `${root}/rest/branch-utils/1.0` };
}

/** Latest commit id on a branch (also proves the branch exists). Null when missing. */
async function branchTip(api: string, key: string, slug: string, branch: string, headers: Record<string, string>): Promise<string | null> {
  const r = await fetch(
    `${api}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}/commits?until=${encodeURIComponent(`refs/heads/${branch}`)}&limit=1`,
    { headers },
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Could not read branch '${branch}' on ${key}/${slug}: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  const data = await r.json() as any;
  return data?.values?.[0]?.id || null;
}

export const bitbucketServerProvider: GitProvider = {
  id: 'bitbucket-server',

  async test(config): Promise<GitTestResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'bitbucket-server') {
      throw new Error(`Expected a Bitbucket Server URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const headers = { Authorization: authHeaderFor(config) };
    const { api } = baseUrls(config, coords.host);
    const { owner: key, repo: slug } = coords;
    const repoUrl = `${api}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}`;

    const repoRes = await fetch(repoUrl, { headers });
    if (!repoRes.ok) {
      if (repoRes.status === 401) throw new Error('Authentication failed — the HTTP access token or username/password is invalid.');
      if (repoRes.status === 404) throw new Error(`Repository ${key}/${slug} not found, or the token lacks repository read access.`);
      throw new Error(`Could not reach ${key}/${slug}: HTTP ${repoRes.status}`);
    }
    const tip = await branchTip(api, key, slug, config.defaultBranch, headers);
    if (!tip) {
      throw new Error(`Default branch '${config.defaultBranch}' does not exist on ${key}/${slug}. Set "Default Branch" to an existing branch (e.g. main).`);
    }
    return { ok: true, message: `Connected to ${key}/${slug}. Default branch '${config.defaultBranch}' found. Ready to raise pull requests.` };
  },

  async publish(config, files, opts): Promise<PublishResult> {
    const coords = parseRepoUrl(config.repoUrl);
    if (coords.provider !== 'bitbucket-server') {
      throw new Error(`Expected a Bitbucket Server URL but got ${coords.provider}: ${config.repoUrl}`);
    }
    const headers = { Authorization: authHeaderFor(config) };
    const { api, branchUtils } = baseUrls(config, coords.host);
    const { owner: key, repo: slug } = coords;
    const repoPath = `projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}`;

    // 1. Tip of the default branch (the new branch's start point).
    const startCommit = await branchTip(api, key, slug, config.defaultBranch, headers);
    if (!startCommit) throw new Error(`Default branch '${config.defaultBranch}' not found on ${key}/${slug}`);

    // 2. Create the feature branch from that commit (branch-utils REST).
    {
      const r = await fetch(`${branchUtils}/${repoPath}/branches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: opts.branch, startPoint: startCommit }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Could not create branch '${opts.branch}' on ${key}/${slug}: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
    }

    // 3. Commit each file via the browse PUT. New files omit sourceCommitId; an
    // existing path is retried WITH the current branch tip (an update). Each PUT
    // makes a new commit, so track the advancing tip for subsequent files.
    let tip = startCommit;
    const putFile = async (f: GitFile, sourceCommitId?: string): Promise<Response> => {
      const form = new FormData();
      form.append('content', f.content);
      form.append('message', opts.commitMessage);
      form.append('branch', opts.branch);
      if (sourceCommitId) form.append('sourceCommitId', sourceCommitId);
      return fetch(`${api}/${repoPath}/browse/${f.path.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'PUT', headers, body: form as any });
    };
    for (const f of files) {
      let r = await putFile(f);                                  // create
      if (!r.ok && (r.status === 409 || r.status === 400)) {
        r = await putFile(f, tip);                               // retry as an update
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Could not commit '${f.path}' to ${key}/${slug}@${opts.branch}: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
      const commit = await r.json().catch(() => ({})) as any;
      if (commit?.id) tip = commit.id;
    }

    // 4. Open the pull request.
    {
      const r = await fetch(`${api}/${repoPath}/pull-requests`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: opts.title,
          description: opts.body,
          fromRef: { id: `refs/heads/${opts.branch}`, repository: { slug, project: { key } } },
          toRef: { id: `refs/heads/${config.defaultBranch}`, repository: { slug, project: { key } } },
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Branch '${opts.branch}' was created with ${files.length} file(s) but the PR could not be opened: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
      const pr = await r.json() as any;
      const { root } = baseUrls(config, coords.host);
      return {
        provider: 'bitbucket-server',
        mode: 'pr',
        prUrl: pr?.links?.self?.[0]?.href || `${root}/${repoPath}/pull-requests/${pr?.id}`,
        prNumber: pr?.id,
        branch: opts.branch,
        fileCount: files.length,
      };
    }
  },
};
