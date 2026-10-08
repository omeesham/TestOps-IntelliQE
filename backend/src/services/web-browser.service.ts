/**
 * web-browser.service.ts
 * ──────────────────────
 * Shared Playwright launch helpers for the opt-in Web Lab tools (accessibility,
 * visual / cross-browser, responsive, performance). These tools launch their
 * OWN short-lived browser — they live alongside the generate → execute → heal
 * pipeline and never touch it, exactly like the API module's standalone tools.
 *
 * Only Chromium ships installed by default; Firefox/WebKit are optional. When an
 * engine's binary is missing we raise BrowserNotInstalledError so callers can
 * report "run npx playwright install firefox webkit" instead of crashing — we
 * never bundle browser binaries.
 */
import type { Browser, BrowserContext, Page, BrowserContextOptions } from '@playwright/test';

export type WebEngine = 'chromium' | 'firefox' | 'webkit';
export const WEB_ENGINES: WebEngine[] = ['chromium', 'firefox', 'webkit'];
export const ENGINE_LABEL: Record<WebEngine, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit (Safari)' };

export class BrowserNotInstalledError extends Error {
  engine: WebEngine;
  constructor(engine: WebEngine) {
    super(`The ${ENGINE_LABEL[engine]} browser is not installed on the server. Run: npx playwright install ${engine}`);
    this.name = 'BrowserNotInstalledError';
    this.engine = engine;
  }
}

function looksMissing(err: unknown): boolean {
  const m = String((err as Error)?.message || err || '');
  return /Executable doesn't exist|playwright install|browserType\.launch.*ENOENT|Failed to launch/i.test(m);
}

/** Validate a target URL — http(s) only, absolute. Blocks obvious non-web schemes. */
export function assertWebUrl(raw: unknown): string {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full absolute URL, e.g. https://app.example.com');
  try { new URL(url); } catch { throw new Error('That is not a valid URL.'); }
  return url.slice(0, 4000);
}

export async function launchBrowser(engine: WebEngine): Promise<Browser> {
  const pw = await import('@playwright/test');
  const bt = pw[engine];
  try {
    return await bt.launch({ headless: true });
  } catch (err) {
    if (looksMissing(err)) throw new BrowserNotInstalledError(engine);
    throw err;
  }
}

export interface WithPageOptions {
  engine?: WebEngine;
  context?: BrowserContextOptions;
  /** Record a video of the session into this dir (needs ffmpeg, which ships). */
  recordVideoDir?: string;
  gotoTimeoutMs?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

/** Launch → new context + page → navigate → run fn → always tear down. */
export async function withPage<T>(
  url: string,
  fn: (page: Page, ctx: { browser: Browser; context: BrowserContext }) => Promise<T>,
  opts: WithPageOptions = {},
): Promise<T> {
  const engine = opts.engine || 'chromium';
  const browser = await launchBrowser(engine);
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      ...(opts.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir } } : {}),
      ...opts.context,
    });
    const page = await context.newPage();
    await page.goto(url, { timeout: opts.gotoTimeoutMs ?? 30_000, waitUntil: opts.waitUntil ?? 'domcontentloaded' });
    return await fn(page, { browser, context });
  } finally {
    try { await context?.close(); } catch { /* ignore */ }
    try { await browser.close(); } catch { /* ignore */ }
  }
}
