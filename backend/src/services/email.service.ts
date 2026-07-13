/**
 * Email Service — test-run notifications via SMTP.
 *
 * Provider-neutral: SMTP host/port/user/pass come from the tenant's
 * notif-email integration config in client_configurations, with env-var fallback.
 *
 * Sends:
 *   - sendTestRunCompletedEmail: a tenant's test run finished (pass/fail summary)
 *   - sendTestRunFailedEmail:    a tenant's test run failed (with error context)
 *
 * Add more notification types here as the product grows.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import pool from '../db.js';
import { decryptField } from '../utils/crypto.js';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  cc?: string;
  secure: boolean;
}

const cache = new Map<string, { config: SmtpConfig; transporter: Transporter }>();

async function loadSmtpConfig(tenantId: string): Promise<SmtpConfig | null> {
  try {
    const { rows } = await pool.query(
      `SELECT config_data FROM "JBSTestOpsAI".client_configurations
       WHERE tenant_id = $1 AND integration_id = 'notif-email' AND status = 'connected'
       LIMIT 1`,
      [tenantId],
    );
    if (rows.length > 0) {
      const c = rows[0].config_data || {};
      const user = c.smtpUser ? decryptField(c.smtpUser) : '';
      const pass = c.smtpPassword ? decryptField(c.smtpPassword) : '';
      if (user && pass) {
        const port = Number(c.smtpPort) || 465;
        return {
          host: c.smtpHost || 'smtp.office365.com',
          port,
          // SSL on 465; STARTTLS (secure:false, auto-upgraded) on 587/25 — e.g. Outlook.
          // An explicit smtpSecure flag still wins if ever set.
          secure: c.smtpSecure !== undefined ? c.smtpSecure !== false : port === 465,
          user,
          pass,
          from: c.fromEmail || user,
          to: c.toEmail || '',
          cc: c.ccEmail || '',
        };
      }
    }
  } catch {
    /* fall through to env */
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return null;
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    user,
    pass,
    from: process.env.SMTP_FROM || user,
    to: process.env.SMTP_TO || '',
    cc: process.env.SMTP_CC || '',
  };
}

async function getTransporter(tenantId: string): Promise<{ transporter: Transporter; config: SmtpConfig } | null> {
  if (cache.has(tenantId)) return cache.get(tenantId)!;
  const config = await loadSmtpConfig(tenantId);
  if (!config) return null;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Outlook / Office 365 (smtp.office365.com:587) requires an enforced
    // STARTTLS upgrade over the plaintext connection — without this the send
    // fails. On SSL (465) the connection is already encrypted.
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  const entry = { config, transporter };
  cache.set(tenantId, entry);
  return entry;
}

export function clearSmtpCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export interface TestRunEmailPayload {
  runId: string;
  feature: string;
  module?: string;
  status: 'passed' | 'failed' | 'partial';
  totalTests: number;
  passed: number;
  failed: number;
  durationSeconds?: number;
  reportUrl?: string;
  error?: string;
}

function buildHtml(payload: TestRunEmailPayload): { subject: string; html: string; text: string } {
  const statusColor =
    payload.status === 'passed' ? '#16a34a' : payload.status === 'failed' ? '#b91c1c' : '#d97706';
  // A mix of pass/fail is PARTIAL (not a blunt FAILED); show how many passed.
  const statusLabel =
    payload.status === 'passed' ? 'PASSED'
      : payload.status === 'failed' ? 'FAILED'
        : `PARTIAL · ${payload.passed}/${payload.totalTests} PASSED`;
  const subject = `[IntelliQE] Test Run ${statusLabel} — ${payload.feature}`;
  const duration =
    payload.durationSeconds !== undefined ? `${Math.round(payload.durationSeconds)}s` : 'n/a';

  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f4f8;margin:0;padding:24px;">
  <table cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr><td style="background:#1E1B4B;padding:20px 24px;">
      <div style="color:#fff;font-size:20px;font-weight:700;">JBS IntelliQE — Test Run Report</div>
      <div style="color:#a5b4fc;font-size:12px;margin-top:4px;">${payload.feature}${payload.module ? ' · ' + payload.module : ''}</div>
    </td></tr>
    <tr><td style="height:4px;background:${statusColor};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:24px;">
      <div style="display:inline-block;background:${statusColor}22;color:${statusColor};padding:6px 14px;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:0.5px;">${statusLabel}</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;border-collapse:collapse;">
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;width:40%;">Run ID</td><td style="padding:6px 0;font-size:13px;font-family:monospace;color:#1E1B4B;">${payload.runId}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Total Tests</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#1E1B4B;">${payload.totalTests}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Passed</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#16a34a;">${payload.passed}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Failed</td><td style="padding:6px 0;font-size:13px;font-weight:600;color:#b91c1c;">${payload.failed}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7280;">Duration</td><td style="padding:6px 0;font-size:13px;color:#1E1B4B;">${duration}</td></tr>
      </table>
      ${payload.error ? `<div style="margin-top:16px;padding:12px;background:#fef2f2;border-left:3px solid #b91c1c;font-size:12px;font-family:monospace;color:#7f1d1d;white-space:pre-wrap;">${escape(payload.error).slice(0, 800)}</div>` : ''}
      ${payload.reportUrl ? `<div style="margin-top:24px;text-align:center;"><a href="${payload.reportUrl}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">View Full Report</a></div>` : ''}
    </td></tr>
    <tr><td style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">JBS IntelliQE · Automated test report · ${new Date().toISOString()}</td></tr>
  </table>
</body></html>`;

  const text = [
    `[IntelliQE] Test Run ${statusLabel} — ${payload.feature}`,
    `Run ID: ${payload.runId}`,
    `Total: ${payload.totalTests} | Passed: ${payload.passed} | Failed: ${payload.failed}`,
    `Duration: ${duration}`,
    payload.error ? `Error: ${payload.error}` : '',
    payload.reportUrl ? `Report: ${payload.reportUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function sendTestRunEmail(
  tenantId: string,
  payload: TestRunEmailPayload,
  overrideTo?: string,
): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  try {
    const entry = await getTransporter(tenantId);
    if (!entry) return { sent: false, error: 'SMTP not configured for tenant' };

    const to = overrideTo || entry.config.to;
    if (!to) return { sent: false, error: 'No recipient configured' };

    const { subject, html, text } = buildHtml(payload);
    const info = await entry.transporter.sendMail({
      from: entry.config.from,
      to,
      cc: entry.config.cc || undefined,
      subject,
      html,
      text,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}

/** Convenience: send a test email to verify SMTP configuration. */
export async function sendTestEmail(tenantId: string, sentBy: string): Promise<{ sent: boolean; messageId?: string; error?: string }> {
  return sendTestRunEmail(tenantId, {
    runId: 'test-' + Date.now(),
    feature: 'SMTP Configuration Test',
    status: 'passed',
    totalTests: 1,
    passed: 1,
    failed: 0,
    durationSeconds: 0,
    error: undefined,
    reportUrl: undefined,
  });
}
