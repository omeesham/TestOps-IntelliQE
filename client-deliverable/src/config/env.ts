/**
 * Environment configuration — the single, externalized source of run settings.
 *
 * Every value is read from process.env with safe defaults; no secrets and no
 * hardcoded URLs live in source. Select a target with ENV (dev | qa | uat |
 * prod); per-environment values are read from ENV-prefixed variables so the
 * SAME tests run everywhere through configuration alone.
 *
 *   ENV=qa  →  QA_BASE_URL / QA_USERNAME … (falling back to BASE_URL / USERNAME)
 *
 * Credentials are read from the environment only — never committed.
 */

export type TargetEnv = 'dev' | 'qa' | 'uat' | 'prod';

function str(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value.trim() : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function posInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Worker count: a positive integer, or `undefined` to let Playwright auto-detect
 * CPU cores (recommended in CI). Unset or `0`/invalid → undefined.
 */
function workers(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const ENV = str(process.env.ENV, 'dev').toLowerCase() as TargetEnv;

/** Read a key, preferring the ENV-prefixed override (e.g. QA_BASE_URL). */
function forEnv(key: string, fallback: string): string {
  const prefixed = process.env[`${ENV.toUpperCase()}_${key}`];
  return str(prefixed ?? process.env[key], fallback);
}

export const env = {
  ENV,
  BASE_URL: forEnv('BASE_URL', 'http://localhost:3000'),
  API_BASE_URL: forEnv('API_BASE_URL', ''),
  USERNAME: forEnv('USERNAME', ''),
  PASSWORD: forEnv('PASSWORD', ''),
  HEADLESS: bool(process.env.HEADLESS, true),
  /** undefined → Playwright auto-detects CPU cores. */
  WORKERS: workers(process.env.WORKERS),
  TIMEOUT: posInt(process.env.TIMEOUT, 30_000),
  EXPECT_TIMEOUT: posInt(process.env.EXPECT_TIMEOUT, 10_000),
  /** Undefined → config uses 0 locally and 2 in CI. */
  RETRIES: intOrUndefined(process.env.RETRIES),
  LOG_LEVEL: str(process.env.LOG_LEVEL, 'info'),
  CI: bool(process.env.CI, false),
};

export type Env = typeof env;
