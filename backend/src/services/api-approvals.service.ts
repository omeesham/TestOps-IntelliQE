/**
 * api-approvals.service.ts
 * ────────────────────────
 * Multi-stage review/approval gating for API runs. A workflow defines ordered
 * stages (e.g. QA Lead → Release Manager), each needing a configurable number
 * of approvals from a named set of approvers. An approval request ties a run to
 * a workflow and advances stage-by-stage as approvers act; a single reject stops
 * it. The run's gate is simply the request's status.
 *
 * Additive and layered beside the existing single-stage run sign-off
 * (api-reviews). It grants no permissions and changes nothing in the pipeline or
 * auth — approver membership is enforced only within a request's own stages.
 */
import pool from '../db.js';

export interface ApprovalStage { key: string; name: string; approvers: string[]; minApprovals: number }
export interface ApprovalWorkflow {
  id: string; name: string; stages: ApprovalStage[];
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface ApprovalDecision { stage: number; stageKey: string; approver: string; decision: 'approve' | 'reject'; note: string; at: string }
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'canceled';
export interface ApprovalRequest {
  id: string; workflowId: string; workflowName: string; runId: string; title: string;
  status: RequestStatus; currentStage: number; stages: ApprovalStage[]; decisions: ApprovalDecision[];
  createdBy: string; createdAt: string; updatedAt: string;
}

// ─── workflows ──────────────────────────────────────────────────────────────

function toWorkflow(r: any): ApprovalWorkflow {
  return {
    id: String(r.id), name: r.name || '',
    stages: Array.isArray(r.stages) ? r.stages : [],
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function sanitizeStages(input: any): ApprovalStage[] {
  const arr = Array.isArray(input) ? input : [];
  const out: ApprovalStage[] = [];
  for (const s of arr.slice(0, 10)) {
    const name = String(s?.name || '').trim().slice(0, 120);
    if (!name) continue;
    const approvers = Array.isArray(s?.approvers) ? s.approvers.map((a: unknown) => String(a).slice(0, 100)).filter(Boolean).slice(0, 50) : [];
    const minApprovals = Math.max(1, Math.min(approvers.length || 50, Math.floor(Number(s?.minApprovals)) || 1));
    out.push({ key: String(s?.key || name).slice(0, 60), name, approvers, minApprovals });
  }
  return out;
}

export async function listWorkflows(tenantId: string): Promise<ApprovalWorkflow[]> {
  const { rows } = await pool.query(`SELECT * FROM api_approval_workflows WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toWorkflow);
}
export async function saveWorkflow(tenantId: string, username: string, input: any): Promise<ApprovalWorkflow> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Approval workflow';
  const stages = sanitizeStages(input?.stages);
  if (!stages.length) throw new Error('Add at least one approval stage.');
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_approval_workflows SET name = $3, stages = $4, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, stages],
    );
    if (!rows.length) throw new Error('Workflow not found.');
    return toWorkflow(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_approval_workflows (tenant_id, name, stages, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`,
    [tenantId, name, stages, username],
  );
  return toWorkflow(rows[0]);
}
export async function deleteWorkflow(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_approval_workflows WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── requests ────────────────────────────────────────────────────────────────

function toRequest(r: any): ApprovalRequest {
  const stages: ApprovalStage[] = Array.isArray(r.stages) ? r.stages : [];
  return {
    id: String(r.id), workflowId: String(r.workflow_id), workflowName: r.workflow_name || '',
    runId: r.run_id || '', title: r.title || '',
    status: (['pending', 'approved', 'rejected', 'canceled'].includes(r.status) ? r.status : 'pending') as RequestStatus,
    currentStage: Number(r.current_stage || 0), stages,
    decisions: Array.isArray(r.decisions) ? r.decisions : [],
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listRequests(tenantId: string, runId?: string): Promise<ApprovalRequest[]> {
  const { rows } = runId
    ? await pool.query(`SELECT * FROM api_approval_requests WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC`, [tenantId, String(runId).slice(0, 100)])
    : await pool.query(`SELECT * FROM api_approval_requests WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(toRequest);
}

export async function createRequest(tenantId: string, username: string, input: any): Promise<ApprovalRequest> {
  const workflowId = String(input?.workflowId || '');
  const runId = String(input?.runId || '').slice(0, 100);
  if (!workflowId) throw new Error('Choose an approval workflow.');
  if (!runId) throw new Error('A run is required.');
  const { rows: wf } = await pool.query(`SELECT * FROM api_approval_workflows WHERE tenant_id = $1 AND id = $2`, [tenantId, workflowId]);
  if (!wf.length) throw new Error('Workflow not found.');
  const workflow = toWorkflow(wf[0]);
  if (!workflow.stages.length) throw new Error('That workflow has no stages.');
  const title = String(input?.title || `Approval for run ${runId}`).slice(0, 300);
  // snapshot the stages onto the request so later workflow edits don't change in-flight approvals
  const { rows } = await pool.query(
    `INSERT INTO api_approval_requests (tenant_id, workflow_id, workflow_name, run_id, title, status, current_stage, stages, decisions, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, '[]', $7)`,
    [tenantId, workflowId, workflow.name, runId, title, workflow.stages, username],
  );
  return toRequest(rows[0]);
}

export async function actOnRequest(tenantId: string, approver: string, input: any): Promise<ApprovalRequest> {
  const id = String(input?.requestId || '');
  const decision = input?.decision === 'reject' ? 'reject' : input?.decision === 'approve' ? 'approve' : null;
  if (!id) throw new Error('A request id is required.');
  if (!decision) throw new Error('Decision must be approve or reject.');
  const note = String(input?.note || '').slice(0, 2000);

  const { rows } = await pool.query(`SELECT * FROM api_approval_requests WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) throw new Error('Approval request not found.');
  const req = toRequest(rows[0]);
  if (req.status !== 'pending') throw new Error(`This request is already ${req.status}.`);

  const stage = req.stages[req.currentStage];
  if (!stage) throw new Error('No active stage to act on.');
  if (stage.approvers.length && !stage.approvers.includes(approver)) {
    throw new Error(`You are not an approver for the “${stage.name}” stage.`);
  }
  if (req.decisions.some((d) => d.stage === req.currentStage && d.approver === approver)) {
    throw new Error('You have already recorded a decision for this stage.');
  }

  const decisions: ApprovalDecision[] = [...req.decisions, { stage: req.currentStage, stageKey: stage.key, approver, decision, note, at: new Date().toISOString() }];
  let status: RequestStatus = 'pending';
  let currentStage = req.currentStage;

  if (decision === 'reject') {
    status = 'rejected';
  } else {
    const approvalsThisStage = decisions.filter((d) => d.stage === currentStage && d.decision === 'approve').length;
    if (approvalsThisStage >= stage.minApprovals) {
      currentStage += 1;
      if (currentStage >= req.stages.length) status = 'approved';
    }
  }

  const { rows: upd } = await pool.query(
    `UPDATE api_approval_requests SET status = $3, current_stage = $4, decisions = $5, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, status, currentStage, decisions],
  );
  return toRequest(upd[0]);
}

export async function cancelRequest(tenantId: string, id: string): Promise<ApprovalRequest> {
  const { rows } = await pool.query(
    `UPDATE api_approval_requests SET status = 'canceled', updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [tenantId, id],
  );
  if (!rows.length) throw new Error('Request not found or not pending.');
  return toRequest(rows[0]);
}

export interface ApprovalGate { status: RequestStatus | 'none'; requestId?: string; workflowName?: string; stage?: number; totalStages?: number }
export async function evaluateApprovalGate(tenantId: string, runId: string): Promise<ApprovalGate> {
  const reqs = await listRequests(tenantId, runId);
  if (!reqs.length) return { status: 'none' };
  const latest = reqs[0]!;
  return { status: latest.status, requestId: latest.id, workflowName: latest.workflowName, stage: latest.currentStage, totalStages: latest.stages.length };
}
