/**
 * ADA / website audit engine — the crawl.
 *
 * Give it a URL. It opens a real Chromium, reads robots.txt and the sitemap,
 * then walks the site breadth-first: home page → every menu / in-page link →
 * their links, up to the configured page and depth caps. On every page it
 * reaches it runs the accessibility and best-practice checks. Every link seen
 * anywhere is remembered and fetched afterwards so 404s and dead links are
 * reported with the page that pointed at them.
 *
 * If the first page is a sign-in form and credentials were supplied, it logs
 * in (same heuristic the brownfield explore agent uses) and crawls the
 * authenticated site instead.
 *
 * Progress is reported through `emit` so the UI can show the navigation live.
 */
import { buildInventory, describeInventory, inAuditedLocale, orderForCrawl, sectionOf, type SiteInventory } from './ada-inventory.js';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { tryLogin } from '../../agents/exploreAgent.js';
import { runAccessibilityCheck, runBestPracticeCheck } from './ada-checks.js';
import { checkLinks, shouldCheckLink, BROWSER_UA, type CollectedLink } from './ada-links.js';
import { buildSummary } from './ada-score.js';
import type { CrawlCoverage, Finding, LinkResult, PageResult, PageSource, ProgressEvent, ScanOptions, ScanSummary } from './ada-types.js';

type Emit = (e: Omit<ProgressEvent, 'seq' | 'at'>) => void;

export interface EngineResult {
  pages: PageResult[];
  links: LinkResult[];
  summary: ScanSummary;
}

export interface EngineControl {
  /** Set by the caller to stop the crawl at the next safe point. */
  cancelled: boolean;
}

const PAGE_TIMEOUT_MS = 30_000;
const MAX_SITEMAP_CHILDREN = 50;
const MAX_SITEMAP_URLS = 50_000;
const MAX_ROBOTS_DELAY_MS = 3000;
/** After "Stop & report", links collected so far are still checked — but only for this long. */
const LINK_BUDGET_AFTER_STOP_MS = 120_000;
const BINARY_EXT = /\.(pdf|zip|rar|7z|gz|tar|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp3|mp4|m4a|wav|avi|mov|wmv|webm|docx?|xlsx?|pptx?|csv|json|xml|rss|atom|css|js|woff2?|ttf|eot|exe|dmg|apk|ics)(\?.*)?$/i;

let _chromium: typeof import('@playwright/test').chromium | null = null;
async function loadChromium() {
  if (_chromium) return _chromium;
  const mod = await import('@playwright/test');
  _chromium = mod.chromium;
  return _chromium;
}

/* ───────────────────────────── url helpers ───────────────────────────── */

export function normaliseStartUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u); // throws on garbage — caller validates
  parsed.hash = '';
  return parsed.toString();
}

function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    // Drop common tracking params so the same page isn't crawled twice.
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
    let s = url.toString();
    if (url.pathname !== '/' || url.search === '') s = s.replace(/\/$/, '');
    return s;
  } catch {
    return u;
  }
}

/* ───────────────────────────── robots.txt ───────────────────────────── */

interface Robots { disallow: string[]; crawlDelay: number | null; sitemaps: string[] }

async function readRobots(ctx: BrowserContext, origin: string, emit: Emit): Promise<Robots> {
  const robots: Robots = { disallow: [], crawlDelay: null, sitemaps: [] };
  try {
    const res = await ctx.request.get(`${origin}/robots.txt`, { timeout: 10_000, headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok()) { emit({ type: 'robots', message: 'No robots.txt — crawling with default politeness.' }); return robots; }
    const text = await res.text();
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const [k, ...rest] = line.split(':');
      const key = k.trim().toLowerCase();
      const val = rest.join(':').trim();
      if (key === 'user-agent') applies = val === '*';
      else if (key === 'sitemap') robots.sitemaps.push(val);
      else if (applies && key === 'disallow' && val) robots.disallow.push(val);
      else if (applies && key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n)) robots.crawlDelay = n; }
    }
    emit({
      type: 'robots',
      message: `robots.txt read — ${robots.disallow.length} disallowed path${robots.disallow.length === 1 ? '' : 's'}, ${robots.sitemaps.length} sitemap${robots.sitemaps.length === 1 ? '' : 's'}${robots.crawlDelay ? `, crawl-delay ${robots.crawlDelay}s` : ''}.`,
      data: { ...robots },
    });
  } catch {
    emit({ type: 'robots', message: 'robots.txt not reachable — crawling with default politeness.' });
  }
  return robots;
}

function isDisallowed(url: string, robots: Robots): boolean {
  try {
    const path = new URL(url).pathname;
    return robots.disallow.some((d) => d !== '/' ? path.startsWith(d.replace(/\*$/, '')) : true);
  } catch {
    return false;
  }
}

/* ───────────────────────────── sitemap ───────────────────────────── */

async function readSitemap(ctx: BrowserContext, origin: string, robots: Robots, sameSite: (u: string) => boolean, emit: Emit): Promise<string[]> {
  const candidates = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls = new Set<string>();
  const fetchXml = async (u: string): Promise<string | null> => {
    try {
      const res = await ctx.request.get(u, { timeout: 15_000, headers: { 'User-Agent': BROWSER_UA } });
      if (!res.ok()) return null;
      const ct = res.headers()['content-type'] || '';
      if (!/xml|text/i.test(ct)) return null;
      return await res.text();
    } catch {
      return null;
    }
  };
  for (const sm of candidates) {
    const xml = await fetchXml(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs.slice(0, MAX_SITEMAP_CHILDREN)) {
        const cx = await fetchXml(child);
        if (!cx) continue;
        for (const m of cx.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
          const u = m[1].trim();
          if (sameSite(u) && !BINARY_EXT.test(u)) urls.add(normaliseUrl(u));
          if (urls.size >= MAX_SITEMAP_URLS) break;
        }
      }
    } else {
      for (const u of locs) {
        if (sameSite(u) && !BINARY_EXT.test(u)) urls.add(normaliseUrl(u));
        if (urls.size >= MAX_SITEMAP_URLS) break;
      }
    }
    if (urls.size) break;
  }
  if (!urls.size) emit({ type: 'sitemap', message: 'No sitemap found — relying on links discovered while navigating.', data: { count: 0 } });
  return [...urls];
}

/* ───────────────────────────── the crawl ───────────────────────────── */

export async function runScan(options: ScanOptions, emit: Emit, control: EngineControl): Promise<EngineResult> {
  const startedAt = new Date();
  const startUrl = normaliseStartUrl(options.url);
  const origin = new URL(startUrl).origin;
  const site = siteKey(new URL(startUrl).host);
  const sameSite = (u: string) => { try { return siteKey(new URL(u).host) === site; } catch { return false; } };
  const notes: string[] = [];

  emit({ type: 'start', message: `Opening ${startUrl}`, data: { url: startUrl, maxPages: options.maxPages, maxDepth: options.maxDepth } });

  const chromium = await loadChromium();
  let browser: Browser | null = null;
  const pages: PageResult[] = [];
  const linkMap = new Map<string, CollectedLink>();
  let loginAttempted = false;
  let loginSucceeded: boolean | null = null;
  let robots: Robots = { disallow: [], crawlDelay: null, sitemaps: [] };
  let sitemapUrls: string[] = [];
  let inventory: SiteInventory = buildInventory([], startUrl);
  const TEMPLATED_SAMPLE_NOTE = 8;
  // Coverage bookkeeping — counted, never estimated.
  let skippedNonHtml = 0;
  let redirectedOffSite = 0;

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 900 },
      userAgent: BROWSER_UA,
      locale: 'en-US',
    });
    // tsx injects a `__name` helper into serialized page.evaluate callbacks.
    await ctx.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
    // Don't spend time on video/audio — nothing we check needs them.
    await ctx.route('**/*', (route) => (['media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

    robots = await readRobots(ctx, origin, emit);
    if (options.useSitemap) sitemapUrls = await readSitemap(ctx, origin, robots, sameSite, emit);
    // What is this site made of? Languages, sections, templated archives — and which pages are in scope.
    inventory = buildInventory(sitemapUrls, startUrl);
    if (sitemapUrls.length) {
      emit({ type: 'sitemap', message: describeInventory(inventory), data: { count: inventory.pagesInScope, inventory } });
      if (inventory.auditedLocale && inventory.locales.length > 1) {
        notes.push(`The site has ${inventory.locales.length} language versions (${inventory.locales.map((l) => l.code).join(', ')}); this audit covers ${inventory.auditedLocale}. The others are translations of the same pages.`);
      }
      if (inventory.templatedPages) {
        notes.push(`${inventory.templatedPages.toLocaleString()} of the ${inventory.pagesInScope.toLocaleString()} pages are templated articles (${inventory.sections.filter((s) => s.templated).map((s) => s.path).join(', ')}); a sample of ${TEMPLATED_SAMPLE_NOTE} per section is audited before the rest.`);
      }
    }
    sitemapUrls = orderForCrawl(sitemapUrls.filter((u) => inAuditedLocale(u, inventory)), inventory);

    const delayMs = Math.max(options.crawlDelayMs, Math.min(MAX_ROBOTS_DELAY_MS, (robots.crawlDelay || 0) * 1000));
    if (robots.crawlDelay && robots.crawlDelay * 1000 > MAX_ROBOTS_DELAY_MS) {
      notes.push(`robots.txt asks for a ${robots.crawlDelay}s crawl delay; capped at ${MAX_ROBOTS_DELAY_MS / 1000}s for this audit.`);
    }

    const page = await ctx.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.on('dialog', (d) => d.dismiss().catch(() => { /* ignore */ }));
    let consoleErrors: string[] = [];
    let pageErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const visited = new Set<string>([normaliseUrl(startUrl)]);
    const queue: { url: string; depth: number; parent?: string; source: PageSource }[] = [{ url: startUrl, depth: 0, source: 'start' }];
    let sitemapSeeded = false;
    const linkCounts = () => {
      let internal = 0;
      for (const l of linkMap.values()) if (!l.external) internal++;
      return { linksFound: linkMap.size, linksInternal: internal, linksExternal: linkMap.size - internal };
    };

    const rememberLink = (href: string, referrer: string, text?: string) => {
      if (!shouldCheckLink(href)) return;
      const key = normaliseUrl(href);
      const existing = linkMap.get(key);
      if (existing) { existing.referrers.add(referrer); return; }
      linkMap.set(key, { url: key, external: !sameSite(href), referrers: new Set([referrer]), text: text?.slice(0, 120) });
    };

    // Discovery keeps going past the audit cap so the user sees how big the site really is.
    const DISCOVERY_CEILING = 5000;
    const enqueue = (href: string, depth: number, parent: string, source: PageSource = 'link') => {
      if (pages.length + queue.length >= DISCOVERY_CEILING) return;
      if (depth > options.maxDepth) return;
      if (!sameSite(href) || BINARY_EXT.test(href) || isDisallowed(href, robots)) return;
      if (!inAuditedLocale(href, inventory)) return; // a translation of a page we already cover
      const key = normaliseUrl(href);
      if (visited.has(key)) return;
      visited.add(key);
      queue.push({ url: key, depth, parent, source });
    };

    while (queue.length && pages.length < options.maxPages) {
      if (control.cancelled) { notes.push('Scan cancelled by user.'); break; }
      const item = queue.shift()!;
      consoleErrors = []; pageErrors = [];
      emit({ type: 'navigate', message: `Navigating to ${item.url}`, data: { url: item.url, depth: item.depth, source: item.source, audited: pages.length, queued: queue.length, discovered: pages.length + queue.length + 1, max: options.maxPages } });

      const t0 = Date.now();
      let loadMsMeasured = 0;
      let statusCode: number | null = null;
      let finalUrl = item.url;
      try {
        const resp = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        statusCode = resp?.status() ?? null;
        loadMsMeasured = Date.now() - t0; // to DOM ready - not the settle wait below
        const ct = resp?.headers()['content-type'] || '';
        if (ct && !/html|xhtml/i.test(ct)) {
          emit({ type: 'warning', message: `Skipped ${item.url} — not an HTML page (${ct.split(';')[0]}).` });
          rememberLink(item.url, item.parent || startUrl);
          skippedNonHtml++;
          continue;
        }
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => { /* SPAs may never idle */ });
        finalUrl = page.url();
      } catch (err) {
        const msg = (err as Error).message.split('\n')[0];
        emit({ type: 'warning', message: `Could not load ${item.url}: ${msg}` });
        pages.push({
          url: item.url, title: '', statusCode: null, depth: item.depth, parentUrl: item.parent, source: item.source,
          loadMs: Date.now() - t0, linksFound: 0, a11yScore: 0, bpScore: 0,
          findings: [{ pageUrl: item.url, category: 'best-practice', ruleId: 'page-unreachable', severity: 'critical', title: 'Page could not be loaded', description: msg, occurrences: 1 }],
        });
        continue;
      }
      const loadMs = loadMsMeasured || Date.now() - t0;

      // Redirected off-site (e.g. to an IdP or a different brand domain) — record and move on.
      if (!sameSite(finalUrl)) {
        emit({ type: 'warning', message: `${item.url} redirected off-site to ${finalUrl} — not crawled further.` });
        pages.push({ url: item.url, title: await page.title().catch(() => ''), statusCode, depth: item.depth, parentUrl: item.parent, source: item.source, loadMs, linksFound: 0, a11yScore: 100, bpScore: 100, findings: [] });
        redirectedOffSite++;
        continue;
      }

      // ── First page: sign in if it looks like a login screen and we have creds ──
      if (pages.length === 0) {
        const hasPassword = (await page.locator('input[type="password"]').count()) > 0;
        if (hasPassword) {
          if (options.username && options.password) {
            loginAttempted = true;
            emit({ type: 'login', message: `Sign-in form detected — signing in as ${options.username}…` });
            loginSucceeded = await tryLogin(page, options.username, options.password);
            emit({ type: 'login', message: loginSucceeded ? `Signed in as ${options.username}. Crawling the authenticated site.` : 'Sign-in did not succeed — continuing without signing in.', data: { ok: loginSucceeded } });
            if (loginSucceeded) {
              await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => { /* SPA */ });
              await page.waitForTimeout(1500);
              finalUrl = page.url();
            }
          } else {
            emit({ type: 'login', message: 'Sign-in form detected but no credentials were supplied — auditing the public pages only.' });
            notes.push('A sign-in form was found on the first page. Supply credentials to audit pages behind it.');
          }
        }
      }

      const title = await page.title().catch(() => '');
      if (pages.length === 0) emit({ type: 'page', message: `Site: ${title || site}`, data: { siteName: title } });

      // ── Links on this page ──
      const found = await page.evaluate(() => {
        const inNav = (el: Element) => !!el.closest('nav, header, [role="navigation"], .nav, .menu, .navbar, footer');
        const seen = new Map<string, { text: string; nav: boolean }>();
        for (const a of Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
          const href = a.href;
          if (!href) continue;
          const text = (a.textContent || a.getAttribute('aria-label') || a.querySelector('img')?.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
          const prev = seen.get(href);
          if (!prev) seen.set(href, { text, nav: inNav(a) });
          else if (!prev.nav && inNav(a)) prev.nav = true;
        }
        return Array.from(seen, ([href, v]) => ({ href, text: v.text, nav: v.nav }));
      }).catch(() => [] as { href: string; text: string; nav: boolean }[]);

      for (const l of found) rememberLink(l.href, finalUrl, l.text);
      // Menu links first so the crawl covers the site's main sections early.
      for (const l of found.filter((x) => x.nav)) enqueue(l.href, item.depth + 1, finalUrl);
      for (const l of found.filter((x) => !x.nav)) enqueue(l.href, item.depth + 1, finalUrl);
      if (!sitemapSeeded) {
        sitemapSeeded = true;
        for (const u of sitemapUrls) enqueue(u, 1, 'sitemap', 'sitemap');
      }
      const internal = found.filter((l) => sameSite(l.href)).length;
      emit({ type: 'page', message: `${title || finalUrl} — ${found.length} links (${internal} internal, ${found.length - internal} external) · ${pages.length + 1 + queue.length} pages found so far`, data: { url: finalUrl, title, links: found.length, internal, status: statusCode, discovered: pages.length + 1 + queue.length, ...linkCounts() } });

      // ── Checks ──
      const findings: Finding[] = [];
      let a11yScore = 100;
      let bpScore = 100;
      let axeBpFailures = 0;
      try {
        const a11y = await runAccessibilityCheck(page, finalUrl);
        findings.push(...a11y.findings);
        axeBpFailures = a11y.findings.filter((f) => f.category === 'best-practice').length;
        a11yScore = a11y.score;
        emit({ type: 'accessibility', message: `Accessibility: ${a11y.violations === 0 ? 'no violations' : `${a11y.violations} violation${a11y.violations === 1 ? '' : 's'}`}${a11y.needsReview ? `, ${a11y.needsReview} to review` : ''} on ${shortUrl(finalUrl)}`, data: { url: finalUrl, violations: a11y.violations, needsReview: a11y.needsReview, score: a11y.score } });
      } catch (err) {
        emit({ type: 'warning', message: `Accessibility check failed on ${shortUrl(finalUrl)}: ${(err as Error).message.split('\n')[0]}` });
      }
      try {
        const bp = await runBestPracticeCheck(page, finalUrl, { consoleErrors: [...consoleErrors], pageErrors: [...pageErrors], statusCode, loadMs });
        findings.push(...bp.findings);
        // Each axe best-practice rule that fired costs a little, capped so the
        // hygiene rules still dominate this score.
        bpScore = Math.max(0, bp.score - Math.min(15, axeBpFailures * 2));
        const failed = bp.rules.filter((r) => !r.passed).length + axeBpFailures;
        emit({ type: 'best-practice', message: `Best practices: ${bp.rules.length - failed}/${bp.rules.length} checks passed on ${shortUrl(finalUrl)}`, data: { url: finalUrl, failed, score: bp.score } });
      } catch (err) {
        emit({ type: 'warning', message: `Best-practice check failed on ${shortUrl(finalUrl)}: ${(err as Error).message.split('\n')[0]}` });
      }

      pages.push({ url: finalUrl, title, statusCode, depth: item.depth, parentUrl: item.parent, source: item.source, loadMs, linksFound: found.length, a11yScore, bpScore, findings });

      if (queue.length && pages.length < options.maxPages && delayMs > 0) await page.waitForTimeout(delayMs);
    }

    if (queue.length && pages.length >= options.maxPages) {
      notes.push(`Audited ${pages.length} of ${pages.length + queue.length} pages found. ${queue.length} page${queue.length === 1 ? '' : 's'} discovered but not audited (safety limit of ${options.maxPages} pages per audit).`);
    }
    emit({ type: 'page', message: `Crawl finished — ${pages.length} page${pages.length === 1 ? '' : 's'} audited, ${queue.length} found but not audited, ${linkMap.size} unique links collected.`, data: { audited: pages.length, discovered: pages.length + queue.length, ...linkCounts() } });

    // ── Link check ──
    // A stopped audit still checks the links it collected, under a time budget,
    // so the Links category is measured rather than silently skipped.
    let links: LinkResult[] = [];
    const collected = [...linkMap.values()];
    if (collected.length && control.cancelled) {
      emit({ type: 'links', message: `Audit stopped — checking the ${collected.length.toLocaleString()} links collected so far (up to ${LINK_BUDGET_AFTER_STOP_MS / 1000}s)…`, data: { total: collected.length } });
      links = await checkLinks(ctx.request, collected, { checkExternal: options.checkExternalLinks, deadlineMs: LINK_BUDGET_AFTER_STOP_MS }, emit);
    } else if (collected.length) {
      links = await checkLinks(ctx.request, collected, { checkExternal: options.checkExternalLinks }, emit);
    }

    const coverage = buildCoverage({
      pages, queue, links, linkMap: [...linkMap.values()], inventory, skippedNonHtml, redirectedOffSite,
      stoppedBecause: control.cancelled ? 'cancelled' : queue.length ? 'page-limit' : 'every-page-audited',
    });

    const finishedAt = new Date();
    const summary = buildSummary({
      targetUrl: startUrl,
      siteName: pages[0]?.title || site,
      startedAt, finishedAt,
      pages, links,
      loginAttempted, loginSucceeded,
      robots: { crawlDelay: robots.crawlDelay, disallowCount: robots.disallow.length, sitemaps: robots.sitemaps },
      sitemapUrlsFound: inventory.sitemapUrls,
      inventory,
      coverage,
      pagesDiscovered: pages.length + queue.length,
      linksFound: linkMap.size,
      notes,
    });
    emit({ type: 'summary', message: `Health score ${summary.overall.score}/100 (${summary.overall.grade}) — ${summary.categories.accessibility.violations} accessibility violations, ${summary.categories.links.measured ? `${summary.categories.links.broken + summary.categories.links.serverErrors + summary.categories.links.timeouts} broken links` : 'links not checked'}, ${summary.categories.bestPractice.failingRules.length} best-practice rules failing.`, data: { overall: summary.overall, audited: pages.length, discovered: pages.length + queue.length } });
    return { pages, links, summary };
  } finally {
    if (browser) await browser.close().catch(() => { /* ignore */ });
  }
}

function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' ? x.host : x.pathname) + (x.search || ''); } catch { return u; }
}

/* ───────────────────────────── coverage ───────────────────────────── */

const MAX_NOT_AUDITED_KEPT = 3000;

/** Tally what the crawl actually touched. Every number is a count of real pages / links; nothing is projected. */
function buildCoverage(input: {
  pages: PageResult[];
  queue: { url: string; depth: number; parent?: string; source: PageSource }[];
  links: LinkResult[];
  linkMap: CollectedLink[];
  inventory: SiteInventory;
  skippedNonHtml: number;
  redirectedOffSite: number;
  stoppedBecause: CrawlCoverage['stoppedBecause'];
}): CrawlCoverage {
  const { pages, queue, links, linkMap, inventory } = input;
  const bySource: CrawlCoverage['bySource'] = { start: { found: 0, audited: 0 }, sitemap: { found: 0, audited: 0 }, link: { found: 0, audited: 0 } };
  const depthMap = new Map<number, { found: number; audited: number }>();
  const sectionMap = new Map<string, { found: number; audited: number }>();
  const bump = <K,>(m: Map<K, { found: number; audited: number }>, k: K, audited: boolean) => {
    const e = m.get(k) || { found: 0, audited: 0 };
    e.found++;
    if (audited) e.audited++;
    m.set(k, e);
  };
  for (const p of pages) {
    bySource[p.source].found++; bySource[p.source].audited++;
    bump(depthMap, p.depth, true);
    bump(sectionMap, sectionOf(p.url), true);
  }
  for (const q of queue) {
    bySource[q.source].found++;
    bump(depthMap, q.depth, false);
    bump(sectionMap, sectionOf(q.url), false);
  }
  const templated = new Set(inventory.sections.filter((s) => s.templated).map((s) => s.path));
  let internal = 0;
  for (const l of linkMap) if (!l.external) internal++;
  return {
    audited: pages.length,
    found: pages.length + queue.length,
    unreachable: pages.filter((p) => p.statusCode === null).length,
    redirectedOffSite: input.redirectedOffSite,
    skippedNonHtml: input.skippedNonHtml,
    bySource,
    byDepth: [...depthMap.entries()].sort((a, b) => a[0] - b[0]).map(([depth, e]) => ({ depth, ...e })),
    bySection: [...sectionMap.entries()].sort((a, b) => b[1].found - a[1].found).map(([path, e]) => ({ path, ...e, templated: templated.has(path) })),
    links: {
      unique: linkMap.length,
      internal,
      external: linkMap.length - internal,
      checked: links.filter((l) => l.kind !== 'skipped').length,
      skipped: links.filter((l) => l.kind === 'skipped').length,
    },
    notAudited: queue.slice(0, MAX_NOT_AUDITED_KEPT).map((q) => ({ url: q.url, depth: q.depth, source: q.source, parentUrl: q.parent && q.parent !== 'sitemap' ? q.parent : undefined })),
    notAuditedTotal: queue.length,
    stoppedBecause: input.stoppedBecause,
  };
}
