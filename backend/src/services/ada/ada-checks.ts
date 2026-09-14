/**
 * Per-page checks for the ADA / website audit.
 *
 *  - runAccessibilityCheck: axe-core (via @axe-core/playwright) → WCAG findings
 *  - runBestPracticeCheck:  DOM hygiene rules evaluated inside the page
 *
 * Both return plain Finding[] plus a 0-100 page score so the engine can stay
 * agnostic of how each check works.
 */
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Finding, Severity } from './ada-types.js';

/* ───────────────────────────── accessibility ───────────────────────────── */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const IMPACT_TO_SEVERITY: Record<string, Severity> = {
  critical: 'critical', serious: 'serious', moderate: 'moderate', minor: 'minor',
};
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, serious: 6, moderate: 3, minor: 1 };

// Nodes kept per rule per page. The count is preserved in `occurrences`; the
// full node list is not — it would balloon the findings table on big pages.
const MAX_NODES_PER_RULE = 5;

/** axe tags like "wcag111" → "1.1.1"; "wcag2aa" → level AA. */
function wcagFromTags(tags: string[]): string | undefined {
  const criteria = tags
    .map((t) => /^wcag(\d)(\d)(\d{1,2})$/.exec(t))
    .filter(Boolean)
    .map((m) => `${m![1]}.${m![2]}.${m![3]}`);
  const level = tags.includes('wcag2a') || tags.includes('wcag21a') || tags.includes('wcag22a')
    ? 'A'
    : tags.some((t) => /^wcag2\d?aa$/.test(t)) ? 'AA' : undefined;
  if (criteria.length === 0 && !level) return undefined;
  return [criteria.join(', '), level ? `(${level})` : ''].filter(Boolean).join(' ');
}

export async function runAccessibilityCheck(page: Page, pageUrl: string): Promise<{ findings: Finding[]; score: number; violations: number }> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const findings: Finding[] = [];
  let penalty = 0;
  let violations = 0;

  for (const v of results.violations) {
    const severity = IMPACT_TO_SEVERITY[v.impact || 'minor'] || 'minor';
    const nodes = v.nodes || [];
    // Only rules tied to a WCAG success criterion count as accessibility
    // violations. axe's own best-practice rules (landmarks, heading order...)
    // are worth fixing but are not ADA/WCAG failures, so they are reported
    // under best practices instead of inflating the compliance number.
    const isWcag = (v.tags || []).some((t) => /^wcag\d/.test(t));
    if (!isWcag) {
      findings.push({
        pageUrl, category: 'best-practice', ruleId: `axe-${v.id}`, severity,
        title: v.help, description: v.description, helpUrl: v.helpUrl,
        element: (nodes[0]?.target || []).map(String).join(' ').slice(0, 1000),
        htmlSnippet: (nodes[0]?.html || '').slice(0, 2000),
        occurrences: nodes.length,
        details: { tags: v.tags, source: 'axe-core best-practice' },
      });
      continue;
    }
    violations += nodes.length;
    penalty += SEVERITY_WEIGHT[severity] * Math.min(nodes.length, 10);

    const kept = nodes.slice(0, MAX_NODES_PER_RULE);
    for (const node of kept) {
      findings.push({
        pageUrl,
        category: 'accessibility',
        ruleId: v.id,
        severity,
        title: v.help,
        description: v.description,
        wcag: wcagFromTags(v.tags || []),
        element: (node.target || []).map(String).join(' ').slice(0, 1000),
        htmlSnippet: (node.html || '').slice(0, 2000),
        helpUrl: v.helpUrl,
        occurrences: 1,
        details: {
          failureSummary: node.failureSummary,
          tags: v.tags,
          totalNodesOnPage: nodes.length,
        },
      });
    }
    if (nodes.length > kept.length && kept.length > 0) {
      // Fold the remainder into the last kept finding so totals stay honest.
      findings[findings.length - 1].occurrences = nodes.length - kept.length + 1;
    }
  }

  // A page with zero violations is 100. Each weighted violation chips away;
  // the cap keeps one catastrophic page from dragging the whole site to 0.
  const score = Math.max(0, 100 - penalty);
  return { findings, score, violations };
}

/* ───────────────────────────── best practice ───────────────────────────── */

export interface BpRuleResult {
  id: string;
  title: string;
  severity: Severity;
  passed: boolean;
  detail: string;
  count?: number;
  element?: string;
}

export interface PageRuntimeSignals {
  consoleErrors: string[];
  pageErrors: string[];
  statusCode: number | null;
  loadMs: number;
}

/**
 * Evaluate hygiene rules inside the page. Everything DOM-related runs in one
 * page.evaluate so we touch the document once; runtime signals (console errors,
 * HTTP status, load time) come from the engine's listeners.
 */
export async function runBestPracticeCheck(
  page: Page,
  pageUrl: string,
  signals: PageRuntimeSignals,
): Promise<{ findings: Finding[]; score: number; rules: BpRuleResult[] }> {
  const dom = await page.evaluate(() => {
    const q = (sel: string) => Array.from(document.querySelectorAll(sel));
    const isHttps = location.protocol === 'https:';
    const headings = q('h1,h2,h3,h4,h5,h6').map((h) => Number(h.tagName[1]));
    let skipped = 0;
    for (let i = 1; i < headings.length; i++) if (headings[i] - headings[i - 1] > 1) skipped++;

    const imgs = q('img') as HTMLImageElement[];
    const imgsNoAlt = imgs.filter((i) => !i.hasAttribute('alt')).length;
    const imgsNoDims = imgs.filter((i) => !i.getAttribute('width') || !i.getAttribute('height')).length;
    const oversized = imgs.filter((i) => i.clientWidth > 0 && i.naturalWidth > i.clientWidth * 2 && i.naturalWidth > 600).length;

    const blankNoRel = (q('a[target="_blank"]') as HTMLAnchorElement[])
      .filter((a) => !/noopener|noreferrer/i.test(a.rel || '')).length;

    const mixed = isHttps
      ? q('img[src^="http:"],script[src^="http:"],link[href^="http:"],iframe[src^="http:"],video[src^="http:"],audio[src^="http:"]').length
      : 0;

    const deprecated = q('font,center,marquee,blink,frame,frameset,big,tt,strike').length;
    const metaDesc = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content?.trim() || '';
    const viewport = !!document.querySelector('meta[name="viewport"]');
    const favicon = !!document.querySelector('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]');
    const canonical = !!document.querySelector('link[rel="canonical"]');
    const lang = document.documentElement.getAttribute('lang') || '';
    const inlineStyles = q('[style]').length;
    const inlineHandlers = q('[onclick],[onload],[onmouseover],[onchange],[onsubmit]').length;
    const emptyButtons = q('button').filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.querySelector('img[alt],svg[aria-label],svg title')).length;
    const genericLinks = (q('a[href]') as HTMLAnchorElement[])
      .filter((a) => /^(click here|read more|more|here|link)$/i.test((a.textContent || '').trim())).length;
    const iframesNoTitle = q('iframe').filter((f) => !f.getAttribute('title')).length;
    const tablesNoHeaders = q('table').filter((t) => !t.querySelector('th')).length;

    return {
      hasDoctype: !!document.doctype,
      lang,
      title: (document.title || '').trim(),
      metaDescLen: metaDesc.length,
      viewport,
      favicon,
      canonical,
      h1Count: q('h1').length,
      headingSkips: skipped,
      imgCount: imgs.length,
      imgsNoAlt,
      imgsNoDims,
      oversized,
      blankNoRel,
      mixed,
      deprecated,
      inlineStyles,
      inlineHandlers,
      emptyButtons,
      genericLinks,
      iframesNoTitle,
      tablesNoHeaders,
      isHttps,
    };
  });

  const rules: BpRuleResult[] = [];
  const add = (id: string, title: string, severity: Severity, passed: boolean, detail: string, count?: number) =>
    rules.push({ id, title, severity, passed, detail, count });

  add('https', 'Page is served over HTTPS', 'serious', dom.isHttps, dom.isHttps ? 'Secure connection.' : 'Page loaded over plain HTTP — content and forms are not encrypted.');
  add('http-status', 'Page returns a successful HTTP status', 'serious',
    signals.statusCode !== null && signals.statusCode >= 200 && signals.statusCode < 400,
    `HTTP ${signals.statusCode ?? 'unknown'}.`);
  add('doctype', 'Document declares a DOCTYPE', 'minor', dom.hasDoctype, dom.hasDoctype ? 'Standards mode.' : 'Missing <!DOCTYPE> — browsers render in quirks mode.');
  add('html-lang', 'Page language is declared', 'moderate', !!dom.lang, dom.lang ? `lang="${dom.lang}".` : 'No lang attribute on <html> — screen readers cannot pick the right voice.');
  add('title', 'Page has a descriptive title', 'moderate', dom.title.length >= 5 && dom.title.length <= 80,
    dom.title ? `"${dom.title.slice(0, 80)}" (${dom.title.length} chars).` : 'Missing <title>.');
  add('meta-description', 'Meta description is present and concise', 'minor', dom.metaDescLen > 0 && dom.metaDescLen <= 170,
    dom.metaDescLen === 0 ? 'No meta description.' : `${dom.metaDescLen} chars${dom.metaDescLen > 170 ? ' — too long' : ''}.`);
  add('meta-viewport', 'Mobile viewport is configured', 'moderate', dom.viewport, dom.viewport ? 'Viewport meta present.' : 'No viewport meta — page will not scale on phones.');
  add('single-h1', 'Page has exactly one H1', 'moderate', dom.h1Count === 1, `${dom.h1Count} H1 element(s).`);
  add('heading-order', 'Headings do not skip levels', 'minor', dom.headingSkips === 0, dom.headingSkips ? `${dom.headingSkips} heading level skip(s) (e.g. H2 → H4).` : 'Heading hierarchy is sequential.', dom.headingSkips);
  add('img-alt', 'All images have an alt attribute', 'serious', dom.imgsNoAlt === 0, `${dom.imgsNoAlt} of ${dom.imgCount} images missing alt.`, dom.imgsNoAlt);
  add('img-dimensions', 'Images declare width and height', 'minor', dom.imgsNoDims === 0, `${dom.imgsNoDims} image(s) without explicit dimensions — causes layout shift while loading.`, dom.imgsNoDims);
  add('img-oversized', 'Images are not oversized for their display size', 'minor', dom.oversized === 0, `${dom.oversized} image(s) served at more than 2× their rendered width.`, dom.oversized);
  add('link-noopener', 'New-tab links use rel="noopener"', 'moderate', dom.blankNoRel === 0, `${dom.blankNoRel} target="_blank" link(s) without rel="noopener" — a reverse-tabnabbing risk.`, dom.blankNoRel);
  add('mixed-content', 'No mixed content on HTTPS pages', 'serious', dom.mixed === 0, `${dom.mixed} resource(s) loaded over http:// on an https page.`, dom.mixed);
  add('deprecated-tags', 'No deprecated HTML elements', 'minor', dom.deprecated === 0, `${dom.deprecated} deprecated element(s) (font, center, marquee…).`, dom.deprecated);
  add('console-errors', 'No JavaScript console errors', 'moderate', signals.consoleErrors.length === 0,
    signals.consoleErrors.length ? `${signals.consoleErrors.length} console error(s): ${signals.consoleErrors[0].slice(0, 160)}` : 'Console clean.', signals.consoleErrors.length);
  add('page-errors', 'No uncaught JavaScript exceptions', 'serious', signals.pageErrors.length === 0,
    signals.pageErrors.length ? `${signals.pageErrors.length} uncaught exception(s): ${signals.pageErrors[0].slice(0, 160)}` : 'No uncaught exceptions.', signals.pageErrors.length);
  add('favicon', 'Site declares a favicon', 'minor', dom.favicon, dom.favicon ? 'Favicon linked.' : 'No favicon link — tabs and bookmarks show a blank icon.');
  add('canonical', 'Page declares a canonical URL', 'minor', dom.canonical, dom.canonical ? 'Canonical link present.' : 'No canonical link — duplicate-content risk for search engines.');
  add('load-time', 'Page loads in under 3 seconds', 'minor', signals.loadMs < 3000, `${(signals.loadMs / 1000).toFixed(1)}s to DOM ready.`);
  add('inline-handlers', 'No inline JavaScript event handlers', 'minor', dom.inlineHandlers === 0, `${dom.inlineHandlers} element(s) with inline on* handlers — blocks a strict Content-Security-Policy.`, dom.inlineHandlers);
  add('empty-buttons', 'Buttons have an accessible name', 'serious', dom.emptyButtons === 0, `${dom.emptyButtons} button(s) with no text or aria-label.`, dom.emptyButtons);
  add('generic-link-text', 'Links avoid generic text', 'minor', dom.genericLinks === 0, `${dom.genericLinks} link(s) reading "click here" / "read more".`, dom.genericLinks);
  add('iframe-title', 'Iframes have a title', 'moderate', dom.iframesNoTitle === 0, `${dom.iframesNoTitle} iframe(s) without a title.`, dom.iframesNoTitle);
  add('table-headers', 'Data tables have header cells', 'moderate', dom.tablesNoHeaders === 0, `${dom.tablesNoHeaders} table(s) without <th> header cells.`, dom.tablesNoHeaders);

  const findings: Finding[] = rules.filter((r) => !r.passed).map((r) => ({
    pageUrl,
    category: 'best-practice',
    ruleId: r.id,
    severity: r.severity,
    title: r.title,
    description: r.detail,
    occurrences: r.count && r.count > 0 ? r.count : 1,
  }));

  // Weighted pass rate so a failing "https" costs more than a missing favicon.
  const totalW = rules.reduce((a, r) => a + SEVERITY_WEIGHT[r.severity], 0);
  const passW = rules.filter((r) => r.passed).reduce((a, r) => a + SEVERITY_WEIGHT[r.severity], 0);
  const score = totalW ? Math.round((passW / totalW) * 100) : 100;
  return { findings, score, rules };
}
