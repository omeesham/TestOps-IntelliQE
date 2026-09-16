/**
 * ADA Compliance / website audit — shared types.
 *
 * A scan takes a URL, crawls the site with a real browser, and runs three
 * families of checks on every page it reaches:
 *   - accessibility  (axe-core, WCAG 2.x A/AA)
 *   - links          (every link on every page is fetched: 404s, 5xx, timeouts)
 *   - best-practice  (page hygiene: lang, title, headings, images, mixed content…)
 * and rolls the results up into a scored website health report.
 */

/** 'review' = axe could not decide automatically; a person must check (e.g. contrast on a gradient). */
import type { SiteInventory } from './ada-inventory.js';

export type FindingCategory = 'accessibility' | 'links' | 'best-practice' | 'review';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface ScanOptions {
  url: string;
  /** Optional credentials — used only if the site shows a sign-in form. */
  username?: string;
  password?: string;
  /** Hard cap on pages visited in the browser. */
  maxPages: number;
  /** How many hops from the start page to follow. */
  maxDepth: number;
  /** Also seed the crawl from the site's sitemap.xml when it has one. */
  useSitemap: boolean;
  /** Also fetch external (off-site) links to confirm they resolve. */
  checkExternalLinks: boolean;
  /** Politeness delay between page visits (ms). robots.txt Crawl-delay overrides upward, capped. */
  crawlDelayMs: number;
}

export interface ProgressEvent {
  seq: number;
  at: string;
  type:
    | 'start' | 'robots' | 'sitemap' | 'navigate' | 'page' | 'login'
    | 'accessibility' | 'best-practice' | 'links' | 'link-check'
    | 'summary' | 'warning' | 'error' | 'done';
  message: string;
  data?: Record<string, unknown>;
}

export interface Finding {
  pageUrl: string;
  category: FindingCategory;
  ruleId: string;
  severity: Severity;
  title: string;
  description?: string;
  /** e.g. "1.1.1 (A)" */
  wcag?: string;
  /** CSS selector of the offending element, when known. */
  element?: string;
  htmlSnippet?: string;
  helpUrl?: string;
  occurrences: number;
  details?: Record<string, unknown>;
}

/** How the crawler learned about a page: the start URL, the sitemap, or a link on an audited page. */
export type PageSource = 'start' | 'sitemap' | 'link';

export interface PageResult {
  url: string;
  title: string;
  statusCode: number | null;
  depth: number;
  parentUrl?: string;
  source: PageSource;
  loadMs: number;
  linksFound: number;
  a11yScore: number;
  bpScore: number;
  findings: Finding[];
}

export interface LinkResult {
  url: string;
  status: number | null;
  ok: boolean;
  kind: 'ok' | 'redirect' | 'broken' | 'server-error' | 'timeout' | 'error' | 'blocked' | 'skipped';
  finalUrl?: string;
  external: boolean;
  referrers: string[];
  linkText?: string;
  error?: string;
}

export interface CategoryScore {
  score: number;      // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  label: string;
}

/**
 * Exactly what the crawl touched, so the report can prove its own coverage:
 * every page opened, every page found but left unaudited, and where each came
 * from. Nothing here is estimated — the numbers are counts of real visits.
 */
export interface CrawlCoverage {
  /** Pages opened in the browser with every check run (unreachable pages are recorded, not estimated). */
  audited: number;
  /** In-scope pages found: audited + still queued when the audit ended. */
  found: number;
  /** Audited pages that never loaded (timeout, DNS, connection refused). */
  unreachable: number;
  /** Pages that redirected off-site; recorded, not crawled further. */
  redirectedOffSite: number;
  /** URLs that answered with a non-HTML type (PDF, image…) and were skipped. */
  skippedNonHtml: number;
  /** Where the pages came from. */
  bySource: Record<PageSource, { found: number; audited: number }>;
  /** Pages by distance from the start page (depth 0 = the start URL, 1 = its menu/links and sitemap pages…). */
  byDepth: { depth: number; found: number; audited: number }[];
  /** Site sections (first two path segments), biggest first. */
  bySection: { path: string; found: number; audited: number; templated: boolean }[];
  /** Unique links seen on audited pages. */
  links: { unique: number; internal: number; external: number; checked: number; skipped: number };
  /** Pages found but not audited when the audit ended (capped — see notAuditedTotal). */
  notAudited: { url: string; depth: number; source: PageSource; parentUrl?: string }[];
  notAuditedTotal: number;
  /** Why the audit ended before every found page was audited. */
  stoppedBecause: 'every-page-audited' | 'page-limit' | 'cancelled';
}

export interface ScanSummary {
  targetUrl: string;
  siteName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesCrawled: number;
  /** Pages found (audited + still queued) — how big the site is, regardless of how far the audit got. */
  pagesDiscovered: number;
  linksFound: number;
  linksChecked: number;
  loginAttempted: boolean;
  loginSucceeded: boolean | null;
  robots: { crawlDelay: number | null; disallowCount: number; sitemaps: string[] };
  sitemapUrlsFound: number;
  /** What the site consists of: sitemap URLs, language versions, pages in scope, templated sections. */
  inventory?: SiteInventory;
  /** Proof of what was visited: pages by section / depth / source, links, and the pages left unaudited. */
  coverage?: CrawlCoverage;
  overall: CategoryScore;
  categories: {
    accessibility: CategoryScore & { violations: number; needsReview: number; bySeverity: Record<Severity, number>; topRules: { ruleId: string; title: string; severity: Severity; pages: number; occurrences: number; helpUrl?: string; wcag?: string }[] };
    links: CategoryScore & { checked: number; ok: number; redirects: number; broken: number; serverErrors: number; timeouts: number; blocked: number; brokenLinks: LinkResult[]; blockedLinks: LinkResult[] };
    bestPractice: CategoryScore & { rulesEvaluated: number; rulesPassed: number; failingRules: { ruleId: string; title: string; severity: Severity; pages: number }[] };
  };
  worstPages: { url: string; title: string; a11yScore: number; bpScore: number; findings: number }[];
  notes: string[];
}

export function gradeFor(score: number): CategoryScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function gradeLabel(grade: CategoryScore['grade']): string {
  return { A: 'Excellent', B: 'Good', C: 'Needs attention', D: 'Poor', F: 'Critical' }[grade];
}

export function makeScore(score: number): CategoryScore {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  const grade = gradeFor(s);
  return { score: s, grade, label: gradeLabel(grade) };
}
