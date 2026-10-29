/**
 * apiValidation.ts
 * ────────────────
 * Deterministic readiness checks for the endpoints that enter the automation
 * pipeline. Nothing here calls a model: it is rule-based so it runs instantly
 * and gives the same verdict every time.
 *
 * Two gates share this one validator:
 *   - Import gate      — run over everything a document produced, so a file that
 *                        is not really an API spec (or whose endpoints can't be
 *                        automated) is flagged before it pollutes the catalogue.
 *   - Generation gate  — re-run over the *selected* endpoints the moment the user
 *                        starts test generation, resolved against the active
 *                        environment, so a run never kicks off on endpoints that
 *                        aren't ready.
 *
 * Policy is "warn, don't block": `ok` is true as long as there are no hard
 * errors; warnings are surfaced but the user may always proceed anyway.
 */
import type { ApiEnvironment } from './types';

export type ValidationLevel = 'error' | 'warning' | 'info';

/**
 * The structural subset both a catalogue endpoint and a freshly-parsed import
 * endpoint satisfy — so one validator serves both gates without coupling to the
 * full CatalogEndpoint shape.
 */
export interface ValidatableEndpoint {
  id?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: string; value?: string; oauth2?: unknown };
  body?: string;
}

export interface ValidationIssue {
  level: ValidationLevel;
  /** Stable machine code for the check that fired. */
  code: string;
  message: string;
  /** Set when the issue is tied to one endpoint. */
  endpointId?: string;
  endpointLabel?: string;
}

export interface ApiValidationReport {
  /** True when there are no hard errors (warnings are allowed through). */
  ok: boolean;
  /** Endpoints examined. */
  total: number;
  /** Endpoints with no error and no warning. */
  ready: number;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Mirrors the backend importer's PLACEHOLDER_HOST (api-import.service.ts). */
const PLACEHOLDER_HOSTS = new Set(['api.example.com']);
const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

const isAbsolute = (url: string): boolean => /^https?:\/\//i.test(url.trim());

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function envValues(env?: ApiEnvironment | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (env?.variables) for (const v of env.variables) if (v.key) map[v.key] = v.value ?? '';
  return map;
}

/** The `{{var}}` tokens in `text` that the environment can't fill. */
function unresolvedVars(text: string, vals: Record<string, string>): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text))) {
    const key = (m[1] || '').trim();
    if (key && (!(key in vals) || vals[key] === '')) out.add(key);
  }
  return [...out];
}

/**
 * Validate a set of endpoints for automation readiness.
 *
 * @param endpoints the endpoints to check (a document's output, or the selection)
 * @param env       the active environment, used to resolve `{{vars}}` and the base URL
 */
export function validateApiEndpoints(
  endpoints: ValidatableEndpoint[],
  env?: ApiEnvironment | null,
): ApiValidationReport {
  const issues: ValidationIssue[] = [];
  const total = endpoints.length;
  const vals = envValues(env);
  const hasEnvBaseUrl = !!env?.baseUrl && isAbsolute(env.baseUrl);

  // Document-level: an API doc that yielded nothing is the headline failure.
  if (total === 0) {
    issues.push({
      level: 'error',
      code: 'no-endpoints',
      message: 'No API endpoints were found — this document does not look like an API specification.',
    });
    return { ok: false, total: 0, ready: 0, errorCount: 1, warningCount: 0, issues };
  }

  let ready = 0;
  for (const ep of endpoints) {
    const label = `${ep.method} ${ep.url}`;
    const before = issues.length;
    const add = (level: ValidationLevel, code: string, message: string) =>
      issues.push({ level, code, message, endpointId: ep.id, endpointLabel: label });

    // Method must be a real HTTP verb.
    if (!HTTP_METHODS.has(String(ep.method || '').toUpperCase())) {
      add('warning', 'bad-method', `Unusual HTTP method "${ep.method || '(none)'}".`);
    }

    // URL must be an absolute, callable address.
    const url = String(ep.url || '').trim();
    if (!url) {
      add('error', 'no-url', 'Endpoint has no URL.');
    } else if (!isAbsolute(url)) {
      add('error', 'relative-url', `URL is not absolute (needs http/https): ${url}`);
    } else if (PLACEHOLDER_HOSTS.has(hostOf(url)) && !hasEnvBaseUrl) {
      add('warning', 'placeholder-host', 'Uses a placeholder host — select an environment with a base URL before running.');
    }

    // Unresolved {{variables}} across URL, headers and body.
    const texts = [url, ...(ep.headers || []).flatMap((h) => [h.key, h.value]), ep.body || ''];
    const missing = [...new Set(texts.flatMap((t) => unresolvedVars(String(t || ''), vals)))];
    if (missing.length) {
      add('warning', 'unresolved-vars',
        `Unresolved variable${missing.length > 1 ? 's' : ''}: ${missing.map((v) => `{{${v}}}`).join(', ')} — define ${missing.length > 1 ? 'them' : 'it'} in the environment.`);
    }

    // Declared auth with nothing behind it won't authenticate at run time.
    if (ep.auth && ep.auth.type !== 'none') {
      const hasValue = !!(ep.auth.value && ep.auth.value.trim()) || !!ep.auth.oauth2;
      if (!hasValue && ep.auth.type !== 'oauth2') {
        add('warning', 'auth-missing', `Auth is "${ep.auth.type}" but no token/secret is set.`);
      }
    }

    if (issues.length === before) ready++;
  }

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;
  return { ok: errorCount === 0, total, ready, errorCount, warningCount, issues };
}
