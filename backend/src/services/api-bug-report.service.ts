/**
 * api-bug-report.service.ts
 * ─────────────────────────
 * Auto-generated bug-report artifact. From one failing API test it assembles a
 * complete, tracker-ready report: a title, a severity, steps to reproduce (the
 * exact request + a runnable curl), expected-vs-actual, environment, the error
 * log, and — when an LLM is configured — an AI root-cause triage. It emits the
 * report three ways: Markdown (to paste anywhere), a Jira-issue payload, and a
 * GitHub-issue payload.
 *
 * Standalone and opt-in, read-only. It REUSES the diagnosis service for
 * root-cause; it does NOT file the issue anywhere (the user copies it, or hands
 * the payload to the existing Remediation-PR / tracker integrations). The
 * pipeline is untouched.
 */
import { diagnoseFailure, type FailureInput, type Diagnosis } from './api-diagnose.service.js';
import type { LlmConfig } from '../agents/claude-runner.js';

export interface BugReportInput extends FailureInput {
  /** Extra request headers to document (redacted — auth values are masked). */
  requestHeaders?: { key: string; value: string }[];
  responseHeaders?: { key: string; value: string }[];
  /** A sample of the response the test expected, when the test recorded one. */
  expectedResponse?: string;
  environment?: string;
  runId?: string;
  reportUrl?: string;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface BugReport {
  title: string;
  severity: Severity;
  labels: string[];
  markdown: string;
  jira: { summary: string; description: string; issuetype: string; priority: string; labels: string[] };
  github: { title: string; body: string; labels: string[] };
  diagnosis?: Diagnosis;
  reproCurl: string;
}

const SENSITIVE = /^(authorization|cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;

/** Mask credential-bearing header values so a report is safe to paste into a tracker. */
function maskHeaders(headers: { key: string; value: string }[] | undefined): { key: string; value: string }[] {
  if (!Array.isArray(headers)) return [];
  return headers.filter((h) => h && h.key).slice(0, 30).map((h) => ({ key: String(h.key), value: SENSITIVE.test(String(h.key)) ? '«redacted»' : String(h.value ?? '').slice(0, 300) }));
}

function buildCurl(f: BugReportInput): string {
  const method = (f.method || 'GET').toUpperCase();
  const lines = [`curl -i -X ${method} '${f.url}'`];
  for (const h of maskHeaders(f.requestHeaders)) lines.push(`  -H '${h.key}: ${h.value}'`);
  if (f.requestBody && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!f.requestHeaders?.some((h) => /content-type/i.test(h.key))) lines.push(`  -H 'Content-Type: application/json'`);
    lines.push(`  -d '${f.requestBody.replace(/'/g, "'\\''").slice(0, 1000)}'`);
  }
  return lines.join(' \\\n');
}

/** Map the diagnosis + status into a severity. */
function deriveSeverity(f: BugReportInput, d?: Diagnosis): Severity {
  const status = Number(f.responseStatus) || 0;
  const cat = d?.category || '';
  if (cat === 'server-defect' || status >= 500) return 'critical';
  if (cat === 'auth' || status === 401 || status === 403) return 'high';
  if (cat === 'contract' || cat === 'data-setup') return 'high';
  if (cat === 'flaky' || cat === 'rate-limited') return 'low';
  if (cat === 'assertion-drift') return 'medium';
  return status >= 400 ? 'high' : 'medium';
}

/** PURE: assemble the Markdown body. Testable without an LLM. */
export function buildMarkdown(f: BugReportInput, severity: Severity, curl: string, d?: Diagnosis): string {
  const method = (f.method || 'GET').toUpperCase();
  const title = f.title || `${method} ${f.url} failed`;
  const reqHeaders = maskHeaders(f.requestHeaders);
  const resHeaders = maskHeaders(f.responseHeaders);
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`**Severity:** ${severity}${f.environment ? `  ·  **Environment:** ${f.environment}` : ''}${f.runId ? `  ·  **Run:** ${f.runId}` : ''}`);
  if (f.reportUrl) lines.push(`**Report:** ${f.reportUrl}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(d?.rootCause || f.error || 'An API test failed.');
  lines.push('');
  lines.push('## Steps to reproduce');
  lines.push('1. Issue the request below (a runnable curl is included).');
  lines.push(`2. Observe the response status / body.`);
  lines.push('');
  lines.push('```bash');
  lines.push(curl);
  lines.push('```');
  lines.push('');
  lines.push('## Request');
  lines.push(`- **Method / URL:** \`${method} ${f.url}\``);
  if (reqHeaders.length) lines.push(`- **Headers:** ${reqHeaders.map((h) => `\`${h.key}: ${h.value}\``).join(', ')}`);
  if (f.requestBody) { lines.push('- **Body:**'); lines.push('```json'); lines.push(f.requestBody.slice(0, 1500)); lines.push('```'); }
  lines.push('');
  lines.push('## Expected vs. actual');
  lines.push(`| | Value |`);
  lines.push(`|---|---|`);
  if (f.expectedStatus) lines.push(`| Expected status | ${f.expectedStatus} |`);
  if (f.responseStatus) lines.push(`| Actual status | ${f.responseStatus} |`);
  if (f.expectedResponse) lines.push(`| Expected (sample) | \`${String(f.expectedResponse).slice(0, 200).replace(/\|/g, '\\|')}\` |`);
  lines.push('');
  if (resHeaders.length) { lines.push('## Response headers'); lines.push(resHeaders.map((h) => `- \`${h.key}: ${h.value}\``).join('\n')); lines.push(''); }
  if (f.responseBody) { lines.push('## Response body'); lines.push('```json'); lines.push(String(f.responseBody).slice(0, 2000)); lines.push('```'); lines.push(''); }
  if (f.error) { lines.push('## Error / assertion log'); lines.push('```'); lines.push(String(f.error).slice(0, 2000)); lines.push('```'); lines.push(''); }
  if (d) {
    lines.push('## AI root-cause triage');
    lines.push(`- **Category:** ${d.category}  (confidence: ${d.confidence})`);
    lines.push(`- **Root cause:** ${d.rootCause}`);
    lines.push(`- **Suggested fix:** ${d.suggestedFix}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('_Generated by IntelliQE API Automation._');
  return lines.join('\n');
}

export async function buildBugReport(input: BugReportInput, llm?: LlmConfig | null): Promise<BugReport> {
  if (!input || !input.url) throw new Error('A failing request (method + url) is required to build a bug report.');
  const method = (input.method || 'GET').toUpperCase();

  let diagnosis: Diagnosis | undefined;
  if (llm) {
    try { diagnosis = await diagnoseFailure(input, llm); } catch { /* report still builds without a diagnosis */ }
  }

  const severity = deriveSeverity(input, diagnosis);
  const curl = buildCurl(input);
  const title = (input.title || `${method} ${input.url} failed`).slice(0, 200);
  const markdown = buildMarkdown(input, severity, curl, diagnosis);
  const labels = ['bug', 'api', `severity:${severity}`, ...(diagnosis?.category ? [diagnosis.category] : [])];
  const jiraPriority = severity === 'critical' ? 'Highest' : severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';

  return {
    title,
    severity,
    labels,
    markdown,
    jira: { summary: title, description: markdown, issuetype: 'Bug', priority: jiraPriority, labels },
    github: { title, body: markdown, labels },
    diagnosis,
    reproCurl: curl,
  };
}
