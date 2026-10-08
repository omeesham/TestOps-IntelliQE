/**
 * web-a11y.service.ts
 * ───────────────────
 * Accessibility testing — a standalone, opt-in Web Lab tool. Loads a URL in a
 * headless browser, runs axe-core against it, and reports WCAG violations by
 * severity and rule. Lives alongside the generate → execute → heal pipeline and
 * never touches it.
 *
 * This finally wires up the accessibility reporting that was scaffolded in the
 * platform (AccessibilityTestData / compileAccessibilityReport) but never
 * populated — now a real scan produces the data.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { withPage, assertWebUrl, ENGINE_LABEL, type WebEngine } from './web-browser.service.js';

export type WcagStandard = 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa' | 'best-practice';

const STANDARD_TAGS: Record<WcagStandard, string[]> = {
  'wcag2a': ['wcag2a'],
  'wcag2aa': ['wcag2a', 'wcag2aa'],
  'wcag21aa': ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  'wcag22aa': ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  'best-practice': ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
};
const STANDARD_LABEL: Record<WcagStandard, string> = {
  'wcag2a': 'WCAG 2.0 A', 'wcag2aa': 'WCAG 2.0 AA', 'wcag21aa': 'WCAG 2.1 AA', 'wcag22aa': 'WCAG 2.2 AA', 'best-practice': 'WCAG 2.2 AA + best practices',
};

export type A11yImpact = 'critical' | 'serious' | 'moderate' | 'minor';
const IMPACTS: A11yImpact[] = ['critical', 'serious', 'moderate', 'minor'];

export interface A11yViolation {
  id: string;
  impact: A11yImpact | 'unknown';
  help: string;
  description: string;
  helpUrl: string;
  wcagTags: string[];
  nodeCount: number;
  sampleNodes: { html: string; target: string }[];
}

export interface A11yReport {
  url: string;
  engine: WebEngine;
  engineLabel: string;
  standard: WcagStandard;
  standardLabel: string;
  summary: {
    violations: number;
    byImpact: Record<A11yImpact, number>;
    passes: number;
    incomplete: number;
    score: number; // 0–100, weighted by severity
  };
  violations: A11yViolation[];
  scannedAt: string;
}

/** 0–100 score: start at 100, subtract weighted by severity × occurrences (capped). */
function scoreFrom(byImpact: Record<A11yImpact, number>): number {
  const weight: Record<A11yImpact, number> = { critical: 10, serious: 6, moderate: 3, minor: 1 };
  let penalty = 0;
  for (const k of IMPACTS) penalty += byImpact[k] * weight[k];
  return Math.max(0, Math.round(100 - Math.min(100, penalty)));
}

export async function runAccessibilityScan(input: { url: unknown; engine?: unknown; standard?: unknown }): Promise<A11yReport> {
  const url = assertWebUrl(input.url);
  const engine: WebEngine = (['chromium', 'firefox', 'webkit'].includes(String(input.engine)) ? input.engine : 'chromium') as WebEngine;
  const standard: WcagStandard = (Object.keys(STANDARD_TAGS).includes(String(input.standard)) ? input.standard : 'wcag21aa') as WcagStandard;

  const result = await withPage(url, async (page) => {
    const axe = new AxeBuilder({ page }).withTags(STANDARD_TAGS[standard]);
    return axe.analyze();
  }, { engine, waitUntil: 'load', gotoTimeoutMs: 45_000 });

  const byImpact: Record<A11yImpact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const violations: A11yViolation[] = result.violations.map((v) => {
    const impact = (IMPACTS.includes(v.impact as A11yImpact) ? v.impact : 'unknown') as A11yImpact | 'unknown';
    if (impact !== 'unknown') byImpact[impact] += v.nodes.length;
    return {
      id: v.id,
      impact,
      help: v.help,
      description: v.description,
      helpUrl: v.helpUrl,
      wcagTags: (v.tags || []).filter((t) => /^wcag|best-practice/i.test(t)),
      nodeCount: v.nodes.length,
      sampleNodes: v.nodes.slice(0, 5).map((n) => ({ html: String(n.html || '').slice(0, 600), target: (n.target || []).join(' ').slice(0, 400) })),
    };
  }).sort((a, b) => IMPACTS.indexOf(a.impact as A11yImpact) - IMPACTS.indexOf(b.impact as A11yImpact));

  return {
    url,
    engine,
    engineLabel: ENGINE_LABEL[engine],
    standard,
    standardLabel: STANDARD_LABEL[standard],
    summary: {
      violations: result.violations.length,
      byImpact,
      passes: result.passes.length,
      incomplete: result.incomplete.length,
      score: scoreFrom(byImpact),
    },
    violations,
    scannedAt: new Date().toISOString(),
  };
}
