/**
 * Public business-capability API (HIPAA architecture boundary).
 *
 * Per the JBS HIPAA Enterprise Architecture Guide, customer applications
 * should call business-capability APIs only — internal orchestration logic
 * stays hidden. This router exposes five HIPAA-doc-prescribed endpoints:
 *
 *   POST /api/v1/public/requirements/analyze    — start from requirements
 *   POST /api/v1/public/tests/plan              — generate a test plan
 *   POST /api/v1/public/scripts/generate        — generate automation scripts
 *   POST /api/v1/public/scripts/heal            — self-heal failed scripts
 *   POST /api/v1/public/results/evaluate        — quality evaluation
 *
 * Each endpoint validates input with zod, then delegates to the internal
 * pipeline orchestrator. The auth middleware applied at mount time stamps
 * tenant context; the audit middleware records every call.
 *
 * Response shape is uniform: `{ runId, status: 'queued', pollUrl }`.
 * Callers poll `GET /api/pipeline/:runId` to track progress, or subscribe
 * via SSE at `/api/pipeline-events/:runId`.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import pool from '../../db.js';
import {
  createPipelineRun as createPipelineRunRow,
  createStageResult,
  createWorkerTask,
} from '../../services/pipeline-queries.js';
import { loadPipelineDefinitionForClient } from '../../orchestrator/orchestrator.js';

const router = Router();

/* ── Shared validation helpers ────────────────────────────────── */

const RequirementsSchema = z.object({
  feature: z.string().min(1).max(500),
  module: z.string().min(1).max(200),
  intent: z.string().min(1).max(2000),
  targetUrl: z.string().url().optional(),
});

const PlanSchema = RequirementsSchema.extend({
  requirements: z.array(z.string()).min(1),
});

const GenerateSchema = RequirementsSchema.extend({
  testCases: z.array(z.unknown()).min(1),
});

const HealSchema = z.object({
  runId: z.string().uuid().optional(),
  feature: z.string().min(1).max(500),
  module: z.string().min(1).max(200),
  failureContext: z.string().min(1),
});

const EvaluateSchema = z.object({
  runId: z.string().uuid(),
});

/* ── Helper: kick off a pipeline run at a specific stage ─────── */

async function startAt(
  req: Request,
  startStage: 'requirements' | 'planning' | 'generation' | 'healing' | 'audit',
  payload: { feature: string; module: string; intent: string; targetUrl?: string; extras?: Record<string, unknown> },
): Promise<{ runId: string }> {
  const tenantId = req.user!.tenantId;
  const username = req.user!.username;

  const run = await createPipelineRunRow(pool, {
    tenant_id: tenantId,
    feature: payload.feature,
    module: payload.module,
    intent: payload.intent,
    target_url: payload.targetUrl || null,
    priority: 'medium',
    execution_mode_live: 'full-auto',
  });

  const definition = await loadPipelineDefinitionForClient(pool, tenantId);
  const stageDef = definition.stages.find((s) => s.id === startStage);
  if (!stageDef) {
    throw new Error(`Stage "${startStage}" not defined in pipeline-definition.json`);
  }

  const prompt =
    `Stage: ${stageDef.name} (${startStage})\n` +
    `Agent: ${stageDef.agent}\n` +
    `Feature: ${payload.feature}\n` +
    `Module: ${payload.module}\n` +
    `Intent: ${payload.intent}\n` +
    (payload.targetUrl ? `Target URL: ${payload.targetUrl}\n` : '') +
    '\n' +
    (stageDef.description || '') +
    '\n\nExecute this pipeline stage and return results as JSON.';

  await createStageResult(pool, run.id, startStage, stageDef.retries || 1, stageDef.model);
  await createWorkerTask(pool, run.id, tenantId, startStage, prompt, {
    targetUrl: payload.targetUrl,
    module: payload.module,
    feature: payload.feature,
    executionMode: 'full-auto',
    initiatedBy: username,
    ...payload.extras,
  });

  return { runId: run.id };
}

function uniformResponse(runId: string, req: Request): object {
  return {
    runId,
    status: 'queued' as const,
    pollUrl: `/api/pipeline/${runId}`,
    eventsUrl: `/api/pipeline-events/${runId}`,
    requestId: req.requestId,
  };
}

/* ── Endpoints ───────────────────────────────────────────────── */

router.post('/requirements/analyze', async (req: Request, res: Response) => {
  const parsed = RequirementsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }
  try {
    const { runId } = await startAt(req, 'requirements', parsed.data);
    res.status(202).json(uniformResponse(runId, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tests/plan', async (req: Request, res: Response) => {
  const parsed = PlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }
  try {
    const { runId } = await startAt(req, 'planning', {
      ...parsed.data,
      extras: { requirements: parsed.data.requirements },
    });
    res.status(202).json(uniformResponse(runId, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scripts/generate', async (req: Request, res: Response) => {
  const parsed = GenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }
  try {
    const { runId } = await startAt(req, 'generation', {
      ...parsed.data,
      extras: { testCases: parsed.data.testCases },
    });
    res.status(202).json(uniformResponse(runId, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/scripts/heal', async (req: Request, res: Response) => {
  const parsed = HealSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }
  try {
    const { runId } = await startAt(req, 'healing', {
      feature: parsed.data.feature,
      module: parsed.data.module,
      intent: 'Self-heal failing tests',
      extras: { failureContext: parsed.data.failureContext, sourceRunId: parsed.data.runId },
    });
    res.status(202).json(uniformResponse(runId, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/results/evaluate', async (req: Request, res: Response) => {
  const parsed = EvaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT feature, module, intent, target_url FROM "JBSTestOpsAI".qa_pipeline_runs
       WHERE id = $1 AND tenant_id = $2`,
      [parsed.data.runId, req.user!.tenantId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    const src = rows[0];
    const { runId } = await startAt(req, 'audit', {
      feature: src.feature,
      module: src.module,
      intent: src.intent,
      targetUrl: src.target_url,
      extras: { sourceRunId: parsed.data.runId },
    });
    res.status(202).json(uniformResponse(runId, req));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
