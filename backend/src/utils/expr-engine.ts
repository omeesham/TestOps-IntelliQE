/**
 * expr-engine.ts
 * ──────────────
 * A tiny, SAFE boolean expression evaluator for flow conditions — the step up
 * from the old single `var op value` form. It is a hand-written tokenizer plus
 * recursive-descent parser over a fixed grammar: NO `eval`, NO `Function`, no
 * access to anything but the flow's variable bag. Everything is bounded.
 *
 * Grammar (low → high precedence):
 *   or   := and ('||' and)*
 *   and  := not ('&&' not)*
 *   not  := '!' not | comparison
 *   cmp  := add ( (== != === !== < <= > >= contains startsWith endsWith matches) add )?
 *   add  := mul ( ('+' | '-') mul )*
 *   mul  := unary ( ('*' | '/') unary )*
 *   unary:= '-' unary | primary
 *   prim := number | 'string' | true | false | null | identifier | '(' or ')'
 *
 * Identifiers resolve from the variable bag (`{{name}}` is accepted too). Values
 * are strings; a comparison uses numeric order when BOTH sides look numeric,
 * otherwise string order. `and/or/not` are accepted as word forms.
 *
 * Examples:  `status == 200`,  `status >= 200 && status < 300`,
 *            `role == "admin" || isAdmin`,  `name contains "foo"`,
 *            `email matches ".+@.+"`,  `count > 0`
 */

export type ExprValue = string | number | boolean | null;

const MAX_EXPR_LEN = 2000;
const MAX_TOKENS = 500;

interface Tok { t: 'num' | 'str' | 'ident' | 'op'; v: string }

const MULTI_OPS = ['===', '!==', '&&', '||', '==', '!=', '<=', '>='];
const SINGLE_OPS = ['!', '(', ')', '+', '-', '*', '/', '<', '>'];
const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' };
const CMP_WORDS = new Set(['contains', 'startswith', 'endswith', 'matches']);
const CMP_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=', 'contains', 'startswith', 'endswith', 'matches']);

function tokenize(src: string): Tok[] {
  const s = src;
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    if (toks.length > MAX_TOKENS) throw new Error('Expression has too many tokens.');
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }

    // string literal
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let out = '';
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; } else { out += s[j]; j++; }
      }
      toks.push({ t: 'str', v: out }); i = j + 1; continue;
    }

    // {{var}} → identifier
    if (c === '{' && s[i + 1] === '{') {
      const end = s.indexOf('}}', i + 2);
      if (end !== -1) { toks.push({ t: 'ident', v: s.slice(i + 2, end).trim() }); i = end + 2; continue; }
    }

    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      toks.push({ t: 'num', v: s.slice(i, j) }); i = j; continue;
    }

    // identifier / word-operator / literal
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z0-9_.]/.test(s[j]!)) j++;
      const w = s.slice(i, j); const lw = w.toLowerCase();
      if (WORD_OPS[lw]) toks.push({ t: 'op', v: WORD_OPS[lw]! });
      else if (CMP_WORDS.has(lw)) toks.push({ t: 'op', v: lw });
      else toks.push({ t: 'ident', v: w });
      i = j; continue;
    }

    // operators (longest match first)
    const three = s.slice(i, i + 3);
    const two = s.slice(i, i + 2);
    if (MULTI_OPS.includes(three)) { toks.push({ t: 'op', v: three }); i += 3; continue; }
    if (MULTI_OPS.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (SINGLE_OPS.includes(c)) { toks.push({ t: 'op', v: c }); i += 1; continue; }

    throw new Error(`Unexpected character "${c}" in expression.`);
  }
  return toks;
}

function num(v: ExprValue): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return null;
  const s = String(v).trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

export function toBool(v: ExprValue): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'null' && s !== 'undefined';
}

function compare(a: ExprValue, op: string, b: ExprValue): boolean {
  const sa = a === null ? '' : String(a);
  const sb = b === null ? '' : String(b);
  switch (op) {
    case 'contains': return sa.includes(sb);
    case 'startswith': return sa.startsWith(sb);
    case 'endswith': return sa.endsWith(sb);
    case 'matches': { try { return new RegExp(sb).test(sa); } catch { return false; } }
    default: break;
  }
  const na = num(a); const nb = num(b);
  const bothNum = na !== null && nb !== null;
  switch (op) {
    case '==': case '===': return bothNum ? na === nb : sa === sb;
    case '!=': case '!==': return bothNum ? na !== nb : sa !== sb;
    case '<': return bothNum ? na! < nb! : sa < sb;
    case '<=': return bothNum ? na! <= nb! : sa <= sb;
    case '>': return bothNum ? na! > nb! : sa > sb;
    case '>=': return bothNum ? na! >= nb! : sa >= sb;
    default: return false;
  }
}

function arith(a: ExprValue, op: string, b: ExprValue): ExprValue {
  if (op === '+') {
    const na = num(a); const nb = num(b);
    if (na !== null && nb !== null) return na + nb;
    return `${a === null ? '' : a}${b === null ? '' : b}`;
  }
  const na = num(a) ?? 0; const nb = num(b) ?? 0;
  switch (op) {
    case '-': return na - nb;
    case '*': return na * nb;
    case '/': return nb === 0 ? NaN : na / nb;
    default: return NaN;
  }
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private vars: Record<string, string>) {}

  private peek(): Tok | undefined { return this.toks[this.i]; }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === 'op' && t.v === v; }
  private eat(v: string): boolean { if (this.isOp(v)) { this.i++; return true; } return false; }

  parse(): ExprValue {
    const v = this.or();
    if (this.i !== this.toks.length) throw new Error('Unexpected trailing tokens in expression.');
    return v;
  }

  private or(): ExprValue { let l = this.and(); while (this.isOp('||')) { this.i++; const r = this.and(); l = toBool(l) || toBool(r); } return l; }
  private and(): ExprValue { let l = this.not(); while (this.isOp('&&')) { this.i++; const r = this.not(); l = toBool(l) && toBool(r); } return l; }
  private not(): ExprValue { if (this.eat('!')) return !toBool(this.not()); return this.cmp(); }

  private cmp(): ExprValue {
    const l = this.add();
    const t = this.peek();
    if (t && t.t === 'op' && CMP_OPS.has(t.v)) { this.i++; const r = this.add(); return compare(l, t.v, r); }
    return l;
  }

  private add(): ExprValue { let l = this.mul(); while (this.isOp('+') || this.isOp('-')) { const op = this.toks[this.i++]!.v; const r = this.mul(); l = arith(l, op, r); } return l; }
  private mul(): ExprValue { let l = this.unary(); while (this.isOp('*') || this.isOp('/')) { const op = this.toks[this.i++]!.v; const r = this.unary(); l = arith(l, op, r); } return l; }
  private unary(): ExprValue { if (this.eat('-')) { const n = num(this.unary()); return n === null ? NaN : -n; } return this.primary(); }

  private primary(): ExprValue {
    const t = this.toks[this.i++];
    if (!t) throw new Error('Unexpected end of expression.');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = this.or(); if (!this.eat(')')) throw new Error('Missing ")".'); return v; }
    if (t.t === 'ident') {
      const lw = t.v.toLowerCase();
      if (lw === 'true') return true;
      if (lw === 'false') return false;
      if (lw === 'null') return null;
      const raw = this.vars[t.v];
      return raw === undefined ? null : raw;
    }
    throw new Error(`Unexpected token "${t.v}".`);
  }
}

/** Evaluate a boolean expression against a variable bag. Throws on a bad expression. */
export function evalExpression(expr: string, vars: Record<string, string> = {}): boolean {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  if (expr.length > MAX_EXPR_LEN) throw new Error('Expression is too long.');
  const toks = tokenize(expr);
  if (!toks.length) return false;
  return toBool(new Parser(toks, vars).parse());
}

/** As `evalExpression`, but a malformed expression yields `false` instead of throwing. */
export function evalExpressionSafe(expr: string, vars: Record<string, string> = {}): boolean {
  try { return evalExpression(expr, vars); } catch { return false; }
}
