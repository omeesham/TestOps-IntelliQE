/**
 * Production start-up check: list required settings that are missing or weak,
 * so a deployment fails at start with a clear message instead of failing later
 * (or silently running on a development default).
 */
const WEAK_WORKER_SECRETS = new Set(['dev-secret', 'change-me-in-production']);

export function missingProductionSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) problems.push('JWT_SECRET (32+ characters)');

  const key = env.ENCRYPTION_KEY ? Buffer.from(env.ENCRYPTION_KEY, 'base64') : null;
  if (!key || key.length !== 32) problems.push('ENCRYPTION_KEY (Base64 of 32 bytes)');

  const worker = env.WORKER_SECRET || '';
  if (worker.length < 16 || WEAK_WORKER_SECRETS.has(worker)) problems.push('WORKER_SECRET (16+ characters, not a default)');

  if (!(env.AZURE_SQL_PASSWORD || env.DB_PASSWORD)) problems.push('AZURE_SQL_PASSWORD (or DB_PASSWORD)');

  return problems;
}
