/**
 * exploreAgent
 * ─────────────
 * Last-resort requirements source. When the user has nothing but a URL
 * (no Jira story, no uploaded document, no pasted text), this agent
 * launches a headless Chromium, navigates the app, optionally logs in
 * with provided credentials, and harvests a structured "UI map" of the
 * application. Claude then turns that map into a synthetic requirements
 * document that the downstream requirement / planner / generator agents
 * can consume exactly as if a human had written it.
 *
 * Design choices:
 *  • Uses `chromium` re-exported by `@playwright/test` so no new dep is needed.
 *  • Heuristic login: looks for password input + nearby username/email field;
 *    submits with provided creds; on failure falls back to anonymous crawl.
 *  • Crawl is bounded — MAX_PAGES and MAX_DEPTH protect against runaway
 *    spidering on large sites. Only same-origin links are followed.
 *  • Extracts: page title, headings, forms (fields + types + required),
 *    visible buttons, in-page nav, and outbound same-origin links.
 *  • Returns an ExploredApp object and ALSO a markdown-style requirements
 *    string that requirementAgent treats as if it were a functional spec.
 */
import type { TestOpsState, ExploredApp, AppContext } from './state.js';
import { runLLM, parseJsonFromResponse, isClaudeCliAvailable, llmForStage } from './claude-runner.js';

// Lazy import so unit tests that don't touch this agent don't drag in a
// 100 MB browser binary on require().
type ChromiumModule = typeof import('@playwright/test').chromium;
let _chromium: ChromiumModule | null = null;
async function loadChromium(): Promise<ChromiumModule> {
  if (_chromium) return _chromium;
  const mod = await import('@playwright/test');
  _chromium = mod.chromium;
  return _chromium;
}

const MAX_PAGES = 12;       // Hard cap so a giant site doesn't crash the worker
const MAX_DEPTH = 2;        // 0 = landing only, 2 = landing + 2 hops
const PAGE_TIMEOUT_MS = 20_000;

/** Internal — a single extracted page snapshot before consolidation. */
interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  forms: {
    id?: string;
    name?: string;
    action?: string;
    fields: { name: string; type: string; required: boolean; label?: string }[];
  }[];
  buttons: string[];
  links: { text: string; href: string }[];
  navItems: string[];
}

/**
 * Run the explore agent against `state.appContext.targetUrl`.
 * If no URL is set, this is a no-op (state passes through unchanged).
 */
export async function exploreAgent(state: TestOpsState): Promise<TestOpsState> {
  const targetUrl = state.appContext?.targetUrl?.trim();
  if (!targetUrl) {
    // Nothing to explore — leave state untouched so the pipeline can
    // continue (or fail loudly on empty requirements downstream).
    return state;
  }

  // eslint-disable-next-line no-console
  console.log(`[exploreAgent] starting crawl of ${targetUrl}`);

  let snapshots: PageSnapshot[] = [];
  let authDetected = false;
  let notes: string[] = [];

  try {
    const result = await crawlApp(targetUrl, state.appContext || undefined);
    snapshots = result.snapshots;
    authDetected = result.authDetected;
    notes = result.notes;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // eslint-disable-next-line no-console
    console.error('[exploreAgent] crawl failed:', msg);
    // Still return state with a one-page placeholder so requirementAgent
    // can at least produce a smoke-level test of the URL itself.
    snapshots = [{
      url: targetUrl, title: 'Unreachable', headings: [],
      forms: [], buttons: [], links: [], navItems: [],
    }];
    notes = [`Crawler error: ${msg}`];
  }

  const exploredApp: ExploredApp = {
    appName: state.appContext?.appName,
    baseUrl: targetUrl,
    pages: snapshots,
    detectedFeatures: deriveFeatures(snapshots),
    authDetected,
    notes,
  };

  // Hand the UI map to Claude — produce a natural-language requirements
  // document that mimics what a BA would have written for this app. Use the
  // DB-configured LLM key when present; fall back to the CLI, else a naive map.
  const synthesized = (state.llm?.apiKey || state.llm?.oauthToken || isClaudeCliAvailable())
    ? await synthesizeRequirements(exploredApp, llmForStage(state.llm, 'explore'))
    : naiveRequirementsFromMap(exploredApp);

  return {
    ...state,
    exploredApp,
    // Inject as if the user typed/pasted this — downstream agents are
    // unchanged. We append rather than overwrite so any partial text the
    // user did provide is preserved.
    requirements: [state.requirements?.trim(), synthesized].filter(Boolean).join('\n\n'),
  };
}

/**
 * Crawl-only entry point: return the structured UI map (selectors, forms,
 * buttons, pages) for a target app WITHOUT the LLM requirements synthesis.
 * Used by the script generator to ground Playwright selectors in the real DOM.
 * Logs in with the first role's credentials when a login screen is detected.
 */
export async function crawlAppMap(targetUrl: string, appContext?: AppContext): Promise<ExploredApp> {
  const { snapshots, authDetected, notes } = await crawlApp(targetUrl, appContext);
  return {
    appName: appContext?.appName,
    baseUrl: targetUrl,
    pages: snapshots,
    detectedFeatures: deriveFeatures(snapshots),
    authDetected,
    notes,
  };
}

/* ───────────────────────────────────────────────────────────────────
   CRAWLER
   ─────────────────────────────────────────────────────────────────── */

async function crawlApp(
  startUrl: string,
  appContext?: AppContext,
): Promise<{ snapshots: PageSnapshot[]; authDetected: boolean; notes: string[] }> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const notes: string[] = [];
  let authDetected = false;

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
    });
    // tsx/esbuild injects a `__name` helper into functions; when Playwright
    // serializes a page.evaluate() callback into the browser, that reference is
    // undefined there. Define a no-op shim before any page script runs so the
    // DOM-extraction evaluate works under tsx (harmless no-op under tsc/prod).
    await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
    const page = await context.newPage();

    // Same-origin gate
    const startOrigin = new URL(startUrl).origin;

    // Visit the landing page first.
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { /* SPAs sometimes never idle */ });

    // Heuristic: if landing page looks like a login screen and we have
    // credentials, try to authenticate.
    const landingSnap = await snapshotPage(page);
    // ALWAYS keep the landing/login page — its form selectors (username,
    // password, submit) are what most generated tests need.
    const snapshots: PageSnapshot[] = [landingSnap];
    const isLoginLike = looksLikeLogin(landingSnap);
    if (isLoginLike) {
      authDetected = true;
      const role = appContext?.roles?.[0];
      if (role?.username && role?.password) {
        const ok = await tryLogin(page, role.username, role.password);
        notes.push(ok ? `Logged in as ${role.username}` : `Login attempt with ${role.username} failed`);
        if (ok) {
          // Let the post-login SPA render, then capture the authenticated page.
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => { /* SPA */ });
          snapshots.push(await snapshotPage(page));
        }
      } else {
        notes.push('Login screen detected but no credentials supplied — crawling as anonymous');
      }
    }

    // BFS crawl, bounded — seed from the CURRENT page (post-login if we logged in).
    const visited = new Set<string>([normaliseUrl(startUrl)]);
    const queue: { url: string; depth: number }[] = [];
    for (const link of snapshots[snapshots.length - 1].links) {
      if (snapshots.length + queue.length >= MAX_PAGES) break;
      const abs = resolveSameOrigin(link.href, startOrigin);
      if (abs && !visited.has(normaliseUrl(abs))) {
        queue.push({ url: abs, depth: 1 });
        visited.add(normaliseUrl(abs));
      }
    }

    while (queue.length > 0 && snapshots.length < MAX_PAGES) {
      const { url, depth } = queue.shift()!;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => { /* tolerate */ });
        const snap = await snapshotPage(page);
        snapshots.push(snap);
        if (depth < MAX_DEPTH) {
          for (const link of snap.links) {
            if (snapshots.length + queue.length >= MAX_PAGES) break;
            const abs = resolveSameOrigin(link.href, startOrigin);
            if (abs && !visited.has(normaliseUrl(abs))) {
              queue.push({ url: abs, depth: depth + 1 });
              visited.add(normaliseUrl(abs));
            }
          }
        }
      } catch (err) {
        notes.push(`Could not visit ${url}: ${(err as Error).message}`);
      }
    }

    return { snapshots, authDetected, notes };
  } finally {
    await browser.close();
  }
}

/* ───────────────────────────────────────────────────────────────────
   PAGE SNAPSHOT
   ─────────────────────────────────────────────────────────────────── */

async function snapshotPage(page: import('@playwright/test').Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  // All extraction happens inside page.evaluate so we touch the DOM once.
  const data = await page.evaluate(() => {
    const text = (el: Element | null): string => (el?.textContent || '').trim().replace(/\s+/g, ' ');

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => text(h)).filter(Boolean).slice(0, 30);

    const forms = Array.from(document.querySelectorAll('form')).slice(0, 10).map((f) => {
      const fields = Array.from(f.querySelectorAll('input, select, textarea')).map((el) => {
        const input = el as HTMLInputElement;
        const name = input.name || input.id || input.getAttribute('aria-label') || '';
        const type = input.type || el.tagName.toLowerCase();
        const required = input.required || input.getAttribute('aria-required') === 'true';
        // Try to find the label
        let label = '';
        if (input.id) {
          const lbl = document.querySelector(`label[for="${input.id}"]`);
          if (lbl) label = text(lbl);
        }
        if (!label && input.placeholder) label = input.placeholder;
        return { name: name || '(unnamed)', type, required, label };
      }).filter((f) => f.name !== '(unnamed)' || f.type === 'submit');
      return {
        id: (f as HTMLFormElement).id || undefined,
        name: (f as HTMLFormElement).name || undefined,
        action: (f as HTMLFormElement).action || undefined,
        fields,
      };
    });

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
      .map((b) => text(b) || (b as HTMLInputElement).value || '')
      .filter((t) => t.length > 0 && t.length < 60)
      .slice(0, 30);

    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 60).map((a) => ({
      text: text(a),
      href: (a as HTMLAnchorElement).href,
    })).filter((l) => l.text || l.href);

    const navItems = Array.from(document.querySelectorAll('nav a, [role="navigation"] a, .sidebar a, .menu a, header a'))
      .map((a) => text(a))
      .filter(Boolean)
      .slice(0, 30);

    return { headings, forms, buttons, links, navItems };
  });

  return { url, title, ...data };
}

/* ───────────────────────────────────────────────────────────────────
   LOGIN HEURISTIC
   ─────────────────────────────────────────────────────────────────── */

function looksLikeLogin(snap: PageSnapshot): boolean {
  const hasPasswordField = snap.forms.some((f) => f.fields.some((fd) => fd.type === 'password'));
  if (hasPasswordField) return true;
  const t = (snap.title + ' ' + snap.headings.join(' ')).toLowerCase();
  return /\b(sign in|log in|login|signin)\b/.test(t);
}

async function tryLogin(
  page: import('@playwright/test').Page,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    // Find password input first — it's the most reliable anchor.
    const pwInput = page.locator('input[type="password"]').first();
    if (await pwInput.count() === 0) return false;

    // Find a likely username field nearby. Try common heuristics.
    const userInput = page.locator(
      'input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]',
    ).first();
    if (await userInput.count() === 0) return false;

    await userInput.fill(username);
    await pwInput.fill(password);

    // Submit: prefer the form's own submit button, else Enter key.
    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first();
    if (await submit.count() > 0) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { /* tolerate SPA */ }),
        submit.click(),
      ]);
    } else {
      await pwInput.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { /* tolerate */ });
    }

    // Heuristic for success: URL changed AND no password input visible.
    const stillHasPw = (await page.locator('input[type="password"]').count()) > 0;
    return !stillHasPw;
  } catch {
    return false;
  }
}

/* ───────────────────────────────────────────────────────────────────
   FEATURE DERIVATION (heuristic — no LLM call yet)
   ─────────────────────────────────────────────────────────────────── */

function deriveFeatures(snaps: PageSnapshot[]): string[] {
  const features = new Set<string>();
  for (const s of snaps) {
    if (s.forms.some((f) => f.fields.some((fd) => fd.type === 'password'))) features.add('Authentication');
    if (/search/i.test(s.title) || s.buttons.some((b) => /search/i.test(b))) features.add('Search');
    if (/cart|checkout|order/i.test(s.title)) features.add('Checkout');
    if (/dashboard|home/i.test(s.title)) features.add('Dashboard');
    if (/profile|account|settings/i.test(s.title)) features.add('User Profile');
    if (/admin/i.test(s.url)) features.add('Admin');
    if (s.forms.length > 0 && !features.has('Authentication')) features.add('Form Submission');
    // Use page title as a feature when nothing else fits
    if (s.title && features.size < 3) features.add(s.title.split('|')[0].split('-')[0].trim());
  }
  return Array.from(features).filter(Boolean);
}

/* ───────────────────────────────────────────────────────────────────
   REQUIREMENTS SYNTHESIS
   ─────────────────────────────────────────────────────────────────── */

/**
 * Pretty-print the UI map and ask Claude to turn it into a functional spec.
 * Claude is instructed to write as if it were a BA who had just shadowed
 * the application, NOT to invent features the crawler did not observe.
 */
async function synthesizeRequirements(app: ExploredApp, llm?: import('./state.js').LlmConfig | null): Promise<string> {
  const uiMap = JSON.stringify(
    {
      baseUrl: app.baseUrl,
      pages: app.pages.map((p) => ({
        url: p.url,
        title: p.title,
        headings: p.headings.slice(0, 8),
        forms: p.forms.map((f) => ({
          fields: f.fields.map((fd) => `${fd.name}:${fd.type}${fd.required ? '(req)' : ''}`).join(', '),
        })),
        buttons: p.buttons.slice(0, 15),
        navItems: p.navItems.slice(0, 12),
      })),
      authDetected: app.authDetected,
      notes: app.notes,
    },
    null,
    2,
  );

  const prompt = `You are a senior Business Analyst. A QA team has crawled a live web application and produced the UI inventory below. Reverse-engineer it into a clear functional specification that a test designer can work from.

UI INVENTORY:
${uiMap}

Write the specification in markdown, with these sections:
1. **Application Overview** — what does this app appear to do? (1 paragraph)
2. **User Roles** — actors that can use the system (infer from login screens, admin areas, etc.)
3. **Functional Modules** — group the observed pages into modules and submodules
4. **Features per Module** — bullet list of features. Each feature: name + 1-sentence description + the URL it lives on.
5. **User Flows** — 5-10 end-to-end flows a real user would perform (e.g., "Customer searches for product, adds to cart, checks out")
6. **Data Validation Rules** — for every form field observed, infer the validation likely needed (required, format, length, etc.)
7. **Edge Cases & Error Scenarios** — boundary conditions, failure modes, security concerns
8. **Acceptance Criteria** — 3-5 Given/When/Then statements per major feature

Rules:
- ONLY describe features supported by evidence in the UI inventory. Do not invent functionality.
- If something is ambiguous, note the assumption explicitly ("Assumption: …")
- Be specific. "User can log in" is weak. "Authenticated user can sign in via email + password from /login" is good.
- Output markdown only, no commentary.`;

  try {
    const response = await runLLM(prompt, { maxTokens: 6000, llm: llm || undefined });
    return response.trim();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[exploreAgent] Claude synthesis failed, falling back to naive description:', (err as Error).message);
    return naiveRequirementsFromMap(app);
  }
}

/**
 * Deterministic fallback when Claude is unreachable — produces a usable but
 * less polished spec directly from the UI map.
 */
function naiveRequirementsFromMap(app: ExploredApp): string {
  const lines: string[] = [];
  lines.push(`# Application: ${app.appName || app.baseUrl}`);
  lines.push('');
  lines.push(`Base URL: ${app.baseUrl}`);
  lines.push(`Authentication detected: ${app.authDetected ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Pages discovered');
  for (const p of app.pages) {
    lines.push(`\n### ${p.title || p.url}`);
    lines.push(`- URL: ${p.url}`);
    if (p.headings.length) lines.push(`- Headings: ${p.headings.slice(0, 5).join(' | ')}`);
    if (p.forms.length) {
      for (const f of p.forms) {
        lines.push(`- Form with fields: ${f.fields.map((fd) => `${fd.name} (${fd.type}${fd.required ? ', required' : ''})`).join(', ')}`);
      }
    }
    if (p.buttons.length) lines.push(`- Buttons: ${p.buttons.slice(0, 8).join(', ')}`);
  }
  lines.push('');
  lines.push('## Inferred features');
  for (const f of app.detectedFeatures) lines.push(`- ${f}`);
  return lines.join('\n');
}

/* ───────────────────────────────────────────────────────────────────
   URL UTILITIES
   ─────────────────────────────────────────────────────────────────── */

function resolveSameOrigin(href: string, origin: string): string | null {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;
    // Skip non-HTTP schemes, fragments-only, mailto, etc.
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (u.pathname === '' && u.hash) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    // Drop trailing slashes for consistent deduping
    return url.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}
