/**
 * Playwright run tuning — browser runs and API runs are not the same workload.
 *
 * A browser spec is CPU- and memory-bound: each worker drives a real Chromium,
 * so Playwright's default (50% of the host's cores) is the right ceiling.
 *
 * An API spec is I/O-bound. It opens a socket, waits on the network and
 * asserts on the response — it uses almost no CPU. Sizing those workers by
 * core count is the wrong heuristic in both directions: on a 1-vCPU container
 * (Azure Container Apps) 50% resolves to ONE worker and a 200-scenario suite
 * runs strictly serially, while the same suite on a dev box uses a fraction of
 * the concurrency the network could carry.
 *
 * So API runs get their own settings: a fixed worker pool sized to the suite,
 * request-shaped timeouts, and no browser artefacts (there is no page to trace
 * or screenshot). Everything is env-tunable, because the right number depends
 * on what the API under test tolerates — a rate-limited partner API wants
 * API_TEST_WORKERS=2, a local service can take far more.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

export interface RunTuning {
  /** Rendered into playwright.config.cjs — omitted lines keep Playwright's defaults. */
  workersLine: string;
  testTimeoutMs: number;
  expectTimeoutMs: number;
  /** `use` entries for artefacts. */
  traceLine: string;
  screenshotLine: string;
  /** The projects array body. */
  projectsLine: string;
  /** Ceiling for the whole `playwright test` process. */
  processTimeoutMs: number;
  workers: number | null;
}

const MAX_PROCESS_MS = 45 * 60_000;

export function runTuning(apiMode: boolean, specCount: number): RunTuning {
  if (!apiMode) {
    // Browser runs keep every existing default; only the process ceiling grows
    // with the suite so a large-but-healthy run is never killed mid-flight.
    return {
      workersLine: '',
      testTimeoutMs: 90_000,
      expectTimeoutMs: 20_000,
      traceLine: "    trace: 'retain-on-failure',\n",
      screenshotLine: "    screenshot: 'only-on-failure',\n",
      projectsLine: "  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],\n",
      processTimeoutMs: Math.min(MAX_PROCESS_MS, Math.max(600_000, specCount * 25_000)),
      workers: null,
    };
  }

  // API run.
  const cap = envInt('API_TEST_WORKERS', 10, 1, 32);
  const workers = Math.max(1, Math.min(specCount || 1, cap));
  const testTimeoutMs = envInt('API_TEST_TIMEOUT_MS', 30_000, 5_000, 300_000);
  const expectTimeoutMs = Math.min(testTimeoutMs, envInt('API_EXPECT_TIMEOUT_MS', 10_000, 1_000, 60_000));
  // Wall-clock estimate: batches of `workers` specs, each allowed the full test
  // timeout, doubled for start-up and retries, floored at 5 minutes.
  const batches = Math.ceil((specCount || 1) / workers);
  const processTimeoutMs = Math.min(MAX_PROCESS_MS, Math.max(300_000, batches * testTimeoutMs * 2));

  return {
    workersLine: `  workers: ${workers},\n`,
    testTimeoutMs,
    expectTimeoutMs,
    // Tracing stays ON. Measured over a 40-spec suite it costs nothing
    // (3.1–3.7s with tracing, 3.1–3.4s without — inside run-to-run noise), and
    // the trace is what makes a failed request debuggable afterwards. Set
    // API_TEST_TRACE=off to drop it on a very large suite or a small disk.
    // The screenshot is genuinely dead weight: there is no page to capture.
    traceLine: `    trace: ${JSON.stringify(process.env.API_TEST_TRACE || 'retain-on-failure')},\n`,
    screenshotLine: "    screenshot: 'off',\n",
    // A project with no browserName never resolves a browser binary, so an API
    // suite runs (and stays fast) even where browsers are not installed.
    projectsLine: "  projects: [{ name: 'api' }],\n",
    processTimeoutMs,
    workers,
  };
}
