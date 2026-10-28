/**
 * postman-import.ts
 * ─────────────────
 * Convert a Postman Collection (v2.0 / v2.1) into runnable flow steps — the
 * inverse of postman.ts (export). Purpose-built for the flow builder rather than
 * reusing the catalogue importer, because a flow needs behaviour the catalogue
 * importer deliberately does NOT provide:
 *   - ORDER preserved and NO de-duplication (a flow may hit the same URL twice).
 *   - `{{var}}` templates kept VERBATIM (the flow engine resolves them at run
 *     time from seed variables) — not substituted or dropped as placeholders.
 *   - request-level `request.auth` honoured, inheriting folder/collection auth.
 *
 * Pure and dependency-free. Collection variables are returned as suggested seed
 * variables so `{{baseUrl}}`-style tokens resolve once the user fills them.
 */
import type { FlowStep } from '../services/api-flow.service.js';

type Auth = { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
interface PmResult { steps: FlowStep[]; variables: Record<string, string>; warnings: string[] }

const MAX_STEPS = 60;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Postman auth array → a flat {key: value} map. */
function kv(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(list)) for (const p of list) if (isObj(p) && p.key) out[String(p.key)] = String(p.value ?? '');
  return out;
}

/** A Postman auth block → our flow auth shape (templates kept verbatim). */
function toAuth(a: unknown): Auth {
  if (!isObj(a)) return { type: 'none' };
  const t = String(a.type || '').toLowerCase();
  if (t === 'bearer') return { type: 'bearer', value: kv(a.bearer).token };
  if (t === 'basic') { const b = kv(a.basic); return { type: 'basic', value: b.username ? `${b.username}:${b.password ?? ''}` : undefined }; }
  if (t === 'apikey') { const k = kv(a.apikey); return { type: 'apikey', value: k.value, headerName: k.in === 'query' ? undefined : (k.key || 'X-API-Key') }; }
  if (t === 'oauth2' || t === 'jwt') return { type: 'bearer', value: kv(a.oauth2 || a.jwt).accessToken };
  if (t === 'noauth') return { type: 'none' };
  return { type: 'none' };
}

/** Resolve a request's URL to its raw string (prefer `.raw` so {{vars}} survive). */
function urlOf(u: unknown): string {
  if (typeof u === 'string') return u;
  if (!isObj(u)) return '';
  if (u.raw) return String(u.raw);
  const host = Array.isArray(u.host) ? u.host.join('.') : String(u.host || '');
  const path = Array.isArray(u.path) ? u.path.join('/') : String(u.path || '');
  const proto = u.protocol ? `${u.protocol}://` : '';
  const query = Array.isArray(u.query)
    ? u.query.filter((q: any) => isObj(q) && !q.disabled && q.key).map((q: any) => `${q.key}=${q.value ?? ''}`).join('&')
    : '';
  return `${proto}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
}

/** A request's body → a flow body string + any implied Content-Type header. */
function bodyOf(b: unknown, warnings: string[], name: string): { body?: string; header?: { key: string; value: string } } {
  if (!isObj(b)) return {};
  const mode = String(b.mode || 'raw');
  if (mode === 'raw' && b.raw) return { body: String(b.raw) };
  if (mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
    const body = b.urlencoded.filter((p: any) => isObj(p) && !p.disabled && p.key).map((p: any) => `${p.key}=${p.value ?? ''}`).join('&');
    return { body, header: { key: 'Content-Type', value: 'application/x-www-form-urlencoded' } };
  }
  if (mode === 'graphql' && isObj(b.graphql)) {
    return { body: JSON.stringify({ query: b.graphql.query || '', variables: typeof b.graphql.variables === 'string' ? b.graphql.variables : (b.graphql.variables ?? {}) }, null, 2), header: { key: 'Content-Type', value: 'application/json' } };
  }
  if (mode === 'formdata') warnings.push(`"${name}": form-data body imported as-is may need manual review.`);
  if (mode === 'file') warnings.push(`"${name}": file-upload body is not supported — step imported without a body.`);
  return {};
}

export function postmanToFlow(doc: unknown): PmResult {
  const warnings: string[] = [];
  const steps: FlowStep[] = [];
  const variables: Record<string, string> = {};
  if (!isObj(doc)) return { steps, variables, warnings: ['Not a Postman collection.'] };
  if (Array.isArray(doc.variable)) for (const v of doc.variable) if (isObj(v) && v.key) variables[String(v.key)] = String(v.value ?? '');

  const collectionAuth = toAuth(doc.auth);

  const walk = (items: unknown, inherited: Auth, depth: number): void => {
    if (!Array.isArray(items) || depth > 8) return;
    for (const it of items) {
      if (steps.length >= MAX_STEPS) { if (!warnings.includes('Too many requests — import stopped at 60 steps.')) warnings.push('Too many requests — import stopped at 60 steps.'); return; }
      if (!isObj(it)) continue;
      const itemAuth = it.auth ? toAuth(it.auth) : inherited;
      if (Array.isArray(it.item)) { walk(it.item, itemAuth, depth + 1); continue; }
      const req = isObj(it.request) ? it.request : (typeof it.request === 'string' ? { url: it.request, method: 'GET' } : null);
      if (!req) continue;

      const method = String(req.method || 'GET').toUpperCase();
      const url = urlOf(req.url);
      if (!url) { warnings.push(`"${String(it.name || 'request')}": skipped (no URL).`); continue; }

      // request.auth wins; else inherited folder/collection auth.
      const auth = req.auth ? toAuth(req.auth) : itemAuth;

      const headers: { key: string; value: string }[] = [];
      if (Array.isArray(req.header)) {
        for (const h of req.header) {
          if (!isObj(h) || h.disabled || !h.key) continue;
          // Drop an Authorization header when structured auth already covers it.
          if (/^authorization$/i.test(String(h.key)) && auth.type !== 'none') continue;
          headers.push({ key: String(h.key), value: String(h.value ?? '') });
        }
      }

      const { body, header } = bodyOf(req.body, warnings, String(it.name || method));
      if (header && !headers.some((h) => h.key.toLowerCase() === header.key.toLowerCase())) headers.push(header);

      const step: FlowStep = { name: String(it.name || `${method} ${url}`).slice(0, 80), method, url, headers };
      if (auth.type !== 'none' && (auth.value || auth.type === 'apikey')) step.auth = auth as FlowStep['auth'];
      if (body && method !== 'GET' && method !== 'HEAD') step.body = body;
      steps.push(step);
    }
  };
  walk(doc.item, collectionAuth, 0);

  if (!steps.length) warnings.unshift('No requests found in the collection.');
  return { steps, variables, warnings };
}
