/**
 * Notification Dispatcher
 *
 * Single entry point for sending test-run-related notifications.
 * Currently routes to email only — wire additional channels here if added later.
 * Channels are tenant-configured in client_configurations (integration_id = 'notif-email').
 */
import pool from '../db.js';
import { sendTestRunEmail, clearSmtpCache, type TestRunEmailPayload } from './email.service.js';

export type NotificationChannel = 'email';

export interface DispatchResult {
  channel: NotificationChannel;
  sent: boolean;
  error?: string;
}

async function getConnectedChannels(tenantId: string): Promise<NotificationChannel[]> {
  try {
    const { rows } = await pool.query(
      `SELECT integration_id FROM "JBSTestOpsAI".client_configurations
       WHERE tenant_id = $1 AND integration_id = 'notif-email' AND status = 'connected'`,
      [tenantId],
    );
    return rows.length > 0 ? ['email'] : [];
  } catch {
    return [];
  }
}

/**
 * Dispatch a test-run notification to every channel the tenant has enabled.
 * No-op if no channels are configured.
 */
export async function dispatchTestRunNotification(
  tenantId: string,
  payload: TestRunEmailPayload,
): Promise<DispatchResult[]> {
  const channels = await getConnectedChannels(tenantId);
  if (channels.length === 0) return [];

  const results: DispatchResult[] = [];
  for (const channel of channels) {
    if (channel === 'email') {
      clearSmtpCache(tenantId);
      const r = await sendTestRunEmail(tenantId, payload);
      results.push({ channel, sent: r.sent, error: r.error });
    }
  }
  return results;
}
