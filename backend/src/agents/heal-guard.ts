/**
 * Heal safety guard — deterministic anti-"cheat" verification.
 *
 * An auto-healer's worst failure mode is making a test pass by WEAKENING it:
 * deleting/loosening the assertion, skipping it, swallowing its failure, or
 * asserting something trivially true. Such a "fix" turns red green while
 * destroying the test's value — strictly worse than a visible failure. Before we
 * ever trust a healed spec we statically compare it to the ORIGINAL and reject
 * any change that reduces verification strength, regardless of whether it passes
 * at runtime.
 *
 * This is a heuristic SAFETY NET layered with the runtime re-run and the
 * intent-preserving prompt — defense in depth, not a perfect oracle. It is
 * deliberately conservative: when in doubt it rejects (the heal loop then gets
 * another attempt, and an unhealable test is quarantined for human review).
 *
 * Pure functions — no LLM, no I/O — so this layer is fully unit-testable and
 * cannot itself fail a heal run.
 */

export interface WeakeningVerdict {
  weakened: boolean;
  reasons: string[];
}

const EXPECT_RE = /\bexpect\s*\(/g;
const SOFT_RE = /\bexpect\s*\.\s*soft\s*\(/;
const SKIP_FIXME_RE = /\btest\s*\.\s*(?:skip|fixme)\b/;
const ONLY_RE = /\btest\s*\.\s*only\b/;
const TRIVIAL_RE = /\bexpect\s*\(\s*(?:true|false|1|0|!!1)\s*\)\s*\.\s*(?:toBeTruthy|toBeFalsy|toBe|toBeDefined)\b/;
const NOT_RE = /\.\s*not\s*\./g;
const IF_FALSE_RE = /\bif\s*\(\s*false\s*\)/; // `\s` matches newlines, so multiline `if(\nfalse\n)` is covered
const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/;
const MATCH_ALL_TOKENS = ['/.*/', '/^.*$/', '[\\s\\S]*'];

function count(re: RegExp, s: string): number {
  return (s.match(re) || []).length;
}

function nonWs(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/**
 * Blank out string/template literals FIRST (so `//` or `expect(` inside a URL or
 * a string never registers as a comment or a real assertion), then strip block
 * and line comments. Regex-literal edge cases (`//` inside a regex) are a known,
 * accepted limitation of this heuristic.
 */
function stripStringsAndComments(src: string): string {
  return src
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function hasMatchAll(live: string): boolean {
  const compact = live.replace(/\s+/g, '');
  return MATCH_ALL_TOKENS.some((t) => compact.includes(t.replace(/\s+/g, '')));
}

/**
 * Compare a healed spec against the original and report every way the fix made
 * the test weaker. `weakened: true` ⇒ reject even if it passes at runtime.
 */
export function detectAssertionWeakening(original: string, fixed: string): WeakeningVerdict {
  const reasons: string[] = [];
  const origLive = stripStringsAndComments(original);
  const newLive = stripStringsAndComments(fixed);

  const origExpects = count(EXPECT_RE, origLive);
  const newExpects = count(EXPECT_RE, newLive);

  // A drop in assertion count is only suspicious when the fix is not clearly MORE
  // assertion logic — legitimate consolidation (two expects → one richer
  // toEqual) tends to be at least as long. Compare non-whitespace length so
  // padding cannot game the check.
  if (newExpects < origExpects && nonWs(newLive) <= nonWs(origLive)) {
    reasons.push(`assertion count dropped (${origExpects} → ${newExpects}) without added assertion logic`);
  }
  if (newExpects === 0) {
    reasons.push('healed spec contains no assertions');
  }
  // Soft assertions weaken the test only when they REPLACE a hard assertion (the
  // hard `expect(` count drops). Adding soft checks alongside unchanged hard
  // assertions is a legitimate robustness pattern and is allowed.
  if (SOFT_RE.test(newLive) && !SOFT_RE.test(origLive) && newExpects < origExpects) {
    reasons.push('replaced a hard assertion with a soft one (expect.soft) that does not fail the test');
  }
  if (SKIP_FIXME_RE.test(newLive) && !SKIP_FIXME_RE.test(origLive)) {
    reasons.push('introduced test.skip()/test.fixme() to dodge the failure');
  }
  if (ONLY_RE.test(newLive)) {
    reasons.push('introduced test.only() (would silently drop the rest of the suite)');
  }
  if (TRIVIAL_RE.test(newLive)) {
    reasons.push('introduced a trivially-true/constant assertion');
  }
  if (hasMatchAll(newLive) && !hasMatchAll(origLive)) {
    reasons.push('introduced a match-everything pattern (e.g. /.*/) that asserts nothing');
  }
  // Dropping a negative assertion (.not.*) is flagged conservatively: it catches
  // the dangerous INVERSION case (e.g. `.not.toHaveURL(/dashboard/)` →
  // `.toHaveURL(/dashboard/)`), which the runtime re-run cannot detect because the
  // inverted test passes. A legitimate negative→equivalent-positive refactor
  // (e.g. `.not.toBeVisible()` → `.toBeHidden()`) may be flagged too, but the cost
  // is a quarantine for human review — never silent acceptance of a weaker test.
  const negBefore = count(NOT_RE, origLive);
  const negAfter = count(NOT_RE, newLive);
  if (negAfter < negBefore) {
    reasons.push(`removed ${negBefore - negAfter} negative assertion(s) (.not.*) — verify it did not flip the test's intent`);
  }
  if (IF_FALSE_RE.test(newLive) && !IF_FALSE_RE.test(origLive)) {
    reasons.push('wrapped code in an always-false `if (false)` branch so the assertion never runs');
  }
  // An EMPTY catch swallows failures (a real bypass the re-run can't catch). A
  // non-empty catch — e.g. the goto-retry loop the healing prompt itself
  // recommends for connection refusals — is legitimate and NOT flagged.
  if (EMPTY_CATCH_RE.test(newLive) && !EMPTY_CATCH_RE.test(origLive)) {
    reasons.push('introduced an empty catch block that can swallow a failure');
  }

  return { weakened: reasons.length > 0, reasons };
}

/** True when the "fix" is not actually a change (no-op echo of the input). */
export function isNoOpFix(original: string, fixed: string): boolean {
  return original.trim() === fixed.trim();
}

/**
 * Coarse failure category from the Playwright error text. Telemetry only — the
 * healing prompt does its own richer diagnosis.
 */
export type FailureCategory =
  | 'assertion'
  | 'selector'
  | 'timing'
  | 'network'
  | 'auth'
  | 'compile'
  | 'unknown';

export function categorizeFailure(error: string | undefined): FailureCategory {
  const e = (error || '').toLowerCase();
  if (!e) return 'unknown';
  if (e.includes('econnrefused') || e.includes('err_connection') || e.includes('err_name_not_resolved') || e.includes('net::err')) return 'network';
  if (e.includes('strict mode') || e.includes('resolved to') || e.includes('no element') || e.includes('not found') || e.includes('locator')) return 'selector';
  if (e.includes('timeout') || e.includes('timed out') || e.includes('exceeded')) return 'timing';
  if (e.includes('ts(') || e.includes('syntaxerror') || e.includes('is not defined') || e.includes('cannot find')) return 'compile';
  if (e.includes('unauthor') || e.includes('forbidden') || e.includes('login') || e.includes('credential') || e.includes('session')) return 'auth';
  if (e.includes('expect') || e.includes('tohave') || e.includes('tobe') || e.includes('assertion')) return 'assertion';
  return 'unknown';
}
