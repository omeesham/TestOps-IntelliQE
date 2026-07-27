/**
 * client-deliverable.service.ts
 * ─────────────────────────────
 * Assembles the IP-safe "client deliverable" — the self-contained Playwright
 * runner package under `client-deliverable/src` (package.json, config, utils,
 * .env.example, README) — for publishing to a client repository.
 *
 * CRITICAL: this package contains NO framework internals (no backend/, no
 * agents, no orchestrator, no credentials). It is the ONLY thing that may be
 * pushed to a client repo. The generated `.spec.ts` files are dropped into its
 * `tests/` folder by the publish route; everything else here is the static,
 * environment-agnostic harness the client runs.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GitFile } from './git/git.types.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Location of the deliverable runner package (the TypeScript `src` build).
// Overridable for containerized deployments where the repo layout differs.
export const CLIENT_DELIVERABLE_DIR =
  process.env.CLIENT_DELIVERABLE_DIR || path.resolve(BACKEND_ROOT, '..', 'client-deliverable', 'src');

// Never shipped: the placeholder smoke test (replaced by the generated specs),
// any real env file, and dependency/build/VCS directories.
const EXCLUDE_FILES = new Set(['tests/example.spec.ts', '.env']);
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'reports', 'test-results', 'playwright-report']);

async function walk(dir: string, rel: string, out: { rel: string; abs: string }[]): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist at runtime — caller handles the empty result
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) await walk(path.join(dir, e.name), childRel, out);
    } else if (!EXCLUDE_FILES.has(childRel)) {
      out.push({ rel: childRel, abs: path.join(dir, e.name) });
    }
  }
}

/** Path of the CI/CD workflow inside the deliverable / client repo. */
export const CI_WORKFLOW_PATH = '.github/workflows/playwright.yml';

/**
 * Canonical GitHub Actions workflow for the generated Playwright suite. The
 * on-disk deliverable ships an identical copy; this constant is the guaranteed
 * fallback so the CI file is ALWAYS published — even in the specs-only path
 * where the on-disk package isn't available at runtime.
 */
export const CI_WORKFLOW_CONTENT = `name: Playwright Tests

# CI/CD for the IntelliQE-generated Playwright suite.
# Runs on every push / pull request to the main branch, and on demand.
on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
  workflow_dispatch:

jobs:
  test:
    name: Run Playwright tests
    timeout-minutes: 60
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      # No lockfile is shipped, so fall back to \`npm install\`.
      - name: Install dependencies
        run: npm ci || npm install

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run Playwright tests
        run: npx playwright test
        env:
          # Provide these under Settings → Secrets and variables → Actions.
          BASE_URL: \${{ secrets.BASE_URL }}
          APP_USERNAME: \${{ secrets.APP_USERNAME }}
          APP_PASSWORD: \${{ secrets.APP_PASSWORD }}
          HEADLESS: 'true'
          CI: 'true'

      - name: Upload HTML report
        uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: reports/
          retention-days: 30
`;

/** The CI workflow as a GitFile, for guaranteed inclusion in a publish. */
export function ciWorkflowFile(): GitFile {
  return { path: CI_WORKFLOW_PATH, content: CI_WORKFLOW_CONTENT };
}

/**
 * Read the client-deliverable runner package from disk and return it as
 * GitFile[] with repo-relative paths (e.g. `config/env.ts`, `package.json`).
 * Returns [] (with a warning) if the package isn't present at runtime so the
 * caller can fall back to publishing the generated specs alone.
 */
export async function collectClientDeliverableBundle(): Promise<GitFile[]> {
  const found: { rel: string; abs: string }[] = [];
  await walk(CLIENT_DELIVERABLE_DIR, '', found);
  if (found.length === 0) {
    console.warn(
      `[client-deliverable] runner package not found at ${CLIENT_DELIVERABLE_DIR} — publishing generated specs only. ` +
        `Set CLIENT_DELIVERABLE_DIR if the deployment layout differs.`,
    );
    return [];
  }
  const files: GitFile[] = [];
  for (const f of found) {
    files.push({ path: f.rel, content: await fs.readFile(f.abs, 'utf-8') });
  }
  return files;
}
