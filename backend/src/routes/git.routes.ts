/**
 * git.routes.ts
 * ─────────────
 * Real Git PR creation — replaces the old fake "Pull request created
 * successfully" lie from the frontend's handlePublishToGit.
 *
 *   POST /api/git/publish
 *     body: {
 *       branch?:           string   // optional — defaults to "intelliqe/tests-<timestamp>"
 *       title?:             string  // PR title; default generated from run id
 *       description?:       string  // PR body; default lists files + run info
 *       commitMessage?:     string  // commit message; default = title
 *       scripts:            { fileName: string; code: string }[]
 *       directory?:         string  // repo subdirectory; default "tests/"
 *       testRunId?:         string  // for PR body context
 *       integrationId?:     'github' | 'gitlab' | 'bitbucket'  // override auto-detect
 *     }
 *     resp: { provider, prUrl, prNumber, branch, fileCount }
 *
 * Credentials are read from `client_configurations` for the user's
 * tenant, scoped to category `'git-repo'`. The provider is auto-detected
 * from the repo URL host (or honoured from `integrationId` if supplied).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { decryptConfigData } from '../utils/crypto.js';
import { parseRepoUrl, type GitProvider, type GitFile, type GitProviderConfig } from '../services/git/git.types.js';
import { githubProvider } from '../services/git/github.provider.js';
import { gitlabProvider } from '../services/git/gitlab.provider.js';
import { bitbucketProvider } from '../services/git/bitbucket.provider.js';

const router = Router();

const PROVIDERS: Record<string, GitProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
};

/**
 * Look up the user's connected git-repo integration. We prefer an
 * explicit integrationId (when the caller passes one) over auto-detect
 * so the user can pick which connection to use if they have several.
 */
async function loadGitConfig(
  tenantId: string,
  preferred?: string,
): Promise<{ integrationId: string; config: GitProviderConfig } | null> {
  // 1. Try the preferred integration first.
  if (preferred) {
    const r = await pool.query(
      `SELECT integration_id, config_data FROM client_configurations
        WHERE tenant_id = $1 AND integration_id = $2 AND status = 'connected'`,
      [tenantId, preferred],
    );
    if (r.rows.length > 0) {
      const cfg = decryptConfigData(r.rows[0].config_data);
      return { integrationId: r.rows[0].integration_id, config: cfgToProvider(cfg) };
    }
  }
  // 2. Fall back to any connected git-repo integration.
  const r = await pool.query(
    `SELECT integration_id, config_data FROM client_configurations
      WHERE tenant_id = $1
        AND integration_id IN ('github','gitlab','bitbucket')
        AND status = 'connected'
      ORDER BY connected_at DESC
      LIMIT 1`,
    [tenantId],
  );
  if (r.rows.length === 0) return null;
  const cfg = decryptConfigData(r.rows[0].config_data);
  return { integrationId: r.rows[0].integration_id, config: cfgToProvider(cfg) };
}

/** Translate the stored config_data shape into the provider-neutral GitProviderConfig. */
function cfgToProvider(cfg: Record<string, any>): GitProviderConfig {
  return {
    repoUrl: String(cfg.repo_url || cfg.repoUrl || '').trim(),
    defaultBranch: String(cfg.branch || cfg.default_branch || 'main').trim(),
    accessToken: String(cfg.access_token || cfg.accessToken || cfg.app_password || '').trim(),
    username: cfg.username ? String(cfg.username).trim() : undefined,
  };
}

router.post('/publish', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const {
      branch: requestedBranch,
      title: requestedTitle,
      description: requestedDescription,
      commitMessage: requestedCommitMessage,
      scripts,
      directory: requestedDir,
      testRunId,
      integrationId,
    } = req.body;

    if (!Array.isArray(scripts) || scripts.length === 0) {
      res.status(400).json({ error: 'At least one script is required to publish.' });
      return;
    }

    // 1. Resolve credentials.
    const loaded = await loadGitConfig(user.tenantId, integrationId);
    if (!loaded) {
      res.status(400).json({
        error: 'No connected git-repo integration found. Connect GitHub, GitLab, or Bitbucket in System Configuration first.',
      });
      return;
    }
    const { integrationId: resolvedIntegrationId, config } = loaded;

    if (!config.repoUrl) {
      res.status(400).json({ error: 'Connected integration is missing the repository URL.' });
      return;
    }
    if (!config.accessToken) {
      res.status(400).json({ error: 'Connected integration is missing the access token.' });
      return;
    }

    // 2. Pick the provider. Use the URL's host as authoritative source —
    // if the user connected as "github" but pasted a GitLab URL by
    // mistake, we trust the URL and surface a friendly mismatch error.
    const coords = parseRepoUrl(config.repoUrl);
    const provider = PROVIDERS[coords.provider];
    if (!provider) {
      res.status(400).json({ error: `No provider implementation for ${coords.provider}` });
      return;
    }
    if (resolvedIntegrationId !== coords.provider) {
      console.warn(
        `[git.publish] Integration mismatch: connected as ${resolvedIntegrationId}, URL is ${coords.provider}. Using ${coords.provider}.`,
      );
    }

    // 3. Build commit payload. Files are placed under the requested
    // subdirectory (default "tests/"). File names are sanitised so we
    // never end up with directory traversal or empty path segments.
    const dir = (requestedDir || 'tests').replace(/^\/+|\/+$/g, '');
    const files: GitFile[] = scripts.map((s: any, i: number) => {
      const raw = String(s.fileName || `test-${i + 1}.spec.ts`).trim();
      const cleaned = raw.replace(/^\/+/, '').replace(/\.\.+/g, '_').replace(/\s+/g, '-');
      return {
        path: `${dir}/${cleaned}`,
        content: String(s.code || ''),
      };
    });

    // 4. Defaults — branch name, PR title, commit message, PR body.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const branch = (requestedBranch && String(requestedBranch).trim()) || `intelliqe/tests-${ts}`;
    const title = (requestedTitle && String(requestedTitle).trim())
      || `IntelliQE: ${files.length} generated test script(s)${testRunId ? ` (run ${testRunId})` : ''}`;
    const commitMessage = (requestedCommitMessage && String(requestedCommitMessage).trim()) || title;
    const body = (requestedDescription && String(requestedDescription).trim()) || buildDefaultPrBody(files, { testRunId, username: user.username });

    // 5. Publish.
    const result = await provider.publish(config, files, { branch, title, body, commitMessage });

    // 6. Bump last_sync_at so the UI shows a fresh connection timestamp.
    await pool.query(
      `UPDATE client_configurations SET last_sync_at = NOW() WHERE tenant_id = $1 AND integration_id = $2`,
      [user.tenantId, resolvedIntegrationId],
    );

    console.log(`[git.publish] ${user.username} (tenant=${user.tenantId}) published ${result.fileCount} file(s) to ${result.provider}: ${result.prUrl}`);
    res.json(result);
  } catch (err: any) {
    const msg = err?.message || 'Git publish failed';
    console.error('[git.publish] Error:', msg);
    // Map authn/permission failures to 4xx so the UI shows a sensible error.
    const lower = msg.toLowerCase();
    const status = lower.includes('unauthor') || lower.includes('authentication') || lower.includes('forbidden') || lower.includes('401') || lower.includes('403')
      ? 401
      : lower.includes('already exists') || lower.includes('not found') || lower.includes('missing') || lower.includes('invalid')
        ? 400
        : 500;
    res.status(status).json({ error: msg });
  }
});

function buildDefaultPrBody(files: GitFile[], opts: { testRunId?: string; username: string }): string {
  const lines: string[] = [];
  lines.push('## IntelliQE — generated test scripts');
  lines.push('');
  lines.push(`Generated by **${opts.username}** via JBS IntelliQE.`);
  if (opts.testRunId) lines.push(`Test run: \`${opts.testRunId}\``);
  lines.push('');
  lines.push(`### Files (${files.length})`);
  for (const f of files.slice(0, 50)) {
    lines.push(`- \`${f.path}\``);
  }
  if (files.length > 50) lines.push(`- _…and ${files.length - 50} more_`);
  lines.push('');
  lines.push('### Review checklist');
  lines.push('- [ ] Scripts compile (`npx playwright test --list`)');
  lines.push('- [ ] Selectors look stable (no brittle CSS)');
  lines.push('- [ ] Test data uses environment-appropriate fixtures');
  lines.push('- [ ] No credentials in committed files');
  return lines.join('\n');
}

export default router;
