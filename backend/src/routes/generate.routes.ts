import { Router } from 'express';
import type { Request, Response } from 'express';
import { runGenerationOnly } from '../agents/pipeline.js';
import { getTenantLlm } from '../services/llm.service.js';
import { getConfiguredApplication } from '../services/configurations.service.js';

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

  // Requirement Analysis must target a known application. Block generation
  // unless the tenant has a properly-configured application under test in
  // System Configuration → Application Setup — mirrors the LLM guard below.
  // Explore mode / an explicit target URL supplies the application inline, so
  // it satisfies the requirement without a saved Application Setup entry.
  const hasExplicitTarget = Boolean(targetUrl && String(targetUrl).trim());
  if (req.user && !hasExplicitTarget) {
    const configuredApp = await getConfiguredApplication(req.user.tenantId);
    if (!configuredApp) {
      res.status(400).json({
        error: 'No application configured. Add your application under test in System Configuration → Application Setup before starting requirement analysis.',
      });
      return;
    }
  }

  // Resolve the tenant's LLM (key + model) from the DB — saved by the admin in
  // System Configuration → LLM Configuration. No env var, no local CLI login.
  const llm = req.user ? await getTenantLlm(req.user.tenantId) : null;
  if (!llm) {
    res.status(400).json({ error: 'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.' });
    return;
  }

  try {
    const state = await runGenerationOnly(reqText, {
      maxTestCases: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined,
      appContext,
      llm,
    });

    res.json({
      testCases: state.testCases,
      automationScripts: state.automationScripts,
      pageObjects: state.pageObjects || [],
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
