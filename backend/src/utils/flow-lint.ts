/**
 * flow-lint.ts
 * ────────────
 * Static pre-flight validation of a runnable flow — catch the authoring bugs
 * that only surface at run time (a typo'd `{{var}}`, a step that asserts nothing)
 * before a single request goes out. Pure, network-free, no model cost.
 *
 * Deliberately HIGH-PRECISION: it only reports things that are almost always a
 * real mistake, so authors trust the result. The headline check is the
 * undefined-variable reference — a `{{token}}` that is never seeded and never
 * captured by any step's `extract`. Variables bound dynamically (`{{$uuid}}`,
 * `{{$index}}`, …) and loop bindings (`item`, `$index`) are treated as provided.
 *
 * Also flags: request steps with no URL (error), request steps that assert
 * nothing (info), duplicate step names (warning), and captured-but-unused
 * variables (info).
 */
import type { FlowStep } from '../services/api-flow.service.js';

export type LintLevel = 'error' | 'warning' | 'info';
export interface LintIssue {
  level: LintLevel;
  /** step name (or a positional label) the issue is attached to, when applicable */
  step?: string;
  message: string;
}
export interface LintReport {
  ok: boolean;          // no errors (warnings/info don't fail the gate)
  errors: number;
  warnings: number;
  info: number;
  issues: LintIssue[];
}

/** Pull `{{token}}` variable names out of a string (filter suffix and dotting ignored → base key). */
const REF_RE = /\{\{\s*([\w$.-]+)/g;
function collectRefs(text: unknown, into: Set<string>): void {
  if (typeof text !== 'string' || !text) return;
  let m: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    const base = String(m[1]).split('.')[0].trim();
    if (base) into.add(base);
  }
}

/** Base variable key referenced by a condition/loop bare `var` (not a `{{}}` token). */
function baseKey(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.split('.')[0].trim() || undefined;
}

function label(s: FlowStep, i: number): string {
  return s.name || `${(s.method || s.type || 'step').toUpperCase()} ${s.url || ''}`.trim() || `step ${i + 1}`;
}

export function lintFlow(steps: FlowStep[] | undefined, variables: Record<string, string> = {}): LintReport {
  const issues: LintIssue[] = [];
  const declared = new Set<string>(Object.keys(variables || {}));
  const refsHard = new Set<string>();   // {{}} refs — drive the undefined-var error
  const usesSoft = new Set<string>();   // {{}} refs + bare condition/loop vars — suppress dead-capture info
  const names = new Map<string, number>();
  let requestCount = 0;

  // Pass 1 — gather declared vars (extracts, loop bindings) across the whole tree.
  const gather = (list: FlowStep[] | undefined, depth: number): void => {
    if (!list || depth > 8) return;
    for (const s of list) {
      for (const e of s.extract || []) if (e && e.name) declared.add(e.name);
      if (s.loop) { declared.add(s.loop.var || 'item'); declared.add('$index'); }
      gather(s.then, depth + 1);
      gather(s.else, depth + 1);
      gather(s.steps, depth + 1);
    }
  };
  gather(steps, 0);

  // Pass 2 — gather references and per-step structural issues.
  const walk = (list: FlowStep[] | undefined, depth: number): void => {
    if (!list || depth > 8) return;
    list.forEach((s, i) => {
      const kind = s.type || 'request';
      const nm = (s.name || '').trim();
      if (nm) names.set(nm, (names.get(nm) || 0) + 1);

      // references in substituted text fields
      collectRefs(s.url, refsHard);
      for (const h of s.headers || []) { collectRefs(h.key, refsHard); collectRefs(h.value, refsHard); }
      collectRefs(s.body, refsHard);
      for (const f of s.formFields || []) { collectRefs(f.key, refsHard); collectRefs(f.value, refsHard); }
      if (s.auth) collectRefs((s.auth as { value?: string }).value, refsHard);
      for (const c of s.checks || []) { collectRefs(c.expr, refsHard); collectRefs(c.text, refsHard); collectRefs(c.path, refsHard); if (typeof c.value === 'string') collectRefs(c.value, refsHard); }
      // soft references (bare var names in conditions/loops/retries) — don't drive errors
      for (const cond of [s.condition, s.loop?.while, s.retry?.until]) {
        if (!cond) continue;
        const b = baseKey(cond.var); if (b) usesSoft.add(b);
        collectRefs(cond.expr, usesSoft); collectRefs(cond.value, usesSoft);
      }
      collectRefs(s.loop?.items, usesSoft);

      // structural checks on real HTTP steps
      if (kind === 'request') {
        requestCount++;
        if (!s.url || !String(s.url).trim()) issues.push({ level: 'error', step: label(s, i), message: 'Request step has no URL.' });
        if (!s.checks || s.checks.length === 0) issues.push({ level: 'info', step: label(s, i), message: 'Step runs but asserts nothing — add at least a status check.' });
      }

      walk(s.then, depth + 1);
      walk(s.else, depth + 1);
      walk(s.steps, depth + 1);
    });
  };
  walk(steps, 0);

  // undefined-variable references (the headline check)
  for (const r of refsHard) {
    usesSoft.add(r);
    if (r.startsWith('$')) continue;               // dynamic token / loop $index
    if (!declared.has(r)) issues.push({ level: 'error', message: `References {{${r}}} which is never seeded or captured by any step.` });
  }
  // captured-but-never-used variables (only flag extracts, not seed vars)
  const extractNames = new Set<string>();
  const collectExtracts = (list: FlowStep[] | undefined, depth: number): void => {
    if (!list || depth > 8) return;
    for (const s of list) { for (const e of s.extract || []) if (e?.name) extractNames.add(e.name); collectExtracts(s.then, depth + 1); collectExtracts(s.else, depth + 1); collectExtracts(s.steps, depth + 1); }
  };
  collectExtracts(steps, 0);
  for (const name of extractNames) {
    if (name.startsWith('$')) continue;
    if (!usesSoft.has(name)) issues.push({ level: 'info', message: `Captured variable "${name}" is never used by a later step.` });
  }
  // duplicate step names
  for (const [nm, count] of names) if (count > 1) issues.push({ level: 'warning', message: `Step name "${nm}" is used ${count} times — rename for clearer results.` });

  if (requestCount === 0) issues.push({ level: 'warning', message: 'Flow has no HTTP request steps.' });

  // order: errors, then warnings, then info
  const rank: Record<LintLevel, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.level] - rank[b.level]);
  const errors = issues.filter((x) => x.level === 'error').length;
  const warnings = issues.filter((x) => x.level === 'warning').length;
  const info = issues.filter((x) => x.level === 'info').length;
  return { ok: errors === 0, errors, warnings, info, issues };
}
