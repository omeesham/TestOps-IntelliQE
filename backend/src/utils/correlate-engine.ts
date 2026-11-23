/**
 * correlate-engine.ts
 * ───────────────────
 * Pure, DB-free dependency-correlation engine for captured traffic.
 *
 * Given the ORDERED request/response entries of a capture session, it finds
 * values a response produced (ids, tokens, uuids, emails) that a LATER request
 * reuses (url, a header like Authorization, or body), and rewrites the journey:
 *   • an EXTRACT is added on the producing step to bind the value to a {{var}};
 *   • the literal occurrence in the consuming step becomes that {{var}}.
 *
 * The output is a `FlowStep[]` that runs end-to-end instead of N disconnected
 * calls with stale hard-coded ids. Fully deterministic — the signal is "this
 * exact value was produced here and consumed there". No DB, no network, no LLM,
 * so it is directly unit-testable (see utils/correlate-engine.test on the repo).
 *
 * `import type` only from api-flow.service — erased at compile, so this module
 * pulls in no db/pool at runtime.
 */
import type { FlowStep, FlowExtract } from '../services/api-flow.service.js';

/* ── Bounds ── */
export const MAX_STEPS = 40;          // saveFlow caps at 40; build a clean journey, not a replay dump
const MAX_VALUES_PER_RESP = 300;      // candidate values harvested from one response body
const MAX_VALUE_LEN = 400;
const BODY_SCAN_LIMIT = 200_000;

export interface CaptureEntry {
  method: string;
  url: string;
  status?: number;
  reqHeaders: { key: string; value: string }[];
  reqBody?: string;
  resBody?: string;
}

export interface CorrelationLink {
  fromStep: number;             // 0-based index of the step whose response produced the value
  toStep: number;               // 0-based index of the step that consumes it
  var: string;                  // the flow variable bound/substituted
  in: 'url' | 'header' | 'body';
  header?: string;              // the consumer header name, when `in` is 'header'
  via: 'body' | 'header';       // how the value was read from the producer
}

export interface CorrelatedFlow {
  name: string;
  steps: FlowStep[];
  links: CorrelationLink[];
  variables: Record<string, string>;
  fromEntries: number;          // entries the session held
  stepCount: number;            // steps emitted (≤ MAX_STEPS)
  linkCount: number;            // dependency links discovered
}

/** A value produced by some step's response, and where it was read from. */
interface Candidate {
  value: string;
  step: number;
  via: 'body' | 'header';
  path: string;                 // dotted JSON path (via 'body') or header name (via 'header')
}

/* ────────────────────────────────────────────────────────────────
   Value harvesting & matching
   ──────────────────────────────────────────────────────────────── */

/**
 * Is this scalar worth correlating? We want identifiers/tokens, not noise like
 * `true`, a one-digit number, or a status word. The value must ALSO turn up in a
 * later request for a link to form — that reuse is the real guard — so this
 * filter only needs to drop the obviously-junk so we don't rewrite a stray "ok".
 */
export function isCorrelatable(v: string): boolean {
  if (!v || v.length < 2 || v.length > MAX_VALUE_LEN) return false;
  if (/^(true|false|null|undefined|yes|no|ok|success|error|none)$/i.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true; // uuid
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return true;            // jwt
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return true;             // email
  if (/^[0-9a-f]{24,}$/i.test(v)) return true;                       // mongo-ish / hash
  if (/^[A-Za-z0-9_-]{16,}$/.test(v)) return true;                  // long opaque token
  if (/^[A-Za-z0-9_-]{8,}$/.test(v) && /\d/.test(v)) return true;   // mixed alnum id/token
  if (/^\d{2,}$/.test(v)) return true;                               // numeric id (≥2 digits)
  return false;
}

/** Walk a parsed JSON value, collecting correlatable scalars with their dotted path. */
function collectValues(node: unknown, path: string, out: Candidate[], step: number, depth: number): void {
  if (depth > 6 || out.length >= MAX_VALUES_PER_RESP) return;
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length && out.length < MAX_VALUES_PER_RESP; i++) {
      collectValues(node[i], path ? `${path}.${i}` : String(i), out, step, depth + 1);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (out.length >= MAX_VALUES_PER_RESP) break;
      collectValues(v, path ? `${path}.${k}` : k, out, step, depth + 1);
    }
    return;
  }
  const s = typeof node === 'number' ? String(node) : (typeof node === 'string' ? node : '');
  if (isCorrelatable(s)) out.push({ value: s, step, via: 'body', path });
}

function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text.slice(0, BODY_SCAN_LIMIT)); } catch { return undefined; }
}

const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);

/** Does `needle` occur in `hay` as a WHOLE token (not inside a longer id/word)? */
export function occursAsToken(hay: string, needle: string): boolean {
  if (!hay || !needle) return false;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const before = i === 0 ? '' : hay[i - 1]!;
    const after = i + needle.length >= hay.length ? '' : hay[i + needle.length]!;
    if ((before === '' || !isWord(before)) && (after === '' || !isWord(after))) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
}

/** Replace every WHOLE-token occurrence of `needle` in `hay` with `token`. */
export function replaceToken(hay: string, needle: string, token: string): string {
  let out = '';
  let i = 0;
  while (i < hay.length) {
    const at = hay.indexOf(needle, i);
    if (at === -1) { out += hay.slice(i); break; }
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = at + needle.length >= hay.length ? '' : hay[at + needle.length]!;
    if ((before === '' || !isWord(before)) && (after === '' || !isWord(after))) {
      out += hay.slice(i, at) + token;
      i = at + needle.length;
    } else {
      out += hay.slice(i, at + needle.length);
      i = at + needle.length;
    }
  }
  return out;
}

function baseVarName(path: string, via: 'body' | 'header'): string {
  if (via === 'header') return 'locationId';
  const seg = (path.split('.').pop() || 'value').replace(/[^A-Za-z0-9_]/g, '');
  const name = /^[A-Za-z_]/.test(seg) ? seg : `v${seg}`;
  return name || 'value';
}

/* ────────────────────────────────────────────────────────────────
   Build steps from entries
   ──────────────────────────────────────────────────────────────── */

function stepName(entry: CaptureEntry, i: number): string {
  let path = entry.url;
  try { path = new URL(entry.url).pathname || entry.url; } catch { /* keep raw */ }
  return `${i + 1}. ${entry.method} ${path}`.slice(0, 120);
}

/** Expected-status check from the OBSERVED status, so the flow asserts the real contract. */
function statusCheck(status?: number): FlowStep['checks'] {
  if (!status || status < 100) return [{ kind: 'status' }];               // <400 default
  return [{ kind: 'status', oneOf: [status] }];
}

function entryToStep(entry: CaptureEntry, i: number): FlowStep {
  return {
    name: stepName(entry, i),
    type: 'request',
    method: entry.method,
    url: entry.url,
    headers: entry.reqHeaders.map((h) => ({ key: h.key, value: h.value })),
    body: entry.reqBody,
    extract: [],
    checks: statusCheck(entry.status),
  };
}

/** Drop exact-duplicate requests and keep a clean journey of ≤ MAX_STEPS. */
function pickJourney(entries: CaptureEntry[]): CaptureEntry[] {
  const seen = new Set<string>();
  const out: CaptureEntry[] = [];
  for (const e of entries) {
    const key = `${e.method} ${e.url} ${e.reqBody || ''}`;
    if (seen.has(key)) continue;          // exact-duplicate request — one is enough for a journey
    seen.add(key);
    out.push(e);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   Correlation (the pure core)
   ──────────────────────────────────────────────────────────────── */

export function buildCorrelatedFlow(allEntries: CaptureEntry[], sessionName: string, fromEntries?: number): CorrelatedFlow {
  const entries = pickJourney(allEntries);
  const steps = entries.map(entryToStep);
  const links: CorrelationLink[] = [];
  const variables: Record<string, string> = {};

  // Harvest every correlatable value each step's RESPONSE produced.
  const produced: Candidate[] = [];
  entries.forEach((e, i) => {
    const parsed = tryParse(e.resBody);
    if (parsed !== undefined) collectValues(parsed, '', produced, i, 0);
  });

  // De-dup candidates by (step,value), keeping the shortest path (most specific id).
  const byKey = new Map<string, Candidate>();
  for (const c of produced) {
    const k = `${c.step}::${c.value}`;
    const prev = byKey.get(k);
    if (!prev || c.path.length < prev.path.length) byKey.set(k, c);
  }
  // Longer values first so a token isn't shadowed by a short id it contains.
  const candidates = Array.from(byKey.values()).sort((a, b) => b.value.length - a.value.length);

  // Per producer step+path → the var name already assigned (reuse across consumers).
  const assigned = new Map<string, string>();
  const usedNames = new Set<string>();
  function nameFor(c: Candidate): string {
    const key = `${c.step}::${c.path}`;
    const existing = assigned.get(key);
    if (existing) return existing;
    const base = baseVarName(c.path, c.via);
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}${n++}`;
    usedNames.add(name);
    assigned.set(key, name);
    const ex: FlowExtract = { name, from: c.via, path: c.path };
    (steps[c.step]!.extract ||= []).push(ex);
    return name;
  }

  for (let j = 0; j < steps.length; j++) {
    const step = steps[j]!;
    for (const c of candidates) {
      if (c.step >= j) continue;                 // producer must come strictly before consumer
      if (step.url && occursAsToken(step.url, c.value)) {
        const name = nameFor(c);
        step.url = replaceToken(step.url, c.value, `{{${name}}}`);
        links.push({ fromStep: c.step, toStep: j, var: name, in: 'url', via: c.via });
      }
      for (const h of step.headers || []) {
        if (h.value && occursAsToken(h.value, c.value)) {
          const name = nameFor(c);
          h.value = replaceToken(h.value, c.value, `{{${name}}}`);
          links.push({ fromStep: c.step, toStep: j, var: name, in: 'header', header: h.key, via: c.via });
        }
      }
      if (step.body && occursAsToken(step.body, c.value)) {
        const name = nameFor(c);
        step.body = replaceToken(step.body, c.value, `{{${name}}}`);
        links.push({ fromStep: c.step, toStep: j, var: name, in: 'body', via: c.via });
      }
    }
  }

  return {
    name: `${sessionName || 'Capture'} — correlated flow`,
    steps,
    links,
    variables,
    fromEntries: fromEntries ?? allEntries.length,
    stepCount: steps.length,
    linkCount: links.length,
  };
}
