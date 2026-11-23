/**
 * api-git-assemble.ts
 * ───────────────────
 * Pure assembly of the files an API-automation code push commits. Kept DB-free
 * so it is directly unit-testable: given scripts / pre-pathed files / the API
 * catalogue, it produces the `GitFile[]` to hand to a git provider, with path
 * traversal stripped and bare names placed under the scripts folder.
 */
import type { GitFile } from '../services/git/git.types.js';

export interface ApiPublishScript { fileName?: string; path?: string; code?: string; content?: string }

export interface ApiPublishInput {
  integrationId?: string;
  scripts?: ApiPublishScript[];
  /** Pre-pathed files (path + content), kept as given when they carry a folder. */
  files?: { path: string; content: string }[];
  /** The API catalogue JSON to ship as test-as-code (optional). */
  catalogue?: string;
  /** Repo subdirectory for bare-name scripts (default "tests/api"). */
  scriptsPath?: string;
  branch?: string;
  mode?: 'pr' | 'direct';
  title?: string;
  body?: string;
  commitMessage?: string;
}

/** Strip path traversal and leading slashes so a file can only land where intended. */
export function safeRel(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * Assemble the files to commit. Scripts and relative bare-name files land under
 * `base`; a path that already carries a folder is honoured (sanitised); the
 * catalogue, when present, ships at `<base>/api-catalogue.json`. Deduped by path
 * (last write wins).
 */
export function assembleApiFiles(input: ApiPublishInput, base = 'tests/api'): GitFile[] {
  const root = safeRel(input.scriptsPath || base) || 'tests/api';
  const byPath = new Map<string, string>();

  const put = (rawPath: string, content: string) => {
    const rel = safeRel(rawPath);
    if (!rel) return;
    const path = rel.includes('/') ? rel : `${root}/${rel}`;
    byPath.set(path, content);
  };

  for (const s of input.scripts || []) {
    const name = s.fileName || s.path;
    const code = s.code ?? s.content;
    if (!name || code == null) continue;
    put(name, String(code));
  }
  for (const f of input.files || []) {
    if (!f || !f.path || f.content == null) continue;
    put(f.path, String(f.content));
  }
  if (typeof input.catalogue === 'string' && input.catalogue.trim()) {
    byPath.set(`${root}/api-catalogue.json`, input.catalogue);
  }

  return [...byPath.entries()].map(([path, content]) => ({ path, content }));
}
