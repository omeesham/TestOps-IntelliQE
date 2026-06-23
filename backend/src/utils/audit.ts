/**
 * Audit Trail Utility
 * Logs every meaningful action for HIPAA compliance and operational tracking.
 * Writes to "JBSTestOpsAI".audit_log (created in db.ts).
 */
import pool from '../db.js';
import type { Request } from 'express';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'execute'
  | 'approve'
  | 'reject'
  | 'login'
  | 'logout'
  | 'deploy'
  | 'rotate_key';

/**
 * Log an audit event derived from an authenticated Express request.
 * Tenant context is read from req.user (attached by auth middleware).
 * Failures are swallowed — audit must never block the main request flow.
 */
export async function logAudit(
  req: Request,
  action: AuditAction,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    const username = req.user?.username || 'system';
    const requestId = (req as any).requestId || null;
    const ipAddress = req.ip || req.socket?.remoteAddress || null;

    if (!tenantId) return;

    await pool.query(
      `INSERT INTO "JBSTestOpsAI".audit_log
         (tenant_id, username, action, resource_type, resource_id, details, ip_address, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, username, action, resourceType, resourceId, JSON.stringify(details), ipAddress, requestId],
    );
  } catch (err) {
    console.error('[audit] Failed to log:', (err as Error).message);
  }
}

/**
 * Log a system-level audit event (no request context — for workers, schedulers, etc.).
 */
export async function logSystemAudit(
  tenantId: string,
  action: AuditAction,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO "JBSTestOpsAI".audit_log
         (tenant_id, username, action, resource_type, resource_id, details)
       VALUES ($1, 'system', $2, $3, $4, $5)`,
      [tenantId, action, resourceType, resourceId, JSON.stringify(details)],
    );
  } catch (err) {
    console.error('[audit] Failed to log system event:', (err as Error).message);
  }
}
