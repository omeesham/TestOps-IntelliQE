/**
 * Pipeline CRUD queries — adapted from qa_agentic_framework.
 * All tables: "JBSTestOpsAI".qa_*
 */

import type { Db as Pool } from '../db.js';
import type {
  PipelineRun, StageResult, Artifact, WorkerTask,
  Page, PageStageStatus, PageWithStages,
} from '../orchestrator/types.js';

const S = '"JBSTestOpsAI"';

// ── Pipeline Runs ──

export async function createPipelineRun(
  pool: Pool,
  data: {
    tenant_id?: string | null; feature: string; module: string; intent: string;
    target_url?: string | null; priority?: string; page_id?: string | null;
    cascade_plan?: Record<string, unknown> | null; batch_id?: string | null;
    execution_mode_live?: string | null;
  },
): Promise<PipelineRun> {
  const { rows: [run] } = await pool.query<PipelineRun>(
    `INSERT INTO ${S}.qa_pipeline_runs (tenant_id, feature, module, intent, target_url, priority, page_id, cascade_plan, batch_id, execution_mode_live)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.tenant_id || null, data.feature, data.module, data.intent,
     data.target_url || null, data.priority || 'medium', data.page_id || null,
     data.cascade_plan ? JSON.stringify(data.cascade_plan) : null,
     data.batch_id || null, data.execution_mode_live || null],
  );
  return run;
}

export async function getPipelineRun(pool: Pool, id: string): Promise<PipelineRun | null> {
  const { rows } = await pool.query<PipelineRun>(`SELECT * FROM ${S}.qa_pipeline_runs WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listPipelineRuns(
  pool: Pool, tenantId?: string, status?: string, limit = 50,
): Promise<PipelineRun[]> {
  let q = `SELECT * FROM ${S}.qa_pipeline_runs WHERE 1=1`;
  const params: unknown[] = [];
  if (tenantId) { params.push(tenantId); q += ` AND tenant_id = $${params.length}`; }
  if (status) { params.push(status); q += ` AND status = $${params.length}`; }
  params.push(limit); q += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query<PipelineRun>(q, params);
  return rows;
}

export async function updatePipelineRun(
  pool: Pool, id: string, updates: Partial<Pick<PipelineRun, 'stage' | 'status' | 'cost' | 'execution_mode_live'>>,
): Promise<PipelineRun | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.stage !== undefined) { vals.push(updates.stage); sets.push(`stage = $${vals.length}`); }
  if (updates.status !== undefined) { vals.push(updates.status); sets.push(`status = $${vals.length}`); }
  if (updates.cost !== undefined) { vals.push(updates.cost); sets.push(`cost = $${vals.length}`); }
  if (updates.execution_mode_live !== undefined) { vals.push(updates.execution_mode_live); sets.push(`execution_mode_live = $${vals.length}`); }
  if (sets.length === 0) return getPipelineRun(pool, id);
  vals.push(id);
  const { rows } = await pool.query<PipelineRun>(
    `UPDATE ${S}.qa_pipeline_runs SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals,
  );
  return rows[0] || null;
}

export async function incrementRunCost(pool: Pool, runId: string, amount: number): Promise<void> {
  await pool.query(`UPDATE ${S}.qa_pipeline_runs SET cost = cost + $2 WHERE id = $1`, [runId, amount]);
}

// ── Stage Results ──

export async function createStageResult(
  pool: Pool, runId: string, stageId: string, maxAttempts: number, agentModel?: string,
): Promise<StageResult> {
  const existing = await pool.query<StageResult>(
    `SELECT * FROM ${S}.qa_stage_results WHERE run_id = $1 AND stage_id = $2 ORDER BY attempt DESC LIMIT 1`,
    [runId, stageId],
  );
  const attempt = existing.rows[0] ? existing.rows[0].attempt + 1 : 1;
  const { rows: [result] } = await pool.query<StageResult>(
    `INSERT INTO ${S}.qa_stage_results (run_id, stage_id, status, attempt, max_attempts, agent_model, started_at)
     VALUES ($1,$2,'running',$3,$4,$5,now()) RETURNING *`,
    [runId, stageId, attempt, maxAttempts, agentModel || null],
  );
  return result;
}

export async function completeStageResult(
  pool: Pool, id: string, status: 'success' | 'fail', resultData: Record<string, unknown>, cost: number,
): Promise<StageResult> {
  const { rows: [result] } = await pool.query<StageResult>(
    `UPDATE ${S}.qa_stage_results SET status = $2, result_data = $3, cost = $4, completed_at = now() WHERE id = $1 RETURNING *`,
    [id, status, JSON.stringify(resultData), cost],
  );
  return result;
}

export async function getStageResults(pool: Pool, runId: string): Promise<StageResult[]> {
  const { rows } = await pool.query<StageResult>(
    `SELECT * FROM ${S}.qa_stage_results WHERE run_id = $1 ORDER BY created_at`, [runId],
  );
  return rows;
}

// ── Artifacts ──

export async function createArtifact(
  pool: Pool, runId: string, name: string, type: string, content: string, pageId?: string | null, metadata?: Record<string, unknown>,
): Promise<Artifact> {
  const { rows: [art] } = await pool.query<Artifact>(
    `INSERT INTO ${S}.qa_artifacts (run_id, name, type, content, page_id, metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [runId, name, type, content, pageId || null, metadata ? JSON.stringify(metadata) : null],
  );
  return art;
}

export async function getArtifacts(pool: Pool, runId: string): Promise<Artifact[]> {
  const { rows } = await pool.query<Artifact>(
    `SELECT * FROM ${S}.qa_artifacts WHERE run_id = $1 AND replaced_by IS NULL ORDER BY created_at`, [runId],
  );
  return rows;
}

export async function getArtifactsByPageId(pool: Pool, pageId: string): Promise<Artifact[]> {
  const { rows } = await pool.query<Artifact>(
    `SELECT * FROM ${S}.qa_artifacts WHERE page_id = $1 AND replaced_by IS NULL ORDER BY created_at`, [pageId],
  );
  return rows;
}

/** Resolve the owning tenant of an artifact via its run or page. Null if not found. */
export async function getArtifactTenant(pool: Pool, artifactId: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    `SELECT COALESCE(r.tenant_id, p.tenant_id) AS tenant_id
     FROM ${S}.qa_artifacts a
     LEFT JOIN ${S}.qa_pipeline_runs r ON r.id = a.run_id
     LEFT JOIN ${S}.qa_pages p ON p.id = a.page_id
     WHERE a.id = $1`,
    [artifactId],
  );
  return rows[0]?.tenant_id ?? null;
}

export async function updateArtifactVersioned(
  pool: Pool, artifactId: string, content: string, editedBy: string,
): Promise<Artifact> {
  const { rows: [old] } = await pool.query<Artifact>(`SELECT * FROM ${S}.qa_artifacts WHERE id = $1`, [artifactId]);
  if (!old) throw new Error('Artifact not found');
  const { rows: [newArt] } = await pool.query<Artifact>(
    `INSERT INTO ${S}.qa_artifacts (run_id, name, type, content, page_id, metadata, version, edited_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [old.run_id, old.name, old.type, content, old.page_id, old.metadata ? JSON.stringify(old.metadata) : null, (old.version || 1) + 1, editedBy],
  );
  await pool.query(`UPDATE ${S}.qa_artifacts SET replaced_by = $2 WHERE id = $1`, [artifactId, newArt.id]);
  return newArt;
}

export async function softDeleteArtifact(pool: Pool, artifactId: string, deletedBy: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.qa_artifacts SET edited_by = $2,
       metadata = JSON_MODIFY(COALESCE(metadata, '{}'), '$.deleted', CAST(1 AS BIT)) WHERE id = $1`,
    [artifactId, deletedBy],
  );
  return (rowCount ?? 0) > 0;
}

export async function createArtifactDirect(
  pool: Pool, runId: string, name: string, type: string, content: string, pageId?: string,
): Promise<Artifact> {
  return createArtifact(pool, runId, name, type, content, pageId);
}

// ── Worker Tasks ──

export async function createWorkerTask(
  pool: Pool, runId: string, tenantId: string | null, stageId: string, agentPrompt: string, context?: Record<string, unknown>,
): Promise<WorkerTask> {
  const { rows: [task] } = await pool.query<WorkerTask>(
    `INSERT INTO ${S}.qa_worker_tasks (run_id, tenant_id, stage_id, agent_prompt, context) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [runId, tenantId, stageId, agentPrompt, context ? JSON.stringify(context) : null],
  );
  return task;
}

/**
 * Recover stuck tasks: any task left in 'claimed' longer than `staleMs` (a
 * worker crashed, or `complete-task` exhausted its retries and the task never
 * reached 'completed'/'failed') is reset to 'pending' so it can be re-claimed.
 * Idempotent — only flips rows that are currently 'claimed' and past the
 * timeout, and clears `claimed_at` so the staleness window restarts cleanly on
 * the next claim. Returns the number of tasks requeued.
 */
export async function requeueStuckTasks(pool: Pool, staleMs = 10 * 60_000): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE ${S}.qa_worker_tasks
       SET status = 'pending', claimed_at = NULL
     WHERE status = 'claimed'
       AND claimed_at IS NOT NULL
       AND claimed_at < DATEADD(millisecond, -$1, SYSUTCDATETIME())`,
    [staleMs],
  );
  return rowCount ?? 0;
}

export async function claimNextTask(pool: Pool, tenantId?: string): Promise<WorkerTask | null> {
  // Before claiming, sweep tasks stuck in 'claimed' (crashed worker or a
  // complete-task that exhausted its retries) back to 'pending' so a run is
  // never blocked forever by an unrecoverable task. Idempotent.
  await requeueStuckTasks(pool);

  // SQL Server equivalent of "FOR UPDATE SKIP LOCKED": a CTE over TOP(1) rows
  // with READPAST (skip rows locked by other workers) + UPDLOCK + ROWLOCK,
  // updated in place. OUTPUT returns the claimed row atomically.
  const params: unknown[] = [];
  let filter = `status = 'pending'`;
  if (tenantId) { params.push(tenantId); filter += ` AND tenant_id = $${params.length}`; }
  const q =
    `WITH next_task AS (
       SELECT TOP (1) * FROM ${S}.qa_worker_tasks WITH (READPAST, UPDLOCK, ROWLOCK)
       WHERE ${filter}
       ORDER BY created_at
     )
     UPDATE next_task SET status = 'claimed', claimed_at = SYSUTCDATETIME()
     OUTPUT INSERTED.*;`;
  const { rows } = await pool.query<WorkerTask>(q, params);
  return rows[0] || null;
}

export async function completeWorkerTask(
  pool: Pool, taskId: string, success: boolean, result: Record<string, unknown>,
): Promise<WorkerTask | null> {
  const { rows } = await pool.query<WorkerTask>(
    `UPDATE ${S}.qa_worker_tasks SET status = $2, result = $3, completed_at = now() WHERE id = $1 RETURNING *`,
    [taskId, success ? 'completed' : 'failed', JSON.stringify(result)],
  );
  return rows[0] || null;
}

// ── Pages ──

export async function createPage(
  pool: Pool,
  data: { tenant_id?: string | null; module: string; page_slug: string; display_name: string; target_url?: string; parent_page_id?: string; metadata?: Record<string, unknown> },
): Promise<Page> {
  const depth = data.parent_page_id ? 1 : 0;
  const { rows: [page] } = await pool.query<Page>(
    `INSERT INTO ${S}.qa_pages (tenant_id, module, page_slug, display_name, target_url, parent_page_id, depth, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.tenant_id || null, data.module, data.page_slug, data.display_name,
     data.target_url || null, data.parent_page_id || null, depth,
     data.metadata ? JSON.stringify(data.metadata) : null],
  );
  return page;
}

export async function getPage(pool: Pool, id: string): Promise<Page | null> {
  const { rows } = await pool.query<Page>(`SELECT * FROM ${S}.qa_pages WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getPageBySlug(pool: Pool, tenantId: string | null, module: string, slug: string): Promise<Page | null> {
  const { rows } = await pool.query<Page>(
    `SELECT * FROM ${S}.qa_pages
     WHERE ((tenant_id = $1) OR (tenant_id IS NULL AND $1 IS NULL)) AND module = $2 AND page_slug = $3`,
    [tenantId, module, slug],
  );
  return rows[0] || null;
}

export async function listPages(pool: Pool, tenantId?: string): Promise<PageWithStages[]> {
  // json_agg(...) FILTER → a correlated FOR JSON PATH subquery per page;
  // COALESCE keeps the contract of an empty array (never null) for `stages`.
  let q = `SELECT p.*,
             COALESCE((SELECT ps.* FROM ${S}.qa_page_stage_status ps
                       WHERE ps.page_id = p.id ORDER BY ps.stage_id FOR JSON PATH), '[]') AS stages
           FROM ${S}.qa_pages p`;
  const params: unknown[] = [];
  if (tenantId) { params.push(tenantId); q += ` WHERE p.tenant_id = $1`; }
  q += ` ORDER BY p.sort_order, p.created_at`;
  const { rows } = await pool.query<PageWithStages>(q, params);
  return rows;
}

export async function getPageTree(pool: Pool, tenantId?: string): Promise<Page[]> {
  let q = `SELECT * FROM ${S}.qa_pages`;
  const params: unknown[] = [];
  if (tenantId) { params.push(tenantId); q += ` WHERE tenant_id = $1`; }
  q += ` ORDER BY depth, sort_order, display_name`;
  const { rows } = await pool.query<Page>(q, params);
  return rows;
}

export async function updatePage(
  pool: Pool, id: string, updates: { display_name?: string; target_url?: string; metadata?: Record<string, unknown>; sort_order?: number },
): Promise<Page | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (updates.display_name) { vals.push(updates.display_name); sets.push(`display_name = $${vals.length}`); }
  if (updates.target_url !== undefined) { vals.push(updates.target_url); sets.push(`target_url = $${vals.length}`); }
  if (updates.metadata) { vals.push(JSON.stringify(updates.metadata)); sets.push(`metadata = $${vals.length}`); }
  if (updates.sort_order !== undefined) { vals.push(updates.sort_order); sets.push(`sort_order = $${vals.length}`); }
  if (sets.length === 0) return getPage(pool, id);
  vals.push(id);
  const { rows } = await pool.query<Page>(
    `UPDATE ${S}.qa_pages SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals,
  );
  return rows[0] || null;
}

export async function deletePage(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM ${S}.qa_pages WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ── Page Stage Status ──

export async function getPageStageStatuses(pool: Pool, pageId: string): Promise<PageStageStatus[]> {
  const { rows } = await pool.query<PageStageStatus>(
    `SELECT * FROM ${S}.qa_page_stage_status WHERE page_id = $1 ORDER BY stage_id`, [pageId],
  );
  return rows;
}

export async function upsertPageStageStatus(
  pool: Pool, pageId: string, stageId: string, updates: Partial<PageStageStatus>,
): Promise<PageStageStatus> {
  const { rows: [existing] } = await pool.query<PageStageStatus>(
    `SELECT * FROM ${S}.qa_page_stage_status WHERE page_id = $1 AND stage_id = $2`, [pageId, stageId],
  );

  if (existing) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id' || key === 'page_id' || key === 'stage_id') continue;
      vals.push(value);
      sets.push(`${key} = $${vals.length}`);
    }
    if (sets.length === 0) return existing;
    vals.push(existing.id);
    const { rows: [updated] } = await pool.query<PageStageStatus>(
      `UPDATE ${S}.qa_page_stage_status SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals,
    );
    return updated;
  }

  const status = updates.status || 'not_started';
  const { rows: [created] } = await pool.query<PageStageStatus>(
    `INSERT INTO ${S}.qa_page_stage_status (page_id, stage_id, status, active_run_id, last_run_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [pageId, stageId, status, updates.active_run_id || null, updates.last_run_id || null],
  );
  return created;
}

export async function checkPageConcurrency(pool: Pool, pageId: string, stageId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM ${S}.qa_page_stage_status WHERE page_id = $1 AND stage_id = $2 AND status = 'running'`,
    [pageId, stageId],
  );
  return rows.length > 0;
}

// ── Usage Stats ──

export async function getUsageStats(pool: Pool, tenantId?: string): Promise<{ totalRuns: number; completedRuns: number; totalCost: number; avgCostPerRun: number }> {
  let q = `SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
             COALESCE(SUM(cost), 0) as total_cost,
             COALESCE(AVG(CASE WHEN status = 'completed' THEN cost END), 0) as avg_cost
           FROM ${S}.qa_pipeline_runs`;
  const params: unknown[] = [];
  if (tenantId) { params.push(tenantId); q += ` WHERE tenant_id = $1`; }
  const { rows: [stats] } = await pool.query(q, params);
  return {
    totalRuns: Number(stats.total),
    completedRuns: Number(stats.completed),
    totalCost: Number(stats.total_cost),
    avgCostPerRun: Number(stats.avg_cost),
  };
}

// ── Worker Heartbeat (in-memory) ──

const heartbeatMap = new Map<string, { timestamp: Date; currentTaskId?: string }>();
const pendingCommands = new Map<string, string>();

export function recordHeartbeat(workerId: string, currentTaskId?: string): void {
  heartbeatMap.set(workerId, { timestamp: new Date(), currentTaskId });
}

export function isWorkerConnected(): boolean {
  const now = Date.now();
  for (const [, hb] of heartbeatMap) {
    if (now - hb.timestamp.getTime() < 60_000) return true;
  }
  return false;
}

export function getLastHeartbeat(): { workerId: string; timestamp: Date; currentTaskId?: string } | null {
  let latest: { workerId: string; timestamp: Date; currentTaskId?: string } | null = null;
  for (const [id, hb] of heartbeatMap) {
    if (!latest || hb.timestamp > latest.timestamp) {
      latest = { workerId: id, ...hb };
    }
  }
  return latest;
}

export function setPendingWorkerCommand(workerId: string, command: string): void {
  pendingCommands.set(workerId, command);
}

export function consumePendingWorkerCommand(workerId: string): string | null {
  const cmd = pendingCommands.get(workerId);
  if (cmd) pendingCommands.delete(workerId);
  return cmd || null;
}
