/**
 * api-contract.service.ts
 * ───────────────────────
 * Formal contract / schema validation — a standalone, opt-in check that lives
 * ALONGSIDE the generation → execute → heal pipeline and never modifies it.
 *
 * For each selected endpoint it issues the request once (reusing the healer's
 * `probeEndpoint`) and checks the live response against the contract we know:
 *   • status      — the declared expected status (or any 2xx when none)
 *   • content     — JSON expected but not returned
 *   • schema      — the response body validated with Ajv against a JSON Schema:
 *                   an explicit schema when supplied, otherwise one inferred
 *                   from the imported example response.
 *
 * Nothing here is persisted and no generator/executor code is touched — it is a
 * pure read of the live API against the catalogue.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { probeEndpoint, type ParsedApiRequest } from '../agents/apiHealingAgent.js';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);

export interface ContractEndpointInput {
  id: string;
  title?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
  /** Imported example response — a JSON Schema is inferred from it. */
  expectedResponse?: string;
  /** An explicit JSON Schema, when the caller has one (wins over the example). */
  schema?: unknown;
}

export type ViolationKind = 'transport' | 'status' | 'content-type' | 'schema';
export interface ContractViolation { kind: ViolationKind; message: string; path?: string }

export interface ContractResult {
  id: string;
  title: string;
  method: string;
  url: string;
  reachable: boolean;
  status?: number;
  elapsedMs?: number;
  expectedStatus?: number;
  statusOk: boolean;
  schemaChecked: boolean;
  schemaValid: boolean;
  violations: ContractViolation[];
}

export interface ContractReport {
  results: ContractResult[];
  summary: { total: number; passed: number; failed: number; unreachable: number; checkedSchema: number };
}

const MAX_ENDPOINTS = 100;
const CONCURRENCY = 6;

function safeParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Build the live request, folding auth into headers the same way the runner does. */
function toRequest(ep: ContractEndpointInput): ParsedApiRequest {
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

/**
 * Infer a lenient JSON Schema from an example: every key seen becomes required
 * and typed, but extra keys are allowed (additionalProperties). So a missing or
 * type-changed field is flagged, while a newly-added field is not noise.
 */
function inferSchema(example: unknown): Record<string, unknown> {
  if (Array.isArray(example)) {
    return { type: 'array', items: example.length ? inferSchema(example[0]) : {} };
  }
  if (example && typeof example === 'object') {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(example as Record<string, unknown>)) {
      properties[k] = inferSchema(v);
      required.push(k);
    }
    return { type: 'object', properties, required, additionalProperties: true };
  }
  if (typeof example === 'string') return { type: 'string' };
  if (typeof example === 'number') return { type: 'number' };
  if (typeof example === 'boolean') return { type: 'boolean' };
  // null / undefined → accept anything (the field is present but nullable).
  return {};
}

function compile(schema: unknown): ValidateFunction | null {
  try { return ajv.compile(schema as object); } catch { return null; }
}

async function validateOne(ep: ContractEndpointInput): Promise<ContractResult> {
  const method = (ep.method || 'GET').toUpperCase();
  const title = ep.title || `${method} ${ep.url}`;
  const probe = await probeEndpoint(toRequest(ep));

  if (!probe.reachable) {
    return {
      id: ep.id, title, method, url: ep.url, reachable: false, statusOk: false,
      schemaChecked: false, schemaValid: false,
      violations: [{ kind: 'transport', message: probe.transportError || 'The endpoint could not be reached.' }],
    };
  }

  const violations: ContractViolation[] = [];
  const status = probe.status;
  const statusOk = ep.expectedStatus
    ? status === ep.expectedStatus
    : status !== undefined && status >= 200 && status < 300;
  if (!statusOk) violations.push({ kind: 'status', message: `Expected ${ep.expectedStatus || '2xx'}, received ${status ?? 'no status'}` });

  const contentType = probe.headers?.['content-type'] || '';
  const explicit = ep.schema;
  const example = explicit === undefined ? safeParse(ep.expectedResponse) : undefined;

  let schemaChecked = false;
  let schemaValid = true;
  if ((explicit !== undefined || example !== undefined)) {
    if (probe.json === undefined) {
      // We know the shape it should be, but the body was not JSON.
      violations.push({ kind: 'content-type', message: `Expected a JSON body, got ${contentType || 'no content-type'}` });
    } else {
      const schema = explicit !== undefined ? explicit : inferSchema(example);
      const validate = compile(schema);
      if (validate) {
        schemaChecked = true;
        if (!validate(probe.json)) {
          schemaValid = false;
          for (const err of (validate.errors || []).slice(0, 12)) {
            violations.push({ kind: 'schema', message: `${err.instancePath || '(root)'} ${err.message || 'did not match the schema'}`, path: err.instancePath });
          }
        }
      }
    }
  }

  return {
    id: ep.id, title, method, url: ep.url, reachable: true,
    status, elapsedMs: probe.elapsedMs, expectedStatus: ep.expectedStatus,
    statusOk, schemaChecked, schemaValid, violations,
  };
}

/** Normalise the client's catalogue payload into the shape this service checks. */
export function normalizeContractInput(raw: unknown): ContractEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ContractEndpointInput[] = [];
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
      expectedStatus: typeof ep.expectedStatus === 'number' ? ep.expectedStatus : undefined,
      expectedResponse: ep.expectedResponse ? String(ep.expectedResponse) : undefined,
      schema: ep.schema,
    });
  }
  return out;
}

/** Validate a set of endpoints against their contract, bounded-concurrently. */
export async function validateContract(rawEndpoints: unknown): Promise<ContractReport> {
  const endpoints = normalizeContractInput(rawEndpoints);
  const results: ContractResult[] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      results[i] = await validateOne(endpoints[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const passed = results.filter((r) => r.reachable && r.statusOk && (!r.schemaChecked || r.schemaValid)).length;
  const unreachable = results.filter((r) => !r.reachable).length;
  const checkedSchema = results.filter((r) => r.schemaChecked).length;
  return {
    results,
    summary: { total: results.length, passed, failed: results.length - passed - unreachable, unreachable, checkedSchema },
  };
}
