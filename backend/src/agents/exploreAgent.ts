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
import type { TestOpsState, ExploredApp, ExploredField, AppContext, DocumentFeatureSignal, PageTable } from './state.js';
import { runClaudePrompt, parseJsonFromResponse, isClaudeCliAuthenticated } from './claude-runner.js';
import { applyWriteGuard, guardedContextOptions } from '../services/uat-safety.service.js';

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
    fields: ExploredField[];
  }[];
  buttons: string[];
  links: { text: string; href: string }[];
  navItems: string[];
  tables?: PageTable[];
  confidenceLabels?: string[];
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
    // Stop here: generating from a page we never saw produces invented tests.
    throw new Error(`Could not open the application at ${targetUrl}: ${msg.split('\n')[0]}`);
  }

  const exploredApp: ExploredApp = {
    appName: state.appContext?.appName,
    baseUrl: targetUrl,
    pages: snapshots,
    detectedFeatures: deriveFeatures(snapshots),
    documentFeatures: detectDocumentFeatures(snapshots),
    authDetected,
    notes,
  };

  // Hand the UI map to Claude — produce a natural-language requirements
  // document that mimics what a BA would have written for this app.
  const synthesized = isClaudeCliAuthenticated()
    ? await synthesizeRequirements(exploredApp)
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
      ...guardedContextOptions(appContext?.safety),
    });
    const blocked = await applyWriteGuard(context, appContext?.safety, startUrl);
    // When the backend runs under tsx (npm run dev), functions passed to
    // page.evaluate reference esbuild's __name helper, which pages don't have.
    await context.addInitScript('window.__name = window.__name || ((fn) => fn);');
    const page = await context.newPage();

    // Same-origin gate
    const startOrigin = new URL(startUrl).origin;

    // Visit the landing page first.
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { /* SPAs sometimes never idle */ });

    // Heuristic: if landing page looks like a login screen and we have
    // credentials, try to authenticate.
    const landingSnap = await snapshotPage(page);
    const isLoginLike = looksLikeLogin(landingSnap);
    if (isLoginLike) {
      authDetected = true;
      const role = appContext?.roles?.[0];
      if (role?.username && role?.password) {
        const ok = await tryLogin(page, role.username, role.password);
        notes.push(ok ? `Logged in as ${role.username}` : `Login attempt with ${role.username} failed`);
      } else {
        notes.push('Login screen detected but no credentials supplied — crawling as anonymous');
      }
    }

    // BFS crawl, bounded.
    const visited = new Set<string>([normaliseUrl(startUrl)]);
    const snapshots: PageSnapshot[] = [];
    snapshots.push(await snapshotPage(page));

    const queue: { url: string; depth: number }[] = [];
    for (const link of snapshots[0].links) {
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

    if (blocked.length) notes.push(`Read-only environment: blocked ${blocked.length} write request(s)`);
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

    const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';

    // A field with the rules the browser enforces on it (what boundary and
    // invalid-input tests are built from).
    const describeField = (el: Element) => {
      const input = el as HTMLInputElement;
      let label = '';
      if (input.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (lbl) label = text(lbl);
      }
      if (!label) label = text(input.closest('label')) || input.getAttribute('aria-label') || '';
      if (!label) {
        // A label beside the field, not linked to it: the only label in its container.
        const near = input.parentElement?.querySelectorAll('label');
        if (near?.length === 1) label = text(near[0]);
      }
      // A caption that is not a <label> (e.g. <span class="label">): visible, before the field, in a box
      // holding only this field. Notes after it ("Confidence: N/A", hidden text) are skipped, and a box
      // holding only notes defers to its parent.
      for (let box = input.type === 'file' ? null : input.parentElement, up = 0; !label && box && up < 2; box = box.parentElement, up++) {
        if (box.querySelectorAll(FIELD_SELECTOR).length !== 1) break;
        const labelled = Array.from(box.querySelectorAll('[class*="label" i]'));
        const captions = labelled
          .filter((c) => (c as HTMLElement).offsetParent !== null && (c.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
          .map(text).filter((t) => t && !/^confidence\b/i.test(t));
        const caption = captions[0]
          || (labelled.length ? '' : ((box as HTMLElement).innerText || '').replace(/Confidence:\s*\S+/gi, '').replace(/\s+/g, ' ').trim());
        if (caption && caption.length <= 60) label = caption;
      }
      if (!label) label = input.placeholder || '';
      // "*" in a label is the usual mark of a mandatory field, often with no `required` attribute.
      const starred = /\*/.test(label);
      label = label.replace(/\s*\*\s*/g, ' ').trim();
      const name = input.name || input.id || label;
      const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (input.type || 'text');
      const required = input.required || input.getAttribute('aria-required') === 'true' || starred;
      const constraints: string[] = [];
      const attr = (a: string) => input.getAttribute(a);
      if (attr('minlength')) constraints.push(`min length ${attr('minlength')}`);
      if (attr('maxlength')) constraints.push(`max length ${attr('maxlength')}`);
      if (attr('min')) constraints.push(`min ${attr('min')}`);
      if (attr('max')) constraints.push(`max ${attr('max')}`);
      if (attr('step')) constraints.push(`step ${attr('step')}`);
      if (attr('pattern')) constraints.push(`pattern ${attr('pattern')}`);
      if (attr('accept')) constraints.push(`accepts ${attr('accept')}`);
      if (input.multiple) constraints.push('multiple');
      if (input.readOnly) constraints.push('read-only');
      if (input.disabled) constraints.push('disabled');
      if (input.placeholder && input.placeholder !== label) constraints.push(`placeholder "${input.placeholder}"`);
      let options: string[] | undefined;
      if (el.tagName === 'SELECT') {
        const all = Array.from((el as HTMLSelectElement).options).map((o) => text(o)).filter(Boolean);
        options = all.slice(0, 15);
        if (all.length > 15) options.push(`(+${all.length - 15} more)`);
      }
      return { name: name || '(unnamed)', type, required, label, constraints, options };
    };

    const forms: { id?: string; name?: string; action?: string; fields: ReturnType<typeof describeField>[] }[] =
      Array.from(document.querySelectorAll('form')).slice(0, 10).map((f) => ({
        id: (f as HTMLFormElement).id || undefined,
        name: (f as HTMLFormElement).name || undefined,
        action: (f as HTMLFormElement).action || undefined,
        fields: Array.from(f.querySelectorAll(FIELD_SELECTOR)).map(describeField).filter((fd) => fd.name !== '(unnamed)'),
      }));

    // Single-page apps often render inputs without a <form> element.
    const loose = Array.from(document.querySelectorAll(FIELD_SELECTOR))
      .filter((el) => !el.closest('form'))
      .slice(0, 40)
      .map(describeField)
      .filter((fd) => fd.name !== '(unnamed)');
    if (loose.length) forms.push({ name: '(fields outside a form)', fields: loose });

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

    // Tables and ARIA grids: their column headers tell the test designer what a
    // results table holds, e.g. the rows a document scan extracts.
    const tables = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]')).slice(0, 8).map((t) => {
      const raw = Array.from(t.querySelectorAll('th, [role="columnheader"]')).map((h) => text(h)).filter((h) => h && h.length < 40);
      const clean = (h: string) => h.replace(/\s*\*\s*/g, ' ').trim();
      const headers = raw.map(clean);
      // Columns marked "*" are mandatory, like starred field labels.
      const required = Array.from(new Set(raw.filter((h) => h.includes('*')).map(clean)));
      let title = text(t.querySelector('caption'));
      let prev = t.previousElementSibling;
      for (let i = 0; i < 3 && prev && !title; i++, prev = prev.previousElementSibling) {
        const tx = text(prev);
        if (tx && tx.length < 60) title = tx;
      }
      return { title: title || undefined, headers: Array.from(new Set(headers)).slice(0, 25), ...(required.length ? { required } : {}) };
    }).filter((t) => t.headers.length > 0);

    // Fields shown with a confidence indicator ("Confidence: 92%", "Confidence: N/A"):
    // the output fields of a document scan, visible before anything is uploaded.
    const CONF = /^confidence\b/i;
    const confidenceLabels: string[] = [];
    const leaves = Array.from(document.querySelectorAll('body *')).filter((el) => el.children.length === 0);
    for (const el of leaves) {
      const tx = text(el);
      if (!CONF.test(tx) || tx.length > 40) continue;
      let label = '';
      let box: Element | null = el.parentElement;
      for (let i = 0; i < 3 && box && !label; i++, box = box.parentElement) {
        const lbl = box.querySelector('label');
        if (lbl && !CONF.test(text(lbl))) label = text(lbl);
        else {
          const field = box.querySelector('input, select, textarea');
          if (field) label = describeField(field).label || field.getAttribute('name') || '';
        }
      }
      if (!label) label = text(el.parentElement).replace(tx, '').trim();
      label = label.replace(/\s*\*\s*/g, ' ').trim();
      if (label && label.length < 60 && !confidenceLabels.includes(label)) confidenceLabels.push(label);
      if (confidenceLabels.length >= 60) break;
    }

    return { headings, forms, buttons, links, navItems, tables, confidenceLabels };
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
    const loginPath = new URL(page.url()).pathname;
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

    // Success: no password input, and not still on a login page (a rejected
    // sign-in can come back on the same path without a password box).
    const stillHasPw = (await page.locator('input[type="password"]').count()) > 0;
    const stillOnLogin = new URL(page.url()).pathname === loginPath && /\b(log ?in|sign ?in)\b/i.test(await page.title());
    return !stillHasPw && !stillOnLogin;
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
    if (detectDocumentFeatures([s]).length) features.add('Document Extraction');
    if (s.forms.length > 0 && !features.has('Authentication')) features.add('Form Submission');
    // Use page title as a feature when nothing else fits
    if (s.title && features.size < 3) features.add(s.title.split('|')[0].split('-')[0].trim());
  }
  return Array.from(features).filter(Boolean);
}

/** Buttons that start a document read: Scan, Extract, Process, OCR… */
const TRIGGER_RE = /\b(scan|extract|process|ocr|read(?!-only)|recogni[sz]e|digiti[sz]e|analy[sz]e|parse|import)\b/i;

/**
 * Screens that read documents: a file input, plus a trigger button or visible
 * outputs (fields with a confidence indicator, a results table, or several
 * read-only fields). A plain upload (a profile photo) is not one.
 */
export function detectDocumentFeatures(snaps: PageSnapshot[]): DocumentFeatureSignal[] {
  const out: DocumentFeatureSignal[] = [];
  for (const s of snaps) {
    const fields = s.forms.flatMap((f) => f.fields);
    const files = fields.filter((f) => f.type === 'file');
    if (!files.length) continue;
    const triggers = s.buttons.filter((b) => TRIGGER_RE.test(b));
    const confidenceFields = s.confidenceLabels || [];
    const tables = s.tables || [];
    const outputFields = [...new Set(fields
      .filter((f) => f.type !== 'file' && (f.constraints || []).some((c) => c === 'read-only' || c === 'disabled'))
      .map((f) => f.label || f.name)
      .filter(Boolean))].slice(0, 40);
    // A table alone is common (any list page); it counts only beside a read trigger.
    const hasOutput = confidenceFields.length > 0 || outputFields.length >= 3;
    if (!triggers.length && !hasOutput) continue;
    out.push({
      url: s.url,
      title: s.title || s.headings[0] || s.url,
      upload: Array.from(new Set(files.flatMap((f) => f.constraints || []))),
      triggers,
      confidenceFields,
      tables,
      outputFields,
    });
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────
   REQUIREMENTS SYNTHESIS
   ─────────────────────────────────────────────────────────────────── */

/**
 * Pretty-print the UI map and ask Claude to turn it into a functional spec.
 * Claude is instructed to write as if it were a BA who had just shadowed
 * the application, NOT to invent features the crawler did not observe.
 */
async function synthesizeRequirements(app: ExploredApp): Promise<string> {
  const uiMap = JSON.stringify(
    {
      baseUrl: app.baseUrl,
      pages: app.pages.map((p) => ({
        url: p.url,
        title: p.title,
        headings: p.headings.slice(0, 8),
        forms: p.forms.map((f) => ({
          ...(f.name ? { name: f.name } : {}),
          fields: f.fields.map(describeForPrompt),
        })),
        buttons: p.buttons.slice(0, 15),
        navItems: p.navItems.slice(0, 12),
        ...(p.tables?.length ? { tables: p.tables } : {}),
        ...(p.confidenceLabels?.length ? { fieldsWithConfidence: p.confidenceLabels } : {}),
      })),
      ...(app.documentFeatures?.length ? { documentFeatures: app.documentFeatures } : {}),
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
6. **Data Validation Rules** — one line per form field: its label, then the OBSERVED constraints copied exactly from the inventory (required, min/max length, min/max value, pattern, accepted file types, options). Add likely-but-unobserved rules only when the field clearly implies them, marked "(assumed)".
7. **Edge Cases & Error Scenarios** — boundary conditions, failure modes, security concerns
8. **Acceptance Criteria** — 3-5 Given/When/Then statements per major feature
9. **Document Extraction** — ONLY when the inventory lists documentFeatures. For each: the document it reads (infer the type from page title, headings and field names, e.g. a labor ticket), accepted files and limits, the trigger button, EVERY output field (header fields and every table column, by group) with its likely data type, whether it is required, and whether a confidence score is shown. Mark rules not observed on the page "(assumed)".

Rules:
- ONLY describe features supported by evidence in the UI inventory. Do not invent functionality.
- If something is ambiguous, note the assumption explicitly ("Assumption: …")
- Be specific. "User can log in" is weak. "Authenticated user can sign in via email + password from /login" is good.
- Output markdown only, no commentary.`;

  try {
    const response = await runClaudePrompt(prompt, { maxTokens: 6000 });
    return response.trim();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[exploreAgent] Claude synthesis failed, falling back to naive description:', (err as Error).message);
    return naiveRequirementsFromMap(app);
  }
}

/** One field as text: "Age (number, required; min 18; max 99)". */
function describeForPrompt(fd: ExploredField): string {
  const details = [fd.type, fd.required ? 'required' : '', ...(fd.constraints || [])].filter(Boolean);
  if (fd.options?.length) details.push(`options: ${fd.options.join(' | ')}`);
  return `${fd.label || fd.name} (${details.join('; ')})`;
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
        lines.push(`- Form with fields: ${f.fields.map(describeForPrompt).join('; ')}`);
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
