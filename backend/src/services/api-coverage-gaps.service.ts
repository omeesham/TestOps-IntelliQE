/**
 * api-coverage-gaps.service.ts
 * ────────────────────────────
 * Production-traffic coverage gaps — a standalone, opt-in analysis that lives
 * alongside the generate → execute → heal pipeline and never touches it.
 *
 * The idea Katalon ("TrueTest") and testRigor both lead with: compare what your
 * API actually receives in the real world against what your tests cover, and
 * surface the endpoints/flows that have real traffic but NO test. Here that is:
 * recorded traffic (the capture sessions) vs the current tested catalogue →
 * the untested endpoints, returned as ordinary importable endpoints so they can
 * be added and generated like any other import.
 */
import { captureToEndpoints, listCaptureSessions } from './api-capture.service.js';
import { dedupeEndpoints, type ImportedEndpoint } from './api-import.service.js';

/** Host-agnostic request signature: METHOD + path with id-shaped segments collapsed. */
export function requestSignature(method: string, url: string): string {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw */ }
  const segs = path.split('/').filter(Boolean).map((s) =>
    /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i.test(s) ? ':id' : s.toLowerCase(),
  );
  return `${String(method || 'GET').toUpperCase()} /${segs.join('/')}`;
}

export interface CoverageGapsReport {
  summary: { observed: number; tested: number; covered: number; gaps: number; coveragePct: number };
  gaps: ImportedEndpoint[];
  coveredSignatures: string[];
  gapSignatures: string[];
  fromSessions: { id: string; name: string; entryCount: number }[];
}

export async function analyzeCoverageGaps(
  tenantId: string,
  tested: ImportedEndpoint[],
  sessionId?: string,
): Promise<CoverageGapsReport> {
  // Gather observed traffic — one session, or every recording (bounded).
  let observed: ImportedEndpoint[] = [];
  const fromSessions: { id: string; name: string; entryCount: number }[] = [];
  if (sessionId) {
    const r = await captureToEndpoints(tenantId, sessionId);
    observed = r.endpoints;
    fromSessions.push({ id: sessionId, name: r.name, entryCount: r.fromEntries });
  } else {
    const sessions = (await listCaptureSessions(tenantId)).filter((s) => s.entryCount > 0).slice(0, 20);
    for (const s of sessions) {
      try {
        const r = await captureToEndpoints(tenantId, s.id);
        observed.push(...r.endpoints);
        fromSessions.push({ id: s.id, name: s.name, entryCount: r.fromEntries });
      } catch { /* skip a session that fails to convert */ }
    }
  }

  const testedSigs = new Set(tested.map((e) => requestSignature(e.method, e.url)));

  // One representative observed endpoint per signature.
  const bySig = new Map<string, ImportedEndpoint>();
  for (const o of observed) {
    const s = requestSignature(o.method, o.url);
    if (!bySig.has(s)) bySig.set(s, o);
  }

  const coveredSignatures: string[] = [];
  const gapSignatures: string[] = [];
  const gaps: ImportedEndpoint[] = [];
  for (const [s, ep] of bySig) {
    if (testedSigs.has(s)) coveredSignatures.push(s);
    else { gapSignatures.push(s); gaps.push(ep); }
  }

  const observedCount = bySig.size;
  return {
    summary: {
      observed: observedCount,
      tested: testedSigs.size,
      covered: coveredSignatures.length,
      gaps: gaps.length,
      coveragePct: observedCount ? Math.round((coveredSignatures.length / observedCount) * 100) : 0,
    },
    gaps: dedupeEndpoints(gaps),
    coveredSignatures: coveredSignatures.sort(),
    gapSignatures: gapSignatures.sort(),
    fromSessions,
  };
}
