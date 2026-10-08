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
  /** Extra `use` entries (video / geolocation / locale / timezone) — '' by default. */
  useExtraLine: string;
  /** The projects array body. */
  projectsLine: string;
  /** Ceiling for the whole `playwright test` process. */
  processTimeoutMs: number;
  workers: number | null;
}

const MAX_PROCESS_MS = 45 * 60_000;
const VALID_ENGINES = ['chromium', 'firefox', 'webkit'];

/**
 * Optional browser-run environment matrix — opt-in and fully backward-compatible.
 * Unset env ⇒ byte-identical to the historical config (Chromium only, no video,
 * no geo). Set these to run every web suite across more engines / with video /
 * emulating a location — the same "everything is env-tunable" model the API path
 * already uses. (Firefox/WebKit must be installed on the runner:
 * `npx playwright install firefox webkit`.)
 *   WEB_TEST_BROWSERS   e.g. "chromium,firefox,webkit"   (default "chromium")
 *   WEB_TEST_VIDEO      off | on | retain-on-failure      (default off)
 *   WEB_TEST_GEOLOCATION  "lat,lon" e.g. "51.5074,-0.1278"
 *   WEB_TEST_LOCALE     e.g. "en-GB"
 *   WEB_TEST_TIMEZONE   e.g. "Europe/London"
 */
function browserMatrix(): { projectsLine: string; useExtraLine: string } {
  const engines = (process.env.WEB_TEST_BROWSERS || 'chromium')
    .split(',').map((s) => s.trim().toLowerCase()).filter((s) => VALID_ENGINES.includes(s));
  const picked = engines.length ? [...new Set(engines)] : ['chromium'];
  const projectsLine = picked.length === 1 && picked[0] === 'chromium'
    ? "  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],\n"
    : `  projects: [\n${picked.map((b) => `    { name: ${JSON.stringify(b)}, use: { browserName: ${JSON.stringify(b)} } },`).join('\n')}\n  ],\n`;

  let extra = '';
  const video = String(process.env.WEB_TEST_VIDEO || 'off').toLowerCase();
  if (['on', 'retain-on-failure'].includes(video)) extra += `    video: ${JSON.stringify(video)},\n`;
  const geo = String(process.env.WEB_TEST_GEOLOCATION || '').split(',').map((s) => parseFloat(s.trim()));
  if (geo.length === 2 && Number.isFinite(geo[0]) && Number.isFinite(geo[1])) {
    extra += `    geolocation: { latitude: ${geo[0]}, longitude: ${geo[1]} },\n    permissions: ['geolocation'],\n`;
  }
  if (process.env.WEB_TEST_LOCALE) extra += `    locale: ${JSON.stringify(process.env.WEB_TEST_LOCALE)},\n`;
  if (process.env.WEB_TEST_TIMEZONE) extra += `    timezoneId: ${JSON.stringify(process.env.WEB_TEST_TIMEZONE)},\n`;
  return { projectsLine, useExtraLine: extra };
}

export function runTuning(apiMode: boolean, specCount: number): RunTuning {
  if (!apiMode) {
    // Browser runs keep every existing default; only the process ceiling grows
    // with the suite so a large-but-healthy run is never killed mid-flight. The
    // browser matrix (engines / video / geo) is opt-in via env — unset ⇒ today's
    // behaviour exactly.
    const { projectsLine, useExtraLine } = browserMatrix();
    return {
      workersLine: '',
      testTimeoutMs: 90_000,
      expectTimeoutMs: 20_000,
      traceLine: "    trace: 'retain-on-failure',\n",
      screenshotLine: "    screenshot: 'only-on-failure',\n",
      useExtraLine,
      projectsLine,
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
    // API runs never emulate a browser environment.
    useExtraLine: '',
    // A project with no browserName never resolves a browser binary, so an API
    // suite runs (and stays fast) even where browsers are not installed.
    projectsLine: "  projects: [{ name: 'api' }],\n",
    processTimeoutMs,
    workers,
  };
}
