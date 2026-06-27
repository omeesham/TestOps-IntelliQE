import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import {
  createPipelineRun, getPipelineRun, listPipelineRuns, updatePipelineRun,
  getStageResults, getArtifacts, createWorkerTask, createStageResult,
  getPageBySlug, createPage, checkPageConcurrency, upsertPageStageStatus,
} from '../services/pipeline-queries.js';
import { loadPipelineDefinition, loadPipelineDefinitionForClient, buildDryRunPrompt, processStageCompletion } from '../orchestrator/orchestrator.js';
import { checkPageReadiness, buildCascadePlan } from '../orchestrator/dependency-engine.js';
import { broadcastSSE } from '../services/sse-manager.js';

const router = Router();

/** Tenant ownership guard: platform users see all runs; everyone else is
 *  restricted to their own tenant. Responds 404 (not 403) so a run's existence
 *  isn't disclosed across tenants. Returns true when access is allowed. */
function ownsRun(req: Request, run: any, res: Response): boolean {
  const u = (req as any).user;
  if (u?.isPlatform || run?.tenant_id === u?.tenantId) return true;
  res.status(404).json({ error: 'Run not found' });
  return false;
}

// Helper: build stage prompt
function buildStagePrompt(stageDef: any, run: any, intent: string, targetUrl?: string): string {
  return `Stage: ${stageDef.name} (${stageDef.id})
Agent: ${stageDef.agent}
Feature: ${run.feature}
Module: ${run.module}
Intent: ${intent}
Target URL: ${targetUrl || run.target_url || 'Not specified'}

${stageDef.description || ''}

Execute this pipeline stage and return results as JSON.`;
}

// Helper: detect start stage
function detectStartStage(definition: any, startStage?: string): string {
  if (startStage) {
    const stage = definition.stages.find((s: any) => s.id === startStage && s.enabled);
    if (stage) return stage.id;
  }
  const first = definition.stages.find((s: any) => s.enabled);
  return first?.id || 'requirements';
}

// POST /run — Create a new pipeline run
router.post('/run', async (req: Request, res: Response) => {
  try {
    const { feature, module, intent, priority, targetUrl, dryRun, executionMode, startStage, pageId, pageSlug, pageName } = req.body;
    const tenantId = (req as any).user?.tenantId;

    if (!feature || !module || !intent) {
      res.status(400).json({ error: 'feature, module, and intent are required' });
      return;
    }

    const isDryRun = dryRun || executionMode === 'dry-run';
    const definition = await loadPipelineDefinitionForClient(pool, tenantId || null);
    const firstStageId = detectStartStage(definition, startStage);
    const stageDef = definition.stages.find(s => s.id === firstStageId);
    if (!stageDef) { res.status(400).json({ error: `Stage ${firstStageId} not found` }); return; }

    // Resolve page
    let resolvedPageId = pageId || null;
    if (!resolvedPageId && pageSlug) {
      let page = await getPageBySlug(pool, tenantId || null, module, pageSlug);
      if (!page) {
        page = await createPage(pool, { tenant_id: tenantId, module, page_slug: pageSlug, display_name: pageName || pageSlug, target_url: targetUrl });
      }
      resolvedPageId = page.id;
    }

    // Create run
    const modeStr = isDryRun ? 'dry-run' : (executionMode || 'full-auto');
    const run = await createPipelineRun(pool, {
      tenant_id: tenantId, feature, module, intent,
      target_url: targetUrl, priority, page_id: resolvedPageId,
      execution_mode_live: modeStr,
    });

    // Update run to running
    await updatePipelineRun(pool, run.id, { stage: firstStageId, status: 'running' });

    // Build prompt
    const prompt = isDryRun
      ? buildDryRunPrompt(definition, feature, module, intent, targetUrl)
      : buildStagePrompt(stageDef, run, intent, targetUrl);

    // Create stage result
    await createStageResult(pool, run.id, firstStageId, stageDef.retries || 1, stageDef.model);

    // Enqueue worker task
    await createWorkerTask(pool, run.id, tenantId || null, firstStageId, prompt, {
      targetUrl, module, feature, dryRun: isDryRun, executionMode: modeStr,
      stageConfig: {
        model: stageDef.model, maxTurns: stageDef.maxTurns,
        timeoutSeconds: stageDef.timeoutSeconds, budgetCap: stageDef.budgetCap,
        agentFile: stageDef.agentFile, mcpConfig: stageDef.mcpConfig || null,
        allowedTools: stageDef.allowedTools, effort: stageDef.effort,
      },
    });

    // Update page stage status
    if (resolvedPageId) {
      await upsertPageStageStatus(pool, resolvedPageId, firstStageId, { status: 'running', active_run_id: run.id });
    }

    // Emit SSE
    broadcastSSE(run.id, {
      type: 'stage_start', runId: run.id, stage: firstStageId,
      agent: stageDef.agent, model: stageDef.model, attempt: 1,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ runId: run.id });
  } catch (err: any) {
    console.error('Pipeline run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /list — List pipeline runs
router.get('/list', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenantId;
    const status = req.query.status as string | undefined;
    const runs = await listPipelineRuns(pool, tenantId, status);
    res.json(runs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id — Get pipeline run detail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const run = await getPipelineRun(pool, req.params.id as string);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, run, res)) return;
    const [stages, artifacts] = await Promise.all([
      getStageResults(pool, run.id),
      getArtifacts(pool, run.id),
    ]);
    res.json({ ...run, stages, artifacts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/cancel
router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const existing = await getPipelineRun(pool, req.params.id as string);
    if (!existing) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, existing, res)) return;
    const run = await updatePipelineRun(pool, req.params.id as string, { status: 'cancelled' });
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    broadcastSSE(run.id, { type: 'pipeline_complete', runId: run.id, status: 'cancelled', totalCost: Number(run.cost), timestamp: new Date().toISOString() });
    res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const run = await getPipelineRun(pool, req.params.id as string);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, run, res)) return;
    if (run.status !== 'awaiting_approval') { res.status(400).json({ error: 'Run is not awaiting approval' }); return; }

    const definition = await loadPipelineDefinitionForClient(pool, run.tenant_id);
    const stageDef = definition.stages.find(s => s.id === run.stage);
    if (!stageDef) { res.status(400).json({ error: 'Current stage not found' }); return; }

    await updatePipelineRun(pool, run.id, { status: 'running' });

    const prompt = buildStagePrompt(stageDef, run, run.intent, run.target_url || undefined);
    await createStageResult(pool, run.id, run.stage, stageDef.retries || 1, stageDef.model);
    await createWorkerTask(pool, run.id, run.tenant_id, run.stage, prompt, {
      targetUrl: run.target_url, module: run.module, feature: run.feature,
      executionMode: run.execution_mode_live,
    });

    broadcastSSE(run.id, { type: 'stage_start', runId: run.id, stage: run.stage, agent: stageDef.agent, model: stageDef.model, attempt: 1, timestamp: new Date().toISOString() });
    res.json({ approved: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/reject
router.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const existing = await getPipelineRun(pool, req.params.id as string);
    if (!existing) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, existing, res)) return;
    const run = await updatePipelineRun(pool, req.params.id as string, { status: 'cancelled' });
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    broadcastSSE(run.id, { type: 'pipeline_complete', runId: run.id, status: 'cancelled', totalCost: Number(run.cost), timestamp: new Date().toISOString() });
    res.json({ rejected: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/steer — Send guidance to running pipeline
router.post('/:id/steer', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    const run = await getPipelineRun(pool, req.params.id as string);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, run, res)) return;
    broadcastSSE(run.id, { type: 'agent_progress', runId: run.id, stage: run.stage, message: `User guidance: ${message}`, timestamp: new Date().toISOString() });
    res.json({ steered: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /:id/mode — Switch execution mode
router.patch('/:id/mode', async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    const existing = await getPipelineRun(pool, req.params.id as string);
    if (!existing) { res.status(404).json({ error: 'Run not found' }); return; }
    if (!ownsRun(req, existing, res)) return;
    const run = await updatePipelineRun(pool, req.params.id as string, { execution_mode_live: mode });
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    broadcastSSE(run.id, { type: 'mode_switched', runId: run.id, mode, timestamp: new Date().toISOString() });
    res.json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
