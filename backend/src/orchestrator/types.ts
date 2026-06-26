/**
 * Orchestrator types — shared contract between server, worker, and orchestrator.
 */

export interface StageDefinition {
  id: string;
  name: string;
  agent: string;
  agentFile: string;
  model: string;
  enabled: boolean;
  maxTurns: number;
  budgetCap: number;
  retries: number;
  timeoutSeconds: number;
  next: Record<string, string>;
  routing?: {
    condition: string;
    rules: Array<{ when: string; then: string }>;
  };
  mcpConfig?: string | null;
  approvalMode?: 'auto' | 'manual';
  allowedTools?: string[];
  effort?: 'low' | 'medium' | 'high' | 'max';
  preRunGate: string;
  postCompleteGate: string;
  description: string;
}

export interface ConvergenceGuardConfig {
  enabled: boolean;
  sameFindings: { enabled: boolean; action: string };
  notDecreasing: { enabled: boolean; windowSize: number; action: string };
  maxIterations: { enabled: boolean; limit: number; action: string };
  budgetExhausted: { enabled: boolean; action: string };
}

export interface PipelineDefinition {
  version: string;
  defaults: {
    model: string;
    maxTurnsPerStage: number;
    budgetPerRunUsd: number;
    budgetPerStageUsd: number;
    workerPollIntervalMs: number;
    workerHeartbeatIntervalMs: number;
    cliPath: string;
    cliOutputFormat: string;
    agentRunner: 'cli' | 'sdk';
    autoInvoke: boolean;
  };
  models: {
    available: string[];
    costPerMTokenInput: Record<string, number>;
    costPerMTokenOutput: Record<string, number>;
  };
  stages: StageDefinition[];
  terminalStates: string[];
  convergenceGuards: ConvergenceGuardConfig;
}

export type PipelineRunStatus = 'queued' | 'running' | 'completed' | 'fixme' | 'cancelled' | 'error' | 'awaiting_triage' | 'awaiting_approval';

export interface PipelineRun {
  id: string;
  tenant_id: string | null;
  feature: string;
  module: string;
  intent: string;
  target_url: string | null;
  stage: string;
  status: PipelineRunStatus;
  priority: string;
  cost: number;
  page_id: string | null;
  cascade_plan: Record<string, unknown> | null;
  batch_id: string | null;
  execution_mode_live: string | null;
  created_at: string;
  updated_at: string;
}

export type StageStatus = 'pending' | 'running' | 'success' | 'fail' | 'skipped' | 'cancelled';

export interface StageResult {
  id: string;
  run_id: string;
  stage_id: string;
  status: StageStatus;
  attempt: number;
  max_attempts: number;
  agent_model: string | null;
  cost: number;
  result_data: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Artifact {
  id: string;
  run_id: string;
  name: string;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  page_id: string | null;
  version: number;
  replaced_by: string | null;
  edited_by: string | null;
  created_at: string;
}

export type WorkerTaskStatus = 'pending' | 'claimed' | 'completed' | 'failed';

export interface WorkerTask {
  id: string;
  run_id: string;
  tenant_id: string | null;
  stage_id: string;
  status: WorkerTaskStatus;
  agent_prompt: string;
  context: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Page {
  id: string;
  tenant_id: string | null;
  module: string;
  page_slug: string;
  display_name: string;
  target_url: string | null;
  parent_page_id: string | null;
  depth: number;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type PageStageStatusValue = 'not_started' | 'running' | 'completed' | 'failed';

export interface PageStageStatus {
  id: string;
  page_id: string;
  stage_id: string;
  status: PageStageStatusValue;
  active_run_id: string | null;
  last_run_id: string | null;
  last_completed_at: string | null;
  artifact_summary: Record<string, unknown> | null;
  approved_by: string | null;
  approved_at: string | null;
  explore_without_reqs: boolean;
  explore_permitted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageWithStages extends Page {
  stages: PageStageStatus[];
}

export type SSEVisibility = 'public' | 'admin';

export type SSEEvent =
  | { type: 'stage_start'; runId: string; stage: string; agent: string; model: string; attempt: number; timestamp: string; visibility?: SSEVisibility }
  | { type: 'stage_complete'; runId: string; stage: string; result: 'success' | 'fail'; error?: string; cost: number; duration: number; timestamp: string; visibility?: SSEVisibility }
  | { type: 'pipeline_complete'; runId: string; status: 'completed' | 'fixme' | 'cancelled'; totalCost: number; timestamp: string; visibility?: SSEVisibility }
  | { type: 'artifact_ready'; runId: string; artifactId: string; name: string; artifactType: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'retry'; runId: string; stage: string; attempt: number; maxAttempts: number; reason: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'error'; runId: string; message: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'worker_status'; connected: boolean; timestamp: string; visibility?: SSEVisibility }
  | { type: 'agent_progress'; runId: string; stage: string; message: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'triage_required'; runId: string; triageReportPath: string; failureCount: number; timestamp: string; visibility?: SSEVisibility }
  | { type: 'approval_required'; runId: string; stage: string; artifactCount: number; timestamp: string; visibility?: SSEVisibility }
  | { type: 'page_stage_updated'; runId: string; pageId: string; stageId: string; status: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'cascade_progress'; runId: string; pageId: string; completedStage: string; nextStage: string | null; timestamp: string; visibility?: SSEVisibility }
  | { type: 'artifact_updated'; runId: string; artifactId: string; action: 'edited' | 'deleted'; timestamp: string; visibility?: SSEVisibility }
  | { type: 'mode_switched'; runId: string; mode: 'auto' | 'manual'; timestamp: string; visibility?: SSEVisibility }
  // ── Chat-wizard generation job events (POST /api/generate background run) ──
  | { type: 'gen_stage'; runId: string; stage: 'requirements' | 'test-design'; status: 'running' | 'completed'; detail: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'generation_complete'; runId: string; timestamp: string; visibility?: SSEVisibility }
  | { type: 'generation_error'; runId: string; error: string; code?: string; timestamp: string; visibility?: SSEVisibility };

export type ExecutionMode = 'full-auto' | 'approve-per-stage' | 'dry-run';

export interface CreatePipelineRequest {
  feature: string;
  module: string;
  intent: string;
  priority?: string;
  targetUrl?: string;
  tenantId?: string;
  dryRun?: boolean;
  startStage?: string;
  executionMode?: ExecutionMode;
}

export interface CreatePipelineResponse {
  runId: string;
}

export interface CompletedTaskPayload {
  taskId: string;
  success: boolean;
  result: Record<string, unknown>;
  artifacts?: Array<{ name: string; type: string; content: string }>;
  cost?: number;
}

export interface WorkerHeartbeat {
  workerId: string;
  currentTaskId?: string;
  timestamp: string;
}

export interface AdminUsage {
  totalRuns: number;
  completedRuns: number;
  totalCost: number;
  avgCostPerRun: number;
}

export interface WorkerStatusResponse {
  connected: boolean;
  lastHeartbeat: string | null;
  currentTask: string | null;
}
