/**
 * junit.ts
 * ────────
 * Render integration-flow run results as JUnit XML — the format every CI system
 * (Jenkins, GitHub Actions, Azure DevOps, GitLab) ingests to publish test
 * reports. A flow becomes a <testsuite>, each step a <testcase>, and a failed
 * step (or a failed poll/retry) a <failure> carrying the check detail. Suites
 * emit one <testsuite> per flow; data-driven runs one per dataset row.
 *
 * Pure and dependency-free: callers pass the already-computed run result; this
 * only formats it. The shapes mirror api-flow.service (kept structural so this
 * util never imports the service and vice-versa).
 */

interface StepLike {
  name?: string;
  ok?: boolean;
  elapsedMs?: number;
  error?: string;
  checks?: { label?: string; pass?: boolean; detail?: string }[];
}
interface RunLike { steps?: StepLike[]; durationMs?: number }
interface SuiteFlowLike { name?: string; role?: string; run?: RunLike }
interface SuiteLike { flows?: SuiteFlowLike[]; durationMs?: number }
interface DatasetRowLike { index?: number; row?: Record<string, string>; run?: RunLike }
interface DatasetLike { rows?: DatasetRowLike[]; durationMs?: number }

interface JUnitCase { name: string; timeMs: number; failure?: { message: string; text: string } }
interface JUnitSuite { name: string; timeMs: number; cases: JUnitCase[] }

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const secs = (ms: number): string => (Math.max(0, ms || 0) / 1000).toFixed(3);

/** Turn a step into a JUnit case, deriving a failure from its checks / transport error. */
function stepToCase(s: StepLike, i: number): JUnitCase {
  const name = s.name || `step ${i + 1}`;
  const c: JUnitCase = { name, timeMs: Number(s.elapsedMs) || 0 };
  if (s.ok === false) {
    const failed = (s.checks || []).filter((k) => k.pass === false);
    const message = s.error || failed[0]?.label || 'step failed';
    const text = [
      s.error ? `error: ${s.error}` : '',
      ...failed.map((k) => `✗ ${k.label ?? ''}${k.detail ? ` — ${k.detail}` : ''}`),
    ].filter(Boolean).join('\n') || 'step failed';
    c.failure = { message, text };
  }
  return c;
}

function runToSuite(name: string, run: RunLike | undefined): JUnitSuite {
  const steps = run?.steps || [];
  return { name, timeMs: Number(run?.durationMs) || 0, cases: steps.map(stepToCase) };
}

/** A single flow run → one suite. */
export function flowToJUnitSuites(name: string, run: RunLike): JUnitSuite[] {
  return [runToSuite(name || 'Flow', run)];
}
/** A suite run → one <testsuite> per flow (setup/teardown flows labelled in the name). */
export function suiteToJUnitSuites(result: SuiteLike): JUnitSuite[] {
  return (result.flows || []).map((f) => {
    const role = f.role && f.role !== 'flow' ? ` [${f.role}]` : '';
    return runToSuite(`${f.name || 'Flow'}${role}`, f.run);
  });
}
/** A data-driven run → one <testsuite> per dataset row. */
export function datasetToJUnitSuites(name: string, result: DatasetLike): JUnitSuite[] {
  return (result.rows || []).map((r) => {
    const label = r.row && Object.keys(r.row).length
      ? Object.entries(r.row).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(', ')
      : `row ${Number(r.index ?? 0) + 1}`;
    return runToSuite(`${name || 'Flow'} · ${label}`, r.run);
  });
}

/** Render a list of suites as a JUnit <testsuites> document. */
export function renderJUnit(rootName: string, suites: JUnitSuite[]): string {
  let totalTests = 0, totalFail = 0, totalMs = 0;
  const body = suites.map((su) => {
    const tests = su.cases.length;
    const failures = su.cases.filter((c) => c.failure).length;
    totalTests += tests; totalFail += failures; totalMs += su.timeMs;
    const cases = su.cases.map((c) => {
      const open = `    <testcase name="${esc(c.name)}" classname="${esc(su.name)}" time="${secs(c.timeMs)}"`;
      if (!c.failure) return `${open} />`;
      return `${open}>\n      <failure message="${esc(c.failure.message)}">${esc(c.failure.text)}</failure>\n    </testcase>`;
    }).join('\n');
    return `  <testsuite name="${esc(su.name)}" tests="${tests}" failures="${failures}" time="${secs(su.timeMs)}">\n${cases}\n  </testsuite>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(rootName)}" tests="${totalTests}" failures="${totalFail}" time="${secs(totalMs)}">\n${body}\n</testsuites>\n`;
}

/** Convenience: dispatch by run kind to a complete JUnit document. */
export function toJUnit(kind: 'flow' | 'suite' | 'dataset', name: string, result: unknown): string {
  const r = (result || {}) as RunLike & SuiteLike & DatasetLike;
  const suites = kind === 'suite' ? suiteToJUnitSuites(r)
    : kind === 'dataset' ? datasetToJUnitSuites(name, r)
    : flowToJUnitSuites(name, r);
  return renderJUnit(name || 'IntelliQE Integration Tests', suites);
}
