/**
 * catalogReconcile — the pure re-import reconciliation for the endpoint catalogue
 * (IQE-047.1 #4/#7). No React: given the current catalogue and a freshly imported
 * set, it computes the next catalogue plus what was added / changed / removed, so
 * a re-import updates changed endpoints in place (never duplicating them) and, for
 * a full-snapshot source, drops endpoints the spec no longer contains.
 */
import type { CatalogEndpoint } from '../types';

/** Identity key for matching an endpoint across imports (method + URL). */
export function endpointKey(e: { method: string; url: string }): string {
  return `${e.method} ${e.url}`.toLowerCase();
}

/**
 * Content signature of an endpoint's contract — everything a re-import could
 * change, EXCLUDING volatile/identity fields (id, importedAt, source, title)
 * and the auth SECRET value (so a locally-entered credential never counts as a
 * spec change and is preserved across re-imports).
 */
export function endpointSig(e: CatalogEndpoint): string {
  const headers = [...(e.headers || [])].map((h) => `${h.key.toLowerCase()}:${h.value}`).sort().join('|');
  const a = e.auth || { type: 'none' };
  return JSON.stringify([
    e.method, e.url, headers,
    a.type, a.headerName || '', a.in || '',
    e.body || '', e.bodyMode || '', e.bodyContentType || '',
    e.expectedStatus ?? '', e.expectedResponse || '',
    e.description || '', e.businessRules || '', e.operationId || '',
    (e.tags || []).join(','), e.resource || '', e.style || 'rest',
    JSON.stringify(e.pathParams || []), JSON.stringify(e.queryParams || []),
    !!e.deprecated,
  ]);
}

export interface ReconcileResult {
  next: CatalogEndpoint[];
  addedIds: string[];
  changedIds: string[];
  removedIds: string[];
  removedNames: string[];
}

/**
 * Merge `fresh` into `base`:
 *  - a fresh endpoint whose identity is new → ADDED (appended);
 *  - a fresh endpoint matching an existing one but with a different signature →
 *    CHANGED (updated in place, keeping the existing id and any locally-entered
 *    auth secret the spec does not carry);
 *  - matching + identical → left as-is (unchanged);
 *  - when `reconcile` is set (a full-snapshot source), existing endpoints from
 *    the SAME source that the fresh set no longer contains → REMOVED. Endpoints
 *    from other sources, or added by hand, are never removed.
 */
export function reconcileImport(
  base: CatalogEndpoint[],
  fresh: CatalogEndpoint[],
  opts: { method: string; name: string; reconcile?: boolean; replace?: boolean; max: number },
): ReconcileResult {
  const start = opts.replace ? [] : base;

  // Dedupe the incoming set on identity (keep first).
  const freshByKey = new Map<string, CatalogEndpoint>();
  for (const e of fresh) { const k = endpointKey(e); if (!freshByKey.has(k)) freshByKey.set(k, e); }
  const existingKeys = new Set(start.map(endpointKey));

  const addedIds: string[] = [];
  const changedIds: string[] = [];
  const handled = new Set<string>();

  // 1. Update changed-in-place / keep unchanged, preserving order.
  const merged: CatalogEndpoint[] = start.map((e) => {
    const k = endpointKey(e);
    const inc = freshByKey.get(k);
    if (!inc || handled.has(k)) return e;
    handled.add(k);
    if (endpointSig(inc) === endpointSig(e)) return e;
    changedIds.push(e.id);
    return { ...inc, id: e.id, importedAt: Date.now(), auth: { ...inc.auth, value: inc.auth?.value || e.auth?.value } };
  });

  // 2. Append brand-new endpoints.
  for (const e of fresh) {
    const k = endpointKey(e);
    if (existingKeys.has(k) || handled.has(k)) continue;
    handled.add(k);
    merged.push(e);
    addedIds.push(e.id);
  }

  // 3. Removal (full-snapshot re-import only).
  const incomingKeys = new Set([...freshByKey.keys()]);
  let removed: CatalogEndpoint[] = [];
  let reconciled = merged;
  if (opts.reconcile && !opts.replace) {
    removed = merged.filter((e) =>
      e.source?.method === opts.method && (e.source?.name || '') === opts.name && !incomingKeys.has(endpointKey(e)),
    );
    if (removed.length) {
      const removedSet = new Set(removed.map((e) => e.id));
      reconciled = merged.filter((e) => !removedSet.has(e.id));
    }
  }

  return {
    next: reconciled.slice(0, opts.max),
    addedIds,
    changedIds,
    removedIds: removed.map((e) => e.id),
    removedNames: removed.map((e) => e.title),
  };
}
