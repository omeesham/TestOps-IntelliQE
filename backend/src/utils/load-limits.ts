/**
 * load-limits.ts
 * ──────────────
 * Resolve the load runner's ceilings from the environment, with safe hard caps.
 *
 * The in-house load runner shipped with a hard-coded concurrency of 50 — fine
 * for a smoke check, not a credible performance claim. These limits are now
 * operator-tunable (so an owner sizes them to their own infrastructure) while a
 * fixed hard ceiling still protects the server and the target from an absurd
 * request. Pure (takes an env-like object) — directly unit-testable.
 */

export interface LoadLimits {
  maxConcurrency: number;     // simultaneous in-flight requests per run/stage
  maxTotalRequests: number;   // cap on a single fixed-count run
  maxStageSec: number;        // longest a single stage may hold
  maxTotalSec: number;        // longest a staged profile may run
  hardRequestCap: number;     // absolute backstop on requests issued per profile
}

/** Defaults — raised from the old 50/500 to credible load scale. */
export const LOAD_DEFAULTS: LoadLimits = {
  maxConcurrency: 250,
  maxTotalRequests: 20_000,
  maxStageSec: 120,
  maxTotalSec: 300,
  hardRequestCap: 200_000,
};

/** Absolute hard ceilings — an env override can never exceed these. */
export const LOAD_HARD: LoadLimits = {
  maxConcurrency: 1_000,
  maxTotalRequests: 200_000,
  maxStageSec: 300,
  maxTotalSec: 600,
  hardRequestCap: 2_000_000,
};

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Resolve effective limits from an env-like map. Each `LOADTEST_*` override is
 * clamped into [1 (or a sane floor), its hard ceiling]; an unset/invalid value
 * falls back to the default.
 */
export function resolveLoadLimits(env: Record<string, string | undefined> = {}): LoadLimits {
  return {
    maxConcurrency: clampInt(env.LOADTEST_MAX_CONCURRENCY, LOAD_DEFAULTS.maxConcurrency, 1, LOAD_HARD.maxConcurrency),
    maxTotalRequests: clampInt(env.LOADTEST_MAX_TOTAL_REQUESTS, LOAD_DEFAULTS.maxTotalRequests, 1, LOAD_HARD.maxTotalRequests),
    maxStageSec: clampInt(env.LOADTEST_MAX_STAGE_SEC, LOAD_DEFAULTS.maxStageSec, 1, LOAD_HARD.maxStageSec),
    maxTotalSec: clampInt(env.LOADTEST_MAX_TOTAL_SEC, LOAD_DEFAULTS.maxTotalSec, 1, LOAD_HARD.maxTotalSec),
    hardRequestCap: clampInt(env.LOADTEST_HARD_REQUEST_CAP, LOAD_DEFAULTS.hardRequestCap, 1_000, LOAD_HARD.hardRequestCap),
  };
}
