import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { runGenerationOnly } from '../agents/pipeline.js';
import { hydrateAnthropicEnv } from '../services/llm-config.service.js';
import { broadcastSSE } from '../services/sse-manager.js';
import { createJob, updateJob, getJob } from '../services/generation-jobs.js';

const router = Router();

const nowIso = () => new Date().toISOString();

/**
 * Map an internal pipeline/Claude error to a friendly, user-facing message.
 * The chat UI must never show raw strings like "timeout of 300000ms exceeded"
 * or stack traces — only these calm, actionable messages.
 */
function mapGenError(err: unknown): { message: string; code: string } {
  const raw = ((err as Error)?.message || String(err || '')).toLowerCase();

  if (raw.includes('not authenticated') || raw.includes('claude_not_authenticated') || raw.includes('not logged in') || raw.includes('not configured')) {
    return {
      code: 'CLAUDE_NOT_AUTHENTICATED',
      message: 'The AI engine isn’t connected right now. Please add a valid Anthropic Claude API key in System Configuration → LLM Configuration, then try again.',
    };
  }
  if (raw.includes('rate limit') || raw.includes('rate_limit') || raw.includes('429')) {
    return {
      code: 'AI_RATE_LIMIT',
      message: 'The AI engine is busy right now (rate limit). Please wait a few seconds and try again.',
    };
  }
  if ((raw.includes('claude') || raw.includes('anthropic')) && raw.includes('not found')) {
    return {
      code: 'CLAUDE_NOT_FOUND',
      message: 'The AI engine isn’t available on the server. Please contact your administrator, then try again.',
    };
  }
  if (raw.includes('timed out') || raw.includes('timeout') || raw.includes('etimedout')) {
    return {
      code: 'AI_TIMEOUT',
      message: 'The AI took longer than expected on this run. Please try again — a single story or a smaller scope usually completes faster.',
    };
  }
  if (raw.includes('no test cases')) {
    return {
      code: 'NO_TEST_CASES',
      message: 'The AI couldn’t produce test cases for this input. Try a different story, or add a little more detail to the requirements.',
    };
  }
  return {
    code: 'GENERATION_FAILED',
    message: 'Something went wrong while generating test cases. Please try again.',
  };
}

/**
 * POST /api/generate
 *
 * Kicks off the multi-stage Claude generation pipeline as a BACKGROUND job and
 * returns a `runId` immediately (202). Progress and the final result/error are
 * streamed over SSE (`/api/pipeline-events/:runId`). The client never holds a
 * long request open, so it can no longer hit an axios timeout — which was the
 * root cause of the "timeout of 300000ms exceeded" failures.
 */
router.post('/', async (req: Request, res: Response) => {
  const {
    requirements,
    testType,
    maxTestCases,
    targetUrl,
    appName,
    environment,
    roles,
    exploreMode,
  } = req.body;

  // Preflight: the generation agents call the Anthropic API with no offline
  // fallback. Resolve + load the API key configured in LLM Configuration for
  // this tenant, then fail fast with an actionable code if none is available.
  await hydrateAnthropicEnv(req.user?.tenantId ?? null);
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({
      error: 'AI engine not connected. Add your Anthropic Claude API key in System Configuration → LLM Configuration, then retry.',
      code: 'CLAUDE_NOT_AUTHENTICATED',
    });
    return;
  }

  const reqText = exploreMode === true
    ? ''
    : (requirements || `Generate ${testType || 'general'} tests`);
  const parsedMax = Number(maxTestCases);

  const appContext = targetUrl || appName || environment || (Array.isArray(roles) && roles.length > 0)
    ? {
        targetUrl,
        appName,
        environment,
        roles: Array.isArray(roles)
          ? roles.filter((r: any) => r && typeof r === 'object').map((r: any) => ({
              roleName: String(r.roleName || 'user'),
              username: String(r.username || ''),
              password: String(r.password || ''),
            }))
          : undefined,
      }
    : undefined;

  // Bound interactive generation with a sane default so a single pass completes
  // quickly. Callers wanting exhaustive coverage can pass an explicit higher
  // maxTestCases.
  const DEFAULT_MAX_TEST_CASES = 15;
  const effectiveMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_TEST_CASES;

  const runId = crypto.randomUUID();
  createJob(runId, req.user?.tenantId);
  // Respond right away — the work continues in the background below.
  res.status(202).json({ runId });

  // Fire-and-forget. The response is already sent; failures are captured into
  // the job + broadcast over SSE, never thrown to a closed response.
  void (async () => {
    try {
      const state = await runGenerationOnly(reqText, {
        maxTestCases: effectiveMax,
        appContext,
        onProgress: (stage, status, detail) => {
          updateJob(runId, { stage, detail });
          broadcastSSE(runId, { type: 'gen_stage', runId, stage, status, detail, timestamp: nowIso() });
        },
      });

      const result = {
        testCases: state.testCases,
        automationScripts: state.automationScripts,
        testPlan: state.testPlan,
        extendedTestPlan: state.extendedTestPlan,
        parsedRequirements: state.parsedRequirements,
        exploredApp: state.exploredApp || null,
        summary: {
          totalTestCases: state.testCases.length,
          totalScripts: state.automationScripts.length,
          features: state.parsedRequirements?.features || [],
          exploreRan: Boolean(state.exploredApp),
        },
      };

      updateJob(runId, { status: 'done', result, stage: 'test-design', detail: 'Completed' });
      broadcastSSE(runId, { type: 'generation_complete', runId, timestamp: nowIso() });
    } catch (err) {
      const { message, code } = mapGenError(err);
      console.error('[generate] Pipeline error:', (err as Error)?.message || err);
      updateJob(runId, { status: 'error', error: message, code });
      broadcastSSE(runId, { type: 'generation_error', runId, error: message, code, timestamp: nowIso() });
    }
  })();
});

/**
 * GET /api/generate/result/:runId
 *
 * Returns the job's status + final result (or friendly error). Used by the
 * frontend as the completion fetch and as a poll fallback if an SSE event is
 * missed. Scoped to the requesting tenant. (Mounted behind authMiddleware.)
 */
router.get('/result/:runId', (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const job = getJob(runId);
  if (!job || (job.tenantId && req.user?.tenantId && job.tenantId !== req.user.tenantId)) {
    res.status(404).json({
      status: 'unknown',
      error: 'This generation run is no longer available. Please start a new generation.',
    });
    return;
  }
  res.json({
    status: job.status,
    stage: job.stage,
    detail: job.detail,
    result: job.status === 'done' ? job.result : undefined,
    error: job.status === 'error' ? job.error : undefined,
    code: job.code,
  });
});

export default router;
