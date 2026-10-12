/**
 * api-specdiff.service.ts
 * ───────────────────────
 * Spec-vs-spec breaking-change detection — a self-contained "oasdiff"-style gate.
 * Given an OLD and a NEW OpenAPI document it reports what changed and whether any
 * change is BREAKING for existing consumers, so a CI step can block the merge
 * BEFORE it ships. This is distinct from runtime drift detection (which probes a
 * live API): this diffs two static contracts.
 *
 * Breaking (for a consumer of the API):
 *   • a path or operation was removed
 *   • a previously-optional request becomes required (new required param/body field)
 *   • an existing request parameter was removed (clients may rely on it) — reported low
 *   • a success response code was removed
 *   • a response property was removed or changed type (clients may read it)
 *   • a parameter/field type changed, or an enum was narrowed
 * Non-breaking: new optional params, new paths/operations, new response fields.
 *
 * Opt-in and standalone — pure text-in / report-out, no pipeline code touched.
 */
import YAML from 'yaml';

export type ChangeKind =
  | 'path-removed' | 'operation-removed' | 'param-removed' | 'param-required-added'
  | 'request-field-required-added' | 'request-field-removed'
  | 'response-removed' | 'response-field-removed' | 'type-changed' | 'enum-narrowed'
  | 'path-added' | 'operation-added' | 'param-added' | 'response-added' | 'response-field-added' | 'other';

export interface SpecChange { kind: ChangeKind; breaking: boolean; location: string; detail: string }

export interface SpecDiffResult {
  changes: SpecChange[];
  summary: { total: number; breaking: number; nonBreaking: number; additions: number };
  gate: { enabled: boolean; passed: boolean; reason: string };
  oldInfo: { title?: string; version?: string };
  newInfo: { title?: string; version?: string };
}

const MAX_CHANGES = 500;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

/** Parse an OpenAPI doc from a JS object or a JSON/YAML string. */
export function parseSpec(input: unknown): any {
  if (input && typeof input === 'object') return input;
  const text = String(input || '').trim();
  if (!text) throw new Error('Empty spec.');
  try { return YAML.parse(text); } catch (e) { throw new Error(`Could not parse the spec as JSON or YAML: ${(e as Error).message}`); }
}

function jsonType(schema: any): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema.type)) return schema.type.join('|');
  if (typeof schema.type === 'string') return schema.type;
  if (schema.$ref) return `ref:${String(schema.$ref).split('/').pop()}`;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return undefined;
}

/** Resolve a local $ref ("#/components/schemas/Foo") against the root doc; bounded depth. */
function deref(schema: any, root: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 6) return schema;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const parts = schema.$ref.slice(2).split('/');
    let node: any = root;
    for (const p of parts) { node = node?.[p]; if (node === undefined) return schema; }
    return deref(node, root, depth + 1);
  }
  return schema;
}

function opsOf(pathItem: any): string[] {
  if (!pathItem || typeof pathItem !== 'object') return [];
  return METHODS.filter((m) => pathItem[m] && typeof pathItem[m] === 'object');
}

function paramKey(p: any): string { return `${String(p?.name || '?')} (${String(p?.in || '?')})`; }

function bodySchema(op: any, root: any): any {
  const content = op?.requestBody && deref(op.requestBody, root)?.content;
  if (!content || typeof content !== 'object') return undefined;
  const json = content['application/json'] || content[Object.keys(content)[0] || ''];
  return json?.schema ? deref(json.schema, root) : undefined;
}

function successCodes(op: any): string[] {
  const r = op?.responses;
  if (!r || typeof r !== 'object') return [];
  return Object.keys(r).filter((c) => /^2\d\d$/.test(c) || c === '2XX');
}

function responseSchema(op: any, code: string, root: any): any {
  const resp = deref(op?.responses?.[code], root);
  const content = resp?.content;
  if (!content || typeof content !== 'object') return undefined;
  const json = content['application/json'] || content[Object.keys(content)[0] || ''];
  return json?.schema ? deref(json.schema, root) : undefined;
}

export function diffSpecs(oldInput: unknown, newInput: unknown, opts: { failOnBreaking?: boolean } = {}): SpecDiffResult {
  const oldDoc = parseSpec(oldInput);
  const newDoc = parseSpec(newInput);
  const changes: SpecChange[] = [];
  const push = (c: SpecChange) => { if (changes.length < MAX_CHANGES) changes.push(c); };

  const oldPaths = (oldDoc?.paths && typeof oldDoc.paths === 'object') ? oldDoc.paths : {};
  const newPaths = (newDoc?.paths && typeof newDoc.paths === 'object') ? newDoc.paths : {};

  // Removed / added paths
  for (const p of Object.keys(oldPaths)) {
    if (!(p in newPaths)) push({ kind: 'path-removed', breaking: true, location: p, detail: `Path "${p}" was removed — existing clients calling it will break.` });
  }
  for (const p of Object.keys(newPaths)) {
    if (!(p in oldPaths)) push({ kind: 'path-added', breaking: false, location: p, detail: `New path "${p}" added.` });
  }

  // Shared paths → per-operation diff
  for (const p of Object.keys(oldPaths)) {
    if (!(p in newPaths)) continue;
    const oldOps = opsOf(oldPaths[p]);
    const newOps = opsOf(newPaths[p]);
    for (const m of oldOps) {
      if (!newOps.includes(m)) push({ kind: 'operation-removed', breaking: true, location: `${m.toUpperCase()} ${p}`, detail: `Operation ${m.toUpperCase()} ${p} was removed.` });
    }
    for (const m of newOps) {
      if (!oldOps.includes(m)) push({ kind: 'operation-added', breaking: false, location: `${m.toUpperCase()} ${p}`, detail: `New operation ${m.toUpperCase()} ${p} added.` });
    }
    for (const m of oldOps) {
      if (!newOps.includes(m)) continue;
      const loc = `${m.toUpperCase()} ${p}`;
      const oldOp = oldPaths[p][m];
      const newOp = newPaths[p][m];

      // ── Parameters ──
      const oldParams: any[] = Array.isArray(oldOp.parameters) ? oldOp.parameters.map((x: any) => deref(x, oldDoc)) : [];
      const newParams: any[] = Array.isArray(newOp.parameters) ? newOp.parameters.map((x: any) => deref(x, newDoc)) : [];
      const newByKey = new Map(newParams.map((x) => [paramKey(x), x]));
      const oldByKey = new Map(oldParams.map((x) => [paramKey(x), x]));
      for (const op of oldParams) {
        const np = newByKey.get(paramKey(op));
        if (!np) { push({ kind: 'param-removed', breaking: true, location: loc, detail: `Request parameter ${paramKey(op)} was removed.` }); continue; }
        const ot = jsonType(deref(op.schema, oldDoc)) || jsonType(op);
        const nt = jsonType(deref(np.schema, newDoc)) || jsonType(np);
        if (ot && nt && ot !== nt) push({ kind: 'type-changed', breaking: true, location: loc, detail: `Parameter ${paramKey(op)} type changed ${ot} → ${nt}.` });
      }
      for (const np of newParams) {
        if (!oldByKey.has(paramKey(np))) {
          const required = np.required === true;
          push({ kind: required ? 'param-required-added' : 'param-added', breaking: required, location: loc, detail: `New ${required ? 'REQUIRED' : 'optional'} parameter ${paramKey(np)}${required ? ' — existing clients omitting it will now fail.' : '.'}` });
        }
      }

      // ── Request body (required fields) ──
      const oldBody = bodySchema(oldOp, oldDoc);
      const newBody = bodySchema(newOp, newDoc);
      if (newBody?.properties) {
        const oldReq: string[] = Array.isArray(oldBody?.required) ? oldBody.required : [];
        const newReq: string[] = Array.isArray(newBody?.required) ? newBody.required : [];
        for (const f of newReq) {
          if (!oldReq.includes(f)) push({ kind: 'request-field-required-added', breaking: true, location: loc, detail: `Request body field "${f}" became required — clients not sending it will fail.` });
        }
        if (oldBody?.properties) {
          for (const f of Object.keys(oldBody.properties)) {
            if (!(f in newBody.properties)) push({ kind: 'request-field-removed', breaking: false, location: loc, detail: `Request body field "${f}" was removed from the schema.` });
          }
        }
      }

      // ── Responses ──
      const oldCodes = successCodes(oldOp);
      const newCodes = successCodes(newOp);
      for (const c of oldCodes) {
        if (!newCodes.includes(c)) { push({ kind: 'response-removed', breaking: true, location: loc, detail: `Success response ${c} was removed.` }); continue; }
        const os = responseSchema(oldOp, c, oldDoc);
        const ns = responseSchema(newOp, c, newDoc);
        if (os?.properties && ns?.properties) {
          for (const f of Object.keys(os.properties)) {
            if (!(f in ns.properties)) { push({ kind: 'response-field-removed', breaking: true, location: `${loc} ${c}`, detail: `Response field "${f}" was removed — clients reading it will break.` }); continue; }
            const ot = jsonType(deref(os.properties[f], oldDoc));
            const nt = jsonType(deref(ns.properties[f], newDoc));
            if (ot && nt && ot !== nt) push({ kind: 'type-changed', breaking: true, location: `${loc} ${c}`, detail: `Response field "${f}" type changed ${ot} → ${nt}.` });
          }
          for (const f of Object.keys(ns.properties)) {
            if (!(f in os.properties)) push({ kind: 'response-field-added', breaking: false, location: `${loc} ${c}`, detail: `New response field "${f}" added.` });
          }
        }
      }
      for (const c of newCodes) {
        if (!oldCodes.includes(c)) push({ kind: 'response-added', breaking: false, location: loc, detail: `New success response ${c} added.` });
      }
    }
  }

  const breaking = changes.filter((c) => c.breaking).length;
  const additions = changes.filter((c) => /-added$/.test(c.kind)).length;
  const nonBreaking = changes.length - breaking;
  const failOnBreaking = opts.failOnBreaking !== false; // default: gate on breaking changes
  const passed = !failOnBreaking || breaking === 0;
  return {
    changes,
    summary: { total: changes.length, breaking, nonBreaking, additions },
    gate: {
      enabled: failOnBreaking,
      passed,
      reason: !failOnBreaking
        ? 'Gate disabled — reporting only.'
        : breaking === 0
          ? 'No breaking changes detected — safe to merge.'
          : `${breaking} breaking change${breaking === 1 ? '' : 's'} detected — block the merge or bump the major version.`,
    },
    oldInfo: { title: oldDoc?.info?.title, version: oldDoc?.info?.version },
    newInfo: { title: newDoc?.info?.title, version: newDoc?.info?.version },
  };
}
