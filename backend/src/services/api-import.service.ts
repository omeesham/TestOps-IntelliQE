/**
 * api-import.service.ts
 * ─────────────────────
 * Every way an API can arrive in the API Automation workspace, normalised to
 * ONE shape — `ImportedEndpoint` — so the rest of the pipeline (pattern
 * analysis, scenario design, execution, healing, reporting) never has to know
 * where an endpoint came from.
 *
 * Twelve intake methods are supported:
 *
 *   openapi     OpenAPI 3.x / Swagger 2.0 — JSON or YAML, file, URL or paste
 *   postman     Postman collection v2.0 / v2.1 (+ Bruno `.bru`, HAR recordings)
 *   endpoint    A bare API URL — probed live, with OpenAPI auto-discovery on the origin
 *   curl        One or many cURL commands
 *   docs-url    An API documentation web page — fetched, stripped, understood by the LLM
 *   connector   A Custom Connector manifest (our own portable JSON contract)
 *   sdk         SDK / client-library source — understood by the LLM
 *   webhook     Webhook consumer endpoints + sample event payloads (HMAC-signed)
 *   graphql     A GraphQL endpoint — introspected; one operation per field
 *   mcp         An MCP server — tools/list over Streamable HTTP; one call per tool
 *   middleware  Server route definitions (Express/Nest/Spring/FastAPI…) — LLM
 *   manual      The request form (the studio builds the endpoint itself)
 *
 * Deterministic parsers run first wherever the format is machine-readable
 * (OpenAPI, Postman, cURL, HAR, Bruno, connector manifests, GraphQL and MCP
 * introspection) — they are exact, cheap and unbounded by the model's output
 * window. Everything that is prose or code for humans (PDF, Word, Excel, docs
 * pages, SDKs, route files, WSDL) is handed to the tenant's LLM through the
 * existing api-spec-parser, which already knows how to read those.
 */
import { createHmac } from 'crypto';
import YAML from 'yaml';
import { parseApiEndpointsFromText, type ParsedApiSpec } from './api-spec-parser.service.js';
import type { LlmConfig } from '../agents/claude-runner.js';
import { cleanAuthValue, isPlaceholderSecret } from '../utils/api-auth.js';

/* ────────────────────────────────────────────────────────────────
   Types
   ──────────────────────────────────────────────────────────────── */

export type ImportMethod =
  | 'openapi' | 'postman' | 'endpoint' | 'curl' | 'docs-url' | 'connector'
  | 'sdk' | 'webhook' | 'graphql' | 'mcp' | 'middleware' | 'manual' | 'file';

export type ApiStyle = 'rest' | 'graphql' | 'soap' | 'jsonrpc' | 'webhook' | 'mcp';

export type ParserId =
  | 'openapi' | 'postman' | 'bruno' | 'har' | 'curl' | 'graphql' | 'mcp'
  | 'connector' | 'webhook' | 'probe' | 'llm';

export interface ImportedEndpoint extends ParsedApiSpec {
  description?: string;
  operationId?: string;
  tags?: string[];
  /** Resource / module grouping, e.g. "users". */
  resource?: string;
  /** Documented path template, e.g. `/v1/users/{id}` (placeholders intact). */
  pathTemplate?: string;
  pathParams?: { name: string; example?: string; required?: boolean }[];
  queryParams?: { name: string; example?: string; required?: boolean }[];
  style?: ApiStyle;
  source?: { method: ImportMethod; name: string };
  deprecated?: boolean;
  /** Set on endpoints that were auto-discovered (e.g. an OpenAPI document found
      on the origin of a probed URL) rather than named by the user. */
  discovered?: boolean;
}

export interface ImportResult {
  endpoints: ImportedEndpoint[];
  parser: ParserId;
  /** Human label of the detected format, e.g. "OpenAPI 3.0.1 (YAML)". */
  format: string;
  warnings: string[];
  notice?: string;
}

export type SniffedFormat =
  | 'openapi' | 'postman' | 'har' | 'bruno' | 'curl' | 'connector'
  | 'graphql-sdl' | 'wsdl' | 'json' | 'yaml' | 'text';

/** Deterministic parsers may return many endpoints; keep the workspace sane. */
const MAX_BULK_ENDPOINTS = 400;
const PLACEHOLDER_HOST = 'https://api.example.com';
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 6 * 1024 * 1024;

/* ────────────────────────────────────────────────────────────────
   Small helpers
   ──────────────────────────────────────────────────────────────── */

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max = 20000): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.slice(0, max);
  try { return JSON.stringify(v, null, 2).slice(0, max); } catch { return String(v).slice(0, max); }
}

function joinUrl(base: string, path: string): string {
  const b = (base || '').replace(/\/+$/, '');
  const p = (path || '').replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

function isAbsolute(url: string): boolean {
  return /^https?:\/\//i.test(url || '');
}

/** Parse JSON, then YAML, returning null when neither works. */
export function parseStructured(text: string): { doc: any; kind: 'json' | 'yaml' } | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return { doc: JSON.parse(t), kind: 'json' }; } catch { /* fall through */ }
  }
  try {
    const doc = YAML.parse(t, { maxAliasCount: 1000 });
    if (doc && typeof doc === 'object') return { doc, kind: 'yaml' };
  } catch { /* not yaml */ }
  return null;
}

/** Path-parameter placeholders → concrete example values. */
export function exampleForParam(name: string, hint?: unknown): string {
  if (hint !== undefined && hint !== null && String(hint) !== '') return String(hint);
  const n = name.toLowerCase();
  if (/(id|uuid|guid|key|number|no)$/.test(n) || n === 'id') return '1';
  if (n.includes('email')) return 'user@example.com';
  if (n.includes('date')) return '2025-01-01';
  if (n.includes('page')) return '1';
  if (n.includes('limit') || n.includes('size') || n.includes('count')) return '10';
  if (n.includes('name') || n.includes('slug')) return 'example';
  return 'example';
}

function substitutePath(template: string, params: Record<string, string>): string {
  return template
    .replace(/\{([^}]+)\}/g, (_m, k) => encodeURIComponent(params[k] ?? exampleForParam(k)))
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k) => encodeURIComponent(params[k] ?? exampleForParam(k)));
}

/** Resource name from a path: the last non-parameter segment. */
export function resourceFromPath(path: string): string {
  const segs = (path || '').split('?')[0]!.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (/^\{.*\}$/.test(s) || /^:/.test(s) || /^\d+$/.test(s) || /^v\d+$/i.test(s)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) continue;
    return s.toLowerCase();
  }
  return 'api';
}

function normaliseAuthType(t: string): ParsedApiSpec['auth']['type'] {
  const v = (t || '').toLowerCase();
  if (v === 'bearer' || v === 'basic' || v === 'apikey') return v;
  return 'none';
}

/** Trim and validate one endpoint — mirrors api-spec-parser's normalise(). */
export function finalizeEndpoint(e: Partial<ImportedEndpoint>, source?: ImportedEndpoint['source']): ImportedEndpoint | null {
  const url = String(e.url || '').trim();
  if (!isAbsolute(url)) return null;
  const method = String(e.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
  const authType = normaliseAuthType(e.auth?.type || 'none');
  const cleaned = cleanAuthValue(e.auth?.value || '');
  const authValue = authType !== 'none' && !isPlaceholderSecret(cleaned) ? cleaned.slice(0, 4000) : undefined;
  const headers = (e.headers || [])
    .filter((h) => h && String(h.key || '').trim())
    .slice(0, 40)
    .map((h) => ({ key: String(h.key).trim().slice(0, 200), value: String(h.value ?? '').slice(0, 2000) }));
  let title = String(e.title || '').trim().slice(0, 160);
  if (!title) {
    let p = url;
    try { p = new URL(url).pathname || url; } catch { /* keep */ }
    title = `${method} ${p}`;
  }
  const statusNum = Number(e.expectedStatus);
  const expectedStatus = Number.isInteger(statusNum) && statusNum >= 100 && statusNum <= 599 ? statusNum : undefined;
  const auth: ParsedApiSpec['auth'] & { headerName?: string } = { type: authType, value: authValue };
  if (authType === 'apikey' && (e.auth as any)?.headerName) auth.headerName = String((e.auth as any).headerName).slice(0, 100);
  return {
    title,
    method,
    url: url.slice(0, 4000),
    headers,
    auth,
    body: e.body?.trim() ? e.body.slice(0, 20000) : undefined,
    expectedStatus,
    expectedResponse: e.expectedResponse?.trim() ? e.expectedResponse.slice(0, 20000) : undefined,
    description: e.description?.trim() ? e.description.slice(0, 2000) : undefined,
    operationId: e.operationId,
    tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 10) : undefined,
    resource: e.resource || resourceFromPath((() => { try { return new URL(url).pathname; } catch { return url; } })()),
    pathTemplate: e.pathTemplate,
    pathParams: e.pathParams,
    queryParams: e.queryParams,
    style: e.style || 'rest',
    source: e.source || source,
    deprecated: e.deprecated || undefined,
    discovered: e.discovered || undefined,
  };
}

/** De-duplicate on method + URL, preserving first occurrence. */
export function dedupeEndpoints(list: ImportedEndpoint[]): ImportedEndpoint[] {
  const seen = new Set<string>();
  const out: ImportedEndpoint[] = [];
  for (const e of list) {
    const key = `${e.method} ${e.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
   Format sniffing
   ──────────────────────────────────────────────────────────────── */

export function sniffFormat(text: string, fileName = ''): SniffedFormat {
  const t = (text || '').trim();
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (ext === 'bru') return 'bruno';
  if (ext === 'har') return 'har';
  if (/^\s*curl\s/i.test(t) || /(^|\n)\s*curl\s/i.test(t)) return 'curl';
  if (/<(wsdl:)?definitions\b/i.test(t) || /<\/?(wsdl|soap):/i.test(t)) return 'wsdl';
  if (/^\s*(type\s+(Query|Mutation)\b|schema\s*\{)/m.test(t) && !t.startsWith('{')) return 'graphql-sdl';
  const parsed = parseStructured(t);
  if (parsed) {
    const d = parsed.doc;
    if (isObj(d)) {
      if (d.openapi || d.swagger) return 'openapi';
      if (d.info && (Array.isArray(d.item) || d.item)) return 'postman';
      if (isObj(d.log) && Array.isArray(d.log.entries)) return 'har';
      if (Array.isArray(d.endpoints) || (d.connector && Array.isArray(d.connector.endpoints))) return 'connector';
    }
    if (Array.isArray(d) && d.length && isObj(d[0]) && d[0].url && d[0].method) return 'connector';
    return parsed.kind;
  }
  if (/^\s*(meta|get|post|put|patch|delete)\s*\{/m.test(t)) return 'bruno';
  return 'text';
}

/* ────────────────────────────────────────────────────────────────
   OpenAPI / Swagger
   ──────────────────────────────────────────────────────────────── */

/** Resolve a local `$ref` ("#/components/schemas/User") inside `root`. */
function makeResolver(root: any) {
  const cache = new Map<string, any>();
  return function resolve(node: any, depth = 0): any {
    if (!isObj(node) || depth > 30) return node;
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      if (cache.has(ref)) return cache.get(ref);
      const target = ref.slice(2).split('/').reduce((o: any, k: string) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), root);
      const merged = isObj(target) ? { ...resolve(target, depth + 1), ...omitRef(node) } : target;
      cache.set(ref, merged);
      return merged;
    }
    return node;
  };
}
function omitRef(o: Record<string, any>): Record<string, any> {
  const { $ref: _r, ...rest } = o;
  return rest;
}

/**
 * Build a realistic example value from a JSON schema. Prefers documented
 * examples/defaults/enums; otherwise picks a value by type/format/name so the
 * generated request body reads like a real payload, not `"string"`.
 */
export function sampleFromSchema(schema: any, resolve: (n: any) => any, depth = 0, name = ''): any {
  const s = resolve(schema);
  if (!isObj(s) || depth > 6) return undefined;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const anyOf = s.oneOf || s.anyOf;
  if (Array.isArray(anyOf) && anyOf.length) return sampleFromSchema(anyOf[0], resolve, depth + 1, name);
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const merged: Record<string, any> = {};
    for (const part of s.allOf) {
      const v = sampleFromSchema(part, resolve, depth + 1, name);
      if (isObj(v)) Object.assign(merged, v);
    }
    return merged;
  }
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  if (type === 'object' || (!type && isObj(s.properties))) {
    const out: Record<string, any> = {};
    const props = isObj(s.properties) ? s.properties : {};
    const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
    const keys = Object.keys(props);
    // Keep bodies focused: required fields, then the first few optional ones.
    const chosen = keys.filter((k) => required.has(k)).concat(keys.filter((k) => !required.has(k))).slice(0, 14);
    for (const k of chosen) {
      const p = resolve(props[k]);
      if (isObj(p) && p.readOnly) continue;
      const v = sampleFromSchema(p, resolve, depth + 1, k);
      if (v !== undefined) out[k] = v;
    }
    if (keys.length === 0 && isObj(s.additionalProperties)) out.key = sampleFromSchema(s.additionalProperties, resolve, depth + 1, 'key');
    return out;
  }
  if (type === 'array') {
    const item = sampleFromSchema(s.items || {}, resolve, depth + 1, name);
    return item === undefined ? [] : [item];
  }
  if (type === 'integer' || type === 'number') {
    if (typeof s.minimum === 'number') return s.minimum;
    const n = name.toLowerCase();
    if (n.includes('id')) return 1;
    if (n.includes('price') || n.includes('amount')) return 9.99;
    if (n.includes('quantity') || n.includes('count')) return 2;
    if (n.includes('page')) return 1;
    return type === 'integer' ? 1 : 1.5;
  }
  if (type === 'boolean') return true;
  // string (or untyped)
  const fmt = String(s.format || '').toLowerCase();
  const n = name.toLowerCase();
  if (fmt === 'date-time') return '2025-01-01T10:00:00Z';
  if (fmt === 'date') return '2025-01-01';
  if (fmt === 'email' || n.includes('email')) return 'user@example.com';
  if (fmt === 'uuid' || n.endsWith('uuid') || n.endsWith('guid')) return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  if (fmt === 'uri' || fmt === 'url' || n.includes('url')) return 'https://example.com';
  if (fmt === 'password' || n.includes('password')) return 'P@ssw0rd!';
  if (n.includes('phone')) return '+15555550123';
  if (n === 'name' || n.endsWith('name')) return n.includes('first') ? 'Jane' : n.includes('last') ? 'Doe' : 'Example name';
  if (n.includes('title')) return 'Example title';
  if (n.includes('description')) return 'Example description';
  if (n.includes('status')) return 'active';
  if (n.includes('country')) return 'US';
  if (n.includes('currency')) return 'USD';
  if (n.endsWith('id')) return '1';
  if (typeof s.minLength === 'number' && s.minLength > 7) return 'x'.repeat(s.minLength);
  return 'example';
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Parse an OpenAPI 3.x or Swagger 2.0 document object into endpoints. */
export function parseOpenApiDocument(doc: any, opts: { baseUrl?: string; sourceName?: string } = {}): ImportResult {
  const warnings: string[] = [];
  const resolve = makeResolver(doc);
  const isV2 = !!doc.swagger;
  const version = String(doc.openapi || doc.swagger || '');

  // Base URL
  let base = opts.baseUrl || '';
  if (!base) {
    if (!isV2 && Array.isArray(doc.servers) && doc.servers.length) {
      const s = doc.servers[0];
      let u = String(s?.url || '');
      if (isObj(s?.variables)) {
        for (const [k, v] of Object.entries<any>(s.variables)) {
          u = u.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v?.default ?? v?.enum?.[0] ?? ''));
        }
      }
      base = u;
    } else if (isV2 && doc.host) {
      const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : 'https';
      base = `${scheme}://${doc.host}${doc.basePath || ''}`;
    }
  }
  if (base && !isAbsolute(base)) {
    // Relative server ("/api/v1") — nothing to attach it to.
    base = joinUrl(PLACEHOLDER_HOST, base);
    warnings.push('The document declares a relative server URL — endpoints use https://api.example.com as a placeholder host. Set the real base URL in an Environment before running.');
  }
  if (!base) {
    base = PLACEHOLDER_HOST;
    warnings.push('The document declares no server/host — endpoints use https://api.example.com as a placeholder. Set the real base URL in an Environment before running.');
  }

  // Security schemes → our auth types
  const schemes: Record<string, { type: ParsedApiSpec['auth']['type']; headerName?: string }> = {};
  const rawSchemes = isV2 ? doc.securityDefinitions : doc.components?.securitySchemes;
  if (isObj(rawSchemes)) {
    for (const [name, def0] of Object.entries<any>(rawSchemes)) {
      const def = resolve(def0);
      if (!isObj(def)) continue;
      const t = String(def.type || '').toLowerCase();
      if (t === 'http') {
        const scheme = String(def.scheme || '').toLowerCase();
        schemes[name] = { type: scheme === 'basic' ? 'basic' : 'bearer' };
      } else if (t === 'apikey') {
        schemes[name] = { type: 'apikey', headerName: String(def.in || 'header') === 'header' ? String(def.name || 'X-API-Key') : undefined };
      } else if (t === 'oauth2' || t === 'openidconnect' || t === 'basic') {
        schemes[name] = { type: t === 'basic' ? 'basic' : 'bearer' };
      }
    }
  }
  const authFor = (security: any): { type: ParsedApiSpec['auth']['type']; headerName?: string } => {
    const list = Array.isArray(security) ? security : [];
    for (const req of list) {
      if (!isObj(req)) continue;
      for (const name of Object.keys(req)) {
        if (schemes[name]) return schemes[name]!;
      }
    }
    return { type: 'none' };
  };
  const globalSecurity = doc.security;

  const endpoints: ImportedEndpoint[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  const source: ImportedEndpoint['source'] = { method: 'openapi', name: opts.sourceName || (doc.info?.title ? String(doc.info.title) : 'OpenAPI') };

  for (const [rawPath, item0] of Object.entries<any>(paths)) {
    const item = resolve(item0);
    if (!isObj(item)) continue;
    const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = resolve(item[method]);
      if (!isObj(op)) continue;
      if (endpoints.length >= MAX_BULK_ENDPOINTS) break;

      const params = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(resolve).filter(isObj);
      const pathParams: ImportedEndpoint['pathParams'] = [];
      const queryParams: ImportedEndpoint['queryParams'] = [];
      const headers: { key: string; value: string }[] = [];
      const pathValues: Record<string, string> = {};
      const query: string[] = [];
      for (const p of params) {
        const name = String(p.name || '');
        if (!name) continue;
        const schema = resolve(p.schema || p);
        const hint = p.example ?? (isObj(p.examples) ? Object.values<any>(p.examples)[0]?.value : undefined) ?? schema?.example ?? schema?.default ?? (Array.isArray(schema?.enum) ? schema.enum[0] : undefined);
        const example = hint !== undefined ? String(hint) : String(sampleFromSchema(schema, resolve, 0, name) ?? exampleForParam(name));
        const where = String(p.in || '').toLowerCase();
        if (where === 'path') {
          pathParams.push({ name, example, required: true });
          pathValues[name] = example;
        } else if (where === 'query') {
          queryParams.push({ name, example, required: !!p.required });
          // Only required params (and documented examples) go into the URL,
          // so the happy path is the documented request and nothing more.
          if (p.required || hint !== undefined) query.push(`${encodeURIComponent(name)}=${encodeURIComponent(example)}`);
        } else if (where === 'header') {
          if (!/^(authorization|x-api-key)$/i.test(name)) headers.push({ key: name, value: example });
        }
      }

      // Request body (v3 requestBody / v2 in:body parameter)
      let body: string | undefined;
      let contentType: string | undefined;
      if (!isV2 && isObj(op.requestBody)) {
        const rb = resolve(op.requestBody);
        const content = isObj(rb.content) ? rb.content : {};
        const ct = Object.keys(content).find((k) => /json/i.test(k)) || Object.keys(content)[0];
        if (ct) {
          contentType = ct;
          const media = resolve(content[ct]);
          const ex = media?.example ?? (isObj(media?.examples) ? resolve(Object.values<any>(media.examples)[0])?.value : undefined);
          const sample = ex !== undefined ? ex : sampleFromSchema(media?.schema, resolve);
          if (sample !== undefined) body = /json/i.test(ct) ? JSON.stringify(sample, null, 2) : str(sample);
        }
      } else if (isV2) {
        const bp = params.find((p) => String(p.in).toLowerCase() === 'body');
        if (bp) {
          const sample = sampleFromSchema(bp.schema, resolve);
          if (sample !== undefined) body = JSON.stringify(sample, null, 2);
          contentType = Array.isArray(op.consumes) && op.consumes.length ? op.consumes[0] : 'application/json';
        }
        const formParams = params.filter((p) => String(p.in).toLowerCase() === 'formdata');
        if (formParams.length) {
          const form: Record<string, any> = {};
          for (const p of formParams) form[String(p.name)] = exampleForParam(String(p.name), p.example ?? p.default);
          body = JSON.stringify(form, null, 2);
        }
      }
      if (body && contentType && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
        headers.push({ key: 'Content-Type', value: contentType });
      }

      // Response: the first 2xx (or default) — status + example body
      let expectedStatus: number | undefined;
      let expectedResponse: string | undefined;
      const responses = isObj(op.responses) ? op.responses : {};
      const codes = Object.keys(responses).sort();
      const success = codes.find((c) => /^2\d\d$/.test(c)) || (codes.includes('default') ? 'default' : undefined);
      if (success) {
        expectedStatus = /^\d{3}$/.test(success) ? Number(success) : (method === 'post' ? 201 : method === 'delete' ? 204 : 200);
        const r = resolve(responses[success]);
        if (isV2) {
          const sample = r?.examples ? Object.values<any>(r.examples)[0] : sampleFromSchema(r?.schema, resolve);
          if (sample !== undefined) expectedResponse = str(sample);
        } else if (isObj(r?.content)) {
          const ct = Object.keys(r.content).find((k) => /json/i.test(k)) || Object.keys(r.content)[0];
          if (ct) {
            const media = resolve(r.content[ct]);
            const ex = media?.example ?? (isObj(media?.examples) ? resolve(Object.values<any>(media.examples)[0])?.value : undefined);
            const sample = ex !== undefined ? ex : sampleFromSchema(media?.schema, resolve);
            if (sample !== undefined) expectedResponse = str(sample);
          }
        }
      } else {
        expectedStatus = method === 'post' ? 201 : method === 'delete' ? 204 : 200;
      }
      if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.unshift({ key: 'Accept', value: 'application/json' });

      const auth = authFor(op.security !== undefined ? op.security : globalSecurity);
      const summary = String(op.summary || op.description || '').trim().split('\n')[0] || '';
      const url = joinUrl(base, substitutePath(rawPath, pathValues)) + (query.length ? `?${query.join('&')}` : '');
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];
      const ep = finalizeEndpoint({
        title: `${method.toUpperCase()} ${rawPath}${summary ? ` — ${summary.slice(0, 80)}` : ''}`,
        method: method.toUpperCase(),
        url,
        headers,
        auth: { type: auth.type, headerName: auth.headerName } as any,
        body,
        expectedStatus,
        expectedResponse,
        description: String(op.description || op.summary || '').trim() || undefined,
        operationId: op.operationId ? String(op.operationId) : undefined,
        tags,
        resource: tags[0] ? String(tags[0]).toLowerCase() : resourceFromPath(rawPath),
        pathTemplate: rawPath,
        pathParams,
        queryParams,
        deprecated: !!op.deprecated,
        style: 'rest',
      }, source);
      if (ep) endpoints.push(ep);
    }
  }

  if (Object.keys(paths).length && endpoints.length >= MAX_BULK_ENDPOINTS) {
    warnings.push(`The document describes more than ${MAX_BULK_ENDPOINTS} operations — the first ${MAX_BULK_ENDPOINTS} were imported.`);
  }
  return {
    endpoints: dedupeEndpoints(endpoints),
    parser: 'openapi',
    format: `${isV2 ? 'Swagger' : 'OpenAPI'} ${version}`.trim(),
    warnings,
    notice: `${endpoints.length} operation${endpoints.length === 1 ? '' : 's'} read from ${doc.info?.title ? `"${doc.info.title}"` : 'the document'}${doc.info?.version ? ` v${doc.info.version}` : ''}.`,
  };
}

/* ────────────────────────────────────────────────────────────────
   Postman collection (v2.0 / v2.1)
   ──────────────────────────────────────────────────────────────── */

function fillVars(s: string, vars: Record<string, string>): string {
  return (s || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k]! : m));
}

function postmanAuth(auth: any): { type: ParsedApiSpec['auth']['type']; value?: string; headerName?: string } {
  if (!isObj(auth)) return { type: 'none' };
  const t = String(auth.type || '').toLowerCase();
  const kv = (list: any): Record<string, string> => {
    const out: Record<string, string> = {};
    if (Array.isArray(list)) for (const p of list) if (isObj(p) && p.key) out[String(p.key)] = String(p.value ?? '');
    return out;
  };
  if (t === 'bearer') return { type: 'bearer', value: kv(auth.bearer).token };
  if (t === 'basic') {
    const b = kv(auth.basic);
    return { type: 'basic', value: b.username ? `${b.username}:${b.password || ''}` : undefined };
  }
  if (t === 'apikey') {
    const a = kv(auth.apikey);
    return { type: 'apikey', value: a.value, headerName: a.in === 'query' ? undefined : (a.key || 'X-API-Key') };
  }
  if (t === 'oauth2' || t === 'jwt') return { type: 'bearer', value: kv(auth.oauth2 || auth.jwt).accessToken };
  return { type: 'none' };
}

export function parsePostmanCollection(doc: any, opts: { variables?: Record<string, string>; sourceName?: string } = {}): ImportResult {
  const warnings: string[] = [];
  const vars: Record<string, string> = { ...(opts.variables || {}) };
  if (Array.isArray(doc.variable)) {
    for (const v of doc.variable) if (isObj(v) && v.key && vars[String(v.key)] === undefined) vars[String(v.key)] = String(v.value ?? '');
  }
  const collectionAuth = postmanAuth(doc.auth);
  const endpoints: ImportedEndpoint[] = [];
  const source: ImportedEndpoint['source'] = { method: 'postman', name: opts.sourceName || String(doc.info?.name || 'Postman collection') };
  let unresolved = 0;

  const walk = (items: any[], folder: string[], inheritedAuth: typeof collectionAuth) => {
    for (const it of items) {
      if (!isObj(it)) continue;
      if (endpoints.length >= MAX_BULK_ENDPOINTS) return;
      const itemAuth = it.auth ? postmanAuth(it.auth) : inheritedAuth;
      if (Array.isArray(it.item)) { walk(it.item, [...folder, String(it.name || '')], itemAuth); continue; }
      const req = isObj(it.request) ? it.request : (typeof it.request === 'string' ? { url: it.request, method: 'GET' } : null);
      if (!req) continue;

      let raw = '';
      if (typeof req.url === 'string') raw = req.url;
      else if (isObj(req.url)) {
        raw = String(req.url.raw || '');
        if (!raw) {
          const host = Array.isArray(req.url.host) ? req.url.host.join('.') : String(req.url.host || '');
          const path = Array.isArray(req.url.path) ? req.url.path.join('/') : String(req.url.path || '');
          raw = `${req.url.protocol ? `${req.url.protocol}://` : ''}${host}/${path}`;
        }
        // Path variables (":id") → example values
        if (Array.isArray(req.url.variable)) {
          for (const v of req.url.variable) if (isObj(v) && v.key) raw = raw.replace(`:${v.key}`, exampleForParam(String(v.key), v.value));
        }
      }
      raw = fillVars(raw, vars);
      raw = raw.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k) => exampleForParam(k));
      if (/\{\{/.test(raw)) {
        unresolved++;
        // {{baseUrl}}-style prefix with no value: attach a placeholder host so the endpoint survives.
        raw = raw.replace(/^\{\{[^}]+\}\}/, PLACEHOLDER_HOST).replace(/\{\{[^}]+\}\}/g, 'example');
      }
      if (!isAbsolute(raw)) raw = joinUrl(PLACEHOLDER_HOST, raw);

      const headers: { key: string; value: string }[] = [];
      if (Array.isArray(req.header)) {
        for (const h of req.header) {
          if (!isObj(h) || h.disabled || !h.key) continue;
          if (/^authorization$/i.test(String(h.key)) && (itemAuth.type !== 'none')) continue;
          headers.push({ key: String(h.key), value: fillVars(String(h.value ?? ''), vars) });
        }
      }

      let body: string | undefined;
      const b = req.body;
      if (isObj(b)) {
        const mode = String(b.mode || 'raw');
        if (mode === 'raw' && b.raw) body = fillVars(String(b.raw), vars);
        else if (mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
          body = b.urlencoded.filter((p: any) => isObj(p) && !p.disabled).map((p: any) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fillVars(String(p.value ?? ''), vars))}`).join('&');
          if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
        } else if (mode === 'formdata' && Array.isArray(b.formdata)) {
          const form: Record<string, string> = {};
          for (const p of b.formdata) if (isObj(p) && !p.disabled && p.key) form[String(p.key)] = fillVars(String(p.value ?? ''), vars);
          body = JSON.stringify(form, null, 2);
        } else if (mode === 'graphql' && isObj(b.graphql)) {
          body = JSON.stringify({ query: b.graphql.query || '', variables: safeJson(b.graphql.variables) }, null, 2);
        }
      }

      let expectedStatus: number | undefined;
      let expectedResponse: string | undefined;
      if (Array.isArray(it.response) && it.response.length) {
        const ok = it.response.find((r: any) => isObj(r) && Number(r.code) >= 200 && Number(r.code) < 300) || it.response[0];
        if (isObj(ok)) {
          if (Number(ok.code)) expectedStatus = Number(ok.code);
          if (ok.body) expectedResponse = String(ok.body);
        }
      }

      const method = String(req.method || 'GET').toUpperCase();
      const isGraphql = isObj(b) && b.mode === 'graphql';
      const ep = finalizeEndpoint({
        title: `${method} ${it.name || raw}`.slice(0, 160),
        method,
        url: raw,
        headers,
        auth: { type: itemAuth.type, value: itemAuth.value, headerName: itemAuth.headerName } as any,
        body,
        expectedStatus,
        expectedResponse,
        description: typeof req.description === 'string' ? req.description : (isObj(req.description) ? String(req.description.content || '') : undefined),
        tags: folder.filter(Boolean),
        resource: folder.filter(Boolean).pop()?.toLowerCase() || undefined,
        style: isGraphql ? 'graphql' : 'rest',
      }, source);
      if (ep) endpoints.push(ep);
    }
  };
  walk(Array.isArray(doc.item) ? doc.item : [], [], collectionAuth);

  if (unresolved) warnings.push(`${unresolved} request${unresolved === 1 ? '' : 's'} used collection variables with no value (e.g. {{baseUrl}}) — placeholders were substituted. Define them in an Environment before running.`);
  return {
    endpoints: dedupeEndpoints(endpoints),
    parser: 'postman',
    format: `Postman collection ${/2\.1/.test(String(doc.info?.schema || '')) ? 'v2.1' : 'v2.0'}`,
    warnings,
    notice: `${endpoints.length} request${endpoints.length === 1 ? '' : 's'} read from "${doc.info?.name || 'the collection'}".`,
  };
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {};
  try { return JSON.parse(v); } catch { return v; }
}

/* ────────────────────────────────────────────────────────────────
   HAR recordings (browser DevTools → Save all as HAR)
   ──────────────────────────────────────────────────────────────── */

export function parseHar(doc: any, sourceName = 'HAR recording'): ImportResult {
  const entries: any[] = Array.isArray(doc?.log?.entries) ? doc.log.entries : [];
  const endpoints: ImportedEndpoint[] = [];
  const source: ImportedEndpoint['source'] = { method: 'postman', name: sourceName };
  for (const e of entries) {
    if (endpoints.length >= MAX_BULK_ENDPOINTS) break;
    const req = e?.request; const res = e?.response;
    if (!isObj(req) || !req.url) continue;
    const mime = String(res?.content?.mimeType || '');
    // Only API traffic — skip page assets.
    if (!/json|xml|graphql|text\/plain/i.test(mime) && !/\/api\//i.test(String(req.url))) continue;
    const headers = (Array.isArray(req.headers) ? req.headers : [])
      .filter((h: any) => isObj(h) && h.name && !/^(:|host$|cookie$|content-length$|user-agent$|accept-encoding$|origin$|referer$|sec-)/i.test(String(h.name)))
      .map((h: any) => ({ key: String(h.name), value: String(h.value ?? '') }));
    let auth: any = { type: 'none' };
    const authH = headers.find((h) => h.key.toLowerCase() === 'authorization');
    if (authH) {
      const v = authH.value;
      auth = /^bearer /i.test(v) ? { type: 'bearer', value: v.replace(/^bearer /i, '') } : /^basic /i.test(v) ? { type: 'basic', value: Buffer.from(v.replace(/^basic /i, ''), 'base64').toString('utf8') } : { type: 'none' };
    }
    const ep = finalizeEndpoint({
      title: `${req.method} ${(() => { try { return new URL(req.url).pathname; } catch { return req.url; } })()}`,
      method: req.method,
      url: String(req.url),
      headers: headers.filter((h) => h.key.toLowerCase() !== 'authorization'),
      auth,
      body: req.postData?.text ? String(req.postData.text) : undefined,
      expectedStatus: Number(res?.status) || undefined,
      expectedResponse: res?.content?.text && /json/i.test(mime) ? String(res.content.text).slice(0, 20000) : undefined,
      style: /graphql/i.test(String(req.url)) ? 'graphql' : 'rest',
    }, source);
    if (ep) endpoints.push(ep);
  }
  return { endpoints: dedupeEndpoints(endpoints), parser: 'har', format: 'HAR 1.2', warnings: [], notice: `${endpoints.length} API request${endpoints.length === 1 ? '' : 's'} recovered from the recording.` };
}

/* ────────────────────────────────────────────────────────────────
   Bruno `.bru`
   ──────────────────────────────────────────────────────────────── */

export function parseBruno(text: string, sourceName = 'Bruno request'): ImportResult {
  const blocks: Record<string, string> = {};
  const re = /^([a-z:]+)\s*\{\s*\n([\s\S]*?)\n\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks[m[1]!] = m[2]!;
  const kv = (block?: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of (block || '').split('\n')) {
      const mm = /^\s*~?([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (mm) out[mm[1]!.trim()] = mm[2]!.trim();
    }
    return out;
  };
  const methodKey = Object.keys(blocks).find((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k));
  if (!methodKey) return { endpoints: [], parser: 'bruno', format: 'Bruno', warnings: ['No request block (get/post/…) found in the .bru file.'] };
  const reqBlock = kv(blocks[methodKey]);
  const meta = kv(blocks.meta);
  const headers = Object.entries(kv(blocks.headers)).map(([key, value]) => ({ key, value }));
  let auth: any = { type: 'none' };
  if (blocks['auth:bearer']) auth = { type: 'bearer', value: kv(blocks['auth:bearer']).token };
  else if (blocks['auth:basic']) { const b = kv(blocks['auth:basic']); auth = { type: 'basic', value: `${b.username || ''}:${b.password || ''}` }; }
  else if (blocks['auth:apikey']) { const a = kv(blocks['auth:apikey']); auth = { type: 'apikey', value: a.value, headerName: a.key }; }
  const bodyKey = Object.keys(blocks).find((k) => k.startsWith('body'));
  const body = bodyKey ? blocks[bodyKey]!.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n').trim() : undefined;
  let url = fillVars(String(reqBlock.url || ''), {});
  if (/\{\{/.test(url)) url = url.replace(/^\{\{[^}]+\}\}/, PLACEHOLDER_HOST);
  if (!isAbsolute(url)) url = joinUrl(PLACEHOLDER_HOST, url);
  const ep = finalizeEndpoint({
    title: `${methodKey.toUpperCase()} ${meta.name || url}`,
    method: methodKey.toUpperCase(),
    url, headers, auth, body,
  }, { method: 'postman', name: sourceName });
  return { endpoints: ep ? [ep] : [], parser: 'bruno', format: 'Bruno', warnings: [] };
}

/* ────────────────────────────────────────────────────────────────
   cURL
   ──────────────────────────────────────────────────────────────── */

/** Shell-style tokeniser: quotes, `$'…'`, backslash escapes, line continuations. */
function tokenizeShell(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: string | null = null;
  let has = false;
  while (i < s.length) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) { quote = null; i++; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
      if (quote === '$' && ch === '\\' && i + 1 < s.length) {
        const n = s[i + 1]!; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '$' && s[i + 1] === "'") { quote = '$'; has = true; i += 2; continue; }
    if (ch === "'" || ch === '"') { quote = ch; has = true; i++; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; has = true; i += 2; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } i++; continue; }
    cur += ch; has = true; i++;
  }
  if (has || cur) out.push(cur);
  return out;
}

export function parseCurlCommands(text: string, sourceName = 'cURL'): ImportResult {
  // Split on lines that begin a new `curl` command.
  const joined = text.replace(/\\\r?\n/g, '  ');
  const chunks = joined.split(/(?:^|\n)\s*(?=curl\s)/g).map((c) => c.replace(//g, '').trim()).filter((c) => /^curl\s/i.test(c));
  const endpoints: ImportedEndpoint[] = [];
  const warnings: string[] = [];
  const source: ImportedEndpoint['source'] = { method: 'curl', name: sourceName };
  for (const chunk of chunks) {
    if (endpoints.length >= MAX_BULK_ENDPOINTS) break;
    const toks = tokenizeShell(chunk).slice(1);
    let method = '';
    let url = '';
    const headers: { key: string; value: string }[] = [];
    let auth: any = { type: 'none' };
    let body: string | undefined;
    const form: Record<string, string> = {};
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      const next = () => toks[++i] ?? '';
      if (t === '-X' || t === '--request') method = next().toUpperCase();
      else if (t.startsWith('-X') && t.length > 2) method = t.slice(2).toUpperCase();
      else if (t === '-H' || t === '--header') {
        const h = next(); const idx = h.indexOf(':');
        if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
      }
      else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii' || t === '--json') {
        const d = next();
        body = body ? `${body}&${d}` : d;
        if (t === '--json') headers.push({ key: 'Content-Type', value: 'application/json' });
      }
      else if (t === '--data-urlencode') { const d = next(); body = body ? `${body}&${d}` : d; }
      else if (t === '-F' || t === '--form') { const f = next(); const eq = f.indexOf('='); if (eq > 0) form[f.slice(0, eq)] = f.slice(eq + 1); }
      else if (t === '-u' || t === '--user') auth = { type: 'basic', value: next() };
      else if (t === '--url') url = next();
      else if (t === '-A' || t === '--user-agent' || t === '-o' || t === '--output' || t === '-b' || t === '--cookie' || t === '-e' || t === '--referer' || t === '--max-time' || t === '--connect-timeout') next();
      else if (t === '-G' || t === '--get') method = method || 'GET';
      else if (t.startsWith('-')) { /* flag without value */ }
      else if (!url && /^https?:\/\//i.test(t.replace(/^['"]|['"]$/g, ''))) url = t.replace(/^['"]|['"]$/g, '');
      else if (!url && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t)) url = `https://${t}`;
    }
    if (Object.keys(form).length) { body = JSON.stringify(form, null, 2); }
    if (!method) method = body !== undefined ? 'POST' : 'GET';
    const authH = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
    if (authH !== -1 && auth.type === 'none') {
      const v = headers[authH]!.value;
      if (/^bearer /i.test(v)) auth = { type: 'bearer', value: v.replace(/^bearer /i, '') };
      else if (/^basic /i.test(v)) { try { auth = { type: 'basic', value: Buffer.from(v.replace(/^basic /i, ''), 'base64').toString('utf8') }; } catch { /* leave */ } }
      if (auth.type !== 'none') headers.splice(authH, 1);
    }
    const apiKeyH = headers.findIndex((h) => /^(x-api-key|api-key|apikey)$/i.test(h.key));
    if (apiKeyH !== -1 && auth.type === 'none') { auth = { type: 'apikey', value: headers[apiKeyH]!.value, headerName: headers[apiKeyH]!.key }; headers.splice(apiKeyH, 1); }
    if (!url) { warnings.push(`A cURL command had no URL and was skipped: "${chunk.slice(0, 60)}…"`); continue; }
    const ep = finalizeEndpoint({
      title: `${method} ${(() => { try { return new URL(url).pathname; } catch { return url; } })()}`,
      method, url, headers, auth, body,
      style: /graphql/i.test(url) ? 'graphql' : 'rest',
    }, source);
    if (ep) endpoints.push(ep);
  }
  if (!endpoints.length && !warnings.length) warnings.push('No cURL command with an absolute http(s) URL was found.');
  return { endpoints: dedupeEndpoints(endpoints), parser: 'curl', format: 'cURL', warnings, notice: endpoints.length ? `${endpoints.length} request${endpoints.length === 1 ? '' : 's'} parsed from cURL.` : undefined };
}

/* ────────────────────────────────────────────────────────────────
   Custom Connector manifest
   ──────────────────────────────────────────────────────────────── */

/**
 * The portable contract a team can keep next to their code:
 *
 *   {
 *     "name": "Orders service",
 *     "baseUrl": "https://api.acme.com/v2",
 *     "auth": { "type": "bearer", "value": "" },
 *     "headers": { "Accept": "application/json" },
 *     "endpoints": [
 *       { "name": "List orders", "method": "GET", "path": "/orders?limit=10", "expectedStatus": 200,
 *         "expectedResponse": { "items": [] } },
 *       { "name": "Create order", "method": "POST", "path": "/orders", "body": { "sku": "A1", "qty": 2 },
 *         "expectedStatus": 201 }
 *     ]
 *   }
 *
 * A bare array of endpoints (the studio's own export) is accepted too, so an
 * imported catalogue round-trips.
 */
export function parseConnectorManifest(doc: any, sourceName = 'Custom connector'): ImportResult {
  const manifest = isObj(doc) && isObj(doc.connector) ? doc.connector : doc;
  const list: any[] = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.endpoints) ? manifest.endpoints : [];
  const base = isObj(manifest) ? String(manifest.baseUrl || manifest.base_url || '') : '';
  const gAuth = isObj(manifest) && isObj(manifest.auth) ? manifest.auth : null;
  const gHeaders: { key: string; value: string }[] = [];
  if (isObj(manifest) && isObj(manifest.headers)) for (const [k, v] of Object.entries(manifest.headers)) gHeaders.push({ key: k, value: String(v ?? '') });
  else if (isObj(manifest) && Array.isArray(manifest.headers)) for (const h of manifest.headers) if (isObj(h) && h.key) gHeaders.push({ key: String(h.key), value: String(h.value ?? '') });
  const warnings: string[] = [];
  const endpoints: ImportedEndpoint[] = [];
  const source: ImportedEndpoint['source'] = { method: 'connector', name: String((isObj(manifest) && manifest.name) || sourceName) };
  for (const e of list) {
    if (!isObj(e)) continue;
    if (endpoints.length >= MAX_BULK_ENDPOINTS) break;
    let url = String(e.url || '');
    if (!url && e.path !== undefined) url = joinUrl(base || PLACEHOLDER_HOST, String(e.path));
    if (url && !isAbsolute(url)) url = joinUrl(base || PLACEHOLDER_HOST, url);
    if (isObj(e.query)) {
      const q = Object.entries(e.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v ?? ''))}`).join('&');
      if (q) url += (url.includes('?') ? '&' : '?') + q;
    }
    const headers = [...gHeaders];
    if (isObj(e.headers)) for (const [k, v] of Object.entries(e.headers)) headers.push({ key: k, value: String(v ?? '') });
    else if (Array.isArray(e.headers)) for (const h of e.headers) if (isObj(h) && h.key) headers.push({ key: String(h.key), value: String(h.value ?? '') });
    const auth = isObj(e.auth) ? e.auth : gAuth;
    const ep = finalizeEndpoint({
      title: String(e.name || e.title || `${String(e.method || 'GET').toUpperCase()} ${e.path || url}`),
      method: String(e.method || 'GET'),
      url,
      headers,
      auth: auth ? { type: auth.type, value: auth.value, headerName: auth.headerName || auth.header } as any : { type: 'none' },
      body: e.body !== undefined ? str(e.body) : undefined,
      expectedStatus: e.expectedStatus,
      expectedResponse: e.expectedResponse !== undefined ? str(e.expectedResponse) : undefined,
      description: e.description,
      tags: Array.isArray(e.tags) ? e.tags : undefined,
      resource: e.resource,
      style: e.style,
      pathTemplate: e.pathTemplate || (e.path ? String(e.path).split('?')[0] : undefined),
    }, source);
    if (ep) endpoints.push(ep); else warnings.push(`Endpoint "${e.name || e.path || '?'}" has no absolute URL and was skipped.`);
  }
  if (!endpoints.length) warnings.push('The manifest contained no usable endpoints. Expected { baseUrl, endpoints: [{ method, path, … }] }.');
  return { endpoints: dedupeEndpoints(endpoints), parser: 'connector', format: 'Custom connector manifest', warnings, notice: endpoints.length ? `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} read from the connector manifest.` : undefined };
}

/* ────────────────────────────────────────────────────────────────
   Webhooks
   ──────────────────────────────────────────────────────────────── */

export interface WebhookDefinition {
  url: string;
  method?: string;
  /** Header name carrying the HMAC signature, e.g. X-Hub-Signature-256. */
  signatureHeader?: string;
  /** Shared secret used to sign each payload (HMAC-SHA256, hex). Never stored in the title. */
  secret?: string;
  headers?: { key: string; value: string }[];
  expectedStatus?: number;
  events: { name: string; payload: unknown; description?: string }[];
}

/**
 * A webhook is an endpoint the customer's system EXPOSES and a provider calls.
 * Testing it means playing the provider: POST each documented event payload,
 * correctly signed, and assert the consumer acknowledges it.
 */
export function endpointsFromWebhook(def: WebhookDefinition): ImportResult {
  const warnings: string[] = [];
  const endpoints: ImportedEndpoint[] = [];
  const method = String(def.method || 'POST').toUpperCase();
  const events = Array.isArray(def.events) && def.events.length ? def.events : [{ name: 'event', payload: { event: 'ping' } }];
  for (const ev of events) {
    const body = str(ev.payload ?? {});
    const headers = [{ key: 'Content-Type', value: 'application/json' }, ...(def.headers || [])];
    headers.push({ key: 'X-Webhook-Event', value: String(ev.name || 'event') });
    if (def.secret) {
      const sig = createHmac('sha256', def.secret).update(body).digest('hex');
      headers.push({ key: def.signatureHeader || 'X-Signature-256', value: `sha256=${sig}` });
    }
    const ep = finalizeEndpoint({
      title: `${method} webhook · ${ev.name || 'event'}`,
      method,
      url: def.url,
      headers,
      auth: { type: 'none' },
      body,
      expectedStatus: def.expectedStatus || 200,
      description: ev.description || `Deliver the "${ev.name}" webhook event and expect the consumer to acknowledge it.`,
      resource: 'webhooks',
      style: 'webhook',
    }, { method: 'webhook', name: def.url });
    if (ep) endpoints.push(ep); else warnings.push('The webhook URL must be an absolute http(s) URL.');
  }
  return { endpoints, parser: 'webhook', format: 'Webhook events', warnings, notice: endpoints.length ? `${endpoints.length} signed event deliver${endpoints.length === 1 ? 'y' : 'ies'} prepared for ${def.url}.` : undefined };
}

/* ────────────────────────────────────────────────────────────────
   Remote fetch (OpenAPI URLs, docs pages, GraphQL, MCP)
   ──────────────────────────────────────────────────────────────── */

function assertFetchable(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Enter a full absolute URL, for example https://api.example.com/openapi.json'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs can be fetched.');
  // The cloud metadata endpoint is the one address a QA tool must never be
  // pointed at from inside a container.
  if (/^169\.254\.169\.254$|^metadata\.google\.internal$/i.test(u.hostname)) throw new Error('That address is not allowed.');
  return u;
}

export async function fetchRemote(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; contentType: string; text: string; headers: Record<string, string>; durationMs: number }> {
  const u = assertFetchable(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(u, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': 'IntelliQE-API-Automation/1.0', Accept: 'application/json, application/yaml, text/yaml, text/html, text/plain, */*', ...(opts.headers || {}) },
      body: opts.body,
      signal: ctl.signal,
      redirect: 'follow',
    });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); total += value.length; }
        if (total > FETCH_MAX_BYTES) { ctl.abort(); break; }
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, contentType: res.headers.get('content-type') || '', text, headers, durationMs: Date.now() - started };
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(`Timed out fetching ${u.hostname} after ${Math.round((opts.timeoutMs || FETCH_TIMEOUT_MS) / 1000)}s.`);
    throw new Error(`Could not reach ${u.hostname}: ${err?.cause?.code || err?.message || 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Strip an HTML page down to its readable text (docs pages). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/code|\/td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Where APIs conventionally publish their machine-readable description. */
const DISCOVERY_PATHS = [
  '/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger/v1/swagger.json', '/v3/api-docs', '/v2/api-docs',
  '/api-docs', '/api/openapi.json', '/api/swagger.json', '/docs/openapi.json', '/.well-known/openapi.json', '/api/v1/openapi.json',
];

/** Try the well-known OpenAPI locations on an origin; the first hit wins. */
export async function discoverOpenApi(origin: string, headers?: Record<string, string>): Promise<{ url: string; result: ImportResult } | null> {
  const attempts = DISCOVERY_PATHS.map(async (p) => {
    const url = origin.replace(/\/+$/, '') + p;
    try {
      const r = await fetchRemote(url, { headers, timeoutMs: 6000 });
      if (r.status !== 200 || !r.text.trim()) return null;
      const parsed = parseStructured(r.text);
      if (!parsed || !isObj(parsed.doc) || !(parsed.doc.openapi || parsed.doc.swagger)) return null;
      const result = parseOpenApiDocument(parsed.doc, { sourceName: url, baseUrl: undefined });
      result.endpoints = result.endpoints.map((e) => ({ ...e, discovered: true }));
      return { url, result };
    } catch { return null; }
  });
  const results = await Promise.all(attempts);
  return results.find((r) => r !== null) || null;
}

/* ────────────────────────────────────────────────────────────────
   GraphQL introspection
   ──────────────────────────────────────────────────────────────── */

const INTROSPECTION_QUERY = `query IntelliQEIntrospection { __schema { queryType { name } mutationType { name } types { kind name fields(includeDeprecated: false) { name description args { name type { ...TypeRef } defaultValue } type { ...TypeRef } } inputFields { name type { ...TypeRef } } enumValues { name } } } }
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;

function unwrapType(t: any): { name: string; kind: string; list: boolean; nonNull: boolean } {
  let list = false; let nonNull = false; let cur = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) {
    if (cur.kind === 'LIST') list = true;
    if (cur.kind === 'NON_NULL' && !list) nonNull = true;
    cur = cur.ofType;
  }
  return { name: cur?.name || 'String', kind: cur?.kind || 'SCALAR', list, nonNull };
}

export async function introspectGraphql(url: string, headers: Record<string, string> = {}, auth?: { type: string; value?: string }): Promise<ImportResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...headers };
  if (auth?.value && auth.type === 'bearer') h.Authorization = `Bearer ${cleanAuthValue(auth.value)}`;
  if (auth?.value && auth.type === 'basic') h.Authorization = `Basic ${Buffer.from(cleanAuthValue(auth.value)).toString('base64')}`;
  if (auth?.value && auth.type === 'apikey') h['X-API-Key'] = cleanAuthValue(auth.value);
  const r = await fetchRemote(url, { method: 'POST', headers: h, body: JSON.stringify({ query: INTROSPECTION_QUERY }) });
  if (r.status >= 400) throw new Error(`The GraphQL endpoint answered ${r.status} to the introspection query${r.status === 401 || r.status === 403 ? ' — add credentials' : ''}.`);
  let schema: any;
  try { schema = JSON.parse(r.text)?.data?.__schema; } catch { /* handled below */ }
  if (!schema) throw new Error('The endpoint did not return a GraphQL introspection result — introspection may be disabled. Paste the SDL as text instead.');

  const types = new Map<string, any>();
  for (const t of schema.types || []) types.set(t.name, t);
  const scalarSample = (name: string, argName = ''): string => {
    if (name === 'Int') return '1';
    if (name === 'Float') return '1.5';
    if (name === 'Boolean') return 'true';
    if (name === 'ID') return '"1"';
    const t = types.get(name);
    if (t?.kind === 'ENUM' && t.enumValues?.length) return t.enumValues[0].name;
    if (t?.kind === 'INPUT_OBJECT') {
      const fields = (t.inputFields || []).slice(0, 8).map((f: any) => `${f.name}: ${argSample(f.type, f.name, 1)}`);
      return `{ ${fields.join(', ')} }`;
    }
    return JSON.stringify(exampleForParam(argName));
  };
  const argSample = (type: any, name: string, depth: number): string => {
    const u = unwrapType(type);
    if (depth > 3) return 'null';
    const v = u.kind === 'INPUT_OBJECT' || u.kind === 'ENUM' || u.kind === 'SCALAR' ? scalarSample(u.name, name) : 'null';
    return u.list ? `[${v}]` : v;
  };
  const selection = (typeRef: any, depth: number): string => {
    const u = unwrapType(typeRef);
    const t = types.get(u.name);
    if (!t || (t.kind !== 'OBJECT' && t.kind !== 'INTERFACE')) return '';
    const fields: any[] = t.fields || [];
    const scalars = fields.filter((f) => { const fu = unwrapType(f.type); return ['SCALAR', 'ENUM'].includes(types.get(fu.name)?.kind || fu.kind) && !f.args?.length; }).slice(0, 8);
    const objects = depth < 2 ? fields.filter((f) => { const fu = unwrapType(f.type); return types.get(fu.name)?.kind === 'OBJECT' && !f.args?.length; }).slice(0, 2) : [];
    const parts = [...scalars.map((f) => f.name), ...objects.map((f) => { const inner = selection(f.type, depth + 1); return inner ? `${f.name} ${inner}` : ''; }).filter(Boolean)];
    return parts.length ? `{ ${parts.join(' ')} }` : '{ __typename }';
  };

  const endpoints: ImportedEndpoint[] = [];
  const source: ImportedEndpoint['source'] = { method: 'graphql', name: url };
  const build = (rootName: string | undefined, op: 'query' | 'mutation') => {
    if (!rootName) return;
    const root = types.get(rootName);
    for (const f of root?.fields || []) {
      if (endpoints.length >= MAX_BULK_ENDPOINTS) return;
      const args = (f.args || []).filter((a: any) => unwrapType(a.type).nonNull || a.defaultValue === null || a.defaultValue === undefined).slice(0, 6);
      const argStr = (f.args || []).length ? `(${(f.args || []).slice(0, 6).map((a: any) => `${a.name}: ${argSample(a.type, a.name, 0)}`).join(', ')})` : '';
      void args;
      const query = `${op} { ${f.name}${argStr} ${selection(f.type, 0)} }`;
      const ep = finalizeEndpoint({
        title: `${op === 'query' ? 'QUERY' : 'MUTATION'} ${f.name}`,
        method: 'POST',
        url,
        headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Accept', value: 'application/json' }, ...Object.entries(headers).map(([key, value]) => ({ key, value }))],
        auth: { type: normaliseAuthType(auth?.type || 'none'), value: auth?.value },
        body: JSON.stringify({ query, variables: {} }, null, 2),
        expectedStatus: 200,
        description: f.description || `GraphQL ${op} "${f.name}" — expects a data.${f.name} payload with no errors.`,
        resource: op === 'query' ? 'queries' : 'mutations',
        tags: [op],
        style: 'graphql',
        operationId: f.name,
      }, source);
      if (ep) endpoints.push(ep);
    }
  };
  build(schema.queryType?.name, 'query');
  build(schema.mutationType?.name, 'mutation');
  return { endpoints, parser: 'graphql', format: 'GraphQL (introspected)', warnings: [], notice: `${endpoints.length} operation${endpoints.length === 1 ? '' : 's'} discovered by introspecting ${url}.` };
}

/* ────────────────────────────────────────────────────────────────
   MCP servers (Streamable HTTP, JSON-RPC 2.0)
   ──────────────────────────────────────────────────────────────── */

function parseJsonRpcResponse(text: string, contentType: string): any {
  if (/text\/event-stream/i.test(contentType)) {
    // Take the last JSON-RPC message in the stream.
    let last: any = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m && (m.result || m.error)) last = m; } catch { /* skip */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export async function discoverMcpTools(url: string, headers: Record<string, string> = {}, auth?: { type: string; value?: string }): Promise<ImportResult> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (auth?.value && auth.type === 'bearer') h.Authorization = `Bearer ${cleanAuthValue(auth.value)}`;
  if (auth?.value && auth.type === 'apikey') h['X-API-Key'] = cleanAuthValue(auth.value);
  const init = await fetchRemote(url, {
    method: 'POST', headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'IntelliQE API Automation', version: '1.0' } } }),
  });
  if (init.status >= 400) throw new Error(`The MCP server answered ${init.status} to initialize${init.status === 401 ? ' — add credentials' : ''}.`);
  const initMsg = parseJsonRpcResponse(init.text, init.contentType);
  if (!initMsg?.result) throw new Error('The server did not answer the MCP initialize request with a JSON-RPC result — check that this is a Streamable HTTP MCP endpoint.');
  const session = init.headers['mcp-session-id'];
  if (session) h['Mcp-Session-Id'] = session;
  await fetchRemote(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => undefined);
  const list = await fetchRemote(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const listMsg = parseJsonRpcResponse(list.text, list.contentType);
  const tools: any[] = Array.isArray(listMsg?.result?.tools) ? listMsg.result.tools : [];

  const resolve = (n: any) => n;
  const endpoints: ImportedEndpoint[] = [];
  const source: ImportedEndpoint['source'] = { method: 'mcp', name: url };
  const baseHeaders = [{ key: 'Content-Type', value: 'application/json' }, { key: 'Accept', value: 'application/json, text/event-stream' }, ...Object.entries(headers).map(([key, value]) => ({ key, value }))];
  const authNorm = { type: normaliseAuthType(auth?.type || 'none'), value: auth?.value };
  const serverName = String(initMsg.result?.serverInfo?.name || 'MCP server');
  endpoints.push(finalizeEndpoint({
    title: 'MCP initialize handshake', method: 'POST', url, headers: baseHeaders, auth: authNorm,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'IntelliQE', version: '1.0' } } }, null, 2),
    expectedStatus: init.status, expectedResponse: str(initMsg).slice(0, 4000), resource: 'mcp-protocol', tags: ['protocol'], style: 'mcp',
    description: `Protocol handshake with ${serverName}.`,
  }, source)!);
  endpoints.push(finalizeEndpoint({
    title: 'MCP tools/list', method: 'POST', url, headers: baseHeaders, auth: authNorm,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, null, 2),
    expectedStatus: list.status, expectedResponse: str({ jsonrpc: '2.0', id: 2, result: { tools: tools.slice(0, 3).map((t) => ({ name: t.name })) } }), resource: 'mcp-protocol', tags: ['protocol'], style: 'mcp',
    description: `Lists the ${tools.length} tool${tools.length === 1 ? '' : 's'} the server exposes.`,
  }, source)!);
  for (const t of tools) {
    if (endpoints.length >= MAX_BULK_ENDPOINTS) break;
    const args = sampleFromSchema(t.inputSchema || { type: 'object' }, resolve) ?? {};
    const ep = finalizeEndpoint({
      title: `MCP tool · ${t.name}`,
      method: 'POST', url, headers: baseHeaders, auth: authNorm,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: t.name, arguments: args } }, null, 2),
      expectedStatus: 200,
      description: t.description || `Invoke the "${t.name}" tool and expect a JSON-RPC result with content and isError=false.`,
      resource: 'mcp-tools', tags: ['tool'], style: 'mcp', operationId: t.name,
    }, source);
    if (ep) endpoints.push(ep);
  }
  return { endpoints, parser: 'mcp', format: `MCP · ${serverName}`, warnings: tools.length ? [] : ['The server exposes no tools — only the protocol endpoints were imported.'], notice: `${tools.length} tool${tools.length === 1 ? '' : 's'} discovered on ${serverName}.` };
}

/* ────────────────────────────────────────────────────────────────
   Live probe — "API URL / Endpoint"
   ──────────────────────────────────────────────────────────────── */

export interface ProbeInput {
  url: string;
  method?: string;
  headers?: { key: string; value: string }[];
  auth?: { type: string; value?: string; headerName?: string };
  body?: string;
  /** Also look for an OpenAPI document on the origin and import everything it describes. */
  discover?: boolean;
}

export async function probeEndpoint(input: ProbeInput): Promise<ImportResult & { observed?: { status: number; durationMs: number; contentType: string } }> {
  const method = String(input.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const h of input.headers || []) if (h?.key?.trim()) headers[h.key.trim()] = String(h.value ?? '');
  const a = input.auth;
  const av = cleanAuthValue(a?.value || '');
  if (a && av && !isPlaceholderSecret(av)) {
    if (a.type === 'bearer') headers.Authorization = `Bearer ${av}`;
    else if (a.type === 'basic') headers.Authorization = `Basic ${Buffer.from(av).toString('base64')}`;
    else if (a.type === 'apikey') headers[a.headerName || 'X-API-Key'] = av;
  }
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !!input.body?.trim();
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';

  const warnings: string[] = [];
  const r = await fetchRemote(input.url, { method, headers, body: hasBody ? input.body : undefined });
  const isJson = /json/i.test(r.contentType);
  const okStatus = r.status >= 200 && r.status < 300;
  if (!okStatus) warnings.push(`The endpoint answered ${r.status} to the probe${r.status === 401 || r.status === 403 ? ' — add the credential and re-import to capture the real response' : ''}. The observed status was recorded as the expected one; adjust it if that is not the contract.`);
  const probed = finalizeEndpoint({
    title: `${method} ${(() => { try { return new URL(input.url).pathname; } catch { return input.url; } })()}`,
    method,
    url: input.url,
    headers: (input.headers || []).filter((h) => h?.key?.trim() && !/^(authorization|x-api-key)$/i.test(h.key)),
    auth: { type: normaliseAuthType(a?.type || 'none'), value: a?.value, headerName: a?.headerName } as any,
    body: hasBody ? input.body : undefined,
    expectedStatus: r.status,
    expectedResponse: isJson && r.text.trim() ? r.text.slice(0, 20000) : undefined,
    style: /graphql/i.test(input.url) ? 'graphql' : 'rest',
  }, { method: 'endpoint', name: input.url });
  const endpoints: ImportedEndpoint[] = probed ? [probed] : [];
  let notice = `Probed ${method} ${input.url} → ${r.status} in ${r.durationMs} ms${isJson ? ' (JSON body captured as the expected response)' : ''}.`;
  let parser: ParserId = 'probe';
  if (input.discover !== false) {
    let origin = '';
    try { origin = new URL(input.url).origin; } catch { /* validated above */ }
    const found = origin ? await discoverOpenApi(origin, headers.Authorization ? { Authorization: headers.Authorization } : undefined) : null;
    if (found) {
      const existing = new Set(endpoints.map((e) => `${e.method} ${e.url}`.toLowerCase()));
      for (const e of found.result.endpoints) if (!existing.has(`${e.method} ${e.url}`.toLowerCase())) endpoints.push(e);
      notice += ` An OpenAPI document was discovered at ${found.url} — ${found.result.endpoints.length} more endpoint${found.result.endpoints.length === 1 ? '' : 's'} imported from it.`;
      warnings.push(...found.result.warnings);
      parser = 'openapi';
    }
  }
  return { endpoints, parser, format: 'Live endpoint', warnings, notice, observed: { status: r.status, durationMs: r.durationMs, contentType: r.contentType } };
}

/* ────────────────────────────────────────────────────────────────
   Orchestration — text in, endpoints out
   ──────────────────────────────────────────────────────────────── */

export interface TextImportOptions {
  fileName?: string;
  /** Hint from the user: openapi | postman | curl | connector | sdk | middleware | docs | wsdl | auto. */
  formatHint?: string;
  llm?: LlmConfig;
  /** Substitutes {{var}} in Postman collections. */
  variables?: Record<string, string>;
  /** Overrides the document's own server for OpenAPI. */
  baseUrl?: string;
  sourceMethod?: ImportMethod;
}

/**
 * Turn any text — a spec, a collection, cURL, a manifest, or prose — into
 * endpoints. Deterministic when the format allows it, LLM otherwise.
 */
export async function importFromText(text: string, opts: TextImportOptions = {}): Promise<ImportResult> {
  const name = opts.fileName || 'pasted text';
  const hint = (opts.formatHint || 'auto').toLowerCase();
  const sniffed = sniffFormat(text, name);
  const structured = ['openapi', 'postman', 'har', 'connector', 'json', 'yaml'].includes(sniffed) ? parseStructured(text) : null;

  let result: ImportResult | null = null;
  if ((sniffed === 'openapi' || hint === 'openapi') && structured && isObj(structured.doc) && (structured.doc.openapi || structured.doc.swagger)) {
    result = parseOpenApiDocument(structured.doc, { baseUrl: opts.baseUrl, sourceName: name });
    result.format += structured.kind === 'yaml' ? ' (YAML)' : ' (JSON)';
  } else if ((sniffed === 'postman' || hint === 'postman') && structured && isObj(structured.doc) && structured.doc.info) {
    result = parsePostmanCollection(structured.doc, { variables: opts.variables, sourceName: name });
  } else if (sniffed === 'har' && structured) {
    result = parseHar(structured.doc, name);
  } else if (sniffed === 'connector' || hint === 'connector') {
    if (structured) result = parseConnectorManifest(structured.doc, name);
  } else if (sniffed === 'curl' || hint === 'curl') {
    result = parseCurlCommands(text, name);
  } else if (sniffed === 'bruno' || hint === 'bruno') {
    result = parseBruno(text, name);
  }

  if (result && result.endpoints.length) {
    if (opts.sourceMethod) result.endpoints = result.endpoints.map((e) => ({ ...e, source: { method: opts.sourceMethod!, name: e.source?.name || name } }));
    return result;
  }

  // Everything else — prose, code, WSDL, spreadsheets, or a structured file the
  // deterministic parsers could not make sense of — is understood by the model.
  if (!opts.llm) {
    throw new Error(result?.warnings?.[0] || 'This content is not a machine-readable API description, and no LLM is configured to interpret it. Add an Anthropic API key under System Configuration → LLM Configuration.');
  }
  const llmHint = hint !== 'auto' ? hint : sniffed === 'wsdl' ? 'xml' : sniffed === 'graphql-sdl' ? 'graphql' : undefined;
  const llmEndpoints = await parseApiEndpointsFromText(text, name, opts.llm, llmHint);
  const style: ApiStyle = sniffed === 'wsdl' ? 'soap' : sniffed === 'graphql-sdl' ? 'graphql' : 'rest';
  const endpoints = llmEndpoints
    .map((e) => finalizeEndpoint({ ...e, style, source: { method: opts.sourceMethod || 'file', name } }))
    .filter((e): e is ImportedEndpoint => e !== null);
  return {
    endpoints: dedupeEndpoints(endpoints),
    parser: 'llm',
    format: sniffed === 'wsdl' ? 'WSDL / SOAP' : sniffed === 'graphql-sdl' ? 'GraphQL SDL' : hint !== 'auto' ? hint.toUpperCase() : 'Document (AI-read)',
    warnings: result?.warnings || [],
    notice: `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} understood from ${name} by the AI reader.`,
  };
}

/**
 * Fetch a URL and import whatever it serves: an OpenAPI/Postman document, a
 * GraphQL endpoint, or an HTML documentation page.
 */
export async function importFromUrl(url: string, opts: TextImportOptions & { headers?: Record<string, string> } = {}): Promise<ImportResult> {
  const r = await fetchRemote(url, { headers: opts.headers });
  if (r.status >= 400) throw new Error(`${url} answered ${r.status}${r.status === 401 || r.status === 403 ? ' — the document needs credentials' : ''}.`);
  const isHtml = /text\/html/i.test(r.contentType) || /^\s*<!doctype html|^\s*<html/i.test(r.text);
  if (!isHtml) {
    const res = await importFromText(r.text, { ...opts, fileName: url, sourceMethod: opts.sourceMethod || 'openapi' });
    return res;
  }
  // A docs page — first follow any spec link it advertises, then read the prose.
  const linkRe = /(?:href|src)=["']([^"']*(?:openapi|swagger|api-docs)[^"']*\.(?:json|ya?ml)|[^"']*\/(?:v[23]\/api-docs|openapi\.json|swagger\.json))["']/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(r.text)) !== null && seen.size < 4) {
    let abs = m[1]!;
    try { abs = new URL(abs, url).toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const sub = await fetchRemote(abs, { headers: opts.headers, timeoutMs: 8000 });
      if (sub.status === 200) {
        const parsed = parseStructured(sub.text);
        if (parsed && isObj(parsed.doc) && (parsed.doc.openapi || parsed.doc.swagger)) {
          const res = parseOpenApiDocument(parsed.doc, { sourceName: abs, baseUrl: opts.baseUrl });
          res.notice = `Found the OpenAPI document linked from the docs page (${abs}). ${res.notice || ''}`.trim();
          res.endpoints = res.endpoints.map((e) => ({ ...e, source: { method: 'docs-url', name: url } }));
          return res;
        }
      }
    } catch { /* try the next link */ }
  }
  const text = htmlToText(r.text);
  if (text.length < 80) throw new Error('The page had almost no readable text — if the docs are rendered by JavaScript, paste the API reference text or the spec file instead.');
  return importFromText(text, { ...opts, fileName: url, formatHint: opts.formatHint || 'docs', sourceMethod: 'docs-url' });
}
