/**
 * api-drift.service.ts
 * ────────────────────
 * Contract-drift maintenance — a standalone, opt-in check that compares each
 * endpoint's LIVE response against the expectations stored in the catalogue
 * (`expectedStatus`, `expectedResponse`) and, where they have drifted apart,
 * hands back the live values ready to adopt.
 *
 * It only READS the live API and REPORTS a suggested catalogue update; the
 * adoption is applied client-side via the normal endpoint edit. The generation
 * → execute → heal pipeline is untouched — this keeps the catalogue's declared
 * contract current so future generated tests assert against today's reality.
 */
import { probeEndpoint, type ParsedApiRequest } from '../agents/apiHealingAgent.js';

export interface DriftEndpointInput {
  id: string;
  title?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
  expectedResponse?: string;
}

export interface ShapeChange { kind: 'added' | 'removed' | 'type-changed'; path: string; detail?: string }

export interface DriftResult {
  id: string;
  title: string;
  method: string;
  url: string;
  reachable: boolean;
  hasStoredStatus: boolean;
  hasStoredShape: boolean;
  liveStatus?: number;
  storedStatus?: number;
  statusDrift: boolean;
  shapeDrift: boolean;
  changes: ShapeChange[];
  /** The live values to adopt, present only when that facet drifted. */
  suggestedStatus?: number;
  suggestedResponse?: string;
  note?: string;
}

export interface DriftReport {
  results: DriftResult[];
  summary: { total: number; drifted: number; clean: number; unreachable: number; noExpectation: number };
}

const MAX_ENDPOINTS = 100;
const CONCURRENCY = 6;
const MAX_CHANGES = 40;
const SAMPLE_LIMIT = 20_000;

function safeParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function toRequest(ep: DriftEndpointInput): ParsedApiRequest {
  const headers: Record<string, string> = {};
  for (const h of ep.headers || []) { if (h?.key) headers[h.key] = h.value ?? ''; }
  const a = ep.auth;
  if (a && a.type !== 'none' && a.value) {
    if (a.type === 'bearer') headers['Authorization'] = `Bearer ${a.value}`;
    else if (a.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(a.value).toString('base64')}`;
    else if (a.type === 'apikey') headers[a.headerName || 'X-API-Key'] = a.value;
  }
  const method = (ep.method || 'GET').toUpperCase();
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && ep.body ? ep.body : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return { method, url: ep.url, headers, body };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Structural-only diff: added / removed / type-changed keys between the stored
 * example and the live body. VALUE changes are ignored on purpose — a stored
 * example is illustrative, so only a shape change is contract drift.
 */
function shapeDiff(stored: unknown, live: unknown, path: string, out: ShapeChange[]): void {
  if (out.length >= MAX_CHANGES) return;
  const st = typeOf(stored);
  const lt = typeOf(live);
  if (st !== lt) { out.push({ kind: 'type-changed', path: path || '(root)', detail: `${st} → ${lt}` }); return; }
  if (st === 'object') {
    const so = stored as Record<string, unknown>;
    const lo = live as Record<string, unknown>;
    for (const k of Object.keys(so)) {
      const p = `${path}.${k}`.replace(/^\./, '');
      if (!(k in lo)) { out.push({ kind: 'removed', path: p }); continue; }
      shapeDiff(so[k], lo[k], p, out);
    }
    for (const k of Object.keys(lo)) {
      if (!(k in so)) out.push({ kind: 'added', path: `${path}.${k}`.replace(/^\./, '') });
    }
    return;
  }
  if (st === 'array') {
    const sa = stored as unknown[];
    const la = live as unknown[];
    if (sa.length && la.length) shapeDiff(sa[0], la[0], `${path}[0]`.replace(/^\./, ''), out); // element shape
  }
}

export function normalizeDriftInput(raw: unknown): DriftEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: DriftEndpointInput[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, any>;
    const url = String(ep.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id: String(ep.id || url),
      title: ep.title ? String(ep.title) : undefined,
      method: String(ep.method || 'GET'),
      url,
      headers: Array.isArray(ep.headers) ? ep.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
      auth: ep.auth && typeof ep.auth === 'object'
        ? { type: (['none', 'bearer', 'basic', 'apikey'].includes(ep.auth.type) ? ep.auth.type : 'none'), value: ep.auth.value ? String(ep.auth.value) : undefined, headerName: ep.auth.headerName ? String(ep.auth.headerName) : undefined }
        : undefined,
      body: ep.body ? String(ep.body) : undefined,
      expectedStatus: typeof ep.expectedStatus === 'number' ? ep.expectedStatus : (ep.expectedStatus ? Number(ep.expectedStatus) || undefined : undefined),
      expectedResponse: ep.expectedResponse ? String(ep.expectedResponse) : undefined,
    });
  }
  return out;
}

async function scanOne(ep: DriftEndpointInput): Promise<DriftResult> {
  const method = (ep.method || 'GET').toUpperCase();
  const title = ep.title || `${method} ${ep.url}`;
  const hasStoredStatus = typeof ep.expectedStatus === 'number' && ep.expectedStatus > 0;
  const storedExample = safeParse(ep.expectedResponse);
  const hasStoredShape = storedExample !== undefined && typeof storedExample === 'object' && storedExample !== null;

  const probe = await probeEndpoint(toRequest(ep));
  if (!probe.reachable) {
    return { id: ep.id, title, method, url: ep.url, reachable: false, hasStoredStatus, hasStoredShape, storedStatus: ep.expectedStatus, statusDrift: false, shapeDrift: false, changes: [], note: probe.transportError || 'Unreachable.' };
  }

  const liveStatus = probe.status;
  const statusDrift = hasStoredStatus && liveStatus !== undefined && liveStatus !== ep.expectedStatus;

  const changes: ShapeChange[] = [];
  let shapeDrift = false;
  let suggestedResponse: string | undefined;
  if (hasStoredShape) {
    if (probe.json === undefined) {
      shapeDrift = true;
      changes.push({ kind: 'type-changed', path: '(body)', detail: 'JSON → non-JSON' });
    } else {
      shapeDiff(storedExample, probe.json, '', changes);
      shapeDrift = changes.length > 0;
      if (shapeDrift) suggestedResponse = JSON.stringify(probe.json, null, 2).slice(0, SAMPLE_LIMIT);
    }
  }

  return {
    id: ep.id, title, method, url: ep.url, reachable: true,
    hasStoredStatus, hasStoredShape, liveStatus, storedStatus: ep.expectedStatus,
    statusDrift, shapeDrift, changes,
    suggestedStatus: statusDrift ? liveStatus : undefined,
    suggestedResponse,
    note: !hasStoredStatus && !hasStoredShape ? 'No stored expectation to compare — run a snapshot or set an expected response first.' : undefined,
  };
}

export async function scanDrift(rawEndpoints: unknown): Promise<DriftReport> {
  const endpoints = normalizeDriftInput(rawEndpoints);
  const results: DriftResult[] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      results[i] = await scanOne(endpoints[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const unreachable = results.filter((r) => !r.reachable).length;
  const drifted = results.filter((r) => r.reachable && (r.statusDrift || r.shapeDrift)).length;
  const noExpectation = results.filter((r) => r.reachable && !r.hasStoredStatus && !r.hasStoredShape).length;
  const clean = results.filter((r) => r.reachable && !r.statusDrift && !r.shapeDrift && (r.hasStoredStatus || r.hasStoredShape)).length;
  return { results, summary: { total: results.length, drifted, clean, unreachable, noExpectation } };
}
