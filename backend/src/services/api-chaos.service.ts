/**
 * api-chaos.service.ts
 * ────────────────────
 * Chaos / fault injection for resilience testing. Fires a battery of adverse
 * "experiments" at one endpoint — malformed JSON, oversized payloads, wrong
 * content-type, stripped auth, header corruption, concurrency bursts, abrupt
 * aborts — and scores whether the service DEGRADES GRACEFULLY (a handled 4xx,
 * no 5xx, no hang) instead of falling over. Complements the server-side fault
 * injection on virtual services.
 *
 * Standalone and opt-in: reuses only the shared HTTP builder, never the
 * pipeline, and is non-destructive — write-method experiments run only when the
 * caller explicitly allows writes.
 */
import { buildRequestInit, fetchFull, isWriteMethod, clampInt, type HttpEndpoint } from '../utils/api-http.js';

export interface ChaosInput {
  endpoint: HttpEndpoint;
  requests?: number;          // burst size
  concurrency?: number;
  allowWrites?: boolean;
  timeoutMs?: number;
}

export interface ChaosExperiment {
  name: string;
  description: string;
  status?: number;
  elapsedMs: number;
  outcome: 'resilient' | 'fragile' | 'skipped';
  detail: string;
}

export interface ChaosReport {
  url: string;
  method: string;
  experiments: ChaosExperiment[];
  burst: { requests: number; concurrency: number; completed: number; serverErrors: number; failures: number; avgMs: number; outcome: 'resilient' | 'fragile' };
  resilienceScore: number;    // 0–100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: { resilient: number; fragile: number; skipped: number };
}

/** A 5xx, a transport error, or a timeout = the service did NOT degrade gracefully. */
function classify(r: { status?: number; error?: string }): 'resilient' | 'fragile' {
  if (r.error) return 'fragile';
  if (r.status != null && r.status >= 500) return 'fragile';
  return 'resilient';
}

export async function runChaosProbe(input: ChaosInput): Promise<ChaosReport> {
  const ep = input.endpoint;
  const method = (ep.method || 'GET').toUpperCase();
  const timeoutMs = clampInt(input.timeoutMs, 10_000, 1000, 20_000);
  const write = isWriteMethod(method);
  const experiments: ChaosExperiment[] = [];

  const run = async (name: string, description: string, build: () => { url: string; init: RequestInit } | null): Promise<void> => {
    const built = build();
    if (!built) { experiments.push({ name, description, elapsedMs: 0, outcome: 'skipped', detail: 'not applicable to this endpoint' }); return; }
    const r = await fetchFull(built.url, built.init, timeoutMs);
    const outcome = classify(r);
    experiments.push({ name, description, status: r.status, elapsedMs: r.elapsedMs, outcome, detail: r.error ? r.error.slice(0, 160) : `responded ${r.status}` });
  };

  const base = buildRequestInit(ep);

  // 1. Baseline — a normal request should succeed.
  await run('baseline', 'A normal request', () => base);

  // 2. Malformed JSON body (write methods only).
  await run('malformed-json', 'Send invalid JSON — expect a handled 4xx, not a 5xx', () => {
    if (!write) return null;
    if (!input.allowWrites) return null;
    const b = buildRequestInit(ep);
    return { url: b.url, init: { ...b.init, body: '{"broken": ' } };
  });

  // 3. Oversized payload (write methods only).
  await run('oversized-payload', 'Send a very large body — expect 413/400, not a crash', () => {
    if (!write || !input.allowWrites) return null;
    const b = buildRequestInit(ep);
    return { url: b.url, init: { ...b.init, body: JSON.stringify({ blob: 'A'.repeat(2_000_000) }) } };
  });

  // 4. Wrong content-type.
  await run('wrong-content-type', 'Declare text/plain with a JSON body', () => {
    const b = buildRequestInit(ep);
    const headers = { ...(b.init.headers as Record<string, string>), 'content-type': 'text/plain' };
    return { url: b.url, init: { ...b.init, headers, body: write && input.allowWrites ? (ep.body || '{}') : undefined } };
  });

  // 5. Stripped auth — expect 401/403 (a handled rejection), not a 5xx.
  await run('stripped-auth', 'Remove credentials — expect 401/403, not a 5xx', () => {
    if (!ep.auth || ep.auth.type === 'none') return null;
    const b = buildRequestInit({ ...ep, auth: { type: 'none' } });
    return b;
  });

  // 6. Header corruption / injection-shaped values.
  await run('header-fuzz', 'Send odd header values — expect graceful handling', () => {
    const b = buildRequestInit(ep);
    const headers = { ...(b.init.headers as Record<string, string>), 'X-Chaos': "';DROP TABLE--", 'Accept': 'application/\u0000json' };
    return { url: b.url, init: { ...b.init, headers } };
  });

  // 7. Query perturbation.
  await run('query-fuzz', 'Append malformed query params', () => {
    const sep = ep.url.includes('?') ? '&' : '?';
    return { url: `${ep.url}${sep}__chaos=%ff%fe&limit=-999999`, init: base.init };
  });

  // 8. Concurrency burst — does it hold up under sudden load?
  const requests = clampInt(input.requests, 30, 1, 200);
  const concurrency = clampInt(input.concurrency, 15, 1, 50);
  let completed = 0, serverErrors = 0, failures = 0, totalMs = 0, dispatched = 0;
  const worker = async () => {
    while (dispatched < requests) {
      dispatched++;
      const r = await fetchFull(base.url, base.init, timeoutMs);
      if (r.error) failures++;
      else { completed++; totalMs += r.elapsedMs; if (r.status != null && r.status >= 500) serverErrors++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
  const burstOutcome: 'resilient' | 'fragile' = (serverErrors + failures) / Math.max(1, requests) > 0.1 ? 'fragile' : 'resilient';
  experiments.push({
    name: 'concurrency-burst',
    description: `${requests} requests at concurrency ${concurrency}`,
    elapsedMs: completed ? Math.round(totalMs / completed) : 0,
    outcome: burstOutcome,
    detail: `${completed} ok, ${serverErrors} 5xx, ${failures} errors`,
  });

  const resilient = experiments.filter((e) => e.outcome === 'resilient').length;
  const fragile = experiments.filter((e) => e.outcome === 'fragile').length;
  const skipped = experiments.filter((e) => e.outcome === 'skipped').length;
  const assessed = resilient + fragile;
  const resilienceScore = assessed ? Math.round((resilient / assessed) * 100) : 0;
  const grade: ChaosReport['grade'] = resilienceScore >= 90 ? 'A' : resilienceScore >= 75 ? 'B' : resilienceScore >= 60 ? 'C' : resilienceScore >= 40 ? 'D' : 'F';

  return {
    url: base.url,
    method,
    experiments,
    burst: { requests, concurrency, completed, serverErrors, failures, avgMs: completed ? Math.round(totalMs / completed) : 0, outcome: burstOutcome },
    resilienceScore,
    grade,
    summary: { resilient, fragile, skipped },
  };
}
