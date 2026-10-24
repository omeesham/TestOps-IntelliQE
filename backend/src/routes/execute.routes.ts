import { Router } from 'express';
import type { Request, Response } from 'express';
import { runPipeline } from '../agents/pipeline.js';
import { getConfigsForTenant } from '../services/configurations.service.js';
import { readOnlyEnvironmentForUrl } from '../services/app-environments.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { requirements, targetUrl, appName, environment } = req.body;
  // A URL that belongs to a read-only environment stays read-only here too.
  const safety = targetUrl && req.user?.tenantId
    ? readOnlyEnvironmentForUrl(await getConfigsForTenant(req.user.tenantId), targetUrl)?.safety
    : undefined;
  const appContext = targetUrl || appName || environment
    ? { targetUrl, appName, environment, safety }
    : undefined;

  const result = await runPipeline(requirements || 'Run standard test suite', appContext);

  res.json({
    executionResults: result.state.executionResults,
    // Surface per-test details as a top-level field too — frontends should
    // read this rather than fabricating durations / statuses on their own.
    executionDetails: result.state.executionResults?.details || [],
    testCases: result.state.testCases,
    healingAttempted: result.state.healingAttempted,
    failureReason: result.state.failureReason,
    stages: result.stages,
    summary: {
      totalTests: result.state.testCases.length,
      passed: result.state.executionResults?.passed || 0,
      failed: result.state.executionResults?.failed || 0,
      executed: result.state.executionResults !== null,
      healed: result.state.healingAttempted,
      failReason: result.state.executionResults?.failReason || result.state.failureReason || undefined,
    },
  });
});

export default router;
