import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';

/**
 * Trial/license expiry gate. The date is baked into backend/LICENSE_EXPIRY at
 * image build time (Dockerfile ARG), not read from an env var, so it can only
 * be changed by shipping a new image. docker/entrypoint.sh performs the same
 * check before the container starts; this is the runtime safety net for a
 * container that was already running when the date passed.
 *
 * No file outside production (local dev) means no expiry. No file or an
 * unreadable date in production fails closed.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPIRY_FILE = path.resolve(__dirname, '../..', 'LICENSE_EXPIRY');

function readExpiry(): string | null {
  try {
    return fs.readFileSync(EXPIRY_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const LICENSE_EXPIRY_DATE = readExpiry();

export function isLicenseExpired(now: number = Date.now(), expiry: string | null = LICENSE_EXPIRY_DATE,
  production: boolean = process.env.NODE_ENV === 'production'): boolean {
  if (!expiry) return production;
  const cutoff = new Date(`${expiry}T00:00:00Z`).getTime();
  if (Number.isNaN(cutoff)) return true;
  return now >= cutoff;
}

export function licenseExpiryGuard(_req: Request, res: Response, next: NextFunction): void {
  if (isLicenseExpired()) {
    res.status(403).json({
      success: false,
      code: 'TRIAL_EXPIRED',
      error: 'Trial period has ended',
      hint: `This trial deployment expired on ${LICENSE_EXPIRY_DATE ?? 'an unknown date'}. Contact JBS to continue using IntelliQE.`,
    });
    return;
  }
  next();
}
