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

export interface PageResult {
  url: string;
  title: string;
  statusCode: number | null;
  depth: number;
  parentUrl?: string;
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

export interface ScanSummary {
  targetUrl: string;
  siteName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesCrawled: number;
  linksFound: number;
  linksChecked: number;
  loginAttempted: boolean;
  loginSucceeded: boolean | null;
  robots: { crawlDelay: number | null; disallowCount: number; sitemaps: string[] };
  sitemapUrlsFound: number;
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
