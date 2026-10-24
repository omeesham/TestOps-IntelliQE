import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { runGenerationOnly } from '../agents/pipeline.js';
import { COVERAGE_LEVELS } from '../agents/state.js';
import type { CoverageLevel } from '../agents/state.js';
import { isClaudeCliAuthenticated } from '../agents/claude-runner.js';
import { broadcastSSE } from '../services/sse-manager.js';
import { createJob, updateJob, getJob } from '../services/generation-jobs.js';
import { getConfigsForTenant } from '../services/configurations.service.js';
import { pickEnvironment, decryptRoles, readOnlyEnvironmentForUrl } from '../services/app-environments.js';
import type { SafetySettings } from '../services/uat-safety.service.js';
import { testDataContext } from '../services/test-data.service.js';
import { suggestPrompts, AssistRateLimit, MAX_PROMPT_CHARS } from '../services/prompt-assist.service.js';

const router = Router();

/* ───────────────────────────────────────────
   POST /api/generate/suggest-prompts
   Body: { text, appName?, environment? }
   Returns up to 3 improved versions of the user's requirement text.
   ─────────────────────────────────────────── */
const assistLimit = new AssistRateLimit(10, 60_000);

router.post('/suggest-prompts', async (req: Request, res: Response) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length < 10) {
    res.status(400).json({ error: 'Write a little more first (at least 10 characters).' });
    return;
  }
  if (text.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `Suggestions work on up to ${MAX_PROMPT_CHARS} characters. Shorten the text or generate directly.` });
    return;
  }
  if (!assistLimit.allow(req.user!.username)) {
    res.status(429).json({ error: 'Too many suggestions requested. Try again in a minute.' });
    return;
  }
  if (!isClaudeCliAuthenticated()) {
    res.status(503).json({ error: 'The AI engine is not connected right now.' });
    return;
  }
  try {
    const suggestions = await suggestPrompts(text, {
      appName: typeof req.body?.appName === 'string' ? req.body.appName : undefined,
      environment: typeof req.body?.environment === 'string' ? req.body.environment : undefined,
    });
    if (!suggestions.length) {
      res.status(502).json({ error: 'No suggestions came back. Please try again.' });
      return;
    }
    res.json({ suggestions });
  } catch (err) {
    console.error('[generate/suggest-prompts] failed:', (err as Error).message);
    res.status(502).json({ error: 'Could not get suggestions right now. Please try again.' });
  }
});

const nowIso = () => new Date().toISOString();

interface ResolvedRole { roleName: string; username: string; password: string }
interface ResolvedAppContext {
  /** Uploaded test files of the application (names only). */
  testDataFiles?: string[];
  /** Read-only protection of the environment; undefined when off. */
  safety?: SafetySettings;
  targetUrl?: string;
  appName?: string;
  environment?: string;
  roles?: ResolvedRole[];
  /** Mobile path only — drives native-mobile test generation. */
  platform?: 'android' | 'ios';
  appMetadata?: {
    packageName?: string;
    bundleId?: string;
    mainActivity?: string;
    versionName?: string;
    permissions?: string[];
    fileName?: string;
  };
}

/**
 * Merge a saved Application Setup config (looked up by `appId`) into the
 * app context the client sent. The client only ever transmits non-sensitive
 * fields (URL, app name, username) — the role PASSWORD lives encrypted at rest
 * and is decrypted here, server-side, so it never reaches the browser.
 *
 * Precedence: explicit client values win; saved values fill the gaps. A blank
 * client password for a known username is back-filled from the saved role.
 */
async function resolveAppContextFromConfig(
  tenantId: string,
  appId: string,
  envId: string | undefined,
  incoming: ResolvedAppContext | undefined,
): Promise<ResolvedAppContext | undefined> {
  const configs = await getConfigsForTenant(tenantId);
  const cfg = configs.find((c) => c.integrationId === appId && c.integrationId.startsWith('app-'));
  if (!cfg) return incoming;

  const data = cfg.configData || {};
  const env = pickEnvironment(data, envId);
  if (envId && !env) throw new UnknownEnvironmentError(String(data.appName || appId), envId);

  // decryptStoredDeep handles both __AES__ and legacy __ENC__ values.
  const storedRoles: ResolvedRole[] = env ? decryptRoles(env.roles) : [];

  const incomingRoles = incoming?.roles?.filter((r) => r && r.username) || [];
  let roles: ResolvedRole[];
  if (incomingRoles.length === 0) {
    // Client gave no usable credentials — use the saved roles wholesale.
    roles = storedRoles.filter((r) => r.username);
  } else {
    // Back-fill a missing password only from the saved role with the same
    // username, never from a different user.
    roles = incomingRoles.map((r) => {
      if (r.password) return r;
      const match = storedRoles.find((s) => s.username === r.username);
      return { ...r, password: match?.password || '' };
    });
  }

  return {
    targetUrl: incoming?.targetUrl || env?.baseUrl || '',
    appName: incoming?.appName || String(data.appName || ''),
    environment: incoming?.environment || env?.name || '',
    roles: roles.length ? roles : undefined,
    safety: env?.safety,
  };
}

class UnknownEnvironmentError extends Error {
  constructor(appName: string, envId: string) {
    super(`The environment "${envId}" of ${appName} was not found or has no URL. Pick an environment in Application Setup and try again.`);
  }
}

/**
 * Map an internal pipeline/Claude error to a friendly, user-facing message.
 * The chat UI must never show raw strings like "timeout of 300000ms exceeded"
 * or stack traces — only these calm, actionable messages.
 */
function mapGenError(err: unknown): { message: string; code: string } {
  const raw = ((err as Error)?.message || String(err || '')).toLowerCase();

  if (raw.includes('could not open the application')) {
    return {
      code: 'APP_UNREACHABLE',
      message: `IntelliQE could not open the application, so no test cases were generated. Check the URL and that the app is running, then try again. (${(err as Error).message.replace(/^could not open the application at /i, '')})`,
    };
  }

  if (raw.includes('not authenticated') || raw.includes('claude_not_authenticated') || raw.includes('not logged in')) {
    return {
      code: 'CLAUDE_NOT_AUTHENTICATED',
      message: 'The AI engine isn’t connected right now. Please make sure ANTHROPIC_API_KEY is set on the server (or the Claude CLI is signed in), then try again.',
    };
  }
  if (raw.includes('rate limit') || raw.includes('rate_limit') || raw.includes('429')) {
    return {
      code: 'AI_RATE_LIMIT',
      message: 'The AI engine is busy right now (rate limit). Please wait a few seconds and try again.',
    };
  }
  if (raw.includes('claude') && raw.includes('not found')) {
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
    appId,
    envId,
    platform,
    appMetadata,
    coverage,
  } = req.body;
  const coverageLevel: CoverageLevel = (COVERAGE_LEVELS as readonly string[]).includes(coverage) ? coverage : 'standard';

  // Mobile path: only accept the two supported native platforms.
  const mobilePlatform: 'android' | 'ios' | undefined =
    platform === 'android' || platform === 'ios' ? platform : undefined;

  // Preflight: the generation agents call Claude with no offline fallback, so a
  // logged-out CLI yields an opaque failure. Fail fast with an actionable code.
  if (!isClaudeCliAuthenticated()) {
    res.status(503).json({
      error: 'AI engine not connected. Set ANTHROPIC_API_KEY in the backend environment (recommended — create one at console.anthropic.com), or sign in the Claude CLI with `claude auth login --claudeai` on the server, then retry.',
      code: 'CLAUDE_NOT_AUTHENTICATED',
    });
    return;
  }

  const reqText = exploreMode === true
    ? ''
    : (requirements || `Generate ${testType || 'general'} tests`);
  const parsedMax = Number(maxTestCases);

  let appContext: ResolvedAppContext | undefined =
    targetUrl || appName || environment || mobilePlatform || (Array.isArray(roles) && roles.length > 0)
      ? {
          targetUrl,
          appName,
          environment,
          platform: mobilePlatform,
          appMetadata: mobilePlatform && appMetadata && typeof appMetadata === 'object'
            ? {
                packageName: appMetadata.packageName ? String(appMetadata.packageName) : undefined,
                bundleId: appMetadata.bundleId ? String(appMetadata.bundleId) : undefined,
                mainActivity: appMetadata.mainActivity ? String(appMetadata.mainActivity) : undefined,
                versionName: appMetadata.versionName ? String(appMetadata.versionName) : undefined,
                permissions: Array.isArray(appMetadata.permissions)
                  ? appMetadata.permissions.map((p: any) => String(p)).slice(0, 60)
                  : undefined,
                fileName: appMetadata.fileName ? String(appMetadata.fileName) : undefined,
              }
            : undefined,
          roles: Array.isArray(roles)
            ? roles.filter((r: any) => r && typeof r === 'object').map((r: any) => ({
                roleName: String(r.roleName || 'user'),
                username: String(r.username || ''),
                password: String(r.password || ''),
              }))
            : undefined,
        }
      : undefined;

  // When the client references a saved application (Application Setup), resolve
  // its URL + credentials server-side. The role password is never sent by the
  // browser — it's decrypted here from at-rest storage. Client values win.
  if (appId && req.user?.tenantId) {
    try {
      appContext = await resolveAppContextFromConfig(req.user.tenantId, String(appId), typeof envId === 'string' && envId ? envId : undefined, appContext);
      if (appContext) appContext = { ...appContext, ...(await testDataContext(req.user.tenantId, String(appId))) };
    } catch (err) {
      if (err instanceof UnknownEnvironmentError) {
        res.status(400).json({ error: err.message, code: 'UNKNOWN_ENVIRONMENT' });
        return;
      }
      console.error('[generate] Failed to resolve app config for', appId, '-', (err as Error)?.message || err);
      // Non-fatal: fall through with whatever the client supplied.
    }
  }

  // A URL that belongs to a read-only environment stays read-only, however it was entered.
  if (appContext?.targetUrl && !appContext.safety && req.user?.tenantId) {
    const env = readOnlyEnvironmentForUrl(await getConfigsForTenant(req.user.tenantId), appContext.targetUrl);
    if (env) appContext = { ...appContext, safety: env.safety };
  }

  // Suite size follows the coverage level; an explicit maxTestCases is a hard cap.
  const effectiveMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined;

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
        coverage: coverageLevel,
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
        coverage: state.coverageSummary || null,
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
