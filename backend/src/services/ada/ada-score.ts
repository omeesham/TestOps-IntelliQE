/**
 * Roll per-page results into the website health summary.
 *
 * Scores are 0-100 per category and blended into one overall score:
 *   accessibility 45% · links 30% · best practice 25%
 * Accessibility carries the most weight because it is the category with legal
 * exposure (ADA / Section 508) — a site can have a few dead links and still be
 * usable; a site keyboard users cannot navigate cannot.
 */
import type { SiteInventory } from './ada-inventory.js';
import type { CrawlCoverage, LinkResult, PageResult, ScanSummary, Severity, UxRun, UxSummary } from './ada-types.js';
import { makeScore, unmeasuredScore } from './ada-types.js';
import { nearestColor, type DesignStandard } from './ada-design-standard.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function buildUx(run: UxRun, pages: PageResult[], standard: DesignStandard | null): UxSummary {
  const findings = pages.flatMap((p) => p.findings.filter((f) => f.category === 'visual'));
  const conf = (f: { details?: Record<string, unknown> }) => String(f.details?.confidence || 'high');
  const layoutScores = run.results.map((r) => r.layoutScore);
  const adhScores = run.results.map((r) => r.adherenceScore).filter((v): v is number => v !== null);
  const layout = layoutScores.length ? makeScore(avg(layoutScores)) : unmeasuredScore('Not checked');
  const adherence = adhScores.length ? makeScore(avg(adhScores)) : unmeasuredScore(run.standard ? 'Not checked' : 'No design standard uploaded');
  const subs = [layout.score, adherence.score].filter((v): v is number => v !== null);
  const overall = subs.length ? makeScore(avg(subs)) : unmeasuredScore('Not checked');

  const byRule = new Map<string, { ruleId: string; title: string; severity: Severity; family: string; confidence: string; pages: Set<string>; devices: Set<string>; occurrences: number }>();
  for (const f of findings) {
    const r = byRule.get(f.ruleId) || { ruleId: f.ruleId, title: f.title, severity: f.severity, family: String(f.details?.family || ''), confidence: conf(f), pages: new Set<string>(), devices: new Set<string>(), occurrences: 0 };
    r.pages.add(f.pageUrl); r.devices.add(String(f.details?.deviceLabel || f.details?.device || '')); r.occurrences += f.occurrences;
    byRule.set(f.ruleId, r);
  }
  return {
    ...overall,
    layout, adherence, standard: run.standard,
    issues: findings.filter((f) => conf(f) === 'high').reduce((a, f) => a + f.occurrences, 0),
    needsReview: findings.filter((f) => conf(f) !== 'high').reduce((a, f) => a + f.occurrences, 0),
    devices: run.devices.map((d) => {
      const rs = run.results.filter((r) => r.deviceId === d.id);
      const adh = rs.map((r) => r.adherenceScore).filter((v): v is number => v !== null);
      return {
        ...d, pagesChecked: rs.length,
        issues: findings.filter((f) => f.details?.device === d.id && conf(f) === 'high').reduce((a, f) => a + f.occurrences, 0),
        layoutScore: rs.length ? Math.round(avg(rs.map((r) => r.layoutScore))) : null,
        adherenceScore: adh.length ? Math.round(avg(adh)) : null,
      };
    }),
    topRules: [...byRule.values()]
      .sort((a, b) => Number(b.confidence === 'high') - Number(a.confidence === 'high') || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.occurrences - a.occurrences)
      .map((r) => ({ ruleId: r.ruleId, title: r.title, severity: r.severity, family: r.family, confidence: r.confidence, pages: r.pages.size, devices: [...r.devices].filter(Boolean), occurrences: r.occurrences })),
    typography: [...run.typography].sort((a, b) => b.uses - a.uses).slice(0, 40),
    colors: [...run.colors].sort((a, b) => b.uses - a.uses).slice(0, 40).map((c) => {
      if (!standard || !standard.colors.length) return c;
      const n = nearestColor(c.hex, standard.colors);
      const implicit = standard.allowBlackWhite && (c.hex === '#FFFFFF' || c.hex === '#000000');
      return { ...c, inStandard: implicit || (!!n && n.deltaE <= standard.tolerance.colorDeltaE), nearest: n ? { name: n.color.name, hex: n.color.hex, deltaE: Math.round(n.deltaE * 10) / 10 } : undefined };
    }),
    emulationNote: 'Phones and tablets are emulated in Chromium (viewport, pixel density, touch, user agent). Responsive layout is reproduced faithfully; Safari- or Samsung-Internet-specific rendering is not.',
  };
}

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
  inventory?: SiteInventory;
  coverage?: CrawlCoverage;
  ux?: UxRun;
  /** Needed only to mark which observed colours are in the palette. */
  designStandard?: DesignStandard | null;
  pagesDiscovered: number;
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
  const needsReview = pages.flatMap((p) => p.findings.filter((f) => f.category === 'review')).reduce((a, f) => a + f.occurrences, 0);
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
  // No links checked at all (audit stopped before the link phase, or a site
  // with no links) means NO score — never a default 100.
  const scoreable = checked.length - blocked;
  const linksMeasured = checked.length > 0;
  const linkScore: number | null = !linksMeasured ? null : scoreable > 0 ? ((ok + redirects) / scoreable) * 100 : 100;
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

  // Overall = weighted blend of the categories that were actually measured,
  // with the weights re-normalised so an unmeasured category neither helps
  // nor hurts.
  const ux = input.ux ? buildUx(input.ux, pages, input.designStandard || null) : undefined;
  // UX takes a fifth of the overall when it ran; the other three keep their
  // relative weights (0.45 : 0.30 : 0.25) either way thanks to re-normalisation.
  const weighted: [number | null, number][] = [[a11yScore, 0.36], [linkScore, 0.24], [bpScore, 0.20], [ux ? ux.score : null, 0.20]];
  const measured = weighted.filter((w): w is [number, number] => w[0] !== null);
  const weightSum = measured.reduce((a, [, w]) => a + w, 0);
  const overall = measured.reduce((a, [v, w]) => a + v * w, 0) / (weightSum || 1);
  const notes = [...input.notes];
  if (!linksMeasured) {
    notes.push(`No links were checked${input.linksFound ? ` (${input.linksFound.toLocaleString()} were collected)` : ''}, so the Links category is not scored and the overall health score is based on accessibility and best practices only.`);
  }

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
    pagesDiscovered: Math.max(input.pagesDiscovered, pages.length),
    inventory: input.inventory,
    coverage: input.coverage,
    linksFound: input.linksFound,
    linksChecked: checked.length,
    loginAttempted: input.loginAttempted,
    loginSucceeded: input.loginSucceeded,
    robots: input.robots,
    sitemapUrlsFound: input.sitemapUrlsFound,
    overall: makeScore(overall),
    categories: {
      accessibility: { ...makeScore(a11yScore), violations, needsReview, bySeverity, topRules },
      links: { ...(linkScore === null ? unmeasuredScore('Not checked') : makeScore(linkScore)), checked: checked.length, ok, redirects, broken, serverErrors, timeouts, blocked, brokenLinks, blockedLinks: blockedList.slice(0, 100) },
      bestPractice: { ...makeScore(bpScore), rulesEvaluated: RULES_TOTAL, rulesPassed: RULES_TOTAL - failingRules.length, failingRules },
      ...(ux ? { ux } : {}),
    },
    worstPages,
    notes,
  };
}

/**
 * Audits saved before the Links category could be reported as "not checked"
 * stored a default 100 / Grade A with zero links checked. Rewrite that on
 * read so an old report never shows a score for something never measured,
 * and re-blend the overall score from the categories that were.
 */
export function normaliseLegacySummary<T extends ScanSummary | null | undefined>(summary: T): T {
  const cats = summary?.categories;
  const links = cats?.links as (ScanSummary["categories"]["links"] & { measured?: boolean }) | undefined;
  if (!summary || !cats || !links || links.measured !== undefined || (links.checked ?? 0) > 0) return summary;
  Object.assign(links, unmeasuredScore("Not checked"));
  const a = cats.accessibility?.score;
  const b = cats.bestPractice?.score;
  if (typeof a === "number" && typeof b === "number") summary.overall = makeScore((a * 0.45 + b * 0.25) / 0.70);
  const note = "No links were checked in this audit, so the Links category is not scored and the overall health score is based on accessibility and best practices only.";
  summary.notes = [...(summary.notes || []).filter((n) => n !== note), note];
  return summary;
}
