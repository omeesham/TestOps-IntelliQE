/**
 * seed.ts — a DETERMINISTIC, offline stand-in for the AI generator.
 *
 * The real generator (generator.ts) calls the model. When no model credentials
 * are present, offlineGenerate() produces a representative suite the SAME SHAPE
 * the model returns, derived from the spec with simple heuristics — so the full
 * render → execute → report loop is demonstrable end to end WITHOUT a key.
 *
 * This is NOT the invariant's AI half — it is a labelled heuristic so the
 * deterministic half can be shown live. It never authors code either.
 */
import type { ApiSpec, NormalizedCase, ApiCheck, CaseCategory } from './types';

let counter = 0;
function id(): string {
  return `TC-${String(++counter).padStart(3, '0')}`;
}
export function resetSeedIds(): void {
  counter = 0;
}

/** Replace the last numeric path segment with an id that cannot exist (for a 404 case). */
function unknownResourceUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/');
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(segs[i]!)) {
        segs[i] = '99999999';
        u.pathname = segs.join('/');
        return u.toString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function headersWithAuth(spec: ApiSpec, includeAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of spec.headers || []) if (h.key?.trim()) headers[h.key.trim()] = String(h.value ?? '');
  if (includeAuth && spec.auth && spec.auth.type !== 'none' && spec.auth.value?.trim()) {
    const v = spec.auth.value.trim();
    if (spec.auth.type === 'bearer') headers['Authorization'] = `Bearer ${v}`;
    else if (spec.auth.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(v).toString('base64')}`;
    else if (spec.auth.type === 'apikey') headers[spec.auth.headerName?.trim() || 'X-API-Key'] = v;
  }
  return headers;
}

function mkCase(
  spec: ApiSpec,
  opts: { title: string; category: CaseCategory; url?: string; checks: ApiCheck[]; includeAuth?: boolean },
): NormalizedCase {
  return {
    id: id(),
    title: opts.title,
    feature: 'API',
    category: opts.category,
    method: spec.method.toUpperCase(),
    url: opts.url || spec.url,
    headers: headersWithAuth(spec, opts.includeAuth !== false),
    checks: opts.checks,
  };
}

/**
 * A deterministic suite for one spec: happy path, schema (if a sample body is
 * given), a 404 negative (if the path has a numeric id), collection-not-empty
 * (if the path looks like a list), and an auth negative (if auth is configured).
 */
export function offlineGenerate(spec: ApiSpec): NormalizedCase[] {
  const method = spec.method.toUpperCase();
  const cases: NormalizedCase[] = [];
  const expected = spec.expectedStatus ?? (method === 'POST' ? 201 : 200);

  let path = '';
  try {
    path = new URL(spec.url).pathname;
  } catch {
    /* ignore */
  }

  // Happy path.
  cases.push(
    mkCase(spec, {
      title: `Verify ${method} ${path || spec.url} returns ${expected} with a JSON response`,
      category: 'positive',
      checks: [
        { kind: 'status', equals: expected },
        { kind: 'header', name: 'content-type', contains: 'json' },
        { kind: 'responseTimeUnderMs', ms: 5000 },
      ],
    }),
  );

  // Schema — if the user pasted a sample body, assert its top-level keys exist.
  if (spec.expectedResponse?.trim()) {
    try {
      const sample = JSON.parse(spec.expectedResponse);
      if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const checks: ApiCheck[] = Object.keys(sample)
          .slice(0, 6)
          .map((k) => ({ kind: 'jsonProperty', path: k, exists: true }));
        if (checks.length)
          cases.push(
            mkCase(spec, {
              title: `Confirm ${method} ${path} returns the documented fields (${Object.keys(sample).slice(0, 6).join(', ')})`,
              category: 'schema',
              checks,
            }),
          );
      }
    } catch {
      /* non-JSON sample — skip schema */
    }
  }

  // Collection — if the path looks like a list and the method is GET.
  if (method === 'GET' && /s$/.test(path.replace(/\/$/, '').split('/').pop() || '')) {
    cases.push(
      mkCase(spec, {
        title: `Confirm ${method} ${path} returns a non-empty JSON array`,
        category: 'positive',
        checks: [
          { kind: 'status', equals: 200 },
          { kind: 'jsonArrayNotEmpty', path: '' },
        ],
      }),
    );
  }

  // Negative — unknown resource.
  const unknown = unknownResourceUrl(spec.url);
  if (unknown && method === 'GET') {
    cases.push(
      mkCase(spec, {
        title: `Return 404 for ${method} on a resource id that cannot exist`,
        category: 'negative',
        url: unknown,
        checks: [{ kind: 'status', equals: 404 }],
      }),
    );
  }

  // Auth negative — when auth is configured, dropping it must be rejected.
  if (spec.auth && spec.auth.type !== 'none' && spec.auth.value?.trim()) {
    cases.push(
      mkCase(spec, {
        title: `Return 401/403 for ${method} ${path || spec.url} when no credential is supplied`,
        category: 'auth',
        includeAuth: false,
        checks: [{ kind: 'status', oneOf: [401, 403] }],
      }),
    );
  }

  return cases;
}
