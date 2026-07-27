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
import { collectClientDeliverableBundle, ciWorkflowFile, CI_WORKFLOW_PATH } from '../services/client-deliverable.service.js';
import { buildTestCaseDocs } from '../services/test-case-doc.service.js';

/**
 * Repo-name fragments that identify the IntelliQE FRAMEWORK monorepo. Pushing a
 * client deliverable there would expose framework IP, so we refuse it. Override
 * via FRAMEWORK_REPO_GUARD (comma-separated) for differently-named forks.
 */
const FRAMEWORK_REPO_MARKERS = (process.env.FRAMEWORK_REPO_GUARD || 'jbsintelliqe,intelliqe-framework')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
    scriptsPath: String(cfg.scripts_path || cfg.scriptsPath || '').trim() || undefined,
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
      pageObjects: requestedPageObjects,
      testCases: requestedTestCases,
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

    // 2b. IP guard — refuse to publish into the IntelliQE framework monorepo.
    // The client deliverable must go to a DEDICATED client repository; pushing
    // it into the framework repo would expose proprietary internals.
    const repoNameLower = String(coords.repo || '').toLowerCase();
    if (FRAMEWORK_REPO_MARKERS.some((m) => repoNameLower.includes(m))) {
      res.status(400).json({
        error:
          `Refusing to publish into "${coords.owner}/${coords.repo}" — this looks like the IntelliQE framework repository. ` +
          `Configure a DEDICATED client repository under System Configuration → Code Repositories so framework IP is never exposed.`,
      });
      return;
    }

    // 3. Build the commit payload = the IP-safe client-deliverable runner
    // package + the generated test specs. ONLY this self-contained package is
    // published — never the framework.
    // Bundle the static runner package (config, utils, package.json, README,
    // .env.example). Best-effort: if unavailable at runtime, we still publish
    // the specs so the client at least receives the tests.
    const bundle = await collectClientDeliverableBundle();
    // When the runner package is bundled, specs MUST go in `tests/` because the
    // package's playwright.config.ts hardcodes testDir '../tests'. Only honor a
    // custom path in the specs-only fallback (no package present).
    const dir = (bundle.length > 0 ? 'tests' : (requestedDir || config.scriptsPath || 'tests'))
      .replace(/^\/+|\/+$/g, '');
    const cleanRel = (p: string) => p.replace(/^\/+/, '').replace(/\.\.+/g, '_').replace(/\\/g, '/').replace(/\s+/g, '-');
    // Specs honor their POM `path` (tests/<module>/<name>.spec.ts) when present.
    const specFiles: GitFile[] = scripts.map((s: any, i: number) => {
      const declared = typeof s.path === 'string' && s.path.trim()
        ? cleanRel(s.path)
        : `${dir}/${cleanRel(String(s.fileName || `test-${i + 1}.spec.ts`))}`;
      return { path: declared, content: String(s.code || '') };
    });
    // Generated page objects (POM) at their declared src/pages/... paths.
    const pageObjectFiles: GitFile[] = Array.isArray(requestedPageObjects)
      ? requestedPageObjects
          .filter((p: any) => p && typeof p.path === 'string' && typeof p.code === 'string')
          .map((p: any) => ({ path: cleanRel(p.path), content: String(p.code || '') }))
      : [];
    // Test-case documentation (Markdown + CSV) under docs/, so the client gets
    // the human-readable test cases alongside the automation.
    const docFiles: GitFile[] = buildTestCaseDocs(Array.isArray(requestedTestCases) ? requestedTestCases : []);

    // Assemble scaffold + page objects + specs + docs; dedup by path (later wins
    // so a generated file overrides a same-named scaffold placeholder if any).
    const byPath = new Map<string, GitFile>();
    for (const f of [...bundle, ...pageObjectFiles, ...specFiles, ...docFiles]) byPath.set(f.path, f);
    // Guarantee the CI/CD workflow ships even when the on-disk deliverable
    // package isn't available at runtime (specs-only fallback) — so the client
    // repo always gets .github/workflows/playwright.yml to run the suite in
    // GitHub Actions on every push/PR.
    if (!byPath.has(CI_WORKFLOW_PATH)) {
      const wf = ciWorkflowFile();
      byPath.set(wf.path, wf);
    }
    const files: GitFile[] = [...byPath.values()];
    console.log(`[git.publish] deliverable = ${bundle.length} scaffold + ${pageObjectFiles.length} page object(s) + ${specFiles.length} spec(s) + ${docFiles.length} doc(s) + CI workflow`);

    // 4. Defaults — branch name, PR title, commit message, PR body.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const branch = (requestedBranch && String(requestedBranch).trim()) || `intelliqe/tests-${ts}`;
    const title = (requestedTitle && String(requestedTitle).trim())
      || `IntelliQE: ${specFiles.length} generated test script(s)${testRunId ? ` (run ${testRunId})` : ''}`;
    const commitMessage = (requestedCommitMessage && String(requestedCommitMessage).trim()) || title;
    const body = (requestedDescription && String(requestedDescription).trim()) || buildDefaultPrBody(specFiles, { testRunId, username: user.username });

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

/**
 * POST /api/git/test
 * Read-only connectivity check. Verifies the token can reach the repo and
 * that the configured default branch exists — WITHOUT creating any branch,
 * commit or PR. Accepts either:
 *   - form values being entered:  { repo_url, branch, access_token, username }
 *   - a saved integration:        { integrationId }  (or nothing → auto-detect)
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { repo_url, repoUrl, branch, access_token, accessToken, username, app_password, integrationId } = req.body || {};

    // Prefer explicitly-entered form values (testing before saving); otherwise
    // fall back to the stored, connected integration.
    const enteredUrl = String(repo_url || repoUrl || '').trim();
    const enteredToken = String(access_token || accessToken || app_password || '').trim();

    let config: GitProviderConfig;
    if (enteredUrl && enteredToken) {
      config = {
        repoUrl: enteredUrl,
        defaultBranch: String(branch || 'main').trim() || 'main',
        accessToken: enteredToken,
        username: username ? String(username).trim() : undefined,
      };
    } else {
      const loaded = await loadGitConfig(user.tenantId, integrationId);
      if (!loaded) {
        res.status(400).json({ ok: false, error: 'No connected git-repo integration found, and no repository URL/token was provided.' });
        return;
      }
      config = loaded.config;
    }

    if (!config.repoUrl) { res.status(400).json({ ok: false, error: 'Repository URL is required.' }); return; }
    if (!config.accessToken) { res.status(400).json({ ok: false, error: 'Access token is required.' }); return; }

    const coords = parseRepoUrl(config.repoUrl);
    const provider = PROVIDERS[coords.provider];
    if (!provider) { res.status(400).json({ ok: false, error: `No provider implementation for ${coords.provider}` }); return; }

    const result = await provider.test(config);
    res.json(result);
  } catch (err: any) {
    // A failed test is an expected outcome, not a server error — return 200 with
    // ok:false so the modal can render the reason inline.
    res.json({ ok: false, error: err?.message || 'Connection test failed.' });
  }
});

function buildDefaultPrBody(files: GitFile[], opts: { testRunId?: string; username: string }): string {
  const lines: string[] = [];
  lines.push('## IntelliQE — generated Playwright test package');
  lines.push('');
  lines.push(`Generated by **${opts.username}** via JBS IntelliQE.`);
  if (opts.testRunId) lines.push(`Test run: \`${opts.testRunId}\``);
  lines.push('');
  lines.push('This PR delivers a self-contained, runnable Playwright suite:');
  lines.push('- **Test scripts** (`tests/**/*.spec.ts`) and **page objects / POM** (`src/pages/**`)');
  lines.push('- **Runner config** — `package.json`, `playwright.config.ts`, `tsconfig.json`, `.env.example`');
  lines.push('- **Test-case docs** (`docs/`) and sample **test data** (`src/data/`)');
  lines.push('- **CI/CD** — `.github/workflows/playwright.yml` runs the suite on every push/PR');
  lines.push('');
  lines.push(`### Files (${files.length})`);
  for (const f of files.slice(0, 50)) {
    lines.push(`- \`${f.path}\``);
  }
  if (files.length > 50) lines.push(`- _…and ${files.length - 50} more_`);
  lines.push('');
  lines.push('### To run the suite');
  lines.push('1. Add a `BASE_URL` secret (and `APP_USERNAME` / `APP_PASSWORD` if your tests log in) under **Settings → Secrets and variables → Actions**.');
  lines.push('2. GitHub Actions runs `npx playwright test` automatically — or run locally: `npm install && npx playwright install && npx playwright test`.');
  lines.push('');
  lines.push('### Review checklist');
  lines.push('- [ ] Scripts compile (`npx playwright test --list`)');
  lines.push('- [ ] Selectors look stable (no brittle CSS)');
  lines.push('- [ ] Test data uses environment-appropriate fixtures');
  lines.push('- [ ] No credentials in committed files');
  return lines.join('\n');
}

export default router;
