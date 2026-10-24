/**
 * uat-safety.service
 * ──────────────────
 * Read-only protection for applications tested in SHARED environments (a UAT
 * or staging used by other teams), switched on per environment in
 * Application Setup. Off by default.
 *
 * When an environment is read-only, nothing IntelliQE drives may change its
 * data:
 *   - Browsers the backend drives itself (explore) get a write-blocking route
 *     on their context (applyWriteGuard).
 *   - Test runs import `test` from a guard fixture written into the run
 *     workspace instead of '@playwright/test' (guardSpec rewrites the import);
 *     the fixture blocks writes and reports what it blocked.
 *
 * It fails CLOSED: a spec that cannot be guarded (it launches its own browser,
 * adds its own routes, or sends writes through an API request context) is not
 * run; it is replaced by a stub that fails with the reason.
 *
 * A write is any request whose method is not GET/HEAD/OPTIONS. Sign-in
 * requests stay allowed (allowWrite), matched by exact path segment ("auth"
 * allows /api/auth/login but not /authors/12), or by path prefix for entries
 * that contain "/".
 *
 * Known limit: WebSocket messages are not inspected.
 */
import fs from 'fs/promises';
import path from 'path';
import type { BrowserContext, Route } from '@playwright/test';

export interface SafetySettings {
  /** Block every write request (POST/PUT/PATCH/DELETE…). */
  readOnly: boolean;
  /** Sign-in endpoints still allowed to write: path segments, or path prefixes containing "/". */
  allowWrite: string[];
  /** Optional: on the application's own origin, the browser may open only these path prefixes. */
  allowedPaths: string[];
}

/** Sign-in endpoints allowed to write by default (exact path segments). */
export const DEFAULT_AUTH_ALLOW = ['login', 'logon', 'logout', 'signin', 'sign-in', 'signout', 'sign-out', 'auth', 'oauth', 'oauth2', 'saml', 'sso', 'token'];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 50);
}

/** Safety settings of one environment (`environment.safety`), or undefined when off. */
export function parseSafety(raw: unknown): SafetySettings | undefined {
  const s = raw as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== 'object' || s.readOnly !== true) return undefined;
  const allowWrite = cleanList(s.allowWrite);
  return {
    readOnly: true,
    allowWrite: allowWrite.length ? allowWrite : [...DEFAULT_AUTH_ALLOW],
    allowedPaths: cleanList(s.allowedPaths),
  };
}

/** True when the URL's path matches an entry: a whole path segment, or a path prefix for entries with "/". */
export function pathMatches(url: string, entries: string[]): boolean {
  let pathname: string;
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { return false; }
  const segments = pathname.split('/').filter(Boolean);
  return entries.some((e) => {
    const entry = e.toLowerCase();
    return entry.includes('/') ? pathname.startsWith(entry) : segments.includes(entry);
  });
}

/** Decide one request: null = let it through, otherwise why it is blocked. */
export function blockReason(
  req: { method: string; url: string; isNavigation: boolean },
  safety: SafetySettings,
  appOrigin?: string,
): string | null {
  const method = req.method.toUpperCase();
  const isAuth = pathMatches(req.url, safety.allowWrite);
  if (!READ_METHODS.has(method) && !isAuth) return `write request ${method} ${req.url}`;
  if (req.isNavigation && safety.allowedPaths.length && appOrigin) {
    let u: URL;
    try { u = new URL(req.url); } catch { return null; }
    if (u.origin === appOrigin && !isAuth && !safety.allowedPaths.some((p) => u.pathname.startsWith(p))) {
      return `navigation outside allowed paths: ${req.url}`;
    }
  }
  return null;
}

/** Block writes (and, when configured, out-of-scope navigation) on a context the backend drives. */
export async function applyWriteGuard(context: BrowserContext, safety: SafetySettings | undefined, appUrl?: string): Promise<string[]> {
  const blocked: string[] = [];
  if (!safety?.readOnly) return blocked;
  let appOrigin: string | undefined;
  try { appOrigin = appUrl ? new URL(appUrl).origin : undefined; } catch { appOrigin = undefined; }
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    const reason = blockReason(
      { method: req.method(), url: req.url(), isNavigation: req.isNavigationRequest() && req.resourceType() === 'document' },
      safety,
      appOrigin,
    );
    if (!reason) {
      await route.fallback();
      return;
    }
    blocked.push(reason);
    console.warn(`[read-only] blocked ${reason}`);
    await route.abort('blockedbyclient');
  });
  return blocked;
}

/** Requests made by a service worker bypass context routes, so they are blocked in read-only mode. */
export function guardedContextOptions(safety: SafetySettings | undefined): { serviceWorkers?: 'block' } {
  return safety?.readOnly ? { serviceWorkers: 'block' } : {};
}

/** Env vars the guard fixture reads in a test run. */
export function safetyEnv(safety: SafetySettings, appUrl: string | undefined): Record<string, string> {
  let origin = '';
  try { origin = appUrl ? new URL(appUrl).origin : ''; } catch { origin = ''; }
  return {
    IQE_READ_ONLY: 'true',
    IQE_READ_ONLY_ALLOW: safety.allowWrite.join(','),
    IQE_ALLOWED_PATHS: safety.allowedPaths.join(','),
    IQE_APP_ORIGIN: origin,
  };
}

/** File name of the guard fixture in the run workspace (beside tests/). */
export const GUARD_FIXTURE_FILE = 'iqe-guard.ts';

/**
 * Guard fixture written into a read-only run's workspace. It mirrors
 * pathMatches/blockReason above (kept in sync by test/uat-safety.test.ts).
 */
export const GUARD_FIXTURE_SOURCE = `import { test as base, expect, type APIRequestContext } from '@playwright/test';

const list = (v: string | undefined) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW = list(process.env.IQE_READ_ONLY_ALLOW);
const PATHS = list(process.env.IQE_ALLOWED_PATHS);
const ORIGIN = process.env.IQE_APP_ORIGIN || '';
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export function pathMatches(url: string, entries: string[]): boolean {
  let pathname: string;
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { return false; }
  const segments = pathname.split('/').filter(Boolean);
  return entries.some((e) => {
    const entry = e.toLowerCase();
    return entry.includes('/') ? pathname.startsWith(entry) : segments.includes(entry);
  });
}

export function blockReason(method: string, url: string, isNavigation: boolean): string | null {
  const isAuth = pathMatches(url, ALLOW);
  if (!READ.has(method.toUpperCase()) && !isAuth) return 'write request ' + method.toUpperCase() + ' ' + url;
  if (isNavigation && PATHS.length && ORIGIN) {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.origin === ORIGIN && !isAuth && !PATHS.some((p) => u.pathname.startsWith(p))) return 'navigation outside allowed paths: ' + url;
  }
  return null;
}

/** Read-only guard: blocks writes from the page and the API request context. */
export const test = base.extend<{ iqeReadOnly: void }>({
  // Service worker requests bypass context routes.
  serviceWorkers: async ({}, use) => { await use('block'); },
  iqeReadOnly: [async ({ context }, use, testInfo) => {
    const blocked: string[] = [];
    await context.route('**/*', async (route) => {
      const r = route.request();
      const reason = blockReason(r.method(), r.url(), r.isNavigationRequest() && r.resourceType() === 'document');
      if (!reason) { await route.fallback(); return; }
      blocked.push(reason);
      await route.abort('blockedbyclient');
    });
    await use();
    if (blocked.length) await testInfo.attach('read-only-blocked', { body: blocked.join('\\n'), contentType: 'text/plain' });
  }, { auto: true }],
  request: async ({ request }, use) => {
    const guarded = new Proxy(request, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const method = prop === 'fetch' ? String((args[1] as { method?: string } | undefined)?.method || 'GET')
            : ['post', 'put', 'patch', 'delete'].includes(String(prop)) ? String(prop) : 'GET';
          const reason = blockReason(method, String(args[0]), false);
          if (reason) throw new Error('Blocked by read-only safety: ' + reason);
          return value.apply(target, args);
        };
      },
    }) as APIRequestContext;
    await use(guarded);
  },
});

export { expect };
`;

/** Patterns that escape the fixture's guard; a read-only run refuses such specs. */
const UNGUARDABLE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(chromium|firefox|webkit)\s*\.\s*(launch|launchPersistentContext|connect|connectOverCDP)\s*\(/, reason: 'launches its own browser' },
  { pattern: /\brequest\s*\.\s*newContext\s*\(/, reason: 'creates its own API request context' },
  { pattern: /\.\s*newContext\s*\(/, reason: 'creates its own browser context' },
  { pattern: /\.\s*route(WebSocket)?\s*\(/, reason: 'adds its own network routes' },
  { pattern: /import\s+\*\s+as\s+\w+\s+from\s+['"]@playwright\/test['"]/, reason: 'imports @playwright/test as a namespace' },
  { pattern: /require\(\s*['"]@playwright\/test['"]\s*\)/, reason: 'requires @playwright/test directly' },
  { pattern: /\bserviceWorkers\s*:/, reason: 'changes the service worker setting' },
];

export interface GuardedSpec {
  ok: boolean;
  code: string;
  /** Why the spec could not be guarded (ok = false). */
  reason?: string;
}

/**
 * Make a spec in <workspace>/tests use the guard fixture: `test` and `expect`
 * imported from '@playwright/test' are re-pointed to ../iqe-guard; other named
 * imports (types like Page) stay where they were.
 */
export function guardSpec(code: string): GuardedSpec {
  for (const u of UNGUARDABLE) {
    if (u.pattern.test(code)) return { ok: false, code, reason: `spec ${u.reason}` };
  }
  const fixture = `../${GUARD_FIXTURE_FILE.replace(/\.ts$/, '')}`;
  let found = false;
  const out = code.replace(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@playwright\/test['"]\s*;?/g,
    (whole, typeOnly: string | undefined, members: string) => {
      if (typeOnly) return whole;
      const parts = members.split(',').map((m) => m.trim()).filter(Boolean);
      const guarded = parts.filter((m) => /^(test|expect)(\s+as\s+\w+)?$/.test(m));
      if (!guarded.length) return whole;
      found = true;
      const rest = parts.filter((m) => !guarded.includes(m));
      const lines = [`import { ${guarded.join(', ')} } from '${fixture}';`];
      if (rest.length) lines.push(`import { ${rest.join(', ')} } from '@playwright/test';`);
      return lines.join('\n');
    },
  );
  if (!found) return { ok: false, code, reason: 'spec does not import test from @playwright/test' };
  return { ok: true, code: out };
}

/** A spec that loads and fails honestly, used when a spec cannot be guarded. */
export function unguardedStub(title: string, reason: string): string {
  const msg = `Not run: this environment is read-only and the ${reason}. Regenerate the script.`;
  return `import { test, expect } from '@playwright/test';\n\n`
    + `test(${JSON.stringify(`${title} — blocked by read-only safety`)}, async () => {\n`
    + `  expect(false, ${JSON.stringify(msg)}).toBe(true);\n`
    + `});\n`;
}

/**
 * Error of a failed test (Playwright JSON result), led by what the read-only
 * guard blocked during it, so the run shows why a write-dependent test failed.
 */
export function errorWithBlocked(result: { error?: { message?: string }; attachments?: { name?: string; body?: string }[] } | undefined): string | undefined {
  const message = result?.error?.message;
  const blocked = result?.attachments?.find((a) => a.name === 'read-only-blocked')?.body;
  if (!blocked) return message;
  return `Read-only environment blocked:\n${Buffer.from(blocked, 'base64').toString('utf-8')}\n\n${message || ''}`.trim();
}

/** A spec as a read-only run must run it: guarded, or a failing stub. Unchanged when not read-only. */
export function specForRun(code: string, title: string, safety: SafetySettings | undefined): string {
  if (!safety?.readOnly) return code;
  const g = guardSpec(code);
  return g.ok ? g.code : unguardedStub(title, g.reason || 'spec cannot be guarded');
}

/**
 * Write the guard fixture into a read-only run's workspace and return the env
 * vars it reads ({} when off). Throws when the fixture cannot be written, so a
 * read-only run never goes ahead unguarded.
 */
export async function prepareGuardedRun(workspace: string, safety: SafetySettings | undefined, appUrl: string | undefined): Promise<Record<string, string>> {
  if (!safety?.readOnly) return {};
  await fs.writeFile(path.join(workspace, GUARD_FIXTURE_FILE), GUARD_FIXTURE_SOURCE, 'utf-8');
  return safetyEnv(safety, appUrl);
}
