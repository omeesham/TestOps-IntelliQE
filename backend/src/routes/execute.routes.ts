import { Router } from 'express';
import type { Request, Response } from 'express';
import { runPipeline } from '../agents/pipeline.js';
import { getTenantLlm } from '../services/llm.service.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { requirements, targetUrl, appName, environment } = req.body;
  const appContext = targetUrl || appName || environment
    ? { targetUrl, appName, environment }
    : undefined;

  const llm = req.user ? await getTenantLlm(req.user.tenantId) : null;
  if (!llm) {
    res.status(400).json({ error: 'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.' });
    return;
  }

  const result = await runPipeline(requirements || 'Run standard test suite', appContext, llm);

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
