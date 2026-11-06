/**
 * postman-script-parser.ts
 * ────────────────────────
 * Translate a Postman request's test / pre-request scripts into the flow model's
 * own assertions (`FlowCheck`) and variable captures (`FlowExtract`) — so an
 * imported collection keeps the user's TEST INTENT, not just the request shape.
 *
 * It does NOT execute the script (that would be running arbitrary JS). It
 * pattern-matches the handful of `pm.*` idioms that make up the overwhelming
 * majority of real-world scripts:
 *
 *   Assertions → checks
 *     pm.response.to.have.status(200)              → status
 *     pm.expect(pm.response.code).to.eql(201)      → status
 *     pm.response.to.be.ok / .to.be.success        → status (<400)
 *     pm.expect(pm.response.responseTime).below(n) → responseTimeUnderMs
 *     pm.response.to.have.header("X"[, "Y"])       → header (exists | equals)
 *     pm.expect(pm.response.headers.get("X"))
 *         .to.include("Y") / .to.eql("Y")          → header (contains | equals)
 *     pm.expect(json.a.b).to.eql(5)                → jsonPathEquals
 *     pm.expect(json.a).to.exist / .have.property  → jsonPathExists
 *     pm.expect(pm.response.text()).to.include("x")→ bodyContains
 *
 *   Captures → extracts (variable chaining)
 *     pm.environment.set("token", json.token)      → { from:'body',   path:'token' }
 *     pm.collectionVariables.set("id", json.data.id)→ { from:'body',  path:'data.id' }
 *     pm.globals.set("loc", pm.response.headers.get("Location"))
 *                                                   → { from:'header', path:'Location' }
 *     pm.variables.set("code", pm.response.code)    → { from:'status' }
 *     pm.environment.set("env", "prod")             → seed variable (literal)
 *
 * Anything it cannot confidently map is dropped (never guessed) and, when a script
 * was present but yielded nothing, a single soft warning is returned so the user
 * knows to finish the conversion by hand. Pure and dependency-free.
 */
import type { FlowCheck, FlowExtract } from '../services/api-flow.service.js';

export interface ParsedPostmanScript {
  checks: FlowCheck[];
  extracts: FlowExtract[];
  /** Variables set to a literal value (pre-request seeds / static env.set). */
  variables: Record<string, string>;
  /** Soft, name-less notes; the caller prefixes them with the request name. */
  warnings: string[];
}

const MAX_CHECKS = 20;
const MAX_EXTRACTS = 20;

/** Gather the exec lines of a listener kind ("test" | "prerequest") into text. */
function scriptText(events: unknown, listen: 'test' | 'prerequest'): string {
  if (!Array.isArray(events)) return '';
  const lines: string[] = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, any>;
    if (ev.listen !== listen) continue;
    const exec = ev.script?.exec ?? ev.script?.src ?? ev.script;
    if (Array.isArray(exec)) lines.push(...exec.map((l) => String(l)));
    else if (typeof exec === 'string') lines.push(exec);
  }
  return lines.join('\n');
}

/** Variable names bound to the parsed response body, e.g. `var d = pm.response.json()`. */
function jsonAliases(src: string): Set<string> {
  const set = new Set<string>();
  const re = /(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) set.add(m[1]!);
  return set;
}

/** A JS accessor tail (".data[0].id", "['a'].b", "") → a flow body path ("data.0.id"). */
function toPath(accessor: string): string | null {
  let p = (accessor || '').trim();
  if (p === '') return '';
  p = p
    .replace(/\[\s*'([^']*)'\s*\]/g, '.$1')
    .replace(/\[\s*"([^"]*)"\s*\]/g, '.$1')
    .replace(/\[\s*(\d+)\s*\]/g, '.$1')
    .replace(/^\./, '');
  // Only a plain dotted path survives — anything else (calls, operators) is unsafe to map.
  if (!/^[\w$][\w$.-]*$/.test(p)) return null;
  return p;
}

/** An expression that reads from the response body → its dotted path (or null). */
function bodyPathOf(expr: string, aliases: Set<string>): string | null {
  const e = expr.trim();
  const pj = e.match(/^pm\.response\.json\(\)\s*(.*)$/s);
  if (pj) return toPath(pj[1]!);
  const jp = e.match(/^JSON\.parse\([^)]*\)\s*(.*)$/s);
  if (jp) return toPath(jp[1]!);
  const am = e.match(/^([A-Za-z_$][\w$]*)\s*(.*)$/s);
  if (am && aliases.has(am[1]!)) return toPath(am[2]!);
  return null;
}

function unquote(v: string): string {
  const s = v.trim();
  const m = s.match(/^(['"`])([\s\S]*)\1$/);
  return m ? m[2]! : s;
}

/** Join a base body path with a property name (either may be empty / whole-body). */
function joinPath(base: string, prop: string): string {
  if (!base) return prop;
  if (!prop) return base;
  return `${base}.${prop}`;
}

/* ────────────────────────────────────────────────────────────────
   Captures:  pm.*.set(name, value)  →  extract | seed variable
   ──────────────────────────────────────────────────────────────── */

const SET_LINE = /(?:pm\.(?:environment|collectionVariables|collection|globals|variables)\.set|postman\.setEnvironmentVariable|postman\.setGlobalVariable)\(\s*(['"])([^'"]+)\1\s*,\s*(.+?)\s*\)\s*;?\s*$/;

function parseSets(src: string, aliases: Set<string>, out: ParsedPostmanScript): void {
  for (const line of src.split('\n')) {
    const m = line.match(SET_LINE);
    if (!m) continue;
    const name = m[2]!;
    const expr = m[3]!.trim();

    // status / header / body sources → an extract
    if (/^pm\.response\.code$/.test(expr) || /^responseCode\.code$/.test(expr)) {
      if (out.extracts.length < MAX_EXTRACTS) out.extracts.push({ name, from: 'status' });
      continue;
    }
    const hdr = expr.match(/^pm\.response\.headers\.get\(\s*['"]([^'"]+)['"]\s*\)$/);
    if (hdr) {
      if (out.extracts.length < MAX_EXTRACTS) out.extracts.push({ name, from: 'header', path: hdr[1]! });
      continue;
    }
    const bp = bodyPathOf(expr, aliases);
    if (bp !== null) {
      if (out.extracts.length < MAX_EXTRACTS) out.extracts.push({ name, from: 'body', ...(bp ? { path: bp } : {}) });
      continue;
    }
    // A plain string / number / boolean literal → a seed variable.
    if (/^(['"`]).*\1$/.test(expr) || /^-?\d+(\.\d+)?$/.test(expr) || /^(true|false)$/.test(expr)) {
      out.variables[name] = unquote(expr);
    }
    // Anything else (a computed value) is left for the user — not guessed.
  }
}

/* ────────────────────────────────────────────────────────────────
   Assertions → checks
   ──────────────────────────────────────────────────────────────── */

/** Pull out every `pm.expect( ARG ) TAIL` with a balanced-paren ARG. */
function findExpectCalls(src: string): { arg: string; tail: string }[] {
  const out: { arg: string; tail: string }[] = [];
  const needle = 'pm.expect(';
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let depth = 1;
    let j = i + needle.length;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
    }
    const arg = src.slice(i + needle.length, j - 1);
    let k = j;
    while (k < src.length && src[k] !== '\n' && src[k] !== ';') k++;
    out.push({ arg, tail: src.slice(j, k) });
    i = j;
  }
  return out;
}

/** The value inside a `.to.eql(...)` / `.to.equal(...)` matcher tail, if any. */
function equalityValue(tail: string): string | null {
  const m = tail.match(/\.to(?:\.be|\.deep)?\.(?:eql|equal|equals)\(\s*([\s\S]+?)\s*\)\s*$/);
  return m ? unquote(m[1]!) : null;
}

function isExistence(tail: string): boolean {
  return /\.to(?:\.not)?\.(?:exist\b|be\.ok\b|be\.a\(|be\.an\(|be\.null\b|be\.undefined\b)/.test(tail)
    || /\.to\.not\.(?:be\.null|be\.undefined|be\.empty)\b/.test(tail);
}

function parseAssertions(src: string, aliases: Set<string>, out: ParsedPostmanScript): void {
  const push = (c: FlowCheck): void => { if (out.checks.length < MAX_CHECKS) out.checks.push(c); };

  // ── Statement-form assertions (no pm.expect) ──────────────────────
  // status(code)
  for (const m of src.matchAll(/pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g)) push({ kind: 'status', oneOf: [Number(m[1])] });
  // to.be.ok / to.be.success → any non-error status
  if (/pm\.response\.to\.be\.(?:ok|success)\b/.test(src)) push({ kind: 'status' });
  // responseTime via the statement form
  for (const m of src.matchAll(/pm\.response\.to\.have\.responseTime\.below\(\s*(\d+)\s*\)/g)) push({ kind: 'responseTimeUnderMs', ms: Number(m[1]) });
  // header with an expected value  (two-arg form)
  for (const m of src.matchAll(/pm\.response\.to\.have\.header\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]*)\3\s*\)/g)) push({ kind: 'header', name: m[2]!, op: 'equals', value: m[4]! });
  // header exists  (one-arg form — the trailing `)` right after the name rules out the two-arg form)
  for (const m of src.matchAll(/pm\.response\.to\.have\.header\(\s*(['"])([^'"]+)\1\s*\)/g)) push({ kind: 'header', name: m[2]!, op: 'exists' });
  // body contains, statement form
  for (const m of src.matchAll(/pm\.response\.to\.have\.body\(\s*(['"])([\s\S]*?)\1\s*\)/g)) push({ kind: 'bodyContains', text: m[2]! });

  // ── pm.expect(...) forms ──────────────────────────────────────────
  for (const { arg, tail } of findExpectCalls(src)) {
    const a = arg.trim();

    // status code
    if (/^pm\.response\.code$/.test(a) || /^responseCode\.code$/.test(a)) {
      const v = equalityValue(tail);
      if (v && /^\d{3}$/.test(v)) push({ kind: 'status', oneOf: [Number(v)] });
      continue;
    }
    // response time
    if (/^pm\.response\.responseTime$/.test(a)) {
      const below = tail.match(/\.to\.be\.below\(\s*(\d+)\s*\)/);
      if (below) push({ kind: 'responseTimeUnderMs', ms: Number(below[1]) });
      continue;
    }
    // header via headers.get("X")
    const hget = a.match(/^pm\.response\.headers\.get\(\s*['"]([^'"]+)['"]\s*\)$/);
    if (hget) {
      const name = hget[1]!;
      if (/\.to(?:\.not)?\.(?:include|contain|contains)\(/.test(tail)) {
        const vm = tail.match(/\.to(?:\.not)?\.(?:include|contain|contains)\(\s*([\s\S]+?)\s*\)/);
        push({ kind: 'header', name, op: 'contains', value: vm ? unquote(vm[1]!) : '' });
      } else {
        const v = equalityValue(tail);
        push(v != null ? { kind: 'header', name, op: 'equals', value: v } : { kind: 'header', name, op: 'exists' });
      }
      continue;
    }
    // body text / responseBody contains
    if (/^(?:pm\.response\.text\(\)|responseBody)$/.test(a)) {
      const vm = tail.match(/\.to(?:\.not)?\.(?:include|contain|contains)\(\s*([\s\S]+?)\s*\)/);
      if (vm) push({ kind: 'bodyContains', text: unquote(vm[1]!) });
      continue;
    }

    // Otherwise: an expression over the response body (alias / pm.response.json()).
    const basePath = bodyPathOf(a, aliases);
    if (basePath === null) continue;

    // .to.have.property("k")  → that property exists
    const prop = tail.match(/\.to\.have\.(?:a\.)?property\(\s*(['"])([^'"]+)\1\s*(?:,\s*([\s\S]+?)\s*)?\)/);
    if (prop) {
      const path = joinPath(basePath, prop[2]!);
      if (prop[3] != null) push({ kind: 'jsonPathEquals', path, value: unquote(prop[3]) });
      else push({ kind: 'jsonPathExists', path });
      continue;
    }
    const eqv = equalityValue(tail);
    if (eqv != null) { push({ kind: 'jsonPathEquals', path: basePath, value: eqv }); continue; }
    if (isExistence(tail)) { push({ kind: 'jsonPathExists', path: basePath }); continue; }
  }
}

/** Remove exact-duplicate checks while keeping first-seen order. */
function dedupeChecks(checks: FlowCheck[]): FlowCheck[] {
  const seen = new Set<string>();
  const out: FlowCheck[] = [];
  for (const c of checks) {
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Parse a Postman item's `event[]` (test + pre-request scripts) into flow checks,
 * extracts and seed variables. Best-effort and exception-safe.
 */
export function parsePostmanScripts(events: unknown): ParsedPostmanScript {
  const out: ParsedPostmanScript = { checks: [], extracts: [], variables: {}, warnings: [] };
  const test = scriptText(events, 'test');
  const pre = scriptText(events, 'prerequest');
  if (!test.trim() && !pre.trim()) return out;

  try {
    const aliases = jsonAliases(`${test}\n${pre}`);
    // Pre-request first, so a literal seed is overridden by a test-phase capture of the same name.
    parseSets(pre, aliases, out);
    parseSets(test, aliases, out);
    parseAssertions(test, aliases, out);
    out.checks = dedupeChecks(out.checks);

    // A test script was present but produced no assertions — flag it (old `tests[...]`
    // style, chained `.and`, custom helpers, etc. are not auto-converted).
    const hadAssertions = /pm\.(?:expect|response\.to)\b|tests\s*\[/.test(test);
    if (hadAssertions && out.checks.length === 0) {
      out.warnings.push('a test script was found but its assertions could not be auto-converted — add checks manually.');
    }
  } catch {
    out.warnings.push('its script could not be parsed and was skipped.');
  }
  return out;
}
