/**
 * Minimal leveled logger.
 *
 * Honors LOG_LEVEL (error | warn | info | debug) so test output stays useful in
 * CI without drowning in noise. Prefer this over raw console.* so logs are
 * consistent, prefixed, and filterable.
 */
import { env } from '../config/env';

type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function isLevel(value: string): value is Level {
  return value in ORDER;
}

// Validate LOG_LEVEL once at load — surface misconfiguration instead of silently
// falling back, then resolve the threshold.
if (!isLevel(env.LOG_LEVEL)) {
  console.warn(`[WARN] Unknown LOG_LEVEL "${env.LOG_LEVEL}" — falling back to "info". Valid: error|warn|info|debug.`);
}
const threshold = isLevel(env.LOG_LEVEL) ? ORDER[env.LOG_LEVEL] : ORDER.info;

function emit(level: Level, message: string, meta?: unknown): void {
  if (ORDER[level] > threshold) return;
  const line = `[${level.toUpperCase()}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta === undefined) sink(line);
  else sink(line, meta);
}

export const logger = {
  error: (message: string, meta?: unknown): void => emit('error', message, meta),
  warn: (message: string, meta?: unknown): void => emit('warn', message, meta),
  info: (message: string, meta?: unknown): void => emit('info', message, meta),
  debug: (message: string, meta?: unknown): void => emit('debug', message, meta),
};
