/**
 * postman.ts
 * ──────────
 * Export a runnable flow as a Postman Collection (v2.1) so teams can run it with
 * Newman in CI or open it in Postman. The flow engine's `{{var}}` syntax is
 * already Postman's, so URLs/headers/bodies carry over verbatim; flow variables
 * become collection variables.
 *
 * Postman has no if/loop/group/retry, so the flow is FLATTENED to its request
 * steps (a retry/loop/group contributes its inner requests; an `if` contributes
 * both branches; a `wait` is dropped). Pure, dependency-free except randomUUID.
 */
import { randomUUID } from 'node:crypto';
import type { FlowStep } from '../services/api-flow.service.js';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

interface PmHeader { key: string; value: string }
interface PmItem { name: string; request: { method: string; header: PmHeader[]; url: { raw: string }; auth?: unknown; body?: unknown } }

/** Flatten a flow's steps to the request steps Postman can represent. */
function flattenRequests(steps: FlowStep[] | undefined, out: FlowStep[], depth = 0): void {
  if (!steps || depth > 8) return;
  for (const s of steps) {
    const kind = s.type || 'request';
    if (kind === 'retry' || kind === 'loop' || kind === 'group') flattenRequests(s.steps, out, depth + 1);
    else if (kind === 'if') { flattenRequests(s.then, out, depth + 1); flattenRequests(s.else, out, depth + 1); }
    else if (kind === 'wait') { /* no HTTP request */ }
    else out.push(s);
  }
}

/** Map a flow step's structured auth to a Postman auth block. */
function toAuth(a: FlowStep['auth']): unknown {
  if (!a || !a.type || a.type === 'none') return undefined;
  if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.value ?? '', type: 'string' }] };
  if (a.type === 'basic') {
    const [u, ...p] = String(a.value ?? '').split(':');
    return { type: 'basic', basic: [{ key: 'username', value: u ?? '', type: 'string' }, { key: 'password', value: p.join(':'), type: 'string' }] };
  }
  if (a.type === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: a.headerName || 'X-API-Key', type: 'string' }, { key: 'value', value: a.value ?? '', type: 'string' }, { key: 'in', value: 'header', type: 'string' }] };
  return undefined;
}

function toItem(s: FlowStep): PmItem {
  const method = (s.method || 'GET').toUpperCase();
  const request: PmItem['request'] = {
    method,
    header: (s.headers || []).map((h) => ({ key: h.key, value: h.value })),
    url: { raw: s.url || '' },
  };
  const auth = toAuth(s.auth);
  if (auth) request.auth = auth;
  if (s.body && method !== 'GET' && method !== 'HEAD') request.body = { mode: 'raw', raw: s.body, options: { raw: { language: 'json' } } };
  return { name: s.name || `${method} ${s.url || ''}`.slice(0, 80), request };
}

/** Build a Postman v2.1 collection from a flow's steps + variables. */
export function flowToPostman(name: string, steps: FlowStep[], variables: Record<string, string> = {}): unknown {
  const reqs: FlowStep[] = [];
  flattenRequests(steps, reqs);
  return {
    info: { name: name || 'IntelliQE flow', _postman_id: randomUUID(), schema: SCHEMA },
    item: reqs.map(toItem),
    variable: Object.entries(variables || {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}
