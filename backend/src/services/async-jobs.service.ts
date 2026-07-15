/**
 * In-memory async job store for long-running pipeline stages.
 *
 * Azure Container Apps ingress hard-kills any HTTP request at ~240s. Execution
 * and healing (which run Playwright + LLM passes) routinely exceed that, so a
 * synchronous request/response never delivers their results in production —
 * the UI sees a dead socket and reports "could not be run" even though the
 * server finished the work. Stages instead START here (fast response with a
 * jobId) and the client polls short-lived status requests until completion.
 *
 * In-memory is sufficient because the app runs as a single container replica;
 * if the app is ever scaled out, this store must move to the database so any
 * replica can answer a poll.
 */

type JobStatus = 'running' | 'completed' | 'failed';

interface Job {
  tenantId: string;
  status: JobStatus;
  result?: unknown;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, Job>();

// Finished jobs are kept long enough for a slow poller to collect, then swept.
const FINISHED_TTL_MS = 30 * 60 * 1000;
// A job whose runner somehow never settles is dropped after this ceiling.
const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > FINISHED_TTL_MS) jobs.delete(id);
    else if (!job.finishedAt && now - job.createdAt > RUNNING_TTL_MS) jobs.delete(id);
  }
}

/** Start `run` detached and return a jobId the client can poll. */
export function startJob(tenantId: string, run: () => Promise<unknown>): string {
  sweep();
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job: Job = { tenantId, status: 'running', createdAt: Date.now() };
  jobs.set(id, job);
  run()
    .then((result) => {
      job.status = 'completed';
      job.result = result;
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = (err as Error)?.message || 'Job failed';
      job.finishedAt = Date.now();
    });
  return id;
}

/** Look up a job — tenant-scoped so one tenant can never poll another's job. */
export function getJob(tenantId: string, id: string): { status: JobStatus; result?: unknown; error?: string } | null {
  const job = jobs.get(id);
  if (!job || job.tenantId !== tenantId) return null;
  return { status: job.status, result: job.result, error: job.error };
}
