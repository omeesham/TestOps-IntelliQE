/**
 * assert-engine.ts
 * ────────────────
 * Dependency-free assertion primitives shared by the flow runner (and reusable
 * by the generated test template):
 *   - queryPath(): a rich-JSONPath reader — dotted paths PLUS bracket indexing,
 *     wildcards, array slices, recursive descent and simple filters. A plain
 *     dotted path still returns exactly one value (backward-compatible with the
 *     old split-on-dot reader); anything wildcard/slice/recursive/filter returns
 *     every match.
 *   - compareJson(): structural comparison with the four JSONassert-style modes
 *     (strict / strict-order / lenient / non-extensible), expressed as two flags
 *     (extensible? arrays-ordered?).
 *
 * Pure and side-effect-free, so it is unit-tested directly.
 */

/* ───────────────────────── rich JSONPath ───────────────────────── */

type PathOp =
  | { t: 'key'; name: string }
  | { t: 'index'; i: number }
  | { t: 'slice'; start?: number; end?: number }
  | { t: 'wild' }
  | { t: 'recurse'; name: string }           // ..name  (name '*' = every descendant)
  | { t: 'filter'; key: string; op?: string; value?: string };

/** Parse a path string into an op list. Tolerant: unknown syntax is skipped. */
export function parsePath(path: string): PathOp[] {
  const ops: PathOp[] = [];
  let s = String(path || '').trim();
  if (s.startsWith('$')) s = s.slice(1);
  let i = 0;
  const readName = (): string => {
    let n = '';
    while (i < s.length && !'.[]'.includes(s[i]!)) { n += s[i]; i++; }
    return n;
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '.') {
      if (s[i + 1] === '.') { // recursive descent ..name
        i += 2;
        const name = s[i] === '*' ? (i++, '*') : readName();
        ops.push({ t: 'recurse', name });
      } else {
        i += 1;
        if (s[i] === '*') { i++; ops.push({ t: 'wild' }); }
        else { const name = readName(); if (name) ops.push({ t: 'key', name }); }
      }
    } else if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close === -1) break;
      const inner = s.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === '*') ops.push({ t: 'wild' });
      else if (inner.startsWith('?(') || inner.startsWith('?')) {
        // filter: ?(@.key OP value)  or  ?(@.key)
        const m = inner.match(/@\.?([\w.-]+)\s*(==|!=|>=|<=|>|<)?\s*(.*)$/);
        if (m) {
          let val = (m[3] || '').trim().replace(/\)+$/, '').trim();
          if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1);
          ops.push({ t: 'filter', key: m[1]!, op: m[2], value: m[2] ? val : undefined });
        }
      } else if (inner.includes(':')) {
        const [a, b] = inner.split(':');
        ops.push({ t: 'slice', start: a?.trim() ? Number(a) : undefined, end: b?.trim() ? Number(b) : undefined });
      } else if (/^-?\d+$/.test(inner)) {
        ops.push({ t: 'index', i: Number(inner) });
      } else {
        ops.push({ t: 'key', name: inner.replace(/^['"]|['"]$/g, '') });
      }
    } else {
      const name = readName();
      if (name) ops.push({ t: 'key', name });
    }
  }
  return ops;
}

function collectRecursive(node: unknown, name: string, out: unknown[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const el of node) collectRecursive(el, name, out); return; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (name === '*' || k === name) out.push(v);
    collectRecursive(v, name, out);
  }
}

function compareFilter(a: unknown, op: string | undefined, raw: string | undefined): boolean {
  if (!op) return a !== undefined && a !== null; // existence
  const r = raw ?? '';
  if (op === '==') return String(a) === r || Number(a) === Number(r) || (r === 'true' && a === true) || (r === 'false' && a === false);
  if (op === '!=') return !(String(a) === r || Number(a) === Number(r));
  if (op === '>') return Number(a) > Number(r);
  if (op === '<') return Number(a) < Number(r);
  if (op === '>=') return Number(a) >= Number(r);
  if (op === '<=') return Number(a) <= Number(r);
  return false;
}

export interface PathResult { values: unknown[]; deterministic: boolean }

/**
 * Evaluate a path against a parsed JSON value. `deterministic` is true only when
 * the path is a plain key/index chain (one value); wildcards/slices/recursion/
 * filters make it a multi-match query.
 */
export function queryPath(obj: unknown, path: string | undefined): PathResult {
  if (!path || path === '.' || path === '$') return { values: [obj], deterministic: true };
  const ops = parsePath(path);
  let nodes: unknown[] = [obj];
  let deterministic = true;
  for (const op of ops) {
    const next: unknown[] = [];
    if (op.t === 'key') {
      for (const n of nodes) {
        if (n == null || typeof n !== 'object') continue;
        // A numeric dotted segment ("items.0") indexes an array — backward-compatible with the old split-on-dot reader.
        if (Array.isArray(n)) { if (/^-?\d+$/.test(op.name)) { const idx = Number(op.name); const i = idx < 0 ? n.length + idx : idx; if (i >= 0 && i < n.length) next.push(n[i]); } }
        else if (op.name in (n as object)) next.push((n as Record<string, unknown>)[op.name]);
      }
    } else if (op.t === 'index') {
      for (const n of nodes) if (Array.isArray(n)) { const idx = op.i < 0 ? n.length + op.i : op.i; if (idx >= 0 && idx < n.length) next.push(n[idx]); }
    } else if (op.t === 'slice') {
      deterministic = false;
      for (const n of nodes) if (Array.isArray(n)) for (const el of n.slice(op.start, op.end)) next.push(el);
    } else if (op.t === 'wild') {
      deterministic = false;
      for (const n of nodes) { if (Array.isArray(n)) next.push(...n); else if (n != null && typeof n === 'object') next.push(...Object.values(n as object)); }
    } else if (op.t === 'recurse') {
      deterministic = false;
      for (const n of nodes) collectRecursive(n, op.name, next);
    } else if (op.t === 'filter') {
      deterministic = false;
      for (const n of nodes) if (Array.isArray(n)) for (const el of n) {
        const field = el != null && typeof el === 'object' ? (el as Record<string, unknown>)[op.key] : undefined;
        if (compareFilter(field, op.op, op.value)) next.push(el);
      }
    }
    nodes = next;
  }
  return { values: nodes, deterministic };
}

/* ───────────────────────── structural compare ───────────────────────── */

export type CompareMode = 'strict' | 'strict-order' | 'lenient' | 'non-extensible';

function modeFlags(mode: CompareMode): { extensible: boolean; strictOrder: boolean } {
  switch (mode) {
    case 'strict': return { extensible: false, strictOrder: true };
    case 'strict-order': return { extensible: true, strictOrder: true };
    case 'lenient': return { extensible: true, strictOrder: false };
    case 'non-extensible': return { extensible: false, strictOrder: false };
  }
}

function scalarEq(a: unknown, e: unknown): boolean {
  if (a === e) return true;
  if (typeof a !== typeof e) return String(a) === String(e);
  return false;
}

/** Returns null on match, or a short path+reason string for the first mismatch. */
function cmp(actual: unknown, expected: unknown, f: { extensible: boolean; strictOrder: boolean }, path: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path || '$'}: expected an array`;
    if (!f.extensible && actual.length !== expected.length) return `${path || '$'}: array length ${actual.length} ≠ ${expected.length}`;
    if (f.strictOrder) {
      for (let i = 0; i < expected.length; i++) {
        const r = cmp(actual[i], expected[i], f, `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    // unordered: each expected element must match some actual element (greedy, each used once).
    const used = new Set<number>();
    for (let i = 0; i < expected.length; i++) {
      let found = -1;
      for (let j = 0; j < actual.length; j++) { if (used.has(j)) continue; if (cmp(actual[j], expected[i], f, `${path}[${i}]`) === null) { found = j; break; } }
      if (found === -1) return `${path}[${i}]: no matching element in actual array`;
      used.add(found);
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path || '$'}: expected an object`;
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in a)) return `${path}.${k}: missing`;
      const r = cmp(a[k], e[k], f, `${path}.${k}`);
      if (r) return r;
    }
    if (!f.extensible) {
      const extra = Object.keys(a).filter((k) => !(k in e));
      if (extra.length) return `${path || '$'}: unexpected key${extra.length === 1 ? '' : 's'} ${extra.slice(0, 5).join(', ')}`;
    }
    return null;
  }
  return scalarEq(actual, expected) ? null : `${path || '$'}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`;
}

export interface CompareResult { pass: boolean; detail: string }

export function compareJson(actual: unknown, expected: unknown, mode: CompareMode = 'lenient'): CompareResult {
  const mismatch = cmp(actual, expected, modeFlags(mode), '');
  return mismatch ? { pass: false, detail: mismatch } : { pass: true, detail: 'matches' };
}
