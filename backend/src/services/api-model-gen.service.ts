/**
 * api-model-gen.service.ts
 * ────────────────────────
 * Stateful MODEL-BASED generation — a layer deeper than the CRUD sequence
 * generator (api-stateful-gen) and sequence fuzzer. Instead of only chaining
 * create→read→delete, it LEARNS each resource's state machine from the API
 * surface and generates long, VALID business sequences that walk it:
 *
 *   • States are inferred from the verbs and action sub-resources of a resource:
 *       POST /orders              → create         (∅ → created)
 *       GET  /orders/{id}         → read           (observe, any state)
 *       PUT/PATCH /orders/{id}    → update         (created → modified)
 *       POST /orders/{id}/submit  → action         (created → submitted)
 *       POST /orders/{id}/approve → action         (submitted → approved)
 *       DELETE /orders/{id}       → delete         (any → deleted)
 *   • Transitions are the operations; action sub-resources become named edges.
 *   • Sequences are WALKS of the machine: create → read → update → run each
 *     action in a sensible lifecycle order (submit before approve before ship)
 *     → read → delete — threading the produced id through {{vars}} like the Flow
 *     engine, so the output drops straight into the Flow builder to run.
 *
 * PURE analysis — nothing is executed. The emitted sequences are reviewable.
 * The generate → execute → heal pipeline is never involved.
 */
import YAML from 'yaml';

export interface MgOperation { method: string; path: string; resource: string; action?: string; isCollection: boolean; hasId: boolean }
export interface MgState { name: string; terminal?: boolean }
export interface MgTransition { from: string; to: string; via: string; method: string; path: string; action?: string }
export interface MgStep { order: number; name: string; method: string; path: string; injects: { param: string; var: string }[]; extracts: { field: string; var: string }[]; expectState?: string }
export interface MgSequence { id: string; name: string; resource: string; lengthClass: 'short' | 'long'; steps: MgStep[]; note: string }
export interface MgResourceModel { resource: string; states: MgState[]; transitions: MgTransition[] }
export interface ModelGenResult {
  operations: number;
  resources: string[];
  models: MgResourceModel[];
  sequences: MgSequence[];
  notes: string[];
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A rough lifecycle ordering so actions chain in a sensible business order. */
const ACTION_ORDER = ['register', 'verify', 'activate', 'start', 'submit', 'review', 'approve', 'reject', 'pay', 'fulfil', 'fulfill', 'ship', 'deliver', 'complete', 'close', 'archive', 'cancel', 'refund', 'disable', 'suspend'];

function singular(seg: string): string {
  const s = seg.replace(/[^A-Za-z0-9]/g, '');
  if (/ies$/i.test(s)) return s.replace(/ies$/i, 'y');
  if (/sses$/i.test(s)) return s.replace(/es$/i, '');
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.replace(/s$/i, '');
  return s;
}
function varFor(resource: string): string { const b = singular(resource) || 'resource'; return `${b.charAt(0).toLowerCase()}${b.slice(1)}Id`; }
function pathParams(path: string): string[] { return (path.match(/\{([^}]+)\}/g) || []).map((m) => m.slice(1, -1)); }

/** Normalise a concrete URL path into a templated path with {id} params. */
function templatePath(path: string): string {
  const segs = path.split('/').filter(Boolean);
  const out = segs.map((s, i) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s) ? `{${varFor(segs[i - 1] || 'resource')}}` : s));
  return '/' + out.join('/');
}

/** The owning collection + optional trailing action segment of a path. */
function dissect(path: string): { resource: string; action?: string; hasId: boolean } {
  const segs = path.split('/').filter(Boolean);
  const plain = segs.filter((s) => !/^\{.*\}$/.test(s));
  const hasId = segs.some((s) => /^\{.*\}$/.test(s));
  // action = a plain segment that comes AFTER an {id} (e.g. /orders/{id}/submit → submit)
  let action: string | undefined;
  const idIdx = segs.findIndex((s) => /^\{.*\}$/.test(s));
  if (idIdx >= 0 && idIdx < segs.length - 1) {
    const after = segs[segs.length - 1]!;
    if (!/^\{.*\}$/.test(after)) action = after.toLowerCase();
  }
  const resource = (action ? segs[idIdx - 1] : plain[plain.length - 1]) || plain[plain.length - 1] || 'resource';
  return { resource: String(resource).replace(/[{}]/g, ''), action, hasId };
}

function parseSpec(raw: string): any {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Paste an OpenAPI document (JSON or YAML).');
  try { return YAML.parse(text); } catch { /* fall through */ }
  try { return JSON.parse(text); } catch { throw new Error('Could not parse the spec as JSON or YAML.'); }
}

function opsFromSpec(spec: any): MgOperation[] {
  const out: MgOperation[] = [];
  const paths = spec?.paths || {};
  for (const path of Object.keys(paths)) {
    const item = paths[path] || {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      const d = dissect(path);
      out.push({ method: method.toUpperCase(), path, resource: d.resource, action: d.action, hasId: d.hasId, isCollection: !d.hasId });
    }
  }
  return out;
}

function opsFromEndpoints(eps: { method: string; url: string; title?: string }[]): MgOperation[] {
  const out: MgOperation[] = [];
  for (const e of eps) {
    let path = '/';
    try { path = new URL(e.url).pathname; } catch { path = e.url.replace(/^https?:\/\/[^/]+/i, '') || '/'; }
    const tmpl = templatePath(path);
    const d = dissect(tmpl);
    out.push({ method: (e.method || 'GET').toUpperCase(), path: tmpl, resource: d.resource, action: d.action, hasId: d.hasId, isCollection: !d.hasId });
  }
  return out;
}

function actionRank(a: string): number { const i = ACTION_ORDER.indexOf(a); return i === -1 ? 50 : i; }

/** Build the state machine + a short and a long walk for one resource. */
function modelResource(resource: string, ops: MgOperation[], base: string): { model: MgResourceModel; sequences: MgSequence[] } {
  const mkUrl = (p: string) => (base ? base + p : p);
  const idVar = varFor(resource);

  const create = ops.find((o) => o.isCollection && o.method === 'POST');
  const listOp = ops.find((o) => o.isCollection && o.method === 'GET');
  const read = ops.find((o) => o.hasId && o.method === 'GET' && !o.action);
  const update = ops.find((o) => o.hasId && (o.method === 'PUT' || o.method === 'PATCH') && !o.action);
  const del = ops.find((o) => o.hasId && o.method === 'DELETE' && !o.action);
  const actions = ops.filter((o) => o.hasId && !!o.action).sort((a, b) => actionRank(a.action!) - actionRank(b.action!));

  // States + transitions.
  const states: MgState[] = [{ name: 'absent' }, { name: 'created' }];
  const transitions: MgTransition[] = [];
  if (create) transitions.push({ from: 'absent', to: 'created', via: 'create', method: create.method, path: create.path });
  if (update) transitions.push({ from: 'created', to: 'modified', via: 'update', method: update.method, path: update.path });
  if (update && !states.some((s) => s.name === 'modified')) states.push({ name: 'modified' });
  let prevState = 'created';
  for (const a of actions) {
    const st = a.action!;
    if (!states.some((s) => s.name === st)) states.push({ name: st });
    transitions.push({ from: prevState, to: st, via: st, method: a.method, path: a.path, action: st });
    prevState = st;
  }
  if (del) { states.push({ name: 'deleted', terminal: true }); transitions.push({ from: prevState, to: 'deleted', via: 'delete', method: del.method, path: del.path }); }

  // Walk builder.
  const mkStep = (order: number, name: string, method: string, path: string, expectState?: string, extract = false): MgStep => {
    const injects = pathParams(path).map((p) => ({ param: p, var: idVar }));
    let filled = path;
    for (const p of pathParams(path)) filled = filled.replace(`{${p}}`, `{{${idVar}}}`);
    return { order, name, method, path: mkUrl(filled), injects, extracts: extract ? [{ field: 'id', var: idVar }] : [], expectState };
  };

  const sequences: MgSequence[] = [];
  // SHORT walk: create → read → delete (baseline).
  if (create && (read || del)) {
    const steps: MgStep[] = [];
    let o = 0;
    steps.push(mkStep(o++, `create ${resource}`, create.method, create.path, 'created', true));
    if (read) steps.push(mkStep(o++, `read ${resource}`, read.method, read.path, 'created'));
    if (del) steps.push(mkStep(o++, `delete ${resource}`, del.method, del.path, 'deleted'));
    sequences.push({ id: `mg-${resource}-short`, name: `${resource}: create → read → delete`, resource, lengthClass: 'short', steps, note: 'Baseline lifecycle walk.' });
  }
  // LONG walk: create → read → update → every action in lifecycle order → read → delete.
  if (create && (actions.length || update)) {
    const steps: MgStep[] = [];
    let o = 0;
    steps.push(mkStep(o++, `create ${resource}`, create.method, create.path, 'created', true));
    if (read) steps.push(mkStep(o++, `read ${resource}`, read.method, read.path, 'created'));
    if (update) steps.push(mkStep(o++, `update ${resource}`, update.method, update.path, 'modified'));
    for (const a of actions) steps.push(mkStep(o++, `${a.action} ${resource}`, a.method, a.path, a.action));
    if (read) steps.push(mkStep(o++, `re-read ${resource}`, read.method, read.path, prevState));
    if (del) steps.push(mkStep(o++, `delete ${resource}`, del.method, del.path, 'deleted'));
    sequences.push({ id: `mg-${resource}-long`, name: `${resource}: full lifecycle (${steps.length} steps)`, resource, lengthClass: 'long', steps, note: `Long valid business journey through ${states.length} states${actions.length ? ` incl. ${actions.map((a) => a.action).join(' → ')}` : ''}.` });
  }
  void listOp;
  return { model: { resource, states, transitions }, sequences };
}

export function generateModelSequences(input: {
  spec?: string;
  endpoints?: { method: string; url: string; title?: string }[];
  baseUrl?: string;
  maxSequences?: number;
}): ModelGenResult {
  const ops = input.spec ? opsFromSpec(parseSpec(input.spec)) : opsFromEndpoints(Array.isArray(input.endpoints) ? input.endpoints.slice(0, 400) : []);
  if (!ops.length) throw new Error('No operations found. Provide an OpenAPI spec or a catalogue of endpoints.');
  const notes: string[] = [];
  const base = (input.baseUrl || '').replace(/\/+$/, '');

  const byResource = new Map<string, MgOperation[]>();
  for (const o of ops) { if (!byResource.has(o.resource)) byResource.set(o.resource, []); byResource.get(o.resource)!.push(o); }

  const models: MgResourceModel[] = [];
  let sequences: MgSequence[] = [];
  for (const [resource, rOps] of byResource) {
    const { model, sequences: seqs } = modelResource(resource, rOps, base);
    if (model.transitions.length) models.push(model);
    sequences.push(...seqs);
  }

  const max = Math.min(60, Math.max(1, Number(input.maxSequences) || 30));
  // Prefer the long business journeys first.
  sequences = sequences.sort((a, b) => (a.lengthClass === b.lengthClass ? b.steps.length - a.steps.length : a.lengthClass === 'long' ? -1 : 1)).slice(0, max);

  if (!sequences.length) notes.push('No lifecycle could be modelled — need at least a collection POST plus an id-scoped operation on the same resource.');
  const withActions = models.filter((m) => m.transitions.some((t) => t.action)).length;
  if (models.length && !withActions) notes.push('No action sub-resources (e.g. /{id}/submit) were found — sequences cover CRUD only. Action endpoints yield richer business journeys.');

  return { operations: ops.length, resources: [...byResource.keys()], models, sequences, notes: [...new Set(notes)].slice(0, 20) };
}
