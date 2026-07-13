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
