/**
 * Notification Dispatcher
 *
 * Single entry point for sending test-run-related notifications.
 * Routes to every channel the tenant has connected (email / Slack / Teams).
 * Channels are tenant-configured in client_configurations
 * (integration_id = 'notif-email' | 'notif-slack' | 'notif-teams').
 */
import pool from '../db.js';
import { sendTestRunEmail, clearSmtpCache, type TestRunEmailPayload } from './email.service.js';
import { sendWebhookTestRun } from './webhook-notification.service.js';

export type NotificationChannel = 'email' | 'slack' | 'teams';

export interface DispatchResult {
  channel: NotificationChannel;
  sent: boolean;
  error?: string;
}

const CHANNEL_BY_INTEGRATION: Record<string, NotificationChannel> = {
  'notif-email': 'email',
  'notif-slack': 'slack',
  'notif-teams': 'teams',
};

async function getConnectedChannels(tenantId: string): Promise<NotificationChannel[]> {
  try {
    const { rows } = await pool.query(
      `SELECT integration_id FROM "JBSTestOpsAI".client_configurations
       WHERE tenant_id = $1
         AND integration_id IN ('notif-email', 'notif-slack', 'notif-teams')
         AND status = 'connected'`,
      [tenantId],
    );
    return rows
      .map((r: { integration_id: string }) => CHANNEL_BY_INTEGRATION[r.integration_id])
      .filter((c): c is NotificationChannel => !!c);
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
    } else {
      const r = await sendWebhookTestRun(tenantId, channel, payload);
      results.push({ channel, sent: r.sent, error: r.error });
    }
  }
  return results;
}
