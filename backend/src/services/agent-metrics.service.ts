/**
 * Agent performance metrics — a lightweight, in-memory telemetry layer for the
 * AI pipeline agents (requirement, audit, planner, generator, script,
 * execution, healing, explore).
 *
 * Every agent invocation is wrapped with `timed()`, which:
 *   • broadcasts an `agent_start` SSE event the instant the agent begins, and
 *   • records a completed run (duration + success/error + light metadata) into
 *     a per-tenant ring buffer, broadcasting an `agent_run` SSE event.
 *
 * The Agent Performance page reads `getAgentStats()` for the initial snapshot
 * and subscribes to the SSE stream for live updates — a Task-Manager-style
 * monitor of what each agent is doing and how long it takes.
 *
 * Deliberately in-memory (no DB): this is live operational telemetry, cheap to
 * produce, and it must never add latency or a failure mode to a pipeline run.
 */
import { broadcastSSE } from './sse-manager.js';

export type AgentKey =
  | 'requirement' | 'audit' | 'planner' | 'generator'
  | 'script' | 'execution' | 'healing' | 'explore';

export interface AgentRun {
  id: number;
  agent: AgentKey;
  status: 'success' | 'error';
  startedAt: string;   // ISO
  endedAt: string;     // ISO
  durationMs: number;
  error?: string;
  meta?: Record<string, unknown>;
}

const RUNS_CAP = 200;                 // keep the last N runs per tenant
const runsByTenant = new Map<string, AgentRun[]>();
let seq = 0;

export const agentPerfChannel = (tenantId: string) => `agent-perf:${tenantId}`;

function emit(tenantId: string, event: Record<string, unknown>): void {
  broadcastSSE(agentPerfChannel(tenantId), {
    ...event,
    timestamp: new Date().toISOString(),
  } as any);
}

/** Record a completed agent run and notify live subscribers. */
export function recordAgentRun(tenantId: string, run: Omit<AgentRun, 'id'>): AgentRun {
  const entry: AgentRun = { id: ++seq, ...run };
  const list = runsByTenant.get(tenantId) || [];
  list.push(entry);
  if (list.length > RUNS_CAP) list.splice(0, list.length - RUNS_CAP);
  runsByTenant.set(tenantId, list);
  emit(tenantId, { type: 'agent_run', run: entry });
  return entry;
}

/**
 * Time an agent invocation. Broadcasts a start event, runs `fn`, then records
 * the run (success or error) with its duration. Re-throws on error so callers'
 * existing error handling is completely unaffected.
 *
 * `metaFn` optionally derives light, non-sensitive metadata from the result
 * (e.g. how many test cases were produced) for display on the monitor.
 */
export async function timed<T>(
  tenantId: string | undefined | null,
  agent: AgentKey,
  fn: () => Promise<T>,
  metaFn?: (result: T) => Record<string, unknown>,
): Promise<T> {
  // No tenant context (e.g. an internal call) → run untracked, never block work.
  if (!tenantId) return fn();

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  emit(tenantId, { type: 'agent_start', agent, startedAt });

  try {
    const result = await fn();
    let meta: Record<string, unknown> | undefined;
    try { meta = metaFn?.(result); } catch { /* metadata is best-effort */ }
    recordAgentRun(tenantId, {
      agent, status: 'success', startedAt,
      endedAt: new Date().toISOString(), durationMs: Date.now() - t0, meta,
    });
    return result;
  } catch (err) {
    recordAgentRun(tenantId, {
      agent, status: 'error', startedAt,
      endedAt: new Date().toISOString(), durationMs: Date.now() - t0,
      error: (err as Error)?.message?.slice(0, 300) || 'Agent failed',
    });
    throw err;
  }
}

export interface AgentStat {
  agent: AgentKey;
  runs: number;
  successes: number;
  errors: number;
  lastStatus: 'success' | 'error' | null;
  lastDurationMs: number | null;
  avgDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  totalDurationMs: number;
  lastRunAt: string | null;
  lastError?: string;
  lastMeta?: Record<string, unknown>;
  recent: { durationMs: number; status: 'success' | 'error'; at: string }[];
}

/** Aggregated per-agent stats + overall totals for the current tenant. */
export function getAgentStats(tenantId: string): {
  agents: AgentStat[];
  totals: { totalRuns: number; totalDurationMs: number; agentsUsed: number; errors: number };
  generatedAt: string;
} {
  const runs = runsByTenant.get(tenantId) || [];
  const byAgent = new Map<AgentKey, AgentRun[]>();
  for (const r of runs) {
    const arr = byAgent.get(r.agent) || [];
    arr.push(r);
    byAgent.set(r.agent, arr);
  }

  const agents: AgentStat[] = [];
  for (const [agent, list] of byAgent) {
    const durations = list.map((r) => r.durationMs);
    const last = list[list.length - 1]!;
    agents.push({
      agent,
      runs: list.length,
      successes: list.filter((r) => r.status === 'success').length,
      errors: list.filter((r) => r.status === 'error').length,
      lastStatus: last.status,
      lastDurationMs: last.durationMs,
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      minDurationMs: Math.min(...durations),
      maxDurationMs: Math.max(...durations),
      totalDurationMs: durations.reduce((a, b) => a + b, 0),
      lastRunAt: last.endedAt,
      lastError: last.status === 'error' ? last.error : undefined,
      lastMeta: last.meta,
      recent: list.slice(-40).map((r) => ({ durationMs: r.durationMs, status: r.status, at: r.endedAt })),
    });
  }

  return {
    agents,
    totals: {
      totalRuns: runs.length,
      totalDurationMs: runs.reduce((s, r) => s + r.durationMs, 0),
      agentsUsed: byAgent.size,
      errors: runs.filter((r) => r.status === 'error').length,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Clear a tenant's captured runs (used by the "reset" control on the monitor). */
export function clearAgentStats(tenantId: string): void {
  runsByTenant.delete(tenantId);
  emit(tenantId, { type: 'agent_reset' });
}
