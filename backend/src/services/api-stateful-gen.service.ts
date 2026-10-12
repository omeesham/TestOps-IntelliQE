/**
 * api-stateful-gen.service.ts
 * ───────────────────────────
 * White-box / stateful test generation (RESTler / EvoMaster parity, the honest
 * static slice). Given an OpenAPI spec OR a catalogue of endpoints, it infers the
 * producer → consumer dependencies between operations — e.g. `POST /users` returns
 * an id that `GET /users/{id}` then needs — and emits ORDERED request sequences
 * that create a resource, read/update it, and finally delete it, threading the
 * produced ids through `{{variables}}` exactly like the Flow engine.
 *
 * This is the "stateful" generation that single-endpoint fuzzers miss: it tests
 * real multi-step journeys and finds use-after-free / wrong-order / dangling-id
 * bugs. It is PURE analysis — nothing is executed here; the emitted sequences are
 * reviewable and can be sent to the Flow builder to run. The pipeline is never
 * involved.
 */
import YAML from 'yaml';

export interface GenParam { name: string; in: 'path' | 'query'; required: boolean }
export interface GenOperation {
  opId: string;
  method: string;
  path: string;
  resource: string;
  params: GenParam[];
  /** id-variable names this op is assumed to PRODUCE (e.g. "userId"). */
  produces: string[];
  /** path-param names this op CONSUMES. */
  consumes: string[];
}
export interface SeqStep {
  order: number;
  name: string;
  method: string;
  path: string;
  /** path params filled from an earlier step's extracted var: {param} → {{var}}. */
  injects: { param: string; var: string }[];
  /** response fields this step extracts into a var for later steps. */
  extracts: { field: string; var: string }[];
}
export interface StatefulSequence {
  id: string;
  name: string;
  target: string;
  steps: SeqStep[];
  note: string;
}
export interface Dependency { producer: string; consumer: string; via: string }
export interface StatefulGenResult {
  operations: number;
  resources: string[];
  dependencies: Dependency[];
  sequences: StatefulSequence[];
  notes: string[];
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function singular(seg: string): string {
  const s = seg.replace(/[^A-Za-z0-9]/g, '');
  if (/ies$/i.test(s)) return s.replace(/ies$/i, 'y');
  if (/sses$/i.test(s)) return s.replace(/es$/i, '');
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.replace(/s$/i, '');
  return s;
}

function varFor(resource: string): string {
  const base = singular(resource) || 'resource';
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}Id`;
}

/** The collection segment that owns a path param: the segment immediately before `{param}`. */
function resourceForParam(path: string, paramName: string): string {
  const segs = path.split('/').filter(Boolean);
  const idx = segs.findIndex((s) => s === `{${paramName}}`);
  if (idx > 0) return segs[idx - 1]!.replace(/[{}]/g, '');
  // Fall back: last plain (non-param) segment.
  const plain = segs.filter((s) => !/^\{.*\}$/.test(s));
  return plain[plain.length - 1] || 'resource';
}

/** The collection a non-parametric write/list operates on (its produced resource). */
function collectionOf(path: string): string {
  const segs = path.split('/').filter(Boolean).filter((s) => !/^\{.*\}$/.test(s));
  return segs[segs.length - 1] || 'resource';
}

function pathParams(path: string): string[] {
  return (path.match(/\{([^}]+)\}/g) || []).map((m) => m.slice(1, -1));
}

function looksLikeId(name: string): boolean {
  return /(^id$|_id$|Id$|^uuid$|Guid$)/.test(name);
}

/* ── Spec / endpoint normalisation ── */

function parseSpec(raw: string): any {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Paste an OpenAPI document (JSON or YAML).');
  try { return YAML.parse(text); } catch { /* fall through */ }
  try { return JSON.parse(text); } catch { throw new Error('Could not parse the spec as JSON or YAML.'); }
}

/** Response id-like fields a spec operation declares (top-level + items[].). */
function producedFields(op: any): string[] {
  const out = new Set<string>();
  const responses = op?.responses || {};
  for (const code of Object.keys(responses)) {
    if (!/^2/.test(code)) continue;
    const content = responses[code]?.content || {};
    for (const ct of Object.keys(content)) {
      let schema = content[ct]?.schema;
      if (schema?.type === 'array') schema = schema.items;
      const props = schema?.properties || {};
      for (const f of Object.keys(props)) if (looksLikeId(f)) out.add(f);
    }
  }
  return [...out];
}

function operationsFromSpec(spec: any): GenOperation[] {
  const out: GenOperation[] = [];
  const paths = spec?.paths || {};
  for (const path of Object.keys(paths)) {
    const item = paths[path] || {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const M = method.toUpperCase();
      const pp = pathParams(path);
      const params: GenParam[] = [];
      for (const p of [...(item.parameters || []), ...(op.parameters || [])]) {
        if (p?.in === 'path' || p?.in === 'query') params.push({ name: String(p.name), in: p.in, required: !!p.required || p.in === 'path' });
      }
      for (const p of pp) if (!params.some((x) => x.name === p)) params.push({ name: p, in: 'path', required: true });
      const consumes = pp;
      const produces: string[] = [];
      if (!pp.length && (M === 'POST' || M === 'GET')) produces.push(varFor(collectionOf(path)));
      for (const f of producedFields(op)) produces.push(f);
      out.push({ opId: op.operationId || `${M} ${path}`, method: M, path, resource: collectionOf(path), params, produces: [...new Set(produces)], consumes });
    }
  }
  return out;
}

function operationsFromEndpoints(eps: { method: string; url: string; title?: string }[]): GenOperation[] {
  const out: GenOperation[] = [];
  for (const e of eps) {
    let path = '/';
    try { path = new URL(e.url).pathname; } catch { path = e.url.replace(/^https?:\/\/[^/]+/i, '') || '/'; }
    // id-shaped concrete segments → {param} so sequencing can thread them.
    const segs = path.split('/').filter(Boolean);
    const tmpl = segs.map((s, i) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s) ? `{${varFor(segs[i - 1] || 'resource')}}` : s));
    const templated = '/' + tmpl.join('/');
    const M = (e.method || 'GET').toUpperCase();
    const pp = pathParams(templated);
    const params: GenParam[] = pp.map((p) => ({ name: p, in: 'path' as const, required: true }));
    const produces = !pp.length && (M === 'POST' || M === 'GET') ? [varFor(collectionOf(templated))] : [];
    out.push({ opId: e.title || `${M} ${templated}`, method: M, path: templated, resource: collectionOf(templated), params, produces, consumes: pp });
  }
  return out;
}

/* ── Sequence assembly ── */

export function generateStatefulSequences(input: {
  spec?: string;
  endpoints?: { method: string; url: string; title?: string }[];
  baseUrl?: string;
  maxSequences?: number;
}): StatefulGenResult {
  const ops = input.spec ? operationsFromSpec(parseSpec(input.spec)) : operationsFromEndpoints(Array.isArray(input.endpoints) ? input.endpoints.slice(0, 300) : []);
  const notes: string[] = [];
  if (!ops.length) throw new Error('No operations found. Provide an OpenAPI spec or a catalogue of endpoints.');

  // Producer index: resource → the best op that yields its id (POST preferred, then GET collection).
  const producerByResource = new Map<string, GenOperation>();
  for (const op of ops) {
    if (op.consumes.length) continue; // a collection-level op produces; a parametric op consumes
    const existing = producerByResource.get(op.resource);
    const score = (o: GenOperation) => (o.method === 'POST' ? 3 : o.method === 'GET' ? 2 : 1);
    if (!existing || score(op) > score(existing)) producerByResource.set(op.resource, op);
  }

  const deps: Dependency[] = [];
  const base = (input.baseUrl || '').replace(/\/+$/, '');
  const mkUrl = (p: string) => (base ? base + p : p);

  const sequences: StatefulSequence[] = [];
  const max = Math.min(50, Math.max(1, Number(input.maxSequences) || 20));
  const seenSeq = new Set<string>();

  // A sequence is anchored on each parametric (consumer) operation: build the chain
  // of producers that satisfy its path params, then the consumer itself.
  for (const consumer of ops) {
    if (sequences.length >= max) break;
    if (!consumer.consumes.length) continue;

    const steps: SeqStep[] = [];
    const varByParam = new Map<string, string>();
    let order = 0;
    const usedResources = new Set<string>();

    for (const param of consumer.consumes) {
      const resource = resourceForParam(consumer.path, param);
      const producer = producerByResource.get(resource);
      const v = varFor(resource);
      varByParam.set(param, v);
      if (producer && !usedResources.has(resource)) {
        usedResources.add(resource);
        const extractField = producer.produces.find((f) => looksLikeId(f)) || 'id';
        steps.push({
          order: order++,
          name: producer.opId,
          method: producer.method,
          path: mkUrl(producer.path),
          injects: [],
          extracts: [{ field: extractField, var: v }],
        });
        deps.push({ producer: `${producer.method} ${producer.path}`, consumer: `${consumer.method} ${consumer.path}`, via: v });
      } else {
        notes.push(`No producer found for "${param}" in ${consumer.method} ${consumer.path} — the sequence seeds it with a placeholder {{${v}}}.`);
      }
    }

    // The anchor (consumer) step, injecting the produced vars into its path.
    let filledPath = consumer.path;
    const injects: SeqStep['injects'] = [];
    for (const [param, v] of varByParam) {
      filledPath = filledPath.replace(`{${param}}`, `{{${v}}}`);
      injects.push({ param, var: v });
    }
    steps.push({ order: order++, name: consumer.opId, method: consumer.method, path: mkUrl(filledPath), injects, extracts: [] });

    // Round the journey out: if we created a resource and the consumer wasn't a delete,
    // append the DELETE on the same resource when one exists (create → use → clean up).
    if (consumer.method !== 'DELETE') {
      const del = ops.find((o) => o.method === 'DELETE' && o.resource === consumer.resource && o.consumes.length);
      if (del && del.opId !== consumer.opId) {
        let dp = del.path;
        for (const [param, v] of varByParam) dp = dp.replace(`{${param}}`, `{{${v}}}`);
        for (const p of pathParams(dp)) dp = dp.replace(`{${p}}`, `{{${varFor(resourceForParam(del.path, p))}}}`);
        steps.push({ order: order++, name: del.opId, method: 'DELETE', path: mkUrl(dp), injects: [], extracts: [] });
      }
    }

    const key = steps.map((s) => `${s.method} ${s.path}`).join(' → ');
    if (seenSeq.has(key)) continue;
    seenSeq.add(key);
    sequences.push({
      id: `seq-${sequences.length + 1}`,
      name: `${consumer.resource}: ${steps.map((s) => s.method).join(' → ')}`,
      target: `${consumer.method} ${consumer.path}`,
      steps,
      note: steps.length > 1 ? `${steps.length}-step stateful journey (${WRITE.has(consumer.method) ? 'mutating' : 'read'} anchor).` : 'Single-step (no producer dependency inferred).',
    });
  }

  if (!sequences.length) notes.push('No multi-step dependencies were inferred — every operation is independent (no path parameters to thread).');
  const resources = [...new Set(ops.map((o) => o.resource))];
  return { operations: ops.length, resources, dependencies: deps, sequences, notes: [...new Set(notes)].slice(0, 20) };
}
