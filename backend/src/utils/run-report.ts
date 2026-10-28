/**
 * run-report.ts
 * ─────────────
 * Render an integration-flow run result as a human-readable **Markdown report** —
 * the counterpart to junit.ts (which targets CI machines). Drop it in a PR
 * description, a bug report, or a Slack message: a verdict, a per-step table, and
 * a focused failure section (error + failed checks + a short body snippet).
 *
 * Pure and dependency-free: the caller passes an already-computed (and already
 * secret-masked) result; this only formats it. Shapes are kept STRUCTURAL so this
 * util never imports api-flow.service and vice-versa (mirrors junit.ts).
 */

interface CheckLike { kind?: string; label?: string; pass?: boolean; detail?: string }
interface StepLike {
  name?: string; method?: string; url?: string; phase?: string;
  ok?: boolean; status?: number; elapsedMs?: number; error?: string;
  checks?: CheckLike[]; extracted?: Record<string, string>; bodyPreview?: string;
}
interface RunLike { passed?: boolean; steps?: StepLike[]; variables?: Record<string, string>; durationMs?: number }
interface SuiteFlowLike { name?: string; role?: string; passed?: boolean; run?: RunLike }
interface SuiteLike { passed?: boolean; flows?: SuiteFlowLike[]; durationMs?: number }
interface DatasetRowLike { index?: number; row?: Record<string, string>; passed?: boolean; run?: RunLike }
interface DatasetLike { passed?: boolean; rows?: DatasetRowLike[]; durationMs?: number }

/** Escape a value for a Markdown table cell (pipes break columns; newlines break rows). */
function cell(s: unknown): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
function trunc(s: unknown, n: number): string {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}
const ms = (n: unknown): string => `${Math.max(0, Math.round(Number(n) || 0))}ms`;

/** Render one flow run (verdict + step table + failure details + captured vars). */
function renderRun(name: string, run: RunLike | undefined, heading: string): string[] {
  const steps = run?.steps || [];
  const passed = steps.filter((s) => s.ok !== false).length;
  const failed = steps.length - passed;
  let checks = 0, checksPassed = 0;
  for (const s of steps) for (const c of s.checks || []) { checks++; if (c.pass) checksPassed++; }
  const fail = run?.passed === false || failed > 0;
  const out: string[] = [];
  out.push(`${heading} ${cell(name) || 'Flow'} — ${fail ? '❌ FAIL' : '✅ PASS'}`);
  out.push('');
  out.push(`${steps.length} step${steps.length === 1 ? '' : 's'} · ${passed} passed · ${failed} failed · ${checksPassed}/${checks} checks · ${ms(run?.durationMs)}`);
  out.push('');
  if (steps.length) {
    out.push('| # | Step | Method | Status | Time | Checks | Result |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    steps.forEach((s, i) => {
      const cp = (s.checks || []).filter((c) => c.pass).length;
      const ct = (s.checks || []).length;
      const ph = s.phase && s.phase !== 'main' ? ` _(${cell(s.phase)})_` : '';
      out.push(`| ${i + 1} | ${cell(s.name) || `step ${i + 1}`}${ph} | ${cell(s.method) || '—'} | ${s.status ?? '—'} | ${ms(s.elapsedMs)} | ${cp}/${ct} | ${s.ok === false ? '❌' : '✅'} |`);
    });
    out.push('');
  }
  // Failure details — only the steps that failed, kept focused.
  const failedSteps = steps.filter((s) => s.ok === false);
  if (failedSteps.length) {
    out.push('**Failures**');
    out.push('');
    failedSteps.forEach((s, i) => {
      out.push(`- **${cell(s.name) || `step ${i + 1}`}** — \`${cell(s.method) || 'GET'} ${trunc(cell(s.url), 120)}\``);
      if (s.error) out.push(`  - error: ${cell(s.error)}`);
      for (const c of (s.checks || []).filter((k) => k.pass === false)) {
        out.push(`  - ✗ ${cell(c.label) || cell(c.kind)}${c.detail ? ` — ${cell(c.detail)}` : ''}`);
      }
      const body = trunc(String(s.bodyPreview || '').trim(), 400);
      if (body) { out.push('  - body:'); out.push('    ```'); for (const ln of body.split(/\r?\n/)) out.push(`    ${ln}`); out.push('    ```'); }
    });
    out.push('');
  }
  // Captured variables (already secret-masked by the caller).
  const vars = Object.entries(run?.variables || {});
  if (vars.length) {
    out.push('**Captured variables**');
    out.push('');
    for (const [k, v] of vars) out.push(`- \`${cell(k)}\` = ${cell(trunc(v, 80))}`);
    out.push('');
  }
  return out;
}

/** Dispatch by run kind to a complete Markdown document. */
export function toMarkdown(kind: 'flow' | 'suite' | 'dataset', name: string, result: unknown): string {
  const title = name || 'IntelliQE integration run';
  const r = (result || {}) as RunLike & SuiteLike & DatasetLike;
  const lines: string[] = [`# ${cell(title)} — integration run report`, ''];

  if (kind === 'suite') {
    const flows = r.flows || [];
    const fail = r.passed === false || flows.some((f) => f.passed === false || f.run?.passed === false);
    lines.push(`**Suite: ${fail ? '❌ FAIL' : '✅ PASS'}** · ${flows.length} flow${flows.length === 1 ? '' : 's'} · ${ms(r.durationMs)}`, '');
    flows.forEach((f) => {
      const role = f.role && f.role !== 'flow' ? ` [${cell(f.role)}]` : '';
      lines.push(...renderRun(`${f.name || 'Flow'}${role}`, f.run, '##'), '---', '');
    });
  } else if (kind === 'dataset') {
    const rows = r.rows || [];
    const fail = r.passed === false || rows.some((x) => x.passed === false || x.run?.passed === false);
    lines.push(`**Data-driven: ${fail ? '❌ FAIL' : '✅ PASS'}** · ${rows.length} row${rows.length === 1 ? '' : 's'} · ${ms(r.durationMs)}`, '');
    rows.forEach((x) => {
      const label = x.row && Object.keys(x.row).length
        ? Object.entries(x.row).map(([k, v]) => `${k}=${trunc(v, 24)}`).join(', ')
        : `row ${Number(x.index ?? 0) + 1}`;
      lines.push(...renderRun(label, x.run, '##'), '---', '');
    });
  } else {
    lines.push(...renderRun(title, r, '##'));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
