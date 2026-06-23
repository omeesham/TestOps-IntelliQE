import { Router } from 'express';
import type { Request, Response } from 'express';
import { runGenerationOnly } from '../agents/pipeline.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const {
    requirements,
    testType,
    maxTestCases,
    targetUrl,
    appName,
    environment,
    // Optional credentials so the explore agent can crawl behind a login.
    // Shape: [{ roleName, username, password }]
    roles,
    // Explicit "explore mode" flag — when true, send an empty requirements
    // string to force shouldExploreFirst() to fire even if the caller padded
    // the body with placeholder text.
    exploreMode,
  } = req.body;

  // When exploreMode is requested we DELIBERATELY pass an empty requirements
  // string so the pipeline's shouldExploreFirst() guard triggers.
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

  try {
    const state = await runGenerationOnly(reqText, {
      maxTestCases: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined,
      appContext,
    });

    res.json({
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
        // Echo back whether explore actually ran — useful for UI feedback
        exploreRan: Boolean(state.exploredApp),
      },
    });
  } catch (err) {
    const message = (err as Error).message || 'Test generation failed';
    console.error('[generate] Pipeline error:', message);
    res.status(500).json({ error: message });
  }
});

export default router;
