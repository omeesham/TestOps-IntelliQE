import { Router } from 'express';
import type { Request, Response } from 'express';
import { runGenerationOnly } from '../agents/pipeline.js';
import { getTenantLlm } from '../services/llm.service.js';
import { getConfiguredApplication, resolveAppConfig, getApplicationDisplayName } from '../services/configurations.service.js';
import { decryptStored } from '../utils/crypto.js';
import { sanitizeApiSpec } from '../utils/api-spec.js';

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
    // Optional free-form guidance (explore mode) that steers what the explore
    // agent focuses on. Additive only — never changes the crawl itself.
    explorePrompt,
    // The SPECIFIC Application Setup entry these requirements target (its
    // `app-<slug>` integrationId). When the tenant has more than one
    // application configured, the caller (chat wizard) MUST send this rather
    // than letting the server guess — guessing is what let one application's
    // stories silently run against a different application's URL.
    appId,
    // API Automation — the structured endpoint the user entered in the chat
    // API form. When present the run is grounded in this endpoint, not a
    // browser application under test.
    apiSpec: rawApiSpec,
    // API Automation, multi-endpoint — an imported collection/spec run across
    // several selected endpoints at once. Each entry is one endpoint contract;
    // the generator produces a suite for every one and merges them.
    apiSpecs: rawApiSpecs,
    // API Automation — which test layers the reviewer switched on (smoke,
    // contract, schema, negative, auth, security, performance, flow) and the
    // optional AI insights from the dashboard's deep analysis. The pattern
    // profile itself is recomputed server-side over the specs being generated.
    apiLayers: rawApiLayers,
    apiProfile: rawApiProfile,
  } = req.body;

  // ── API Automation detection & sanitisation ──────────────────────────
  // API mode is driven by the structured apiSpec the chat form sends (with a
  // valid absolute URL). It grounds the run in a concrete HTTP endpoint, so it
  // needs NO browser application under test — the app-config guard below is
  // skipped for it, and generation routes to apiGeneratorAgent.
  const apiSpec = sanitizeApiSpec(rawApiSpec);
  const apiSpecs = Array.isArray(rawApiSpecs)
    ? rawApiSpecs
        .map((s: any) => sanitizeApiSpec(s))
        .filter((s): s is NonNullable<typeof s> => !!s)
    : [];
  const primaryApiSpec = apiSpec || apiSpecs[0] || null;
  const isApiMode = !!primaryApiSpec;
  if ((rawApiSpec && !apiSpec) || (Array.isArray(rawApiSpecs) && rawApiSpecs.length > 0 && apiSpecs.length === 0)) {
    res.status(400).json({
      error: 'The API URL is invalid. Enter a full absolute URL, e.g. https://api.example.com/v1/resource.',
    });
    return;
  }

  // When exploreMode is requested we DELIBERATELY pass an empty requirements
  // string so the pipeline's shouldExploreFirst() guard triggers.
  const reqText = exploreMode === true
    ? ''
    : (requirements || `Generate ${testType || 'general'} tests`);
  const parsedMax = Number(maxTestCases);

  let appContext = targetUrl || appName || environment || (Array.isArray(roles) && roles.length > 0)
    ? {
        targetUrl,
        appName,
        environment,
        explorePrompt: typeof explorePrompt === 'string' && explorePrompt.trim()
          ? explorePrompt.trim().slice(0, 1000)
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

  // API Automation grounds itself in the endpoint's own origin — no browser
  // application under test is required, so it bypasses the app-config guard and
  // supplies its own target (used as the harmless Playwright baseURL + the
  // executor's "something is configured" signal).
  if (isApiMode) {
    appContext = {
      targetUrl: primaryApiSpec!.baseUrl,
      appName: 'API',
      environment: undefined,
      explorePrompt: undefined,
      roles: undefined,
    };
  }

  // Requirement Analysis must target a known application. Block generation
  // unless the tenant has a properly-configured application under test in
  // System Configuration → Application Setup — mirrors the LLM guard below.
  // Explore mode / an explicit target URL supplies the application inline, so
  // it satisfies the requirement without a saved Application Setup entry.
  const hasExplicitTarget = Boolean(targetUrl && String(targetUrl).trim());
  if (req.user && !hasExplicitTarget && !isApiMode) {
    if (appId) {
      // A specific application was requested — it must resolve exactly, or we
      // fail loudly naming that application rather than silently substituting
      // whichever application happens to be configured.
      const resolved = await resolveAppConfig(req.user.tenantId, String(appId));
      if (!resolved) {
        const displayName = await getApplicationDisplayName(req.user.tenantId, String(appId));
        res.status(400).json({
          error: `"${displayName}" isn't fully configured yet. Add it (name + base URL) under System Configuration → Application Setup before starting requirement analysis.`,
        });
        return;
      }
      const d = resolved.configData || {};
      appContext = {
        targetUrl: (d.baseUrl || '').trim() || undefined,
        appName: d.appName,
        environment: d.environment,
        explorePrompt: undefined,
        roles: Array.isArray(d.roles)
          ? d.roles.filter((r: any) => r && typeof r === 'object').map((r: any) => ({
              roleName: String(r.roleName || 'user'),
              username: String(r.username || ''),
              password: decryptStored(String(r.password || '')),
            }))
          : undefined,
      };
    } else {
      const configuredApp = await getConfiguredApplication(req.user.tenantId);
      if (!configuredApp) {
        res.status(400).json({
          error: 'No application configured. Add your application under test in System Configuration → Application Setup before starting requirement analysis.',
        });
        return;
      }
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
      tenantId: req.user?.tenantId,
      apiSpec,
      apiSpecs: apiSpecs.length ? apiSpecs : null,
      apiLayers: Array.isArray(rawApiLayers) ? rawApiLayers.map((l: unknown) => String(l)).slice(0, 12) : null,
      apiProfile: rawApiProfile && typeof rawApiProfile === 'object' && Array.isArray(rawApiProfile.insights)
        ? { insights: rawApiProfile.insights.map((i: unknown) => String(i)).slice(0, 8) }
        : null,
    });

    res.json({
      testCases: state.testCases,
      automationScripts: state.automationScripts,
      pageObjects: state.pageObjects || [],
      testPlan: state.testPlan,
      extendedTestPlan: state.extendedTestPlan,
      parsedRequirements: state.parsedRequirements,
      exploredApp: state.exploredApp || null,
      // API Automation — the pattern profile the generator grounded itself in.
      apiProfile: state.apiProfile || null,
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
