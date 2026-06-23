import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Db as Pool } from '../db.js';
import type { PipelineDefinition, StageDefinition, SSEEvent } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA = '"JBSTestOpsAI"';

let cachedDefinition: PipelineDefinition | null = null;
let eventCallback: ((runId: string, event: SSEEvent) => void) | null = null;

export function setEventCallback(cb: (runId: string, event: SSEEvent) => void): void {
  eventCallback = cb;
}

function emitEvent(runId: string, event: SSEEvent): void {
  if (eventCallback) eventCallback(runId, event);
}

export function loadPipelineDefinition(): PipelineDefinition {
  if (cachedDefinition) return cachedDefinition;
  const configPath = path.resolve(__dirname, '../../config/pipeline-definition.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  cachedDefinition = JSON.parse(raw) as PipelineDefinition;
  return cachedDefinition;
}

export async function loadPipelineDefinitionForClient(
  pool: Pool,
  tenantId: string | null,
): Promise<PipelineDefinition> {
  if (tenantId) {
    const { rows } = await pool.query(
      `SELECT definition FROM ${SCHEMA}.qa_pipeline_definitions WHERE tenant_id = $1`,
      [tenantId]
    );
    if (rows[0]) return rows[0].definition as PipelineDefinition;
  }
  return loadPipelineDefinition();
}

export async function savePipelineDefinition(
  pool: Pool,
  tenantId: string | null,
  definition: PipelineDefinition,
  createdBy?: string,
): Promise<void> {
  if (tenantId) {
    await pool.query(
      `MERGE INTO ${SCHEMA}.qa_pipeline_definitions WITH (HOLDLOCK) AS t
       USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
       WHEN MATCHED THEN
         UPDATE SET definition = $2, version = t.version + 1, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (tenant_id, definition, created_by) VALUES ($1, $2, $3);`,
      [tenantId, JSON.stringify(definition), createdBy || 'system']
    );
  } else {
    const configPath = path.resolve(__dirname, '../../config/pipeline-definition.json');
    fs.writeFileSync(configPath, JSON.stringify(definition, null, 2));
    cachedDefinition = definition;
  }
}

function resolveNextStage(
  stageDef: StageDefinition,
  result: 'success' | 'fail',
): string | null {
  if (stageDef.routing?.rules) {
    for (const rule of stageDef.routing.rules) {
      if (rule.when === result) return rule.then;
      if (rule.when === 'has_failures' && result === 'fail') return rule.then;
    }
  }
  return stageDef.next[result] || stageDef.next['default'] || null;
}

export async function processStageCompletion(
  pool: Pool,
  runId: string,
  stageId: string,
  success: boolean,
  resultData: Record<string, unknown>,
  cost: number,
  startedAt: Date,
): Promise<{ nextStage: string | null; action: 'continue' | 'complete' | 'fixme' | 'await_approval' }> {
  const { rows: [run] } = await pool.query(
    `SELECT * FROM ${SCHEMA}.qa_pipeline_runs WHERE id = $1`, [runId]
  );
  if (!run) throw new Error(`Run ${runId} not found`);

  const definition = await loadPipelineDefinitionForClient(pool, run.tenant_id);
  const stageDef = definition.stages.find(s => s.id === stageId);
  if (!stageDef) throw new Error(`Stage ${stageId} not found in definition`);

  const result: 'success' | 'fail' = success ? 'success' : 'fail';
  const duration = Date.now() - startedAt.getTime();

  emitEvent(runId, {
    type: 'stage_complete',
    runId, stage: stageId, result, cost, duration,
    error: success ? undefined : String(resultData.error || ''),
    timestamp: new Date().toISOString(),
  });

  // Handle dry run
  if (resultData.dryRun) {
    await pool.query(
      `UPDATE ${SCHEMA}.qa_pipeline_runs SET status = 'completed', stage = $2 WHERE id = $1`,
      [runId, stageId]
    );
    emitEvent(runId, {
      type: 'pipeline_complete', runId, status: 'completed',
      totalCost: Number(run.cost) + cost, timestamp: new Date().toISOString(),
    });
    return { nextStage: null, action: 'complete' };
  }

  const nextStageId = resolveNextStage(stageDef, result);

  // Terminal
  if (!nextStageId || definition.terminalStates.includes(nextStageId)) {
    const finalStatus = success ? 'completed' : 'fixme';
    await pool.query(
      `UPDATE ${SCHEMA}.qa_pipeline_runs SET status = $2, stage = $3 WHERE id = $1`,
      [runId, finalStatus, stageId]
    );
    emitEvent(runId, {
      type: 'pipeline_complete', runId, status: finalStatus as any,
      totalCost: Number(run.cost) + cost, timestamp: new Date().toISOString(),
    });
    return { nextStage: null, action: finalStatus === 'completed' ? 'complete' : 'fixme' };
  }

  // Check approval mode
  const executionMode = run.execution_mode_live || resultData.executionMode;
  if (executionMode === 'approve-per-stage') {
    await pool.query(
      `UPDATE ${SCHEMA}.qa_pipeline_runs SET status = 'awaiting_approval', stage = $2 WHERE id = $1`,
      [runId, nextStageId]
    );
    emitEvent(runId, {
      type: 'approval_required', runId, stage: nextStageId,
      artifactCount: 0, timestamp: new Date().toISOString(),
    });
    return { nextStage: nextStageId, action: 'await_approval' };
  }

  // Continue
  await pool.query(
    `UPDATE ${SCHEMA}.qa_pipeline_runs SET stage = $2, status = 'running' WHERE id = $1`,
    [runId, nextStageId]
  );

  return { nextStage: nextStageId, action: 'continue' };
}

export function buildDryRunPrompt(
  definition: PipelineDefinition,
  feature: string,
  module: string,
  intent: string,
  targetUrl?: string,
): string {
  const stages = definition.stages.filter(s => s.enabled).map(s => `- ${s.name} (${s.agent}, model: ${s.model})`).join('\n');
  return `DRY RUN — Do NOT perform any real actions. Analyze and report what WOULD happen.

Feature: ${feature}
Module: ${module}
Intent: ${intent}
Target URL: ${targetUrl || 'Not specified'}

Pipeline stages that would execute:
${stages}

Respond with a JSON object: { "dryRun": true, "plan": "<brief description>", "estimatedCost": "<rough estimate>" }`;
}
