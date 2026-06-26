/**
 * In-memory store for chat-wizard generation jobs.
 *
 * `POST /api/generate` no longer blocks for the multi-minute Claude pipeline —
 * it starts the pipeline in the background, returns a `runId` immediately, and
 * streams progress over SSE. This module holds the per-run job state so the
 * frontend can also fetch the final result (or a friendly error) by runId,
 * which doubles as a poll fallback if an SSE event is missed.
 *
 * State is intentionally in-memory: this is a single-process dev/demo setup and
 * a job is only meaningful for the lifetime of the request that started it. If
 * the backend restarts mid-run the job is lost; the frontend's poll fallback
 * then surfaces a friendly error and the user retries.
 */

export type GenerationJobStatus = 'running' | 'done' | 'error';

export interface GenerationJob {
  runId: string;
  /** Owning tenant — result fetches are scoped to this so a runId can't leak across tenants. */
  tenantId?: string;
  status: GenerationJobStatus;
  /** Frontend pipeline key of the current/last stage ('requirements' | 'test-design'). */
  stage?: string;
  /** Human-readable detail for the current stage. */
  detail?: string;
  /** Success payload (the same shape the old synchronous /generate returned). */
  result?: unknown;
  /** Friendly, user-facing error message (never a raw stack/timeout string). */
  error?: string;
  /** Optional machine-readable code, e.g. CLAUDE_NOT_AUTHENTICATED. */
  code?: string;
  startedAt: number;
  updatedAt: number;
}

const jobs = new Map<string, GenerationJob>();
const TTL_MS = 30 * 60 * 1000; // forget finished/abandoned jobs after 30 min

/** Drop jobs that haven't been touched within the TTL. Called lazily on writes. */
function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [runId, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(runId);
  }
}

export function createJob(runId: string, tenantId?: string): GenerationJob {
  sweep();
  const now = Date.now();
  const job: GenerationJob = { runId, tenantId, status: 'running', startedAt: now, updatedAt: now };
  jobs.set(runId, job);
  return job;
}

export function updateJob(runId: string, patch: Partial<Omit<GenerationJob, 'runId' | 'startedAt'>>): void {
  const job = jobs.get(runId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

export function getJob(runId: string): GenerationJob | undefined {
  return jobs.get(runId);
}
