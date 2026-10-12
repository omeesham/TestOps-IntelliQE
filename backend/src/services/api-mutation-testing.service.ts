/**
 * api-mutation-testing.service.ts
 * ───────────────────────────────
 * Mutation testing for API assertions — grades how STRONG a test's assertions are.
 * Given a real sample response and the assertions a test makes about it, it injects
 * small faults into the response ("mutants": drop a field, null it, flip a boolean,
 * change a number, empty an array, change the status, …) and checks whether the
 * assertions would CATCH each fault. A mutant that slips through every assertion is
 * a gap — the test would pass even though the API changed.
 *
 * mutationScore = killed / total. A high score means the assertions actually pin
 * the contract down; survivors are turned into concrete "add an assertion for X"
 * suggestions. This answers "are my tests any good?", which coverage alone cannot.
 *
 * STRICTLY non-destructive and PURE: it mutates a local copy of the sample response
 * and re-evaluates the assertions in-process. No network call is ever made, no
 * write is ever fired. The pipeline is never involved.
 */

export type AssertKind = 'status' | 'jsonpath' | 'bodyContains' | 'bodyNotContains';
export interface Assertion {
  kind: AssertKind;
  /** status: the expected code. jsonpath: dotted path (a.b[0].c). */
  path?: string;
  /** jsonpath op. */
  op?: 'exists' | 'equals' | 'notEquals' | 'contains' | 'type' | 'gt' | 'lt';
  /** expected value (status equals / jsonpath equals / contains / type name). */
  value?: string | number;
}

export interface SampleResponse {
  status: number;
  /** Raw body text (JSON is parsed; non-JSON still supports status + body assertions). */
  body: string;
}

export interface Mutant { id: string; operator: string; target: string; description: string; killedBy: string[]; survived: boolean }
export interface MutationResult {
  gradable: boolean;
  /** assertions that already FAIL on the pristine response (can't grade until fixed). */
  failingOnOriginal: { index: number; summary: string }[];
  total: number;
  killed: number;
  survived: number;
  mutationScore: number;             // 0–100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  survivors: Mutant[];
  mutants: Mutant[];
  suggestions: string[];
  notes: string[];
}

/* ── tiny JSON path reader (dotted + [i]) ── */
function readPath(root: unknown, path: string): { found: boolean; value: unknown } {
  if (!path) return { found: true, value: root };
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return { found: false, value: undefined };
    if (!(p in cur)) return { found: false, value: undefined };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Evaluate one assertion against a (status, parsedBody, bodyText) tuple. */
function evalAssertion(a: Assertion, status: number, body: unknown, bodyText: string): boolean {
  switch (a.kind) {
    case 'status': return String(status) === String(a.value);
    case 'bodyContains': return bodyText.includes(String(a.value ?? ''));
    case 'bodyNotContains': return !bodyText.includes(String(a.value ?? ''));
    case 'jsonpath': {
      const { found, value } = readPath(body, String(a.path || ''));
      switch (a.op || 'exists') {
        case 'exists': return found;
        case 'equals': return found && String(value) === String(a.value);
        case 'notEquals': return !found || String(value) !== String(a.value);
        case 'contains': return found && String(value).includes(String(a.value ?? ''));
        case 'type': return found && typeName(value) === String(a.value);
        case 'gt': return found && Number(value) > Number(a.value);
        case 'lt': return found && Number(value) < Number(a.value);
        default: return found;
      }
    }
    default: return false;
  }
}

function assertionSummary(a: Assertion): string {
  if (a.kind === 'status') return `status == ${a.value}`;
  if (a.kind === 'bodyContains') return `body contains "${a.value}"`;
  if (a.kind === 'bodyNotContains') return `body not contains "${a.value}"`;
  return `${a.path} ${a.op || 'exists'}${a.value !== undefined ? ` ${a.value}` : ''}`;
}

/* ── mutation operators ── */
function cloneJson<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/** Collect leaf + container paths worth mutating (bounded). */
function collectPaths(v: unknown, prefix: string, out: { path: string; value: unknown }[], depth = 0): void {
  if (out.length > 120 || depth > 8) return;
  if (v === null || typeof v !== 'object') { out.push({ path: prefix, value: v }); return; }
  if (Array.isArray(v)) {
    out.push({ path: prefix, value: v });
    v.slice(0, 5).forEach((el, i) => collectPaths(el, `${prefix}[${i}]`, out, depth + 1));
    return;
  }
  for (const k of Object.keys(v as Record<string, unknown>)) collectPaths((v as any)[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
}

function setPath(root: any, path: string, mutate: (cur: any, key: string | number, parent: any) => void): any {
  const clone = cloneJson(root);
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (!parts.length) return clone;
  let cur: any = clone;
  for (let i = 0; i < parts.length - 1; i++) { if (cur == null) return clone; cur = cur[parts[i]!]; }
  const last = parts[parts.length - 1]!;
  const key = /^\d+$/.test(last) ? Number(last) : last;
  if (cur != null) mutate(cur, key, cur);
  return clone;
}

const GRADE = (s: number): MutationResult['grade'] => (s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F');

export function gradeAssertions(sample: SampleResponse, rawAssertions: unknown): MutationResult {
  const assertions: Assertion[] = Array.isArray(rawAssertions)
    ? rawAssertions.slice(0, 60).map((a: any) => ({
        kind: (['status', 'jsonpath', 'bodyContains', 'bodyNotContains'].includes(a?.kind) ? a.kind : 'jsonpath') as AssertKind,
        path: a?.path ? String(a.path) : undefined,
        op: a?.op,
        value: a?.value,
      }))
    : [];
  if (!assertions.length) throw new Error('Provide at least one assertion to grade.');

  const status = Number(sample?.status) || 0;
  const bodyText = String(sample?.body ?? '');
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { body = undefined; }
  const notes: string[] = [];
  if (body === undefined) notes.push('Response body is not JSON — only status and body-text assertions can be graded.');

  // Precondition: every assertion must hold on the pristine response.
  const failingOnOriginal = assertions
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !evalAssertion(a, status, body, bodyText))
    .map(({ a, index }) => ({ index, summary: assertionSummary(a) }));
  if (failingOnOriginal.length) {
    return { gradable: false, failingOnOriginal, total: 0, killed: 0, survived: 0, mutationScore: 0, grade: 'F', survivors: [], mutants: [], suggestions: ['Fix the assertions that already fail on the real response, then re-grade.'], notes };
  }

  const mutants: Mutant[] = [];
  const runMutant = (operator: string, target: string, description: string, mStatus: number, mBody: unknown): void => {
    const mText = mBody === undefined ? bodyText : JSON.stringify(mBody);
    const killedBy: string[] = [];
    assertions.forEach((a) => { if (!evalAssertion(a, mStatus, mBody, mText)) killedBy.push(assertionSummary(a)); });
    mutants.push({ id: `m${mutants.length + 1}`, operator, target, description, killedBy, survived: killedBy.length === 0 });
  };

  // 1. Status mutations.
  for (const alt of [500, 404, status === 200 ? 201 : 200]) {
    if (alt === status) continue;
    runMutant('status-change', '(status)', `status ${status} → ${alt}`, alt, body);
  }

  // 2. Body-structure mutations (JSON only).
  if (body !== undefined && body !== null && typeof body === 'object') {
    const paths: { path: string; value: unknown }[] = [];
    collectPaths(body, '', paths);
    const leafPaths = paths.filter((p) => p.path && (p.value === null || typeof p.value !== 'object')).slice(0, 40);
    const arrPaths = paths.filter((p) => Array.isArray(p.value) && p.path).slice(0, 8);

    for (const { path, value } of leafPaths) {
      // drop the field
      runMutant('field-removed', path, `remove "${path}"`, status, setPath(body, path, (cur, key) => { if (Array.isArray(cur)) cur.splice(Number(key), 1); else delete cur[key]; }));
      // null the field
      runMutant('field-nulled', path, `null "${path}"`, status, setPath(body, path, (cur, key) => { cur[key] = null; }));
      // type-appropriate value change
      if (typeof value === 'boolean') runMutant('bool-flipped', path, `flip "${path}"`, status, setPath(body, path, (cur, key) => { cur[key] = !value; }));
      else if (typeof value === 'number') runMutant('number-changed', path, `change "${path}" (${value}→${value + 1})`, status, setPath(body, path, (cur, key) => { cur[key] = value + 1; }));
      else if (typeof value === 'string') runMutant('string-changed', path, `change "${path}"`, status, setPath(body, path, (cur, key) => { cur[key] = value === '' ? 'x' : `${value}_MUT`; }));
    }
    for (const { path } of arrPaths) {
      runMutant('array-emptied', path, `empty array "${path}"`, status, setPath(body, path, (cur, key) => { cur[key] = []; }));
    }
  } else if (body === undefined) {
    // Non-JSON: mutate the raw text so bodyContains assertions are at least exercised.
    mutants.push(...(() => {
      const t = bodyText.slice(0, 200);
      const mText = '';
      const killedBy: string[] = [];
      assertions.forEach((a) => { if (!evalAssertion(a, status, undefined, mText)) killedBy.push(assertionSummary(a)); });
      return [{ id: `m${mutants.length + 1}`, operator: 'body-emptied', target: '(body)', description: `empty the body (was ${t.length} chars)`, killedBy, survived: killedBy.length === 0 }];
    })());
  }

  const total = mutants.length;
  const killed = mutants.filter((m) => !m.survived).length;
  const survived = total - killed;
  const mutationScore = total ? Math.round((killed / total) * 100) : 0;
  const survivors = mutants.filter((m) => m.survived);

  const suggestions: string[] = [];
  const byOp = new Map<string, string[]>();
  for (const s of survivors) { const k = s.operator; if (!byOp.has(k)) byOp.set(k, []); byOp.get(k)!.push(s.target); }
  if (byOp.has('field-removed') || byOp.has('field-nulled')) suggestions.push(`Add existence/type assertions for fields that can vanish undetected: ${[...new Set([...(byOp.get('field-removed') || []), ...(byOp.get('field-nulled') || [])])].slice(0, 8).join(', ')}.`);
  if (byOp.has('number-changed')) suggestions.push(`Assert exact or bounded values for numeric fields: ${byOp.get('number-changed')!.slice(0, 8).join(', ')}.`);
  if (byOp.has('string-changed')) suggestions.push(`Assert string values/patterns for: ${byOp.get('string-changed')!.slice(0, 8).join(', ')}.`);
  if (byOp.has('bool-flipped')) suggestions.push(`Assert the expected boolean for: ${byOp.get('bool-flipped')!.slice(0, 8).join(', ')}.`);
  if (byOp.has('array-emptied')) suggestions.push(`Assert a minimum length for arrays: ${byOp.get('array-emptied')!.slice(0, 8).join(', ')}.`);
  if (byOp.has('status-change')) suggestions.push('Add an explicit status-code assertion — a changed status slips through.');
  if (!survivors.length) suggestions.push('No surviving mutants — the assertions pin this response down well.');

  return { gradable: true, failingOnOriginal: [], total, killed, survived, mutationScore, grade: GRADE(mutationScore), survivors: survivors.slice(0, 40), mutants: mutants.slice(0, 120), suggestions, notes };
}
