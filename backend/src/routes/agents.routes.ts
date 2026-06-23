import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { listPipelineRuns, isWorkerConnected } from '../services/pipeline-queries.js';
import { loadPipelineDefinitionForClient } from '../orchestrator/orchestrator.js';

const SCHEMA = '"JBSTestOpsAI"';
const router = Router();

router.get('/status', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;

    // Fetch real agent types from DB
    const { rows: agentTypes } = await pool.query(
      `SELECT * FROM ${SCHEMA}.qa_agent_types WHERE enabled = 1 ORDER BY sort_order`
    );

    // Get running tasks to determine agent statuses
    const { rows: runningTasks } = await pool.query(
      `SELECT stage_id, COUNT(*) as count FROM ${SCHEMA}.qa_worker_tasks
       WHERE status IN ('pending', 'claimed') GROUP BY stage_id`
    );
    const taskCounts = new Map(runningTasks.map((r: any) => [r.stage_id, Number(r.count)]));

    // Get pipeline definition for config
    const definition = await loadPipelineDefinitionForClient(pool, tenantId || null);

    const agents = agentTypes.map((a: any) => {
      const queueSize = taskCounts.get(a.id) || 0;
      const stageDef = definition.stages.find(s => s.id === a.id);
      return {
        id: a.id,
        name: a.name,
        agentFile: a.agent_file,
        status: queueSize > 0 ? 'running' : 'idle',
        description: a.description,
        model: `Claude ${a.default_model}`,
        icon: a.icon,
        pipelineOrder: a.sort_order,
        queueSize,
        enabled: a.enabled,
        capabilities: a.capabilities || [],
        maxTurns: stageDef?.maxTurns || 50,
        timeoutSeconds: stageDef?.timeoutSeconds || 600,
      };
    });

    const active = agents.filter((a: any) => a.status === 'running').length;
    const workerConnected = isWorkerConnected();

    res.json({
      agents,
      pipelineConfig: {
        autoInvoke: { enabled: definition.defaults.autoInvoke },
        agentRunner: definition.defaults.agentRunner,
        workerConnected,
      },
      summary: { total: agents.length, active, idle: agents.length - active },
    });
  } catch (err: any) {
    console.error('Agent status error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const runs = await listPipelineRuns(pool, tenantId, undefined, 20);

    const queue = runs.map(run => ({
      id: run.id,
      feature: run.feature,
      module: run.module,
      stage: run.stage,
      status: run.status,
      priority: run.priority,
      intent: run.intent,
      targetUrl: run.target_url,
      cost: Number(run.cost),
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    }));

    res.json({ queue, config: { maxRetries: 3, autoHealOnFailure: true } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { feature, module, intent, priority, targetUrl } = req.body;
    const tenantId = (req as any).user?.tenantId;

    // This is now handled by POST /api/pipeline/run
    // For backwards compatibility, redirect to pipeline creation
    const { createPipelineRun, updatePipelineRun, createWorkerTask, createStageResult } = await import('../services/pipeline-queries.js');
    const { loadPipelineDefinitionForClient: loadDef } = await import('../orchestrator/orchestrator.js');

    const definition = await loadDef(pool, tenantId || null);
    const firstStage = definition.stages.find(s => s.enabled);
    if (!firstStage) { res.status(500).json({ error: 'No enabled stages' }); return; }

    const run = await createPipelineRun(pool, {
      tenant_id: tenantId, feature: feature || 'Unknown', module: module || 'general',
      intent: intent || '', target_url: targetUrl, priority: priority || 'medium',
      execution_mode_live: 'full-auto',
    });

    await updatePipelineRun(pool, run.id, { stage: firstStage.id, status: 'running' });
    await createStageResult(pool, run.id, firstStage.id, firstStage.retries || 1, firstStage.model);

    const prompt = `Stage: ${firstStage.name}\nFeature: ${feature}\nModule: ${module}\nIntent: ${intent}\n${firstStage.description}`;
    await createWorkerTask(pool, run.id, tenantId || null, firstStage.id, prompt, {
      targetUrl, module, feature,
      stageConfig: { model: firstStage.model, maxTurns: firstStage.maxTurns, timeoutSeconds: firstStage.timeoutSeconds, budgetCap: firstStage.budgetCap, agentFile: firstStage.agentFile, mcpConfig: firstStage.mcpConfig || null },
    });

    res.json({ message: 'Pipeline run created', runId: run.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/restart', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${SCHEMA}.qa_agent_types WHERE id = $1`, [req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json({ message: `Agent ${rows[0].name} restart requested`, agent: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
