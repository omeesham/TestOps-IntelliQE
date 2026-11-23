/**
 * ci-gate.ts
 * ──────────
 * Pure CI gate helpers. A CI job needs a single answer — did the run pass, and
 * what exit code should the pipeline see — plus a one-line summary to print.
 * This derives both from a flow/suite/dataset run result. No DB, no network —
 * directly unit-testable, and shared by the /flows/ci-run endpoint.
 */

export type CiRunKind = 'flow' | 'suite' | 'dataset';

export interface CiSummary {
  kind: CiRunKind;
  total: number;    // steps (flow) / flows (suite) / rows (dataset)
  passed: number;
  failed: number;
  durationMs: number;
  ok: boolean;
  line: string;     // human one-liner for the CI log
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/** Summarise a run result (flow | suite | dataset) into CI-friendly counts. */
export function summarizeCiRun(kind: CiRunKind, result: any): CiSummary {
  const durationMs = num(result?.durationMs);
  let total = 0, passed = 0;
  if (kind === 'suite') {
    const flows = Array.isArray(result?.flows) ? result.flows : [];
    total = flows.length;
    passed = flows.filter((f: any) => f?.passed).length;
  } else if (kind === 'dataset') {
    total = num(result?.rowsTotal) || (Array.isArray(result?.rows) ? result.rows.length : 0);
    passed = num(result?.rowsPassed);
  } else {
    const steps = Array.isArray(result?.steps) ? result.steps.filter((s: any) => s?.method !== 'WAIT') : [];
    total = steps.length;
    passed = steps.filter((s: any) => s?.ok).length;
  }
  const failed = Math.max(0, total - passed);
  const ok = result?.passed === true && failed === 0;
  const unit = kind === 'suite' ? 'flow' : kind === 'dataset' ? 'row' : 'step';
  const line = `${ok ? 'PASS' : 'FAIL'} · ${passed}/${total} ${unit}${total === 1 ? '' : 's'} passed${durationMs ? ` · ${durationMs}ms` : ''}`;
  return { kind, total, passed, failed, durationMs, ok, line };
}

/** The process exit code a CI job should use: 0 when the run passed, 1 otherwise. */
export function exitCodeFor(summaryOrPassed: CiSummary | boolean): number {
  const ok = typeof summaryOrPassed === 'boolean' ? summaryOrPassed : summaryOrPassed.ok;
  return ok ? 0 : 1;
}
