/**
 * git.types.ts
 * ────────────
 * Provider-agnostic types shared by every git provider (GitHub, GitLab,
 * Bitbucket). The git.routes.ts handler programs to this interface so
 * adding a fourth provider later is just a matter of writing one more
 * file in this directory.
 */

/** A single file to commit. `path` is repo-relative (e.g., "tests/login.spec.ts"). */
export interface GitFile {
  path: string;
  content: string;
}

/** Decrypted configuration values pulled from `client_configurations`. */
export interface GitProviderConfig {
  /** Full repo URL — e.g., https://github.com/org/repo or https://gitlab.com/group/sub/repo */
  repoUrl: string;
  /** Default branch (target of the PR) — e.g., "main" or "master" */
  defaultBranch: string;
  /** Personal Access Token (decrypted) */
  accessToken: string;
  /** Bitbucket-only: workspace username for Basic auth */
  username?: string;
  /** Optional repo subdirectory the generated scripts are committed into
   *  (e.g. "tests/e2e"). Defaults to "tests" when unset. */
  scriptsPath?: string;
}

/** Result of a read-only connectivity test (no branch/PR is created). */
export interface GitTestResult {
  ok: boolean;
  /** Human-readable summary shown in the UI. */
  message: string;
  /** Whether the token has push/write access (when the provider can tell). */
  canPush?: boolean;
}

/** Result of a successful publish. */
export interface PublishResult {
  provider: 'github' | 'gitlab' | 'bitbucket';
  /** PR/MR URL for the 'pr' mode; a browse URL for the pushed code in 'commit' mode. */
  prUrl: string;
  /** PR/MR number for the 'pr' mode; 0 for a direct commit (no PR is opened). */
  prNumber: number;
  branch: string;
  /** Files actually committed (provider may dedupe or skip empty entries) */
  fileCount: number;
  /** How the code was delivered: 'pr' = branch + PR (default), 'commit' = straight to the default branch. */
  mode?: 'pr' | 'commit';
}

/**
 * Common interface — every provider must implement this. The git
 * route invokes `publish(config, files, opts)` and gets back a
 * PublishResult or throws an Error with a clear message.
 */
export interface GitProvider {
  /** Provider identifier used in the response so the UI can label it. */
  readonly id: 'github' | 'gitlab' | 'bitbucket';

  /**
   * Create a branch off `defaultBranch`, commit `files` under `tests/`
   * (or the supplied subdirectory) on that branch, and open a PR/MR
   * back to `defaultBranch`.
   */
  publish(
    config: GitProviderConfig,
    files: GitFile[],
    opts: {
      branch: string;
      title: string;
      body: string;
      commitMessage: string;
      /** When true, commit `files` directly onto `defaultBranch` — no new branch,
       *  no PR. When false/undefined (default), create `branch` + open a PR. */
      directCommit?: boolean;
    },
  ): Promise<PublishResult>;

  /**
   * Read-only connectivity check: verify the token can reach the repo and
   * that `defaultBranch` exists — WITHOUT creating any branch, commit or PR.
   * Throws with a clear message on failure (bad token, repo not found,
   * missing branch); returns a GitTestResult on success.
   */
  test(config: GitProviderConfig): Promise<GitTestResult>;
}

/**
 * Parse a repository URL into provider + owner + repo parts. Throws if
 * the URL isn't recognisable. Used by the route to pick the provider
 * even when the user has multiple integrations connected.
 */
export interface RepoCoords {
  provider: 'github' | 'gitlab' | 'bitbucket';
  /** GitHub owner / GitLab group(+subgroups) / Bitbucket workspace */
  owner: string;
  /** Repository / project slug */
  repo: string;
  /** GitLab only — the URL-encoded "group/subgroup/repo" form needed for API calls */
  projectPath?: string;
  /** Host name (api.github.com, gitlab.com, bitbucket.org, or self-hosted) */
  host: string;
}

export function parseRepoUrl(repoUrl: string): RepoCoords {
  if (!repoUrl) throw new Error('Repository URL is empty');
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }
  const host = url.host;
  // Strip leading slash, trailing slash, and any trailing ".git".
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Repository URL must include owner and repo: ${repoUrl}`);
  }

  if (host === 'github.com' || host.endsWith('.github.com')) {
    return { provider: 'github', owner: parts[0]!, repo: parts[1]!, host };
  }
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) {
    return { provider: 'bitbucket', owner: parts[0]!, repo: parts[1]!, host };
  }
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com') || host.includes('gitlab')) {
    // GitLab supports nested subgroups: group/subgroup/.../project
    const owner = parts.slice(0, -1).join('/');
    const repo = parts[parts.length - 1]!;
    return { provider: 'gitlab', owner, repo, projectPath: path, host };
  }
  throw new Error(`Unsupported git host: ${host}. Supported: github.com, gitlab.com, bitbucket.org.`);
}
