/**
 * api-remediation.service.ts
 * ──────────────────────────
 * Autonomous remediation PRs. Takes a set of file changes (typically a
 * maintenance changeset — adopted contracts, a regenerated catalogue, a
 * changeset note) and opens a real GitHub Pull Request or GitLab Merge Request
 * on a branch, so a human reviews and merges. Extends the maintenance planner
 * from "here's what changed" to "here's a PR".
 *
 * Standalone and opt-in: uses the bundled @octokit/rest / @gitbeaker/rest; the
 * token + repo come from the request (the UI can pre-fill from the stored git
 * integration). The generate → execute → heal pipeline is never involved.
 */
import { Octokit } from '@octokit/rest';
import { Gitlab } from '@gitbeaker/rest';

export interface RemediationFile { path: string; content: string }
export interface RemediationInput {
  provider: 'github' | 'gitlab';
  token: string;
  /** github: "owner/repo". gitlab: numeric project id or "group/project". */
  repo: string;
  baseBranch?: string;
  branch?: string;
  title: string;
  body?: string;
  files: RemediationFile[];
  /** gitlab only: custom host, defaults to gitlab.com. */
  host?: string;
}
export interface RemediationResult { url: string; branch: string; provider: string; filesCommitted: number }

function safeBranch(name?: string): string {
  const base = (name || `intelliqe/maintenance-${Date.now().toString(36)}`).replace(/[^\w./-]/g, '-').slice(0, 100);
  return base.startsWith('intelliqe/') ? base : `intelliqe/${base}`;
}

async function openGithubPr(input: RemediationInput): Promise<RemediationResult> {
  const [owner, repo] = String(input.repo).split('/');
  if (!owner || !repo) throw new Error('For GitHub, repo must be "owner/repo".');
  const octokit = new Octokit({ auth: input.token });
  const base = input.baseBranch || (await octokit.repos.get({ owner, repo })).data.default_branch;
  const baseRef = await octokit.repos.getBranch({ owner, repo, branch: base });
  const baseSha = baseRef.data.commit.sha;
  const branch = safeBranch(input.branch);
  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });

  let committed = 0;
  for (const f of input.files.slice(0, 50)) {
    let sha: string | undefined;
    try { const ex = await octokit.repos.getContent({ owner, repo, path: f.path, ref: branch }); if (!Array.isArray(ex.data) && 'sha' in ex.data) sha = ex.data.sha; } catch { /* new file */ }
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: f.path, branch,
      message: `chore(intelliqe): ${input.title}`.slice(0, 100),
      content: Buffer.from(f.content, 'utf-8').toString('base64'),
      ...(sha ? { sha } : {}),
    });
    committed++;
  }
  const pr = await octokit.pulls.create({ owner, repo, title: input.title.slice(0, 200), head: branch, base, body: input.body || 'Automated maintenance changeset from IntelliQE.' });
  return { url: pr.data.html_url, branch, provider: 'github', filesCommitted: committed };
}

async function openGitlabMr(input: RemediationInput): Promise<RemediationResult> {
  const api = new Gitlab({ token: input.token, host: input.host || 'https://gitlab.com' });
  const projectId: string | number = /^\d+$/.test(input.repo) ? Number(input.repo) : input.repo;
  const project: any = await api.Projects.show(projectId);
  const base = input.baseBranch || project.default_branch || 'main';
  const branch = safeBranch(input.branch);
  await api.Branches.create(projectId, branch, base);

  // Decide create vs update per file.
  const actions: any[] = [];
  for (const f of input.files.slice(0, 50)) {
    let exists = false;
    try { await api.RepositoryFiles.show(projectId, f.path, branch); exists = true; } catch { exists = false; }
    actions.push({ action: exists ? 'update' : 'create', filePath: f.path, content: f.content });
  }
  await api.Commits.create(projectId, branch, `chore(intelliqe): ${input.title}`.slice(0, 100), actions);
  const mr: any = await api.MergeRequests.create(projectId, branch, base, input.title.slice(0, 200), { description: input.body || 'Automated maintenance changeset from IntelliQE.' });
  return { url: mr.web_url, branch, provider: 'gitlab', filesCommitted: actions.length };
}

export async function openRemediationPr(input: RemediationInput): Promise<RemediationResult> {
  if (!input.token) throw new Error('A git access token is required.');
  if (!input.files?.length) throw new Error('No files to commit.');
  if (!input.title) throw new Error('A PR/MR title is required.');
  return input.provider === 'gitlab' ? openGitlabMr(input) : openGithubPr(input);
}
