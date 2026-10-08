/**
 * api-trace.service.ts
 * ────────────────────
 * Observability / trace correlation. Issues a request carrying a W3C traceparent
 * + a correlation id, then (optionally) pulls the resulting distributed trace
 * from a tracing backend (Jaeger / Zipkin / Tempo) and makes trace-based
 * assertions — e.g. "a span named checkout.charge exists", "the trace has ≥ N
 * spans". Observability-driven testing (Tracetest-style) over your own backend.
 *
 * Standalone and opt-in: reuses only the shared HTTP builder + fetch; no deps;
 * the pipeline is never involved.
 */
import { randomBytes } from 'crypto';
import { buildRequestInit, fetchFull, type HttpEndpoint } from '../utils/api-http.js';

export type TracingBackend = 'jaeger' | 'zipkin' | 'tempo';

export interface TraceInput {
  endpoint: HttpEndpoint;
  tracing?: { type: TracingBackend; queryUrl: string };
  /** Span names (operation names) expected to appear in the trace. */
  expectSpans?: string[];
  /** Expected minimum span count. */
  minSpans?: number;
  /** How long to wait before querying the backend (traces land asynchronously). */
  waitMs?: number;
}

export interface TraceSpan { name: string; service: string; durationMs: number; error?: boolean }
export interface TraceResult {
  traceId: string;
  correlationId: string;
  request: { status?: number; elapsedMs: number; error?: string };
  backend?: TracingBackend;
  spans: TraceSpan[];
  spanCount: number;
  assertions: { name: string; pass: boolean; detail?: string }[];
  note?: string;
}

function hex(bytes: number): string { return randomBytes(bytes).toString('hex'); }

async function fetchJaeger(queryUrl: string, traceId: string): Promise<TraceSpan[]> {
  const res = await fetch(`${queryUrl.replace(/\/+$/, '')}/api/traces/${traceId}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Jaeger query ${res.status}`);
  const data: any = await res.json();
  const trace = data?.data?.[0];
  if (!trace) return [];
  const procSvc: Record<string, string> = {};
  for (const [pid, p] of Object.entries<any>(trace.processes || {})) procSvc[pid] = p?.serviceName || '';
  return (trace.spans || []).map((s: any) => ({ name: s.operationName, service: procSvc[s.processID] || '', durationMs: Math.round((s.duration || 0) / 1000), error: (s.tags || []).some((t: any) => t.key === 'error' && (t.value === true || t.value === 'true')) }));
}

async function fetchZipkin(queryUrl: string, traceId: string): Promise<TraceSpan[]> {
  const res = await fetch(`${queryUrl.replace(/\/+$/, '')}/api/v2/trace/${traceId}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Zipkin query ${res.status}`);
  const spans: any[] = await res.json();
  return (spans || []).map((s) => ({ name: s.name, service: s.localEndpoint?.serviceName || '', durationMs: Math.round((s.duration || 0) / 1000), error: !!(s.tags && (s.tags.error || s.tags['otel.status_code'] === 'ERROR')) }));
}

export async function runTraceProbe(input: TraceInput): Promise<TraceResult> {
  const traceId = hex(16);                 // 32 hex chars
  const spanId = hex(8);                    // 16 hex chars
  const correlationId = `iqe-${hex(8)}`;
  const traceparent = `00-${traceId}-${spanId}-01`;

  const { url, init } = buildRequestInit(input.endpoint, {
    extraHeaders: { traceparent, 'X-Correlation-Id': correlationId, 'X-Request-Id': correlationId },
  });
  const r = await fetchFull(url, init);

  const result: TraceResult = {
    traceId, correlationId,
    request: { status: r.status, elapsedMs: r.elapsedMs, error: r.error },
    spans: [], spanCount: 0, assertions: [],
  };

  if (!input.tracing?.queryUrl) {
    result.note = 'No tracing backend configured — use the trace id above to look the trace up in your APM.';
    return result;
  }

  // Traces land asynchronously; wait briefly before querying.
  await new Promise((res) => setTimeout(res, Math.min(10000, Math.max(0, input.waitMs ?? 2500))));
  result.backend = input.tracing.type;
  try {
    const spans = input.tracing.type === 'zipkin' ? await fetchZipkin(input.tracing.queryUrl, traceId) : await fetchJaeger(input.tracing.queryUrl, traceId); // tempo exposes a Jaeger-compatible API
    result.spans = spans.slice(0, 200);
    result.spanCount = spans.length;
  } catch (e) {
    result.note = `Could not fetch the trace: ${(e as Error).message}`;
  }

  const assertions: TraceResult['assertions'] = [];
  if (input.minSpans != null) assertions.push({ name: `≥ ${input.minSpans} spans`, pass: result.spanCount >= input.minSpans, detail: `got ${result.spanCount}` });
  for (const want of input.expectSpans || []) {
    const hit = result.spans.some((s) => s.name === want || s.name?.includes(want));
    assertions.push({ name: `span "${want}" present`, pass: hit, detail: hit ? 'found' : 'missing' });
  }
  result.assertions = assertions;
  return result;
}
