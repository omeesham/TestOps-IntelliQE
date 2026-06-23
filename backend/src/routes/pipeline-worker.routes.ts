import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { workerAuthMiddleware } from '../middleware/worker-auth.middleware.js';
import {
  claimNextTask, completeWorkerTask, createArtifact, incrementRunCost,
  recordHeartbeat, consumePendingWorkerCommand, getPipelineRun, createStageResult,
  createWorkerTask,
} from '../services/pipeline-queries.js';
import { classifyFailure } from '../orchestrator/failure-classifier.js';
import { processStageCompletion } from '../orchestrator/orchestrator.js';
import { loadPipelineDefinitionForClient } from '../orchestrator/orchestrator.js';
import { broadcastSSE } from '../services/sse-manager.js';
import { decryptStored } from '../utils/crypto.js';

const router = Router();
router.use(workerAuthMiddleware);

/**
 * Look up the tenant's own Anthropic API key (HIPAA-architecture pattern:
 * customer-owned LLM credentials). Returns the decrypted plaintext key, or
 * null if the tenant has not configured one. Worker falls back to the
 * platform-default key when null.
 */
async function getTenantAnthropicKey(tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT anthropic_api_key FROM "JBSTestOpsAI".tenants WHERE id = $1`,
      [tenantId],
    );
    const stored = rows[0]?.anthropic_api_key as string | null;
    if (!stored) return null;
    return decryptStored(stored);
  } catch {
    return null;
  }
}

// GET /next-task — Worker polls for next task
router.get('/next-task', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenant_id as string | undefined;
    const task = await claimNextTask(pool, tenantId);
    if (!task) { res.json(null); return; }

    // Look up stage config from pipeline definition
    const run = await getPipelineRun(pool, task.run_id);
    let stageConfig = null;
    if (run) {
      const definition = await loadPipelineDefinitionForClient(pool, run.tenant_id);
      const stageDef = definition.stages.find(s => s.id === task.stage_id);
      if (stageDef) {
        stageConfig = {
          model: stageDef.model,
          maxTurns: stageDef.maxTurns,
          timeoutSeconds: stageDef.timeoutSeconds,
          budgetCap: stageDef.budgetCap,
          agentFile: stageDef.agentFile,
          mcpConfig: stageDef.mcpConfig || null,
          allowedTools: stageDef.allowedTools,
          effort: stageDef.effort,
        };
      }
    }

    // Fetch tenant's own Anthropic key; if none, worker falls back to env var.
    const tenantApiKey = await getTenantAnthropicKey(task.tenant_id);

    res.json({
      taskId: task.id,
      stageId: task.stage_id,
      agentPrompt: task.agent_prompt,
      context: task.context,
      runId: task.run_id,
      tenantId: task.tenant_id,
      tenantApiKey, // plaintext over the wire is acceptable here — this is an
                    // internal worker-only endpoint behind WORKER_SECRET and TLS.
      stageConfig,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /complete-task — Worker reports task completion
router.post('/complete-task', async (req: Request, res: Response) => {
  try {
    const { taskId, success, result, artifacts, cost } = req.body;
    if (!taskId) { res.status(400).json({ error: 'taskId required' }); return; }

    const task = await completeWorkerTask(pool, taskId, success, result || {});
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

    // Save artifacts
    if (artifacts && Array.isArray(artifacts)) {
      const run = await getPipelineRun(pool, task.run_id);
      for (const art of artifacts) {
        await createArtifact(pool, task.run_id, art.name, art.type, art.content, run?.page_id);
      }
    }

    // Increment cost
    if (cost && cost > 0) {
      await incrementRunCost(pool, task.run_id, cost);
    }

    // Classify failure if needed
    let classification = null;
    if (!success && result) {
      classification = classifyFailure(result);
    }

    // Process stage completion (advance pipeline)
    const run = await getPipelineRun(pool, task.run_id);
    if (run) {
      const startedAt = task.claimed_at ? new Date(task.claimed_at) : new Date();
      const { nextStage, action } = await processStageCompletion(
        pool, task.run_id, task.stage_id, success, result || {}, cost || 0, startedAt,
      );

      // If pipeline should continue, enqueue next stage
      if (action === 'continue' && nextStage) {
        const definition = await loadPipelineDefinitionForClient(pool, run.tenant_id);
        const nextStageDef = definition.stages.find(s => s.id === nextStage);
        if (nextStageDef) {
          const prompt = `Stage: ${nextStageDef.name} (${nextStage})
Agent: ${nextStageDef.agent}
Feature: ${run.feature}
Module: ${run.module}
Intent: ${run.intent}
Target URL: ${run.target_url || 'Not specified'}

${nextStageDef.description || ''}

Execute this pipeline stage and return results as JSON.`;

          await createStageResult(pool, run.id, nextStage, nextStageDef.retries || 1, nextStageDef.model);
          await createWorkerTask(pool, run.id, run.tenant_id, nextStage, prompt, {
            targetUrl: run.target_url, module: run.module, feature: run.feature,
            executionMode: run.execution_mode_live,
          });

          broadcastSSE(run.id, {
            type: 'stage_start', runId: run.id, stage: nextStage,
            agent: nextStageDef.agent, model: nextStageDef.model, attempt: 1,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    res.json({ ok: true, classification });
  } catch (err: any) {
    console.error('complete-task error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /progress — Worker reports progress
router.post('/progress', async (req: Request, res: Response) => {
  try {
    const { runId, stage, message } = req.body;
    if (runId && message) {
      broadcastSSE(runId, { type: 'agent_progress', runId, stage: stage || '', message, timestamp: new Date().toISOString() });
    }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// POST /heartbeat
router.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const { workerId, currentTaskId } = req.body;
    recordHeartbeat(workerId || 'unknown', currentTaskId);
    const command = consumePendingWorkerCommand(workerId || 'unknown');
    broadcastSSE('__global__', { type: 'worker_status', connected: true, timestamp: new Date().toISOString() });
    res.json({ ok: true, command: command || undefined });
  } catch { res.json({ ok: true }); }
});

export default router;
