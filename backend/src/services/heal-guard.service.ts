/**
 * Rules an AI healing fix must pass before it is tried. A fix may change how a
 * test finds and waits for things, never what it checks: a weaker test would
 * turn a real app defect into a pass.
 */

const MAX_TIMEOUT_MS = 60_000;

/** Code with comments removed and, when `blankStrings`, string contents blanked. */
function scan(code: string, blankStrings = false): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      const body = code.slice(i + 1, j);
      out += c + (blankStrings ? ' '.repeat(body.length) : body) + c;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const count = (code: string, re: RegExp) => (code.match(re) || []).length;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Plain string literals (no template expressions), comments ignored. */
function literals(code: string): string[] {
  return [...scan(code).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Literals in assertion statements and typed inputs: what the test checks and enters. */
function checkedValues(code: string): string[] {
  const clean = scan(code);
  const skeleton = scan(code, true);
  const values: string[] = [];
  for (const m of skeleton.matchAll(/\bexpect\b|\.(?:fill|type|pressSequentially|selectOption)\s*\(/g)) {
    const end = skeleton.indexOf(';', m.index);
    values.push(...literals(clean.slice(m.index, end < 0 ? undefined : end)));
  }
  return values;
}

/** Checks whose failure is ignored: inside a try block, or chained to .catch(). */
function swallowedChecks(skeleton: string): number {
  let n = 0;
  for (const m of skeleton.matchAll(/\btry\s*\{/g)) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < skeleton.length; j++) {
      if (skeleton[j] === '{') depth++;
      else if (skeleton[j] === '}' && --depth === 0) break;
    }
    n += count(skeleton.slice(m.index, j), /\bexpect\b/g);
  }
  return n + skeleton.split(';').filter((s) => /\bexpect\b/.test(s) && /\.catch\s*\(/.test(s)).length;
}

const maxTimeout = (skeleton: string) =>
  Math.max(0, ...[...skeleton.matchAll(/\b(?:timeout\s*:|setTimeout\s*\()\s*([\d_]+)/g)].map((m) => Number(m[1].replace(/_/g, ''))));

/**
 * Why `after` is a weaker test than `before`, or null when the fix is acceptable.
 * `caseText` is the test case's own wording; values it names may not change.
 */
export function weakerFixReason(before: string, after: string, caseText: string, error = ''): string | null {
  const [b, a] = [scan(before, true), scan(after, true)];
  const checks = /\bexpect(?:\.soft|\.poll)?\s*\(/g;
  if (count(a, checks) < count(b, checks)) return `it removes checks (${count(b, checks)} → ${count(a, checks)})`;
  if (count(a, /\bcheckDocument\s*\(/g) < count(b, /\bcheckDocument\s*\(/g)) return 'it drops the answer-key check';
  if (count(a, /\.(?:skip|fixme)\s*\(/g) > count(b, /\.(?:skip|fixme)\s*\(/g)) return 'it skips the test';
  const trivial = /\bexpect(?:\.soft)?\s*\(\s*(?:true|false|null|undefined|-?\d[\d.]*|'\s*'|"\s*")\s*\)/g;
  if (count(a, trivial) > count(b, trivial)) return 'it adds a check that is always true';
  if (swallowedChecks(a) > swallowedChecks(b)) return 'it ignores a check when it fails';
  if (count(a, /waitForTimeout\s*\(/g) > count(b, /waitForTimeout\s*\(/g)) return 'it adds a fixed wait';
  const picks = /\.(?:first|last)\s*\(\s*\)|\.nth\s*\(/g;
  if (count(a, picks) > count(b, picks) && !/strict mode violation|resolved to \d+ elements/i.test(error)) {
    return 'it picks the first/last match, which can act on a different element';
  }
  const timeout = maxTimeout(a);
  if (timeout > MAX_TIMEOUT_MS && timeout > maxTimeout(b)) return `it raises a timeout to ${timeout / 1000}s, which can hide a slow page`;
  const named = norm(caseText);
  const kept = new Set(literals(after).map(norm));
  const changed = checkedValues(before).find((v) => norm(v).length >= 3 && named.includes(norm(v)) && !kept.has(norm(v)));
  if (changed !== undefined) return `it changes "${changed}", which the test case names`;
  return null;
}
