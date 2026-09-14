/**
 * Roll per-page results into the website health summary.
 *
 * Scores are 0-100 per category and blended into one overall score:
 *   accessibility 45% · links 30% · best practice 25%
 * Accessibility carries the most weight because it is the category with legal
 * exposure (ADA / Section 508) — a site can have a few dead links and still be
 * usable; a site keyboard users cannot navigate cannot.
 */
import type { LinkResult, PageResult, ScanSummary, Severity } from './ada-types.js';
import { makeScore } from './ada-types.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

export function buildSummary(input: {
  targetUrl: string;
  siteName: string;
  startedAt: Date;
  finishedAt: Date;
  pages: PageResult[];
  links: LinkResult[];
  loginAttempted: boolean;
  loginSucceeded: boolean | null;
  robots: ScanSummary['robots'];
  sitemapUrlsFound: number;
  linksFound: number;
  notes: string[];
}): ScanSummary {
  const { pages, links } = input;
  const reachable = pages.filter((p) => p.statusCode !== null);

  // ── accessibility ──
  const a11yFindings = pages.flatMap((p) => p.findings.filter((f) => f.category === 'accessibility'));
  const bySeverity: Record<Severity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const byRule = new Map<string, { ruleId: string; title: string; severity: Severity; pages: Set<string>; occurrences: number; helpUrl?: string; wcag?: string }>();
  for (const f of a11yFindings) {
    bySeverity[f.severity] += f.occurrences;
    const r = byRule.get(f.ruleId) || { ruleId: f.ruleId, title: f.title, severity: f.severity, pages: new Set<string>(), occurrences: 0, helpUrl: f.helpUrl, wcag: f.wcag };
    r.pages.add(f.pageUrl);
    r.occurrences += f.occurrences;
    byRule.set(f.ruleId, r);
  }
  const violations = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  const a11yScore = reachable.length ? reachable.reduce((a, p) => a + p.a11yScore, 0) / reachable.length : 100;
  const topRules = [...byRule.values()]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.pages.size - a.pages.size)
    .slice(0, 15)
    .map((r) => ({ ruleId: r.ruleId, title: r.title, severity: r.severity, pages: r.pages.size, occurrences: r.occurrences, helpUrl: r.helpUrl, wcag: r.wcag }));

  // ── links ──
  const checked = links.filter((l) => l.kind !== 'skipped');
  const ok = checked.filter((l) => l.kind === 'ok').length;
  const redirects = checked.filter((l) => l.kind === 'redirect').length;
  const broken = checked.filter((l) => l.kind === 'broken').length;
  const serverErrors = checked.filter((l) => l.kind === 'server-error').length;
  const timeouts = checked.filter((l) => l.kind === 'timeout' || l.kind === 'error').length;
  const blockedList = checked.filter((l) => l.kind === 'blocked');
  const blocked = blockedList.length;
  // Redirects are healthy and blocked links are unknowable; only hard failures cost points.
  const scoreable = checked.length - blocked;
  const linkScore = scoreable > 0 ? ((ok + redirects) / scoreable) * 100 : 100;
  const brokenLinks = checked
    .filter((l) => !l.ok)
    .sort((a, b) => (a.external === b.external ? 0 : a.external ? 1 : -1) || (a.status ?? 999) - (b.status ?? 999))
    .slice(0, 200);

  // ── best practice ──
  const bpFindings = pages.flatMap((p) => p.findings.filter((f) => f.category === 'best-practice'));
  const bpByRule = new Map<string, { ruleId: string; title: string; severity: Severity; pages: Set<string> }>();
  for (const f of bpFindings) {
    const r = bpByRule.get(f.ruleId) || { ruleId: f.ruleId, title: f.title, severity: f.severity, pages: new Set<string>() };
    r.pages.add(f.pageUrl);
    bpByRule.set(f.ruleId, r);
  }
  const bpScore = reachable.length ? reachable.reduce((a, p) => a + p.bpScore, 0) / reachable.length : 100;
  const HYGIENE_RULES = 25; // keep in sync with ada-checks.ts
  const axeBpRules = [...bpByRule.keys()].filter((k) => k.startsWith('axe-')).length;
  const RULES_TOTAL = HYGIENE_RULES + axeBpRules;
  const failingRules = [...bpByRule.values()]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.pages.size - a.pages.size)
    .map((r) => ({ ruleId: r.ruleId, title: r.title, severity: r.severity, pages: r.pages.size }));

  const overall = a11yScore * 0.45 + linkScore * 0.30 + bpScore * 0.25;

  const worstPages = [...pages]
    .map((p) => ({ url: p.url, title: p.title, a11yScore: p.a11yScore, bpScore: p.bpScore, findings: p.findings.reduce((a, f) => a + f.occurrences, 0) }))
    .sort((a, b) => (a.a11yScore + a.bpScore) - (b.a11yScore + b.bpScore))
    .slice(0, 10);

  return {
    targetUrl: input.targetUrl,
    siteName: input.siteName,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    pagesCrawled: pages.length,
    linksFound: input.linksFound,
    linksChecked: checked.length,
    loginAttempted: input.loginAttempted,
    loginSucceeded: input.loginSucceeded,
    robots: input.robots,
    sitemapUrlsFound: input.sitemapUrlsFound,
    overall: makeScore(overall),
    categories: {
      accessibility: { ...makeScore(a11yScore), violations, bySeverity, topRules },
      links: { ...makeScore(linkScore), checked: checked.length, ok, redirects, broken, serverErrors, timeouts, blocked, brokenLinks, blockedLinks: blockedList.slice(0, 100) },
      bestPractice: { ...makeScore(bpScore), rulesEvaluated: RULES_TOTAL, rulesPassed: RULES_TOTAL - failingRules.length, failingRules },
    },
    worstPages,
    notes: input.notes,
  };
}
