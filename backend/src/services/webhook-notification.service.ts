/**
 * Webhook Notification Service — test-run notifications to chat platforms.
 *
 * Supports Slack and Microsoft Teams via their standard "incoming webhook"
 * model (the same pattern those SaaS products document): the tenant pastes a
 * webhook URL on the Notifications screen, and we POST a formatted message to
 * it. The URL is stored encrypted (sensitive key `webhook_url`) and decrypted
 * only when a message is sent.
 *
 *   - Slack:  https://hooks.slack.com/services/...      (Block Kit payload)
 *   - Teams:  Workflows webhook                          (Adaptive Card payload)
 */
import pool from '../db.js';
import { decryptStored } from '../utils/crypto.js';
import type { TestRunEmailPayload } from './email.service.js';

export type WebhookProvider = 'slack' | 'teams';

const INTEGRATION_BY_PROVIDER: Record<WebhookProvider, string> = {
  slack: 'notif-slack',
  teams: 'notif-teams',
};

interface WebhookConfig {
  url: string;
  channel?: string;   // Slack override (legacy custom webhooks)
  botName?: string;   // Slack username override
}

async function loadWebhookConfig(tenantId: string, provider: WebhookProvider): Promise<WebhookConfig | null> {
  try {
    const { rows } = await pool.query(
      `SELECT config_data FROM "JBSTestOpsAI".client_configurations
       WHERE tenant_id = $1 AND integration_id = $2 AND status = 'connected'
       LIMIT 1`,
      [tenantId, INTEGRATION_BY_PROVIDER[provider]],
    );
    if (!rows.length) return null;
    const c = rows[0].config_data || {};
    const url = c.webhook_url ? decryptStored(c.webhook_url) : '';
    if (!url) return null;
    return { url, channel: c.channel || undefined, botName: c.botName || undefined };
  } catch {
    return null;
  }
}

function statusColor(status: TestRunEmailPayload['status']): string {
  return status === 'passed' ? '#16a34a' : status === 'failed' ? '#b91c1c' : '#d97706';
}

function duration(payload: TestRunEmailPayload): string {
  return payload.durationSeconds !== undefined ? `${Math.round(payload.durationSeconds)}s` : 'n/a';
}

/** Slack Block Kit message (posted as a coloured attachment). */
function buildSlackBody(payload: TestRunEmailPayload, cfg: WebhookConfig): Record<string, unknown> {
  const total = payload.totalTests || 0;
  const heading = payload.status === 'passed'
    ? 'Passed'
    : payload.status === 'failed'
      ? 'Failed'
      : `Partial — ${payload.passed}/${total} passed`;
  const body: Record<string, unknown> = {
    text: `[IntelliQE] Test Run ${heading} — ${payload.feature}`,
    attachments: [
      {
        color: statusColor(payload.status),
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `Test Run ${heading}: ${payload.feature}`.slice(0, 150) } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Run ID:*\n${payload.runId}` },
              { type: 'mrkdwn', text: `*Module:*\n${payload.module || '—'}` },
              { type: 'mrkdwn', text: `*Total:*\n${payload.totalTests}` },
              { type: 'mrkdwn', text: `*Duration:*\n${duration(payload)}` },
              { type: 'mrkdwn', text: `*Passed:*\n${payload.passed}` },
              { type: 'mrkdwn', text: `*Failed:*\n${payload.failed}` },
            ],
          },
          ...(payload.reportUrl
            ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Report' }, url: payload.reportUrl }] }]
            : []),
        ],
      },
    ],
  };
  if (cfg.channel) body.channel = cfg.channel;
  if (cfg.botName) body.username = cfg.botName;
  return body;
}

/**
 * Microsoft Teams Adaptive Card, wrapped in the Workflows ("Post to a channel
 * when a webhook request is received") message envelope. This is the modern,
 * richly-styled format — coloured status header, big metric tiles, pass-rate
 * bar, a clean failures list, and an Open-Report button.
 */
function buildTeamsBody(payload: TestRunEmailPayload): Record<string, unknown> {
  const passed = payload.status === 'passed';
  const total = payload.totalTests || 0;
  const rate = total > 0 ? Math.round((payload.passed / total) * 100) : 0;
  const emoji = passed ? '✅' : payload.status === 'failed' ? '❌' : '⚠️';
  const headerStyle = passed ? 'good' : payload.status === 'failed' ? 'attention' : 'warning';
  // Informative heading: a partial run reports how many passed rather than a
  // blunt "PARTIAL" that reads like a total failure.
  const heading = passed
    ? 'Test Run Passed'
    : payload.status === 'failed'
      ? 'Test Run Failed'
      : `Partial Pass — ${payload.passed}/${total} passed`;

  // A single metric "tile": big number on top, small label underneath.
  const tile = (lbl: string, val: string | number, color?: string) => ({
    type: 'Column',
    width: 'stretch',
    items: [
      { type: 'TextBlock', text: String(val), size: 'ExtraLarge', weight: 'Bolder', horizontalAlignment: 'Center', spacing: 'None', ...(color ? { color } : {}) },
      { type: 'TextBlock', text: lbl, size: 'Small', isSubtle: true, horizontalAlignment: 'Center', spacing: 'None' },
    ],
  });

  const body: Record<string, unknown>[] = [
    {
      type: 'Container',
      style: headerStyle,
      bleed: true,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [{ type: 'TextBlock', text: emoji, size: 'ExtraLarge', spacing: 'None' }] },
            {
              type: 'Column',
              width: 'stretch',
              verticalContentAlignment: 'Center',
              items: [
                { type: 'TextBlock', text: heading, weight: 'Bolder', size: 'Large', wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: payload.feature, isSubtle: true, wrap: true, spacing: 'None' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'ColumnSet',
      spacing: 'Medium',
      columns: [
        tile('Total', total),
        tile('Passed', payload.passed, 'Good'),
        tile('Failed', payload.failed, 'Attention'),
        tile('Duration', duration(payload)),
      ],
    },
    {
      type: 'TextBlock',
      text: `**${rate}% passed**  ·  Module: ${payload.module || '—'}`,
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
    },
  ];

  // Failures — render each as its own line inside a subtle red container.
  if (payload.error) {
    const lines = payload.error.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
    body.push({
      type: 'Container',
      style: 'attention',
      spacing: 'Medium',
      items: [
        { type: 'TextBlock', text: 'Failed tests', weight: 'Bolder', size: 'Small', spacing: 'None' },
        ...lines.map((l) => ({ type: 'TextBlock', text: l.replace(/^[•\-]\s*/, '• '), wrap: true, size: 'Small', spacing: 'Small' })),
      ],
    });
  }

  body.push({
    type: 'TextBlock',
    text: `JBS IntelliQE · Run ${payload.runId}`,
    size: 'Small',
    isSubtle: true,
    spacing: 'Medium',
    wrap: true,
  });

  const card: Record<string, unknown> = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (payload.reportUrl) {
    card.actions = [{ type: 'Action.OpenUrl', title: '📊 Open Full Report', url: payload.reportUrl }];
  }

  // Workflows "Post to a channel" expects this attachments envelope.
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}

async function postWebhook(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Webhook returned ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
}

/** Send a test-run notification to a configured Slack/Teams webhook. */
export async function sendWebhookTestRun(
  tenantId: string,
  provider: WebhookProvider,
  payload: TestRunEmailPayload,
): Promise<{ sent: boolean; error?: string }> {
  try {
    const cfg = await loadWebhookConfig(tenantId, provider);
    if (!cfg) return { sent: false, error: `${provider} webhook not configured for tenant` };
    const body = provider === 'slack' ? buildSlackBody(payload, cfg) : buildTeamsBody(payload);
    await postWebhook(cfg.url, body);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}

/* ── SDET ticket — escalate bugs to the JBS SDET team ─────────── */

export interface SdetTicketBug {
  bugNumber: number;
  title: string;
  severity: string;
  priority: string;
  bugType?: string;
  module?: string | null;
}

export interface SdetTicketPayload {
  bugs: SdetTicketBug[];
  raisedBy: string;
  tenantName?: string;
}

/** Adaptive Card asking the JBS SDET team to pick up framework fixes. */
function buildTeamsSdetTicketBody(payload: SdetTicketPayload): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: 'Container',
      style: 'warning',
      bleed: true,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [{ type: 'TextBlock', text: '🎫', size: 'ExtraLarge', spacing: 'None' }] },
            {
              type: 'Column',
              width: 'stretch',
              verticalContentAlignment: 'Center',
              items: [
                { type: 'TextBlock', text: 'Ticket Raised — JBS SDET Team', weight: 'Bolder', size: 'Large', wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: 'Automation framework changes requested', isSubtle: true, wrap: true, spacing: 'None' },
              ],
            },
          ],
        },
      ],
    },
    ...payload.bugs.map((b) => ({
      type: 'Container',
      spacing: 'Medium',
      separator: true,
      items: [
        { type: 'TextBlock', text: `**BUG-${b.bugNumber}** · ${b.title}`, wrap: true, spacing: 'None' },
        {
          type: 'TextBlock',
          text: `Severity: ${b.severity} · Priority: ${b.priority}${b.bugType ? ` · Type: ${b.bugType}` : ''}${b.module ? ` · Module: ${b.module}` : ''}`,
          size: 'Small',
          isSubtle: true,
          wrap: true,
          spacing: 'Small',
        },
      ],
    })),
    {
      type: 'TextBlock',
      text: `Raised by ${payload.raisedBy}${payload.tenantName ? ` · ${payload.tenantName}` : ''} · JBS IntelliQE`,
      size: 'Small',
      isSubtle: true,
      spacing: 'Medium',
      wrap: true,
    },
  ];

  const card: Record<string, unknown> = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}

/** Post an SDET ticket card to the tenant's configured Teams webhook. */
export async function sendWebhookSdetTicket(
  tenantId: string,
  payload: SdetTicketPayload,
): Promise<{ sent: boolean; error?: string }> {
  try {
    const cfg = await loadWebhookConfig(tenantId, 'teams');
    if (!cfg) return { sent: false, error: 'Microsoft Teams is not connected. Connect it in System Configuration first.' };
    await postWebhook(cfg.url, buildTeamsSdetTicketBody(payload));
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}

/** The sample "it works!" payload used by both saved-config and ad-hoc tests. */
function buildSampleTestPayload(provider: WebhookProvider): TestRunEmailPayload {
  return {
    runId: 'test-' + Date.now(),
    feature: `${provider === 'slack' ? 'Slack' : 'Microsoft Teams'} Configuration Test`,
    module: 'system-configuration',
    status: 'passed',
    totalTests: 1,
    passed: 1,
    failed: 0,
    durationSeconds: 0,
  };
}

/** Convenience: post a sample message to verify the SAVED webhook configuration. */
export async function sendWebhookTest(tenantId: string, provider: WebhookProvider): Promise<{ sent: boolean; error?: string }> {
  return sendWebhookTestRun(tenantId, provider, buildSampleTestPayload(provider));
}

/**
 * Post a sample message to an AD-HOC webhook URL (not yet saved). Lets the UI
 * verify connectivity from the Connect dialog before storing the config.
 */
export async function sendWebhookTestUrl(provider: WebhookProvider, url: string): Promise<{ sent: boolean; error?: string }> {
  const trimmed = (url || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { sent: false, error: 'Enter a valid webhook URL (must start with https://).' };
  }
  try {
    const payload = buildSampleTestPayload(provider);
    const body = provider === 'slack' ? buildSlackBody(payload, { url: trimmed }) : buildTeamsBody(payload);
    await postWebhook(trimmed, body);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}
