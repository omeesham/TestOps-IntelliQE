import type { Request, Response, NextFunction } from 'express';

/**
 * Trial/license expiry gate. The date is baked in at build time via the
 * LICENSE_EXPIRY Dockerfile ARG/ENV; DEFAULT_EXPIRY is the fallback for
 * local/dev runs where that env var isn't set. This is the runtime safety
 * net — docker/entrypoint.sh performs the same check before the container
 * even starts, so an already-running container also stops serving traffic
 * once the date passes.
 */
const DEFAULT_EXPIRY = '2026-09-30';

export const LICENSE_EXPIRY_DATE = process.env.LICENSE_EXPIRY || DEFAULT_EXPIRY;

export function isLicenseExpired(): boolean {
  return Date.now() >= new Date(`${LICENSE_EXPIRY_DATE}T00:00:00Z`).getTime();
}

export function licenseExpiryGuard(_req: Request, res: Response, next: NextFunction): void {
  if (isLicenseExpired()) {
    res.status(403).json({
      success: false,
      code: 'TRIAL_EXPIRED',
      error: 'Trial period has ended',
      hint: `This trial deployment expired on ${LICENSE_EXPIRY_DATE}. Contact JBS to continue using IntelliQE.`,
    });
    return;
  }
  next();
}
