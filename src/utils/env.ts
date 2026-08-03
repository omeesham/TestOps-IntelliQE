/**
 * Environment configuration.
 * Reads from process.env with safe defaults. No secrets, no hardcoded URLs.
 * Override any value by setting it in `.env` (see `.env.example`).
 */

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const env = {
  BASE_URL: process.env.BASE_URL ?? 'http://localhost:3000',
  HEADLESS: bool(process.env.HEADLESS, true),
  WORKERS: int(process.env.WORKERS, 4),
  TIMEOUT: int(process.env.TIMEOUT, 30000),
  CI: bool(process.env.CI, false),
};

export type Env = typeof env;
