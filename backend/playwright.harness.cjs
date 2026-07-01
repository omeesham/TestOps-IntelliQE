// =============================================================================
// playwright.harness.cjs  —  ONE canonical Playwright config for THIS framework
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//   The platform currently emits FOUR near-identical inline Playwright configs
//   from three services (runPlaywrightForRun / executeRunScripts in
//   playwright-runner.service.ts, runPlaywrightInMemory in executionAgent.ts,
//   reRunHealedSpecs in healing.service.ts). They drift: some turn off traces,
//   some omit allure, one omits navigationTimeout, one omits workers. This file
//   is the single source of truth they all call, so behaviour is identical and
//   tunable in ONE place.
//
// HOW IT IS LOADED (the execution model that dictates every choice below)
//   * Each run gets a throwaway workspace under os.tmpdir():
//       <tmpdir>/<prefix>/
//         tests/                <- one self-contained <name>.spec.ts per DB row
//         allure-results/       <- absolute resultsDir (when allure is enabled)
//         playwright.config.cjs <- a 2-line shim that require()s THIS file
//         pw-summary.json       <- JSON reporter output (the primary verdict)
//   * Playwright is spawned with:
//         cwd   = BACKEND_ROOT            (so @playwright/test + allure-playwright
//                                          + any spec import resolve from
//                                          backend/node_modules)
//         env.NODE_PATH = BACKEND_ROOT/node_modules
//         env.CI = '1'                    (HARD-CODED at every call site — see the
//                                          forbidOnly note: do NOT gate behaviour
//                                          on env.CI, it is always truthy here.)
//         env.PLAYWRIGHT_JSON_OUTPUT_NAME = <workspace>/pw-summary.json (absolute)
//         shell = true on win32  (npx.cmd needs a shell, else spawn EINVAL)
//   * The workspace has NO local node_modules. Module resolution happens ONLY
//     through NODE_PATH.
//
// >>> FORMAT DECISION: CommonJS .cjs — NOT .ts, NOT .mjs. <<<
//   Node's NODE_PATH fallback works for CommonJS require() but is IGNORED by the
//   ESM loader. A .ts config additionally forces Playwright's TS/tsconfig loader
//   to resolve from a workspace that has no tsconfig and no node_modules. So:
//     - .ts  -> TS loader can't resolve @playwright/test from the bare workspace
//     - .mjs -> ESM ignores NODE_PATH; require('@playwright/test') would fail
//     - .cjs -> require() + NODE_PATH resolves cleanly. THE ONLY SAFE FORMAT.
//   Do not "modernise" this to ESM/TS; it will break every run.
//
// THE TWO RESULT CONTRACTS THIS CONFIG MUST NEVER BREAK
//   (1) JSON reporter -> ['json', { outputFile: './pw-summary.json' }].
//       PRECEDENCE (verified empirically on the installed Playwright 1.59.1):
//       when the reporter's `outputFile` option is set, it is AUTHORITATIVE and
//       the PLAYWRIGHT_JSON_OUTPUT_NAME env var is INERT — the config value wins.
//       The relative './pw-summary.json' resolves against the workspace (the dir
//       the config shim is loaded from), which is EXACTLY the absolute path the
//       services read back (path.join(workspace,'pw-summary.json')), so the
//       contract holds. PLAYWRIGHT_JSON_OUTPUT_NAME is only a FALLBACK that would
//       apply IF `outputFile` were omitted — it is not. Keep BOTH for belt-and-
//       suspenders, but DO NOT remove the relative `outputFile` trusting the env
//       var to take over: with `outputFile` present the env var does nothing, so
//       dropping it would silently send the JSON somewhere the readers don't look.
//       Shape consumed: stats.{expected,unexpected,...} +
//       suites[].specs[].tests[0].results[0].{status,duration,error.message}.
//       (results[0] == FIRST attempt — this is WHY retries are hard-disabled below.)
//   (2) allure-playwright -> ABSOLUTE resultsDir, detail:true, suiteTitle:false.
//       A RELATIVE resultsDir leaks results to backend/allure-results and the
//       Node v3 single-file Allure builder finds nothing. Only the two
//       report-producing paths pass an allureResultsDir; heal/in-memory omit it.
//
// HARD "MUST NOT" CONSTRAINTS (from the generated-spec contract)
//   * No baseURL reliance — specs navigate with absolute page.goto(targetUrl).
//     baseURL is exposed as an OPTIONAL, inert knob; never rewrite specs relative.
//   * No webServer block — the AUT is an external URL; the harness never starts it.
//   * No storageState / global-setup auth — every spec is self-contained and
//     logs in via its own page object. Injecting state would silently change them.
//   * No custom fixtures / base-page modules — specs import ONLY '@playwright/test'.
//     Anything we add here that a spec would have to import is dead by definition.
//   * Single browser project by default — the readers map ONE result per spec
//     (tests[0]). A second project doubles results per spec and breaks by-file /
//     by-scenario attribution. Multi-project is opt-in, diagnostic-only.
//
// WALL-CLOCK BUDGET — THE RELATIONSHIP CALLERS MUST RESPECT
//   The outer execFileAsync cap is 600_000 ms. If the spawn runs longer it is
//   KILLED with NO pw-summary.json written, and classifyPlaywrightFailure sees a
//   killed process -> the WHOLE batch dies UNKNOWN/500 (every spec lost, not just
//   the slow ones). To stay inside the cap on a slow/down AUT, keep:
//
//        testTimeout * ceil(specCount / workers) < ~500_000   (leave headroom)
//
//   With the shipped defaults (testTimeout=45s, workers=2) that is ~22 specs of
//   pure timeouts per spawn before risk. Larger batches MUST either raise workers,
//   lower testTimeout, or set PLAYWRIGHT_MAX_FAILURES so a fully-down AUT fails
//   fast WITH a written summary instead of being guillotined result-less. See the
//   TIMEOUT BUDGET banner at the bottom for the full rationale.
// =============================================================================

const { defineConfig, devices } = require('@playwright/test');

/**
 * Build the canonical config.
 *
 * @param {object} [opts]
 * @param {string} [opts.allureResultsDir]
 *        ABSOLUTE path to the workspace's allure-results dir. When provided, the
 *        allure-playwright reporter is added (report-producing paths:
 *        runPlaywrightForRun, executeRunScripts). When omitted, only line+json
 *        reporters are used (executionAgent in-memory, healing re-run) — exactly
 *        matching today's behaviour for those paths, plus you MAY pass it there
 *        too if you want every path to leave a reusable Allure snapshot.
 * @param {string} [opts.baseURL]
 *        OPTIONAL, inert. Specs use absolute goto, so this is load-bearing on
 *        nothing. Provided only so a future relative-nav path could opt in; do
 *        NOT pair it with any spec rewrite to relative URLs.
 * @returns Playwright config object (from defineConfig).
 */
function createHarnessConfig(opts = {}) {
  // ── Env knobs (all optional; defaults preserve today's production behaviour) ──
  const channel  = process.env.PLAYWRIGHT_CHANNEL || 'msedge';        // system Edge channel
  const workers  = Number(process.env.PLAYWRIGHT_WORKERS) || 2;       // cap load on flaky AUT
  const headed   = process.env.PLAYWRIGHT_HEADED === '1';

  // forbidOnly is an EXPLICIT opt-in, DECOUPLED from CI.
  //   Why not `isCI`? Every call site HARD-CODES env.CI='1', so gating on CI would
  //   make forbidOnly permanently active. A single stray `test.only` (a plausible
  //   LLM emission from the free-form healer/generator prompts) would then make
  //   Playwright ABORT before running anything: suites=[] / stats.expected=0 /
  //   stats.unexpected=0. Downstream that is catastrophic — the report path finds
  //   allure-results EMPTY and throws (the abort message matches NO classifier
  //   substring -> misclassified UNKNOWN/500 for the WHOLE batch), and the
  //   summary-reading paths walk zero suites and silently mark every test not_run.
  //   Default-FALSE preserves today's tolerant behaviour: a stray test.only merely
  //   focuses, and the (focused) suite still runs and reports through
  //   pw-summary.json / allure. Turn it on deliberately with PLAYWRIGHT_FORBID_ONLY=1
  //   ONLY in an environment where an abort is the desired, surfaced failure.
  //   (Belt-and-suspenders: the spec-writer SHOULD also neutralize 'test.only('
  //   -> 'test(' before writing files, degrading a focus to a normal run.)
  const forbidOnly = process.env.PLAYWRIGHT_FORBID_ONLY === '1';

  // Timeouts are env-overridable but ship with hardened, MUTUALLY-COHERENT defaults.
  //   Coherence rule enforced by these defaults (see TIMEOUT BUDGET banner):
  //     navTimeout (30s) < testTimeout (45s)            -> a slow goto fails AS a nav
  //                                                          timeout, not a generic
  //                                                          test timeout, so the
  //                                                          healer gets the SPECIFIC
  //                                                          cause.
  //     actionTimeout (15s), expectTimeout (10s)  each < testTimeout, and chosen so a
  //                                                          single nav + a single
  //                                                          action sit comfortably
  //                                                          inside the 45s ceiling.
  //   testTimeout stays at the PROVEN 45_000 (3 of 4 legacy configs used 45s and it
  //   worked). It is deliberately NOT raised to 60s: with workers=2, 60s defaults
  //   make a 20-spec all-timeout batch hit the 600s outer cap and get killed
  //   result-less. If you DO raise testTimeout, re-read the wall-clock budget and
  //   set PLAYWRIGHT_MAX_FAILURES accordingly.
  const testTimeout   = Number(process.env.PLAYWRIGHT_TIMEOUT)        || 45_000; // per-test ceiling (HARD)
  const expectTimeout = Number(process.env.PLAYWRIGHT_EXPECT_TIMEOUT) || 10_000; // web-first asserts
  const actionTimeout = Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT) || 15_000; // click/fill
  const navTimeout    = Number(process.env.PLAYWRIGHT_NAV_TIMEOUT)    || 30_000; // goto; < testTimeout on purpose
  const maxFailures   = Number(process.env.PLAYWRIGHT_MAX_FAILURES)   || 0;      // 0 = run all (see banner)

  // Artifacts. ALL gated so a high-failure-rate run against a down AUT can suppress
  // hundreds of trace.zips / screenshots that would otherwise churn disk+IO in the
  // throwaway workspace and lengthen timing-sensitive specs (nudging the 600s cap).
  //   trace      : retain-on-failure by default (gives the healer real context),
  //                set PLAYWRIGHT_TRACE=0 to turn off for a known-down AUT.
  //   screenshot : only-on-failure by default, PLAYWRIGHT_SCREENSHOT=0 to disable.
  //   video      : OFF by default (heaviest), PLAYWRIGHT_VIDEO=1 -> retain-on-failure.
  // NOTE: retain-on-failure artifacts accumulate under os.tmpdir() until the caller
  // GC's the workspace. Confirm each runner removes its workspace (it does for the
  // four current paths); if a new path forgets to, traces LEAK in tmpdir.
  const trace      = process.env.PLAYWRIGHT_TRACE === '0' ? 'off' : 'retain-on-failure';
  const screenshot = process.env.PLAYWRIGHT_SCREENSHOT === '0' ? 'off' : 'only-on-failure';
  const video      = process.env.PLAYWRIGHT_VIDEO === '1' ? 'retain-on-failure' : 'off';
  const wantHtml   = process.env.PLAYWRIGHT_HTML === '1';

  // TLS hardening, ENV-GATED (default-on to preserve OrangeHRM-class demo behaviour).
  //   WARNING: when ON this disables ALL certificate validation, so an expired /
  //   wrong-host / MITM cert on the AUT passes SILENTLY instead of surfacing as a
  //   real failure. If you point this config at a real https endpoint where a cert
  //   error is a verdict you WANT, set PLAYWRIGHT_IGNORE_HTTPS_ERRORS=0.
  //   (Test-harness default ONLY — never default-on for a production-touching config.)
  const ignoreHTTPSErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS !== '0';

  // baseURL: explicit opt wins, else env, else omitted entirely.
  const baseURL  = opts.baseURL || process.env.PLAYWRIGHT_BASE_URL || undefined;

  // ── Cross-browser allowlist (DEFAULT: 'edge' only, == current behaviour) ──
  //   'chromium' is the portability escape hatch: a host WITHOUT system Edge can
  //   set PLAYWRIGHT_PROJECTS=chromium and `npx playwright install chromium`
  //   provides it — avoiding BROWSERS_MISSING on Edge-less hosts. firefox/webkit
  //   are opt-in diagnostics. NOTE: any value with >1 project multiplies results
  //   per spec and the by-file/by-scenario readers collapse to the LAST writer —
  //   so multi-project is a CI/diagnostic mode, never the per-test-case path.
  const wanted = (process.env.PLAYWRIGHT_PROJECTS || 'edge')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ALL = {
    edge:     { name: 'edge',     use: { channel } },                              // system Edge (OS-provisioned)
    chromium: { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined, browserName: 'chromium' } },
    firefox:  { name: 'firefox',  use: { browserName: 'firefox' } },
    webkit:   { name: 'webkit',   use: { browserName: 'webkit' } },
  };
  const projects = wanted.map((n) => ALL[n]).filter(Boolean);
  // Never end up with zero projects (a typo'd env would otherwise run nothing).
  if (projects.length === 0) projects.push(ALL.edge);

  // ── Reporters ──
  //   line  : quiet, single-line CI/headless progress (already piped through the
  //           service's execFile stdout; 'list'/'dot' are noisier for no benefit).
  //   json  : THE primary pass/fail contract — outputFile './pw-summary.json' is
  //           AUTHORITATIVE (resolves against the workspace the shim loads from,
  //           which is the absolute path the services read). PLAYWRIGHT_JSON_OUTPUT_NAME
  //           is an inert fallback while outputFile is present; keep both, drop neither.
  //   allure: ONLY when a resultsDir is supplied; ABSOLUTE path, detail+suiteTitle
  //           exactly as the Node v3 single-file builder + label synthesis expect.
  //   html  : env-gated debug artifact, written INSIDE the workspace, open:'never'
  //           so it is GC'd with the workspace and never blocks the spawn.
  const reporter = [
    ['line'],
    ['json', { outputFile: './pw-summary.json' }],
  ];
  if (opts.allureResultsDir) {
    reporter.push(['allure-playwright', {
      resultsDir: opts.allureResultsDir, // MUST be absolute — caller passes path.join(workspace,'allure-results')
      detail: true,
      suiteTitle: false,
    }]);
  }
  if (wantHtml) {
    reporter.push(['html', { outputFolder: './pw-html-report', open: 'never' }]);
  }

  return defineConfig({
    testDir: './tests',
    // testMatch left at default (**/*.spec.ts): sanitizeFileName guarantees the
    // .spec.ts suffix on every written file, so the default glob always matches.
    // Narrowing it would just be one more thing to keep in sync with the writer.

    fullyParallel: true,           // specs are self-contained & independent
    forbidOnly,                    // EXPLICIT opt-in (PLAYWRIGHT_FORBID_ONLY=1); NOT gated on CI — see note above
    workers,                       // capped (default 2) to protect the flaky external AUT + 5-DTU DB
    retries: 0,                    // HARD-DISABLED — the per-spec readers take results[0] (FIRST attempt);
                                   // any retry would report a recovered flake as FAILED. No env knob: a
                                   // documented-but-broken lever is worse than none. See RETRIES banner below.
    maxFailures,                   // 0 = run all (full reporting); env caps the catastrophic fully-down case
    timeout: testTimeout,          // 45s proven ceiling; navTimeout(30s) sits inside it. << 600s outer cap.
    expect: { timeout: expectTimeout }, // 10s: doubles the 5s default so slow render doesn't flake asserts

    reporter,

    use: {
      // baseURL is included ONLY if explicitly provided; specs never rely on it.
      ...(baseURL ? { baseURL } : {}),

      headless: !headed,           // env-toggle for local debugging; CI stays headless

      // TLS: env-gated (default-on). Disables ALL cert validation when on — see
      // the ignoreHTTPSErrors note above for the security trade-off.
      ignoreHTTPSErrors,

      actionTimeout: actionTimeout, // 15s: enough for slow click/fill, short enough to fail fast → healer
      navigationTimeout: navTimeout, // 30s, deliberately < the 45s test ceiling so a slow goto surfaces as a
                                     // SPECIFIC nav timeout (actionable for the healer) rather than a generic
                                     // test timeout. The deeper waitUntil:'domcontentloaded' fix stays
                                     // SPEC-side (the healer emits it) — config can't set per-goto waitUntil.

      // Diagnostics — all env-gated (see artifact block above). retain-on-failure
      // gives the HEALER real context (trace.zip + screenshot) instead of just
      // error.message, and feeds the Reports page; PLAYWRIGHT_TRACE=0 /
      // PLAYWRIGHT_SCREENSHOT=0 suppress them on a high-failure down-AUT run.
      trace,
      screenshot,
      video,                       // 'off' unless PLAYWRIGHT_VIDEO=1 → 'retain-on-failure'
    },

    projects,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRIES SAFETY BANNER  (why there is NO PLAYWRIGHT_RETRIES knob)
//
//   retries is HARD-CODED to 0. The per-spec readers take the FIRST attempt:
//     playwright-runner.service.ts:485  spec?.tests?.[0]?.results?.[0]
//     executionAgent.ts (runPlaywrightInMemory)   results?.[0]
//     healing.service.ts (reRunHealedSpecs)       results?.[0]
//   With retries on, a test that fails THEN passes has results = [failed, passed];
//   reading [0] reports the FAILED first attempt, so a recovered flake is wrongly
//   marked failed AND Allure stamps it 'flaky'. i.e. enabling retries would HIDE
//   recovery and INFLATE the failure/heal queue — the exact opposite of the intent.
//   A live-but-corrupting env knob is a footgun, so it is deliberately removed: do
//   NOT reintroduce `Number(process.env.PLAYWRIGHT_RETRIES)`.
//
//   TO ENABLE RETRIES SAFELY you MUST first change all three readers to take the
//   LAST result, then set retries here:
//     const r = spec?.tests?.[0]?.results ?? [];
//     const last = r[r.length - 1];   // last attempt is authoritative
//   The run-level verdict (playwright-runner.service.ts:344 reads stats.unexpected)
//   already handles retries correctly (recovered -> flaky, not unexpected); it is
//   ONLY the per-test mapping that needs the last-result fix. Ship that code change
//   WITH the retries bump — never the bump alone.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUT BUDGET BANNER  (read before raising PLAYWRIGHT_TIMEOUT or batch size)
//
//   OUTER CAP: execFileAsync kills the spawn at 600_000 ms. A killed spawn writes
//   NO pw-summary.json, so classifyPlaywrightFailure sees a dead process and the
//   ENTIRE batch dies UNKNOWN/500 — every spec lost, not just the slow ones. The
//   fully-down-AUT case (common for a flaky external app) is exactly where a batch
//   of all-timeouts can cross this cap, so it must be bounded.
//
//   KEEP THIS TRUE:    testTimeout * ceil(specCount / workers) < ~500_000
//     defaults (45s, workers=2) -> ~22 all-timeout specs/spawn before risk.
//
//   IF YOU NEED A LARGER BATCH OR A LONGER testTimeout, do ONE of:
//     - raise PLAYWRIGHT_WORKERS (more parallelism shrinks ceil(N/workers)), or
//     - lower PLAYWRIGHT_TIMEOUT, or
//     - set PLAYWRIGHT_MAX_FAILURES so a down AUT fails fast WITH a written summary.
//       A good rule: stop once ceil(remaining/workers)*testTimeout would exceed the
//       remaining wall-clock budget. A modest absolute (e.g. 20) also works and is
//       a sane default to consider if your suites routinely exceed the ~22 figure.
//
//   maxFailures DEFAULT is 0 (run all) so NORMAL runs report every spec. The cost
//   is that a FULLY-DOWN AUT burns every spec's full timeout up to the 600s kill —
//   the slowest path, ending in a result-less UNKNOWN. If that state is routine for
//   your target, set PLAYWRIGHT_MAX_FAILURES (or have the calling service lower it
//   when a pre-flight already knows the target is unreachable) so the harness writes
//   a partial summary instead of being guillotined.
//
//   SUB-TIMEOUT COHERENCE: the shipped defaults satisfy navTimeout(30s) < testTimeout
//   (45s), and actionTimeout(15s)+expectTimeout(10s) are each well under the ceiling,
//   so a single slow goto or assertion fails with its SPECIFIC cause rather than a
//   generic test timeout (a more actionable signal for the healer). If you override
//   any sub-timeout via env, keep navTimeout <= ~60% of testTimeout, or accept that
//   the test timeout becomes the hard ceiling and root-cause attribution degrades.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { createHarnessConfig };
