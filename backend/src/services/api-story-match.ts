/**
 * api-story-match.ts
 * ──────────────────
 * Pure, dependency-free endpoint-matching helpers for the story agent.
 *
 * Extracted from api-story-gen.service.ts so they can be unit-tested in
 * isolation: the service itself transitively pulls in the LLM runner and the
 * Jira / Azure DevOps / TM connectors (and the DB pool below them), none of
 * which these functions need. The bodies are unchanged — only their home moved.
 *
 * The job: the LLM is handed a short, stable id per catalogue endpoint (`e1`,
 * `e2`, …) and told to answer with ids. These helpers resolve whatever the
 * model actually returns — an id, a bare `GET /posts`, an absolute URL, or a
 * path — back to the catalogue id(s) it means, method-aware, so the same path
 * exposed as both a GET and a POST stays two distinct endpoints.
 */

/**
 * Canonical path for matching: drop scheme+host and query, and collapse every
 * concrete or templated id segment to `{}`. So `/posts/1`, `/posts/{id}` and
 * `https://api/posts/42?x=1` all land on `/posts/{}` — a story's bare path and
 * the catalogue's absolute, concretised URL compare equal.
 */
export function normPath(u: string): string {
  let s = String(u || '').trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''); // strip scheme://host
  s = s.replace(/[?#].*$/, '');                        // strip query / fragment
  if (!s.startsWith('/')) s = '/' + s;
  const segs = s.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\{.*\}$/.test(seg) || /^:/.test(seg)) return '{}';                 // {id} or :id
    if (/^\d+$/.test(seg)) return '{}';                                      // 42
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{}'; // uuid
    if (/^[0-9a-f]{16,}$/i.test(seg)) return '{}';                           // long hex id
    return seg.toLowerCase();
  });
  const out = segs.join('/').replace(/\/+$/, '');
  return out || '/';
}

/** The match key for an endpoint: method + canonical path, so method matters. */
export function endpointKey(method: string | undefined, url: string): string {
  return `${(method || 'GET').toUpperCase()} ${normPath(url)}`;
}

/**
 * Resolve whatever token the model returned for an endpoint — ideally the `eN`
 * id we handed it, but also a bare `GET /posts`, an absolute URL, or a path — to
 * the catalogue endpoint id(s) it means. Returns [] when nothing matches, so a
 * mapped endpoint is always one the user actually has.
 *
 * `idToEp` is only probed with `.has()`, so it is typed structurally — the
 * caller's `Map<string, StoryEndpoint>` satisfies it without this module having
 * to know the endpoint shape.
 */
export function resolveRefs(
  raw: unknown,
  idToEp: { has(key: string): boolean },
  keyToId: Map<string, string>,
  pathToIds: Map<string, string[]>,
): string[] {
  const tokens = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const tok of tokens) {
    const t = String(tok || '').trim();
    if (!t) continue;
    if (idToEp.has(t)) { out.push(t); continue; }                           // exact id
    const idm = t.match(/\be(\d{1,3})\b/i);                                 // "[e2]" / "e2"
    if (idm && idToEp.has(`e${idm[1]}`)) { out.push(`e${idm[1]}`); continue; }
    const mm = t.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i); // "POST /posts"
    if (mm) {
      const id = keyToId.get(`${mm[1].toUpperCase()} ${normPath(mm[2])}`);
      if (id) { out.push(id); continue; }
    }
    const byPath = pathToIds.get(normPath(t));                               // path only — all methods
    if (byPath) out.push(...byPath);
  }
  return [...new Set(out)].slice(0, 8);
}
